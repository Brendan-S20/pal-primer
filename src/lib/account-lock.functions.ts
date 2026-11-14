import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AccountLock } from "@/lib/account-lock";
import type { AuthedContext } from "@/lib/server-fn-context";

// Is the caller's account locked (NP-12)? Read by the `_authenticated` layout
// before any page loads, so a locked account is sent to Plan & billing rather
// than shown a workspace whose every call will be refused.
export const getAccountLock = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadAccountLock(context));

/** getAccountLock's answer, also asked by getShellContext. */
export const loadAccountLock = createServerOnlyFn(
  async (context: AuthedContext): Promise<AccountLock & { canChoosePlan: boolean }> => {
    const { lockForUser } = await import("@/lib/account-lock.server");
    const { lock, orgId } = await lockForUser(context.userId);
    if (!orgId || !lock.locked) return { ...lock, canChoosePlan: true };
    const { resolveCaller } = await import("@/lib/authz.server");
    const { hasPermission } = await import("@/lib/permissions");
    const { role, overrides } = await resolveCaller(context.supabase, context.userId);
    return { ...lock, canChoosePlan: hasPermission(role, "manage_org_billing", overrides) };
  },
);
