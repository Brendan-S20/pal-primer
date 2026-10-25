// Which service lines are live: the platform switch, read at runtime (#531).
//
// Server-only: import inside handlers with `await import(...)`. The one
// reader of public.service_line_availability() (migration 20261025200000).
// Every server path that asks "is this line bookable?" or "may a customer ask
// for it?" calls this; the browser reaches it through
// getServiceLineAvailability. Nothing in code holds the list, so a platform
// admin turns a line on or off without a new iOS or Android build.
//
// A read that fails throws, like any other read a decision depends on: a
// guess either way is wrong (a guessed "yes" sells a Coming soon line, a
// guessed "no" stops a business's signups).

import { serviceLineAvailabilityFromRows, type ServiceLineAvailability } from "@/lib/service-lines";

export async function loadServiceLineAvailability(): Promise<ServiceLineAvailability> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any).rpc("service_line_availability");
  if (error) throw new Error(error.message);
  return serviceLineAvailabilityFromRows(data);
}
