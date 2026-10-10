// A scripted stand-in for Intuit's HTTP endpoints. No test that uses it can
// reach QuickBooks: every call must match the next scripted step, in order,
// or the test fails naming the URL it did not expect.

export type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

type Step = { match: RegExp; method?: "GET" | "POST"; respond: (call: Call) => Response };

export function reply(
  status: number,
  body: unknown,
  opts: { tid?: string | null; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.tid !== null) headers.intuit_tid = opts.tid ?? `tid-${status}`;
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers });
}

export function fakeIntuit() {
  const steps: Step[] = [];
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const step = steps.shift();
    if (!step) throw new Error(`fake Intuit: unexpected call ${call.method} ${url}`);
    if (!step.match.test(url) || (step.method && step.method !== call.method)) {
      throw new Error(`fake Intuit: expected ${step.method ?? ""} ${step.match}, got ${call.method} ${url}`);
    }
    return step.respond(call);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    pending: () => steps.length,
    on(match: RegExp, respond: Response | ((c: Call) => Response), method?: "GET" | "POST") {
      steps.push({ match, method, respond: typeof respond === "function" ? respond : () => respond.clone() });
      return this;
    },
    /** A network failure (no response at all). */
    drop(match: RegExp) {
      steps.push({
        match,
        respond: () => {
          throw new TypeError("fetch failed");
        },
      });
      return this;
    },
  };
}

export const SANDBOX_DISCOVERY = {
  issuer: "https://oauth.platform.intuit.com/op/v1",
  authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
  token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  userinfo_endpoint: "https://sandbox-accounts.platform.intuit.com/v1/openid_connect/userinfo",
};

export const DISCOVERY_URL = /developer\.api\.intuit\.com\/\.well-known\/openid_sandbox_configuration$/;
export const TOKEN_URL = /oauth\.platform\.intuit\.com\/oauth2\/v1\/tokens\/bearer$/;
export const REVOKE_URL = /developer\.api\.intuit\.com\/v2\/oauth2\/tokens\/revoke$/;
export const api = (path: string) =>
  new RegExp(`^https://sandbox-quickbooks\\.api\\.intuit\\.com/v3/company/4620816365/${path}`);
