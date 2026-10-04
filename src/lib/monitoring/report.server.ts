// Server-side error reporting for the Worker: a minimal Sentry client built on
// fetch.
//
// ── WHY NOT @sentry/cloudflare ────────────────────────────────────────────
//
// It wants to wrap the Worker's exported handler (`withSentry(env => opts,
// handler)`) and keeps per-request scope in AsyncLocalStorage. Here the
// exported handler is not ours: Nitro's cloudflare-module preset generates it
// and calls src/server.ts from inside, and the compatibility flags it would
// need are set by the Lovable wrapper, not by this repo. Wrapping something we
// do not control, with a dependency on flags we do not set, is the shape of
// fault this codebase keeps writing post-mortems about.
//
// What the owner asked for is "tell me when something breaks", and that is
// one HTTP POST of a JSON envelope. Every report goes through the same
// policy.scrubEvent the browser uses, so the two cannot disagree about what is
// personal.
//
// ── ON IN PRODUCTION, OFF IN DEV AND TEST ─────────────────────────────────
//
// ./config.ts decides, from SENTRY_DSN (runtime) and the build's mode: a
// production build reports to the HoundStack project by default, SENTRY_DSN
// = "off" silences it, and dev and vitest send nothing. When it is off every
// export here returns before doing anything: no fetch, no log line.
//
// ── WHERE IT IS CALLED FROM ───────────────────────────────────────────────
//
//   * src/start.ts, function middleware: every server function, unexpected
//     exceptions only (policy.isExpectedError decides).
//   * src/start.ts, request middleware: anything thrown out of SSR or a
//     server route, and any 5xx answered by /api/public/hooks/*.
//   * src/server.ts: the catastrophic path, where h3 swallowed the throw.
//   * the outer catch of the Stripe and announcement-email hooks, where the
//     exception behind the 500 is known.

import { resolveDsn } from "./config";
import { isExpectedError, scrubEvent, scrubText, type ScrubbableEvent } from "./policy";

type Level = "fatal" | "error" | "warning" | "info";

export type ReportContext = {
  /** The request being handled, for its URL, method and signed-in user. */
  request?: Request | null;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  level?: Level;
  /** Send even if policy says the error is expected: the handler knows it
   *  answered 500 whatever the message says, or it is the test button. */
  force?: boolean;
};

export function serverDsn(): string {
  return resolveDsn({
    explicit: typeof process !== "undefined" ? process.env.SENTRY_DSN : undefined,
    prod: import.meta.env.PROD === true,
    mode: import.meta.env.MODE,
  });
}

export type ParsedDsn = { endpoint: string; publicKey: string; dsn: string };

/** `https://<key>@<host>[/<path>]/<project>` to the envelope endpoint. */
export function parseDsn(dsn: string): ParsedDsn | null {
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    return null;
  }
  const publicKey = decodeURIComponent(u.username);
  const parts = u.pathname.split("/").filter(Boolean);
  const projectId = parts.pop();
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const prefix = parts.length ? `/${parts.join("/")}` : "";
  const endpoint =
    `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/` +
    `?sentry_key=${encodeURIComponent(publicKey)}&sentry_version=7&sentry_client=houndstack-worker%2F1`;
  return { endpoint, publicKey, dsn };
}

// ── Stack traces ─────────────────────────────────────────────────────────

type Frame = {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
};

/** V8's `at fn (file:line:col)` / `at file:line:col`, oldest frame first,
 *  which is the order Sentry expects. */
export function parseStack(stack: string | undefined): Frame[] {
  if (typeof stack !== "string") return [];
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const m =
      /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line) ?? /^at (.+?) \((.+?)\)$/.exec(line);
    if (!m) continue;
    const [, fn, file, ln, col] = m;
    frames.push({
      function: fn || "?",
      filename: file,
      ...(ln ? { lineno: Number(ln) } : {}),
      ...(col ? { colno: Number(col) } : {}),
      in_app: !!file && !/node_modules|^node:|^internal\//.test(file),
    });
    if (frames.length >= 50) break;
  }
  return frames.reverse();
}

// ── Building an event ────────────────────────────────────────────────────

function eventId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** The signed-in user's id from the request's bearer token, unverified. It is
 *  a label on an event, not an authorization decision, so it does not need
 *  checking; and only `sub` is read, never the email claim beside it. */
export function userIdFromRequest(request: Request | null | undefined): string | null {
  const auth = request?.headers?.get?.("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return typeof json?.sub === "string" && json.sub ? json.sub : null;
  } catch {
    return null;
  }
}

type ExceptionValue = { type: string; value: string; stacktrace?: { frames: Frame[] } };

function exceptionValue(err: unknown): ExceptionValue {
  if (err instanceof Error || (err && typeof err === "object" && "message" in err)) {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown };
    const frames = parseStack(typeof e.stack === "string" ? e.stack : undefined);
    return {
      type: typeof e.name === "string" && e.name ? e.name : "Error",
      value: typeof e.message === "string" ? e.message : String(e.message),
      ...(frames.length ? { stacktrace: { frames } } : {}),
    };
  }
  let value: string;
  try {
    value = typeof err === "string" ? err : (JSON.stringify(err) ?? String(err));
  } catch {
    value = String(err);
  }
  return { type: "NonErrorThrown", value };
}

function runtimeTag(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return ua === "Cloudflare-Workers" ? "cloudflare-workers" : "node";
}

