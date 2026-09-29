// Email campaigns: what the /campaigns pages call. The rules are in
// campaigns.ts; the sending is campaigns.server.ts; the storage and the send
// transition are migration 20260929070000_nobody-could-send-a-seasonal-offer.
//
// Every function asks for `send_campaigns` (owner and office manager). Drafts
// are read and written through the caller's own client, so RLS is the tenant
// boundary for them; the recipients, the stats and the send go through the
// service role, after the permission check, because those tables and
// functions are not reachable by an API role at all.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  audienceLabel,
  audienceSchema,
  campaignContentSchema,
  normalizeContent,
  SEND_BLOCKER_TEXT,
  selectAudience,
  sendBlockers,
  startOutcomeText,
  tagsInUse,
  type CampaignAudience,
  type CampaignContent,
} from "@/lib/campaigns";

export type CampaignStatus = "draft" | "sending" | "sent";

export type CampaignStats = {
  recipients: number;
  waiting: number;
  inQueue: number;
  skipped: number;
  sent: number;
  failed: number;
  bounced: number;
};

export type CampaignRow = {
  id: string;
  status: CampaignStatus;
  subject: string;
  heading: string;
  body: string;
  buttonLabel: string | null;
  buttonUrl: string | null;
  audience: CampaignAudience;
  audienceLabel: string;
  recipientCount: number | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  completedAt: string | null;
  stats: CampaignStats | null;
};

const CAMPAIGN_SELECT =
  "id, status, subject, heading, body, button_label, button_url, audience_kind, audience_tag, recipient_count, created_at, updated_at, sent_at, completed_at";

function audienceOf(row: { audience_kind: string; audience_tag: string | null }): CampaignAudience {
  if (row.audience_kind === "tagged" && row.audience_tag)
    return { kind: "tagged", tag: row.audience_tag };
  if (row.audience_kind === "inactive") return { kind: "inactive" };
  return { kind: "active" };
}

function toRow(r: any, stats: CampaignStats | null): CampaignRow {
  const audience = audienceOf(r);
  return {
    id: r.id,
    status: r.status,
    subject: r.subject ?? "",
    heading: r.heading ?? "",
    body: r.body ?? "",
    buttonLabel: r.button_label ?? null,
    buttonUrl: r.button_url ?? null,
    audience,
    audienceLabel: audienceLabel(audience),
    recipientCount: r.recipient_count ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at ?? null,
    completedAt: r.completed_at ?? null,
    stats,
  };
}

async function adminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function statsFor(orgId: string): Promise<Map<string, CampaignStats>> {
  const db = await adminClient();
  const { data, error } = await db.rpc("email_campaign_stats", { _org_id: orgId });
  if (error) throw new Error(error.message);
  const out = new Map<string, CampaignStats>();
  for (const s of (data ?? []) as any[]) {
    out.set(s.campaign_id, {
      recipients: s.recipients,
      waiting: s.waiting,
      inQueue: s.in_queue,
      skipped: s.skipped,
      sent: s.sent,
      failed: s.failed,
      bounced: s.bounced,
    });
  }
  return out;
}

async function orgBasics(supabase: any, orgId: string) {
  const { data, error } = await supabase
    .from("organizations")
    .select("name, timezone, contact_address, contact_email")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    orgName: (data?.name as string | null) ?? null,
    timezone: (data?.timezone as string | null) ?? null,
    contactAddress: ((data?.contact_address as string | null) ?? "").trim() || null,
    contactEmail: ((data?.contact_email as string | null) ?? "").trim() || null,
  };
}

// ── Reads ──────────────────────────────────────────────────────────────────

export const listCampaigns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "send_campaigns");
    const { data, error } = await supabase
      .from("email_campaigns")
      .select(CAMPAIGN_SELECT)
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const stats = await statsFor(orgId);
    const org = await orgBasics(supabase, orgId);
    return {
      campaigns: ((data ?? []) as any[]).map((r) => toRow(r, stats.get(r.id) ?? null)),
      ...org,
    };
  });

export const getCampaign = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "send_campaigns");
    const { data: row, error } = await supabase
      .from("email_campaigns")
      .select(CAMPAIGN_SELECT)
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Campaign not found");
    const stats = (await statsFor(orgId)).get(row.id) ?? null;

    // Why the ones that did not go, did not go. Only for a campaign that has
    // started; a draft has no recipients.
    const skipReasons: Record<string, number> = {};
    if (row.status !== "draft") {
      const db = await adminClient();
      const { data: skipped } = await db
        .from("email_campaign_recipients")
        .select("skip_reason")
        .eq("campaign_id", row.id)
        .eq("organization_id", orgId)
        .eq("status", "skipped")
        .limit(5000);
      for (const s of (skipped ?? []) as { skip_reason: string | null }[]) {
        const k = s.skip_reason ?? "enqueue_failed";
        skipReasons[k] = (skipReasons[k] ?? 0) + 1;
      }
    }
    const org = await orgBasics(supabase, orgId);
    return { campaign: toRow(row, stats), skipReasons, ...org };
  });

/** Who an audience reaches, before anything is saved or sent. */
export const getCampaignAudience = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ audience: audienceSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "send_campaigns");
    const { loadAudienceClients } = await import("@/lib/campaigns.server");
    const clients = await loadAudienceClients(supabase, orgId);
    const result = selectAudience(clients, data.audience);
    return {
      recipients: result.recipients.length,
      matched: result.matched,
      excluded: result.excluded,
      overCap: result.overCap,
      tags: tagsInUse(clients),
      activeCount: clients.filter((c) => c.active).length,
      inactiveCount: clients.filter((c) => !c.active).length,
    };
  });

// ── Drafts ─────────────────────────────────────────────────────────────────

