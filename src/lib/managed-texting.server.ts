// Server-only: site-r2-05. The facts `managedTextingState` is decided from,
// read with the service role so no credential or SID reaches a browser.

import {
  MANAGED_TEXTING_SLUG,
  managedTextingState,
  type ManagedTextingState,
} from "@/lib/managed-texting";
import type { RegistrationStatus } from "@/lib/texting-registration";

async function admin(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

/** Does the org hold the Managed texting add-on (an active org_platform_addons
 *  row for the managed-sms catalog entry)? */
export async function orgHoldsManagedTexting(orgId: string): Promise<boolean> {
  const db = await admin();
  const { data: addon } = await db
    .from("platform_addons")
    .select("id")
    .eq("slug", MANAGED_TEXTING_SLUG)
    .maybeSingle();
  if (!addon?.id) return false;
  const { data: held } = await db
    .from("org_platform_addons")
    .select("addon_id")
    .eq("organization_id", orgId)
    .eq("addon_id", addon.id)
    .eq("status", "active")
    .maybeSingle();
  return Boolean(held);
}

/** One business's texting state, as every screen shows it. */
export async function managedTextingStateFor(orgId: string): Promise<ManagedTextingState> {
  const db = await admin();
  const { orgCanTextClients } = await import("@/lib/twilio-credentials.server");
  const [live, subscribed, { data: reg }] = await Promise.all([
    orgCanTextClients(orgId),
    orgHoldsManagedTexting(orgId),
    db
      .from("org_texting_registrations")
      .select("status, updated_at")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);
  return managedTextingState({
    live,
    subscribed,
    registrationStatus: (reg?.status as RegistrationStatus | undefined) ?? null,
    registrationUpdatedAt: (reg?.updated_at as string | undefined) ?? null,
  });
}
