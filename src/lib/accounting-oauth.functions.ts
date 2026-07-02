import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const providerSchema = z.enum(["quickbooks", "xero"]);

async function getOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("staff")
    .select("org_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) throw new Error("No org membership");
  return data.org_id;
}

/**
 * Start an OAuth connect flow for QuickBooks Online or Xero.
 * Returns an authorization URL the browser should redirect to.
 * A short-lived `oauth_states` row ties the callback back to this org.
 */
export const startAccountingOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      provider: providerSchema,
      origin: z.string().url(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await getOrgId(supabase, userId);

    const clientId =
      data.provider === "quickbooks" ? process.env.QBO_CLIENT_ID : process.env.XERO_CLIENT_ID;
    if (!clientId) {
      throw new Error(
        `${data.provider === "quickbooks" ? "QBO_CLIENT_ID" : "XERO_CLIENT_ID"} is not configured. ` +
          `Register an OAuth app with the provider and add the client id/secret as project secrets.`,
      );
    }

    const redirectUri = `${data.origin}/api/public/hooks/${
      data.provider === "quickbooks" ? "qbo" : "xero"
    }-callback`;

    // random state, persisted so the callback can verify and locate the org
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: sErr } = await supabaseAdmin.from("oauth_states").insert({
      state,
      org_id: orgId,
      provider: data.provider,
      redirect_to: `${data.origin}/settings/accounting`,
    });
    if (sErr) throw new Error(sErr.message);

    if (data.provider === "quickbooks") {
      const scope = "com.intuit.quickbooks.accounting";
      const url = new URL("https://appcenter.intuit.com/connect/oauth2");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scope);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return { url: url.toString() };
    }

    // Xero
    const scope = [
      "offline_access",
      "openid",
      "profile",
      "email",
      "accounting.transactions",
      "accounting.contacts",
      "accounting.settings.read",
    ].join(" ");
    const url = new URL("https://login.xero.com/identity/connect/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    return { url: url.toString() };
  });