const draftInput = z.object({
  id: z.string().uuid().optional(),
  // Drafts may be half-written, so content is only length-checked here; the
  // full rules (a button needs both halves, https only) apply on save too,
  // because the CHECK constraints would refuse anything else anyway and an
  // error message beats a Postgres one.
  content: campaignContentSchema,
  audience: audienceSchema,
});

export const saveCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => draftInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "send_campaigns");
    const c = normalizeContent(data.content);
    const patch = {
      subject: c.subject,
      heading: c.heading,
      body: c.body,
      button_label: c.buttonLabel,
      button_url: c.buttonUrl,
      audience_kind: data.audience.kind,
      audience_tag: data.audience.kind === "tagged" ? data.audience.tag.trim() : null,
    };
    if (data.id) {
      const { data: row, error } = await supabase
        .from("email_campaigns")
        .update(patch)
        .eq("id", data.id)
        .eq("organization_id", orgId)
        .eq("status", "draft")
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      // RLS only lets a draft be updated, so no row means it has been sent.
      if (!row) throw new Error("This campaign has already been sent and can no longer be edited.");
      return { id: row.id as string };
    }
    const { data: row, error } = await supabase
      .from("email_campaigns")
      .insert({ ...patch, organization_id: orgId, created_by: userId, status: "draft" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

export const deleteCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "send_campaigns");
    const { data: gone, error } = await supabase
      .from("email_campaigns")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .eq("status", "draft")
      .select("id");
    if (error) throw new Error(error.message);
    if (!gone?.length) throw new Error("Only a draft can be deleted.");
    return { ok: true };
  });

// ── Preview ────────────────────────────────────────────────────────────────

/** The email exactly as the template renders it, with this business's footer.
 *  The unsubscribe link is a placeholder: a real one is minted per client when
 *  the email is queued. */
export const previewCampaignEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ content: campaignContentSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "send_campaigns");
    const { data: org } = await supabase
      .from("organizations")
      .select("name, contact_phone, contact_email, contact_address")
      .eq("id", orgId)
      .maybeSingle();
    const c = normalizeContent(data.content);
    const React = await import("react");
    const { render } = await import("react-email");
    const { TEMPLATES } = await import("@/lib/email-templates/registry");
    const { appUrl } = await import("@/lib/app-origin");
    const entry = TEMPLATES.campaign;
    const props = {
      orgName: org?.name ?? "",
      orgPhone: org?.contact_phone ?? null,
      orgEmail: org?.contact_email ?? null,
      orgAddress: org?.contact_address ?? null,
      subject: c.subject,
      heading: c.heading,
      body: c.body,
      buttonLabel: c.buttonLabel,
      buttonUrl: c.buttonUrl,
      unsubscribeUrl: appUrl("/unsubscribe?token=preview"),
    };
    const html = await render(React.createElement(entry.component, props));
    const subject = typeof entry.subject === "function" ? entry.subject(props) : entry.subject;
    return { subject, html };
  });

// ── Send ───────────────────────────────────────────────────────────────────

/**
 * Press Send. Saves nothing: the campaign is sent as it was last saved, which
 * is what the preview and the recipient count on the page were showing.
 *
 * Safe to press twice. start_email_campaign locks the row and only a draft
 * can start, so the second press is told "already sent" and sends nothing;
 * and each recipient is one row, UNIQUE per campaign.
 */
export const sendCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "send_campaigns");

    const { data: row, error } = await supabase
      .from("email_campaigns")
      .select(CAMPAIGN_SELECT)
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Campaign not found");
    if (row.status !== "draft") {
      return {
        outcome: "already_started",
        message: startOutcomeText("already_started"),
        queued: 0,
      };
    }

    const content: CampaignContent = {
      subject: row.subject ?? "",
      heading: row.heading ?? "",
      body: row.body ?? "",
      buttonLabel: row.button_label ?? null,
      buttonUrl: row.button_url ?? null,
    };
    const org = await orgBasics(supabase, orgId);
    const { loadAudienceClients, feedCampaignLane } = await import("@/lib/campaigns.server");
    const clients = await loadAudienceClients(supabase, orgId);
    const audience = selectAudience(clients, audienceOf(row));

    const blockers = sendBlockers({
      contactAddress: org.contactAddress,
      content,
      recipientCount: audience.recipients.length,
    });
    if (blockers.length > 0) {
      throw new Error(blockers.map((b) => SEND_BLOCKER_TEXT[b]).join(" "));
    }

    const db = await adminClient();
    const { data: outcome, error: sErr } = await db.rpc("start_email_campaign", {
      _campaign_id: row.id,
      _org_id: orgId,
      _user_id: userId,
      _recipients: audience.recipients.map((r) => ({ client_id: r.clientId })),
    });
    if (sErr) throw new Error(sErr.message);
    if (outcome !== "started") {
      if (outcome === "already_started") {
        return { outcome, message: startOutcomeText(outcome), queued: 0 };
      }
      throw new Error(startOutcomeText(String(outcome)));
    }

    // The first batch now, so the page shows movement and a small campaign
    // is on its way before the minute's tick. The rest is the processor's.
    let queued = 0;
    try {
      queued = (await feedCampaignLane(10)).queued;
    } catch (e) {
      console.error("first campaign batch failed; the processor will pick it up", String(e));
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: null,
      actorUserId: userId,
      kind: "campaign.sent",
      summary: `Sent the campaign "${content.subject}" to ${audience.recipients.length} client${audience.recipients.length === 1 ? "" : "s"}`,
      meta: { campaignId: row.id, recipients: audience.recipients.length },
    });

    return {
      outcome: "started",
      message: startOutcomeText("started"),
      queued,
      recipients: audience.recipients.length,
    };
  });
