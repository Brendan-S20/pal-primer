import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { isTestAccountEmail, type RatingPromptCounts } from "@/lib/rating-prompt";

/**
 * The two numbers the app-rating prompt decides on (src/lib/rating-prompt.ts),
 * for the signed-in person, and nothing else: head-only counts, so no invoice
 * or visit row ever leaves the database for this.
 *
 * Only the count that person's role is judged on is asked for. An owner or
 * office user is judged on the business's paid invoices; a technician on the
 * visits assigned to their own staff row (`visits.assigned_staff_id`, the
 * column My Day reads in getMyDay). A tech may not read invoices at all, so
 * asking would be a refused query rather than a zero.
 */
export const getRatingPromptCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RatingPromptCounts & { isTestAccount: boolean }> => {
    const { supabase, userId, claims } = context;
    const { orgId, role } = await resolveCaller(supabase, userId);
    const email = typeof claims?.email === "string" ? claims.email : null;
    let paidInvoiceCount = 0;
    let completedVisitCount = 0;

    if (role === "owner" || role === "office_manager" || role === "dispatcher") {
      const { count, error } = await supabase
        .from("invoices")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "paid");
      if (error) throw new Error(error.message);
      paidInvoiceCount = count ?? 0;
    } else if (role === "tech") {
      const { data: staff, error: staffErr } = await supabase
        .from("staff")
        .select("id")
        .eq("user_id", userId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (staffErr) throw new Error(staffErr.message);
      if (staff) {
        const { count, error } = await supabase
          .from("visits")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("assigned_staff_id", staff.id)
          .eq("status", "completed");
        if (error) throw new Error(error.message);
        completedVisitCount = count ?? 0;
      }
    }

    return {
      role,
      paidInvoiceCount,
      completedVisitCount,
      isTestAccount: isTestAccountEmail(email),
    };
  });
