import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// #971: Settings → Texting shows the owner the filing's summary, samples and
// opt-in before Submit. The words are built in the browser by the same
// `filingCopy` the filing uses (lib/texting-filing-copy), from these facts
// and the business email the owner is typing. Nothing secret: a name, the
// service lines and two public links.
export const getTextingFilingContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { filingContextFor } = await import("@/lib/texting-filing.server");
    return filingContextFor(orgId);
  });
