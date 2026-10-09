// The QuickBooks OAuth callback, as a function of its inputs so the CSRF and
// error paths can be tested without Intuit or a database. The route
// (src/routes/api/public/hooks/qbo-callback.ts) supplies the real ones.
//
// Every outcome is a redirect back to Settings → Accounting: success as
// `?connected=quickbooks`, failure as `?qbo_error=<code>`, which the page turns
// into a sentence (QBO_CALLBACK_ERRORS). Nothing Intuit sent is echoed.

import {
  checkOAuthState,
  QBO_CALLBACK_PATH,
  type OAuthStateRow,
  type QboCallbackError,
} from "@/lib/qbo-redirect";
import { QboReconnectRequired, type QboTokens } from "@/lib/qbo-oauth.server";
import { QboApiError } from "@/lib/qbo-http.server";

export type QboCallbackDeps = {
  now: () => number;
  configured: boolean;
  /** Read AND delete the state row in one statement: single use even if the
   *  callback is hit twice at once. */
  consumeState: (state: string) => Promise<OAuthStateRow | null>;
  exchange: (p: { code: string; redirectUri: string }) => Promise<QboTokens & { intuitTid: string | null }>;
  saveGrant: (orgId: string, realmId: string, tokens: QboTokens) => Promise<void>;
};

export async function handleQboCallback(requestUrl: string, deps: QboCallbackDeps): Promise<Response> {
  const url = new URL(requestUrl);
  const back = (q: string) =>
    new Response(null, { status: 302, headers: { Location: `${url.origin}/settings/accounting?${q}` } });
  const fail = (code: QboCallbackError) => back(`qbo_error=${code}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const error = url.searchParams.get("error");

  // The state is consumed even when Intuit reports an error, so a cancelled
  // attempt's state cannot be replayed.
  const row = state ? await deps.consumeState(state) : null;

  if (error) return fail(error === "access_denied" ? "access_denied" : "token_exchange");
  if (!code || !state || !realmId || !/^\d{1,32}$/.test(realmId)) return fail("missing_params");

  const verdict = checkOAuthState(row, deps.now());
  if (verdict !== "ok") return fail(verdict);
  if (!deps.configured) {
    console.error("qbo-callback: QuickBooks OAuth credentials are not configured");
    return fail("not_configured");
  }

  let tokens: QboTokens & { intuitTid: string | null };
  try {
    tokens = await deps.exchange({ code, redirectUri: `${url.origin}${QBO_CALLBACK_PATH}` });
  } catch (e) {
    // Status, Intuit's code and intuit_tid only. Never the response body,
    // never the request (it carries the client secret).
    if (e instanceof QboApiError) console.error("qbo-callback: token exchange failed", e.status, e.code, e.intuitTid);
    else if (e instanceof QboReconnectRequired) console.error("qbo-callback: token exchange refused", e.reason, e.intuitTid);
    else console.error("qbo-callback: token exchange failed", e instanceof Error ? e.name : "error");
    return fail("token_exchange");
  }

  try {
    const { intuitTid: _tid, ...grant } = tokens;
    await deps.saveGrant(row!.org_id, realmId, grant);
  } catch (e) {
    console.error("qbo-callback: saving the connection failed", e instanceof Error ? e.message : "error");
    return fail("save_failed");
  }
  return back("connected=quickbooks");
}
