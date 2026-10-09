// QuickBooks OAuth 2.0: the discovery document, the authorize URL, and the
// three token calls (exchange a code, refresh, revoke).
//
// Every endpoint comes from Intuit's discovery document for the environment
// QBO_ENVIRONMENT selects, cached in memory for a day. If a refresh of the
// document fails, the last good copy is used rather than failing every sync;
// with no copy at all the call fails.

import {
  QBO_DISCOVERY_URL,
  QBO_SCOPE,
  type QboCredentials,
  type QboEnvironment,
} from "@/lib/qbo-config.server";
import { QboApiError, qboHttp, type QboHttpDeps } from "@/lib/qbo-http.server";

export type QboDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
};

export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const discoveryCache = new Map<QboEnvironment, { doc: QboDiscovery; fetchedAt: number }>();

export function resetQboDiscoveryCache(): void {
  discoveryCache.clear();
}

/** An endpoint the client secret is sent to must be Intuit's, over https. A
 *  tampered or mis-served document must not be able to point the token call
 *  anywhere else. */
function intuitHttps(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Intuit discovery document has no ${field}`);
  const u = new URL(value);
  if (u.protocol !== "https:" || !(u.hostname === "intuit.com" || u.hostname.endsWith(".intuit.com"))) {
    throw new Error(`Intuit discovery document ${field} is not an intuit.com https URL`);
  }
  return value;
}

export async function qboDiscovery(
  environment: QboEnvironment,
  deps: QboHttpDeps & { now?: () => number },
): Promise<QboDiscovery> {
  const now = deps.now?.() ?? Date.now();
  const hit = discoveryCache.get(environment);
  if (hit && now - hit.fetchedAt < DISCOVERY_TTL_MS) return hit.doc;
  try {
    const { body } = await qboHttp<Record<string, unknown>>(
      { url: QBO_DISCOVERY_URL[environment], method: "GET", headers: { Accept: "application/json" } },
      deps,
    );
    const doc: QboDiscovery = {
      issuer: String(body.issuer ?? ""),
      authorization_endpoint: intuitHttps(body.authorization_endpoint, "authorization_endpoint"),
      token_endpoint: intuitHttps(body.token_endpoint, "token_endpoint"),
      revocation_endpoint: intuitHttps(body.revocation_endpoint, "revocation_endpoint"),
    };
    discoveryCache.set(environment, { doc, fetchedAt: now });
    return doc;
  } catch (e) {
    if (hit) {
      console.warn("qbo: discovery refresh failed; using the cached document");
      return hit.doc;
    }
    throw e;
  }
}

export function qboAuthorizeUrl(
  discovery: QboDiscovery,
  p: { clientId: string; redirectUri: string; state: string },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QBO_SCOPE);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("state", p.state);
  return url.toString();
}

export type QboTokens = {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working (Intuit: one hour). */
  accessExpiresAt: string;
  /** When the refresh token stops working (Intuit: up to five years, but the
   *  figure is per token and can shrink, so it is read from every response). */
  refreshExpiresAt: string | null;
};

/** The connection can no longer get an access token by itself; a person has
 *  to connect again. `reason` is stored on the connection and shown. */
export class QboReconnectRequired extends Error {
  readonly reason: "invalid_grant" | "refresh_expired" | "no_refresh_token" | "unauthorized";
  readonly intuitTid: string | null;
  constructor(reason: QboReconnectRequired["reason"], intuitTid: string | null = null) {
    super(
      reason === "refresh_expired"
        ? "The QuickBooks connection has expired. Reconnect QuickBooks to keep syncing."
        : "QuickBooks no longer accepts this connection. Reconnect QuickBooks to keep syncing.",
    );
    this.name = "QboReconnectRequired";
    this.reason = reason;
    this.intuitTid = intuitTid;
  }
}

export type QboOAuthDeps = QboHttpDeps & {
  now: () => number;
  environment: QboEnvironment;
  credentials: QboCredentials;
};

function basicAuth(c: QboCredentials): string {
  return `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
};

export function tokensFromResponse(tok: TokenResponse, now: number): QboTokens {
  if (!tok.access_token || !tok.refresh_token) {
    throw new Error("Intuit's token response had no access or refresh token");
  }
  const accessSecs = Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 3600;
  const refreshSecs = Number(tok.x_refresh_token_expires_in);
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    accessExpiresAt: new Date(now + accessSecs * 1000).toISOString(),
    refreshExpiresAt: refreshSecs > 0 ? new Date(now + refreshSecs * 1000).toISOString() : null,
  };
}

async function tokenCall(
  params: Record<string, string>,
  deps: QboOAuthDeps,
): Promise<QboTokens & { intuitTid: string | null }> {
  const discovery = await qboDiscovery(deps.environment, deps);
  try {
    const res = await qboHttp<TokenResponse>(
      {
        url: discovery.token_endpoint,
        method: "POST",
        headers: {
          Authorization: basicAuth(deps.credentials),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(params).toString(),
      },
      deps,
    );
    return { ...tokensFromResponse(res.body, deps.now()), intuitTid: res.intuitTid };
  } catch (e) {
    // invalid_grant: the code or refresh token is expired, revoked, or was
    // already used. Nothing a retry can fix; a person must connect again.
    if (e instanceof QboApiError && e.code === "invalid_grant") {
      throw new QboReconnectRequired("invalid_grant", e.intuitTid);
    }
    throw e;
  }
}

export function exchangeQboCode(p: { code: string; redirectUri: string }, deps: QboOAuthDeps) {
  return tokenCall({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri }, deps);
}

export function refreshQboTokens(refreshToken: string, deps: QboOAuthDeps) {
  return tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken }, deps);
}

/** Revoking the refresh token revokes the access token issued with it. */
export async function revokeQboToken(
  token: string,
  deps: QboOAuthDeps,
): Promise<{ intuitTid: string | null }> {
  const discovery = await qboDiscovery(deps.environment, deps);
  const res = await qboHttp<unknown>(
    {
      url: discovery.revocation_endpoint,
      method: "POST",
      headers: {
        Authorization: basicAuth(deps.credentials),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token }),
    },
    deps,
  );
  return { intuitTid: res.intuitTid };
}
