import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization found for this user. Complete onboarding first.");
  return data.organization_id as string;
}

export const listClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("clients")
      .select(
        "id, display_name, account_type, primary_email, primary_phone, active, created_at, credit_balance_cents, churn_score",
      )
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const clients = data ?? [];
    const ids = clients.map((c: any) => c.id);

    // Fetch aggregate side-data in parallel; ignore individual failures.
    const [dogsRes, subsRes, invRes] = await Promise.all([
      ids.length
        ? supabase.from("dogs").select("client_id").in("client_id", ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length
        ? supabase
            .from("subscriptions")
            .select("client_id, status")
            .in("client_id", ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length
        ? supabase
            .from("invoices")
            .select("client_id, amount_cents, amount_paid_cents, status")
            .in("client_id", ids)
            .in("status", ["open", "past_due"])
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const dogsByClient = new Map<string, number>();
    for (const d of dogsRes.data ?? []) {
      dogsByClient.set(d.client_id, (dogsByClient.get(d.client_id) ?? 0) + 1);
    }
    const activeSubsByClient = new Map<string, number>();
    for (const s of subsRes.data ?? []) {
      if (s.status === "active")
        activeSubsByClient.set(
          s.client_id,
          (activeSubsByClient.get(s.client_id) ?? 0) + 1,
        );
    }
    const balanceByClient = new Map<string, number>();
    for (const inv of invRes.data ?? []) {
      const owed = (inv.amount_cents ?? 0) - (inv.amount_paid_cents ?? 0);
      if (owed > 0)
        balanceByClient.set(
          inv.client_id,
          (balanceByClient.get(inv.client_id) ?? 0) + owed,
        );
    }

    return {
      clients: clients.map((c: any) => ({
        ...c,
        dog_count: dogsByClient.get(c.id) ?? 0,
        active_subscription_count: activeSubsByClient.get(c.id) ?? 0,
        outstanding_cents: balanceByClient.get(c.id) ?? 0,
      })),
    };
  });


const createClientSchema = z.object({
  displayName: z.string().min(1).max(200),
  accountType: z.enum(["residential", "commercial"]),
  primaryEmail: z.string().email().or(z.literal("")).optional(),
  primaryPhone: z.string().max(40).optional(),
});

export const createClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => createClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: row, error } = await supabase
      .from("clients")
      .insert({
        organization_id: orgId,
        display_name: data.displayName,
        account_type: data.accountType,
        primary_email: data.primaryEmail || null,
        primary_phone: data.primaryPhone || null,
      })
      .select("id, portal_token")
      .single();
    if (error) throw new Error(error.message);

    // Fire welcome email (best-effort; never block client creation)
    if (data.primaryEmail) {
      try {
        const appUrl = process.env.APP_URL || "https://pal-primer.lovable.app";
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: orgId,
          clientId: row.id as string,
          templateName: "welcome",
          notifyKey: "notify_email_welcome",
          idempotencyKey: `welcome-${row.id}`,
          templateData: {
            portalUrl: row.portal_token ? `${appUrl}/portal/${row.portal_token}` : undefined,
          },
        });
      } catch (e) {
        console.error("welcome email failed", e);
      }
    }
    return { id: row.id as string };
  });

const getClientSchema = z.object({ clientId: z.string().uuid() });

export const getClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error } = await supabase
      .from("clients")
      .select("id, display_name, account_type, primary_email, primary_phone, active, created_at, notes, portal_token, sms_opt_out, referral_code, referred_by_client_id, referral_applied_at, review_asked_at, review_submitted_at")
      .eq("id", data.clientId)
      .single();
    if (error) throw new Error(error.message);
    return { client };
  });
