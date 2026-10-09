// One HTTP call to Intuit, with the three things Intuit's app assessment asks
// about built in rather than left to each caller:
//
//   * RETRIES. 429 (throttled) and 5xx are retried with exponential backoff
//     and jitter, honouring Retry-After, up to QBO_MAX_ATTEMPTS in total. A 4xx
//     is the request's own fault (a validation error, a stale SyncToken, a
//     duplicate name): retrying it sends the same bad request again, so it is
//     thrown at once for the caller to record.
//   * intuit_tid. Intuit's transaction id for the call, from the response
//     header, is returned on success and carried on every error, so the sync
//     log can hand it to Intuit support.
//   * NOTHING SECRET IN AN ERROR. Messages are built from Intuit's fault code
//     and text, never from request headers or bodies, so a bearer token or the
//     Basic credential cannot end up in a log line or the sync log.

export const QBO_MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

export type QboErrorKind =
  | "validation" // 400 and other 4xx: the request itself is wrong; never retried
  | "auth" // 401: the access token was refused
  | "forbidden" // 403: the company or user may not do this
  | "not_found" // 404, or Intuit's "Object Not Found" fault (610)
  | "throttled" // 429 after every retry
  | "server" // 5xx after every retry
  | "network"; // no response at all, after every retry

export class QboApiError extends Error {
  readonly status: number;
  readonly intuitTid: string | null;
  readonly code: string | null;
  readonly kind: QboErrorKind;
  readonly attempts: number;
  constructor(p: {
    message: string;
    status: number;
    intuitTid: string | null;
    code: string | null;
    kind: QboErrorKind;
    attempts: number;
  }) {
    super(p.message);
    this.name = "QboApiError";
    this.status = p.status;
    this.intuitTid = p.intuitTid;
    this.code = p.code;
    this.kind = p.kind;
    this.attempts = p.attempts;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Milliseconds to wait before attempt `attempt + 1`. Retry-After (seconds)
 *  wins when Intuit sends it, capped so one header cannot stall a request. */
export function backoffMs(
  attempt: number,
  retryAfter: string | null,
  random: () => number = Math.random,
): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, MAX_RETRY_AFTER_MS);
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return exp + Math.floor(random() * 250);
}

/** Intuit's error bodies come in three shapes: the Accounting API's
 *  `{ Fault: { Error: [...] } }`, the same in lower case on some 401s, and the
 *  OAuth endpoints' `{ error, error_description }`. */
export function parseQboFault(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const b = body as Record<string, any>;
  const fault = b.Fault ?? b.fault;
  const err = fault?.Error?.[0] ?? fault?.error?.[0];
  if (err) {
    const code = err.code != null ? String(err.code) : null;
    const msg = [err.Message ?? err.message, err.Detail ?? err.detail].filter(Boolean).join(": ");
    return { code, message: msg || null };
  }
  if (typeof b.error === "string") {
    return { code: b.error, message: typeof b.error_description === "string" ? b.error_description : b.error };
  }
  return { code: null, message: null };
}

function kindFor(status: number, code: string | null): QboErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404 || code === "610") return "not_found";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return "validation";
}

export type QboHttpDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
};

export const realHttpDeps = (): QboHttpDeps => ({
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

export type QboHttpResult<T> = { body: T; status: number; intuitTid: string | null; attempts: number };

export async function qboHttp<T>(
  req: { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  deps: QboHttpDeps,
): Promise<QboHttpResult<T>> {
  let lastTid: string | null = null;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    } catch (e) {
      if (attempt < QBO_MAX_ATTEMPTS) {
        await deps.sleep(backoffMs(attempt, null, deps.random));
        continue;
      }
      throw new QboApiError({
        message: `QuickBooks could not be reached (${e instanceof Error ? e.name : "network error"})`,
        status: 0,
        intuitTid: lastTid,
        code: null,
        kind: "network",
        attempts: attempt,
      });
    }
    const tid = res.headers.get("intuit_tid");
    lastTid = tid ?? lastTid;
    if (res.ok) {
      const text = await res.text();
      return { body: (text ? JSON.parse(text) : {}) as T, status: res.status, intuitTid: tid, attempts: attempt };
    }
    if (isRetryableStatus(res.status) && attempt < QBO_MAX_ATTEMPTS) {
      await res.text().catch(() => "");
      await deps.sleep(backoffMs(attempt, res.headers.get("retry-after"), deps.random));
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      /* not JSON; the status says enough */
    }
    const fault = parseQboFault(parsed);
    throw new QboApiError({
      message: `QuickBooks ${res.status}${fault.code ? ` (${fault.code})` : ""}: ${(fault.message ?? res.statusText ?? "request failed").slice(0, 400)}`,
      status: res.status,
      intuitTid: tid,
      code: fault.code,
      kind: kindFor(res.status, fault.code),
      attempts: attempt,
    });
  }
}
