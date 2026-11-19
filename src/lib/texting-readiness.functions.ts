import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TextingReadiness } from "@/lib/texting-readiness";

// #1003: Platform > Add-ons "Texting readiness". Platform admins only, checked
// against is_platform_admin like every other /platform function. Returns
// Set/Missing booleans and a profile status; never a setting's value.

type RpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

async function assertPlatformAdmin(supabase: RpcClient, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export const getTextingReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TextingReadiness> => {
    await assertPlatformAdmin(context.supabase as unknown as RpcClient, context.userId);
    const { computeTextingReadiness } = await import("@/lib/texting-readiness.server");
    return computeTextingReadiness();
  });
