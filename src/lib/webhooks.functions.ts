// Outbound webhooks: the settings page's server half.
//
// Gated on manage_settings (owner and office manager), like accounting sync
// beside it: an endpoint sends the tenant's events to somebody else's
// system, which is the same kind of decision as connecting QuickBooks.
//
// Reads, edits of description/events/enabled, and deletes run as the
// signed-in user, so RLS is the boundary and requirePermission turns a denial
// into a sentence. Creating an endpoint and rotating its secret use the
// service-role client AFTER the permission check, because those are the two
// writes the migration does not grant to `authenticated`: an endpoint's URL is
// only ever written after it has passed the SSRF checks here, and the signing
// secret lives in a deny-all table.
//
// See supabase/migrations/20260929080000_nothing-could-listen-for-a-completed-visit.sql.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { encryptSecret, secretLast4 } from "@/lib/secret-encryption.server";
import {
  checkWebhookDestination,
  defaultResolver,
  generateWebhookSecret,
  processWebhookDeliveries,
  productionWorkerDeps,
} from "@/lib/webhook-delivery.server";
import { MAX_WEBHOOK_ENDPOINTS, WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT } from "@/lib/webhooks";

const ENDPOINT_COLUMNS =
  "id, url, description, events, enabled, secret_last4, consecutive_failures, disabled_at, disabled_reason, last_success_at, last_failure_at, created_at, updated_at";

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENT_TYPES as unknown as [string, ...string[]]))
  .min(1, "Pick at least one event.")
  .transform((a) => Array.from(new Set(a)));

async function requireWebhookOrg(supabase: unknown, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_settings")).orgId;
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

/** The endpoint, if it is this organization's. Read as the user, so RLS
 *  answers the tenancy question as well as the filter. */
async function ownEndpoint(supabase: any, orgId: string, id: string) {
  const { data, error } = await supabase
    .from("webhook_endpoints")
    .select("id, url, enabled")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That webhook endpoint was not found.");
  return data as { id: string; url: string; enabled: boolean };
}

export const listWebhookEndpoints = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireWebhookOrg(supabase, userId);
    const { data, error } = await (supabase as any)
      .from("webhook_endpoints")
      .select(ENDPOINT_COLUMNS)
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listWebhookDeliveries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await requireWebhookOrg(supabase, userId);
    const { data, error } = await (supabase as any)
      .from("webhook_deliveries")
      .select(
        "id, endpoint_id, event_type, status, attempts, last_status_code, last_error, next_attempt_at, last_attempt_at, delivered_at, created_at",
      )
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        url: z.string().trim().min(1).max(2048),
        description: z.string().trim().max(200).default(""),
        events: eventsSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await requireWebhookOrg(supabase, userId);

    const { count, error: countError } = await (supabase as any)
      .from("webhook_endpoints")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (countError) throw new Error(countError.message);
    if ((count ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
      throw new Error(`An organization can have up to ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`);
    }

    // Save-time SSRF check. The worker repeats it before every send.
    const dest = await checkWebhookDestination(data.url, defaultResolver);
    if (!dest.ok) throw new Error(dest.reason);

    const secret = generateWebhookSecret();
    const db = await admin();
    const { data: endpoint, error } = await db
      .from("webhook_endpoints")
      .insert({
        organization_id: orgId,
        url: dest.href,
        description: data.description,
        events: data.events,
        secret_last4: secretLast4(secret),
        created_by: userId,
      })
      .select(ENDPOINT_COLUMNS)
      .single();
    if (error) throw new Error(error.message);

    const { error: secretError } = await db.from("webhook_endpoint_secrets").insert({
      endpoint_id: endpoint.id,
      secret_ciphertext: encryptSecret(secret),
    });
    if (secretError) {
      // An endpoint with no secret cannot sign anything; do not leave one.
      await db
        .from("webhook_endpoints")
        .delete()
        .eq("id", endpoint.id)
        .eq("organization_id", orgId);
      throw new Error(secretError.message);
    }

    // The only time the secret leaves the server in plaintext.
    return { endpoint, secret };
  });

export const updateWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        description: z.string().trim().max(200).optional(),
        events: eventsSchema.optional(),
        enabled: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await requireWebhookOrg(supabase, userId);
    const current = await ownEndpoint(supabase, orgId, data.id);

    // Switching an endpoint back on is a promise to start sending to it
    // again, so its destination is checked again first.
    if (data.enabled === true && !current.enabled) {
      const dest = await checkWebhookDestination(current.url, defaultResolver);
      if (!dest.ok) throw new Error(dest.reason);
    }

    const patch: Record<string, unknown> = {};
    if (data.description !== undefined) patch.description = data.description;
    if (data.events !== undefined) patch.events = data.events;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (!Object.keys(patch).length) return { ok: true };

    const { error } = await (supabase as any)
      .from("webhook_endpoints")
      .update(patch)
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const rotateWebhookSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await requireWebhookOrg(supabase, userId);
    await ownEndpoint(supabase, orgId, data.id);

    const secret = generateWebhookSecret();
    const db = await admin();
    const { error } = await db.from("webhook_endpoint_secrets").upsert(
      {
        endpoint_id: data.id,
        secret_ciphertext: encryptSecret(secret),
        rotated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint_id" },
    );
    if (error) throw new Error(error.message);
    const { error: hintError } = await db
      .from("webhook_endpoints")
      .update({ secret_last4: secretLast4(secret) })
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (hintError) throw new Error(hintError.message);

    return { secret };
  });

export const deleteWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await requireWebhookOrg(supabase, userId);
    const { error } = await (supabase as any)
      .from("webhook_endpoints")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Queue a `webhook.test` event for one endpoint and deliver it now, so the
 * owner sees the receiver's answer on the page instead of in a minute. The
 * endpoint's switch is ignored on purpose: testing a switched-off endpoint is
 * how you find out whether it is safe to switch back on. A failed test does
 * not count toward switching it off.
 */
export const sendWebhookTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await requireWebhookOrg(supabase, userId);
    await ownEndpoint(supabase, orgId, data.id);

    const eventId = crypto.randomUUID();
    const db = await admin();
    const { data: row, error } = await db
      .from("webhook_deliveries")
      .insert({
        organization_id: orgId,
        endpoint_id: data.id,
        event_id: eventId,
        event_type: WEBHOOK_TEST_EVENT,
        // Out of the cron worker's reach: this row is sent below, now, and
        // a minute-boundary run must not claim it first.
        next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        payload: {
          id: eventId,
          type: WEBHOOK_TEST_EVENT,
          created_at: new Date().toISOString(),
          organization_id: orgId,
          data: {
            endpoint_id: data.id,
            message: "A test event from HoundStack. If you can read this, the endpoint works.",
          },
        },
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const summary = await processWebhookDeliveries(db, await productionWorkerDeps(), {
      only: row.id,
    });
    const result = summary.results[0];
    return {
      ok: result?.ok ?? false,
      status_code: result?.status_code ?? null,
      error: result ? result.error : "The test event could not be claimed for sending.",
    };
  });
