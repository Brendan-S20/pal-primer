// A QuickBooks Accounting API client for one connected company.
//
// TOKENS. An access token lives one hour. Before every call the client
// refreshes it if it has less than REFRESH_SKEW_MS left, and on a 401 it
// refreshes once and repeats the call. Every refresh's result is handed to
// `persistTokens` straight away, because Intuit may ROTATE the refresh token:
// keeping the old one would strand the connection on its next refresh.
//
// When a refresh cannot work (invalid_grant, or the refresh token is past its
// own expiry) the client calls `markNeedsReconnect` and throws
// QboReconnectRequired. Syncing stops there; the settings page and the
// dashboard ask a person to reconnect.
//
// Every call's intuit_tid is kept on `lastIntuitTid` so the caller can write
// it into the sync log beside the outcome.

import { QBO_API_BASE, QBO_MINOR_VERSION } from "@/lib/qbo-config.server";
import { QboApiError, qboHttp } from "@/lib/qbo-http.server";
import {
  QboReconnectRequired,
  refreshQboTokens,
  type QboOAuthDeps,
  type QboTokens,
} from "@/lib/qbo-oauth.server";

export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type QboConnectionState = {
  id: string;
  realmId: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
};

export type QboClientDeps = QboOAuthDeps & {
  persistTokens: (connectionId: string, tokens: QboTokens) => Promise<void>;
  markNeedsReconnect: (
    connectionId: string,
    reason: QboReconnectRequired["reason"],
    intuitTid: string | null,
  ) => Promise<void>;
};

export class QboClient {
  private conn: QboConnectionState;
  private readonly deps: QboClientDeps;
  lastIntuitTid: string | null = null;
  /** Attempts the last call took (retries included), for the sync log. */
  lastAttempts = 0;

  constructor(conn: QboConnectionState, deps: QboClientDeps) {
    this.conn = { ...conn };
    this.deps = deps;
  }

  get connectionId(): string {
    return this.conn.id;
  }

  private async reconnect(reason: QboReconnectRequired["reason"], tid: string | null): Promise<never> {
    await this.deps.markNeedsReconnect(this.conn.id, reason, tid);
    throw new QboReconnectRequired(reason, tid);
  }

  /** Make sure the access token has more than REFRESH_SKEW_MS to run. `force`
   *  refreshes regardless (after a 401). */
  async ensureFreshToken(force = false): Promise<void> {
    const now = this.deps.now();
    const accessExp = this.conn.accessExpiresAt ? Date.parse(this.conn.accessExpiresAt) : 0;
    if (!force && this.conn.accessToken && accessExp - now > REFRESH_SKEW_MS) return;

    if (!this.conn.refreshToken) return this.reconnect("no_refresh_token", null);
    const refreshExp = this.conn.refreshExpiresAt ? Date.parse(this.conn.refreshExpiresAt) : Infinity;
    if (refreshExp <= now) return this.reconnect("refresh_expired", null);

    let tokens: QboTokens & { intuitTid: string | null };
    try {
      tokens = await refreshQboTokens(this.conn.refreshToken, this.deps);
    } catch (e) {
      if (e instanceof QboReconnectRequired) return this.reconnect(e.reason, e.intuitTid);
      throw e;
    }
    this.lastIntuitTid = tokens.intuitTid;
    const { intuitTid: _tid, ...rotated } = tokens;
    // Persisted before it is used: if the process dies after this line the
    // stored refresh token is still the one Intuit now expects.
    await this.deps.persistTokens(this.conn.id, rotated);
    this.conn = {
      ...this.conn,
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      accessExpiresAt: rotated.accessExpiresAt,
      refreshExpiresAt: rotated.refreshExpiresAt ?? this.conn.refreshExpiresAt,
    };
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(`${QBO_API_BASE[this.deps.environment]}/v3/company/${encodeURIComponent(this.conn.realmId)}/${path}`);
    u.searchParams.set("minorversion", String(QBO_MINOR_VERSION));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    await this.ensureFreshToken();
    for (let authTry = 0; ; authTry++) {
      try {
        const res = await qboHttp<T>(
          {
            url: this.url(path, opts.query),
            method,
            headers: {
              Authorization: `Bearer ${this.conn.accessToken}`,
              Accept: "application/json",
              ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          },
          this.deps,
        );
        this.lastIntuitTid = res.intuitTid;
        this.lastAttempts = res.attempts;
        return res.body;
      } catch (e) {
        if (e instanceof QboApiError) {
          this.lastIntuitTid = e.intuitTid;
          this.lastAttempts = e.attempts;
          if (e.kind === "auth") {
            // The token was refused though it had time left (revoked, or the
            // clock is off). Refresh once and repeat; a second 401 on a
            // brand-new token means the grant itself is gone.
            if (authTry === 0) {
              await this.ensureFreshToken(true);
              continue;
            }
            return this.reconnect("unauthorized", e.intuitTid);
          }
        }
        throw e;
      }
    }
  }

  /** A QuickBooks query (`select * from Customer where ...`). */
  query<T>(sql: string): Promise<{ QueryResponse?: T }> {
    return this.request("GET", "query", { query: { query: sql } });
  }
}

/** A string literal for a QuickBooks query. The query language quotes with
 *  single quotes and escapes them with a backslash. */
export function qboQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
