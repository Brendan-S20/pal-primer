import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// The production dry run the owner reads before switching the deletion job on
// (NP-12). Platform admins only. Counts; never deletes, whatever the switches
// in src/lib/account-deletion.server.ts say.
export const previewAccountDeletion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await (context.supabase as any).rpc("is_platform_admin", {
      _user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Forbidden");
    const { runAccountDeletion } = await import("@/lib/account-deletion.server");
    const report = await runAccountDeletion({ forceDryRun: true });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;
    // What the job has already done, and the consent records it kept. Both are
    // here so the owner can see them in one place before and after switching
    // the job on.
    const [{ data: purges }, { data: consents }] = await Promise.all([
      admin
        .from("account_deletion_schedule")
        .select("organization_id, reason, purged_at, last_report")
        .not("purged_at", "is", null)
        .order("purged_at", { ascending: false })
        .limit(20),
      admin
        .from("sms_consent_records")
        .select("organization_id, subject, consent_at, consent_text, retain_until")
        .order("archived_at", { ascending: false })
        .limit(20),
    ]);
    return { report, recentPurges: purges ?? [], keptConsents: consents ?? [] };
  });