export function buildServerEvent(
  input: { error?: unknown; message?: string },
  ctx: ReportContext = {},
): ScrubbableEvent & Record<string, unknown> {
  const request = ctx.request ?? null;
  const userId = userIdFromRequest(request);
  const release = import.meta.env.VITE_SENTRY_RELEASE;
  const envOverride =
    typeof process !== "undefined" ? process.env.SENTRY_ENVIRONMENT?.trim() : undefined;

  const values: ExceptionValue[] = [];
  if (input.error !== undefined) {
    // One level of `cause`, oldest first, so "Upload failed" shows what it
    // wrapped.
    const cause = (input.error as { cause?: unknown } | null)?.cause;
    if (cause !== undefined && cause !== null) values.push(exceptionValue(cause));
    values.push(exceptionValue(input.error));
  }

  let url: URL | null = null;
  try {
    url = request?.url ? new URL(request.url) : null;
  } catch {
    url = null;
  }

  const event: ScrubbableEvent & Record<string, unknown> = {
    event_id: eventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    logger: "server",
    level: ctx.level ?? "error",
    environment:
      envOverride || (import.meta.env.MODE === "production" ? "production" : "development"),
    ...(typeof release === "string" && release ? { release } : {}),
    tags: { platform: "server", runtime: runtimeTag(), ...(ctx.tags ?? {}) },
    ...(ctx.extra ? { extra: ctx.extra } : {}),
    ...(userId ? { user: { id: userId } } : {}),
    ...(request
      ? { request: { ...(url ? { url: url.toString() } : {}), method: request.method } }
      : {}),
    ...(values.length ? { exception: { values } } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(url ? { transaction: `${request?.method ?? "GET"} ${url.pathname}` } : {}),
  };
  return scrubEvent(event);
}

export function serializeEnvelope(event: Record<string, unknown>, dsn: string): string {
  const payload = JSON.stringify(event);
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn,
  });
  const item = JSON.stringify({ type: "event", content_type: "application/json" });
  return `${header}\n${item}\n${payload}`;
}

// ── Sending ──────────────────────────────────────────────────────────────

// One report per error object and per request. The same throw passes the
// function middleware, the request middleware and src/server.ts on its way
// out; it should arrive once.
const reportedErrors = new WeakSet<object>();
const reportedRequests = new WeakSet<Request>();

/** Has something already been reported while handling this request? */
export function requestWasReported(request: Request | null | undefined): boolean {
  return !!request && reportedRequests.has(request);
}

const SEND_TIMEOUT_MS = 2_000;

async function send(
  event: Record<string, unknown>,
  parsed: ParsedDsn,
  request?: Request | null,
): Promise<void> {
  const body = serializeEnvelope(event, parsed.dsn);
  const attempt = (async () => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS) : null;
    try {
      await fetch(parsed.endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
        body,
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch {
      // Monitoring is best-effort and never becomes the error.
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  // On Cloudflare, Nitro puts the Worker's ExecutionContext.waitUntil on the
  // incoming Request (nitro's cloudflare `augmentReq`). With it the response
  // is not held up by the report; without it (Node in dev, or a request object
  // that is not the original) the report is awaited, which only ever costs
  // time on a request that has already failed.
  const waitUntil = (request as unknown as { waitUntil?: (p: Promise<unknown>) => void } | null)
    ?.waitUntil;
  if (typeof waitUntil === "function") {
    try {
      waitUntil.call(request, attempt);
      return;
    } catch {
      /* fall through and await */
    }
  }
  await attempt;
}

/** Report an exception, unless it is expected (see policy.isExpectedError) or
 *  already reported. Never throws, never logs. */
export async function reportServerError(error: unknown, ctx: ReportContext = {}): Promise<void> {
  const dsn = serverDsn();
  if (!dsn) return;
  if (!ctx.force && isExpectedError(error)) return;
  if (error && typeof error === "object") {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  const parsed = parseDsn(dsn);
  if (!parsed) return;
  if (ctx.request) reportedRequests.add(ctx.request);
  try {
    await send(buildServerEvent({ error }, ctx), parsed, ctx.request);
  } catch {
    /* best-effort */
  }
}

/** Report something that is not an exception: a hook that answered 500. */
export async function reportServerMessage(message: string, ctx: ReportContext = {}): Promise<void> {
  const dsn = serverDsn();
  if (!dsn) return;
  const parsed = parseDsn(dsn);
  if (!parsed) return;
  if (ctx.request) reportedRequests.add(ctx.request);
  try {
    await send(buildServerEvent({ message: scrubText(message) }, ctx), parsed, ctx.request);
  } catch {
    /* best-effort */
  }
}

/** Used by src/start.ts: a cron or webhook endpoint answered 5xx and nothing
 *  has reported the exception behind it. Reads at most 300 characters of a
 *  text body for the event, because that is usually where the reason is. */
export async function reportFailedHookResponse(
  request: Request,
  response: Response,
): Promise<void> {
  if (!serverDsn()) return;
  if (response.status < 500) return;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return;
  }
  if (!pathname.startsWith("/api/public/hooks/")) return;
  if (requestWasReported(request)) return;
  let excerpt = "";
  try {
    const type = response.headers.get("content-type") ?? "";
    if (!type || /json|text/.test(type)) excerpt = (await response.clone().text()).slice(0, 300);
  } catch {
    excerpt = "";
  }
  await reportServerMessage(`${pathname} answered ${response.status}`, {
    request,
    tags: { hook: pathname.slice("/api/public/hooks/".length) || "/" },
    ...(excerpt ? { extra: { body: excerpt } } : {}),
  });
}

/** For the platform admin's test button: one event, sent whatever policy
 *  says. Returns whether monitoring is on, so the button can say so. */
export async function sendServerTestError(request: Request | null): Promise<boolean> {
  if (!serverDsn()) return false;
  const err = new Error("HoundStack server test error, sent on purpose from /platform/health");
  err.name = "MonitoringTestError";
  await reportServerError(err, { request, force: true, tags: { test_event: "yes" } });
  return true;
}
