import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RegistrationStatus } from "@/lib/texting-registration";

// site-r2-05: the admin/ops half of "Under review". A business that has
// added Managed texting and submitted its details waits here until a
// HoundStack admin presses Activate on /platform/addons. Texting switches on
// when both the admin and the carrier have approved, in either order
// (lib/managed-texting `shouldActivate`, lib/twilio-provisioning.server
// `opsActivateTexting`).
//
// Platform admins only, checked against is_platform_admin like every other
// /platform function. Never returns a SID, a token or an EIN.

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export type TextingReviewRow = {
  organizationId: string;
  businessName: string;
  legalName: string | null;
  status: RegistrationStatus;
  phoneNumber: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  opsApprovedAt: string | null;
  lastError: string | null;
};

export const listTextingReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: TextingReviewRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as any;
    const { data, error } = await db
      .from("org_texting_registrations")
      .select(
        "organization_id, status, legal_name, phone_number, submitted_at, approved_at, ops_approved_at, last_error",
      )
      .in("status", ["submitted", "in_review", "approved"])
      .order("submitted_at", { ascending: true });
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((r: any) => r.organization_id);
    if (!ids.length) return { rows: [] };
    const [{ data: live }, { data: orgs }] = await Promise.all([
      db.from("org_twilio_credentials").select("organization_id").in("organization_id", ids),
      db.from("organizations").select("id, name").in("id", ids),
    ]);
    const sending = new Set((live ?? []).map((r: any) => r.organization_id));
    const names = new Map((orgs ?? []).map((o: any) => [o.id, o.name as string]));
    return {
      rows: (data ?? [])
        // Already sending: no longer under review, nothing to do here.
        .filter((r: any) => !sending.has(r.organization_id))
        .map(
          (r: any): TextingReviewRow => ({
            organizationId: r.organization_id,
            businessName: names.get(r.organization_id) ?? r.legal_name ?? r.organization_id,
            legalName: r.legal_name ?? null,
            status: r.status,
            phoneNumber: r.phone_number ?? null,
            submittedAt: r.submitted_at ?? null,
            approvedAt: r.approved_at ?? null,
            opsApprovedAt: r.ops_approved_at ?? null,
            lastError: r.last_error ?? null,
          }),
        ),
    };
  });

export const activateTextingForOrg = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ organizationId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { opsActivateTexting, scrub } = await import("@/lib/twilio-provisioning.server");
    try {
      return await opsActivateTexting(data.organizationId, context.userId);
    } catch (e) {
      throw new Error(scrub((e as Error).message));
    }
  });
