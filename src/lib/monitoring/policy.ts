// What error monitoring is allowed to send, and what it should not bother
// sending. Shared by the browser (src/lib/monitoring/client.ts) and the Worker
// (src/lib/monitoring/report.server.ts) so the two cannot drift: one scrubber,
// one idea of "expected", tested once (tests/error-monitoring.test.ts).
//
// Pure functions only. No Sentry import, no environment reads, nothing that
// can only run in one runtime.
//
// ── WHAT LEAVES THE BUILDING ──────────────────────────────────────────────
//
// The people in these events are a small business owner, their technicians and
// their customers. A Sentry event is a copy of a moment in somebody's working
// day sent to a third party, so the rule is "only what a developer needs to
// find the bug":
//
//   * The user is an id and an org id. Never an email, a name or an IP.
//   * No cookies, no request headers (bar User-Agent, which is how Sentry
//     knows the browser and OS), no request body, no query string.
//   * A URL keeps its path, with every token-bearing segment replaced. The
//     portal, pay, quote, tracking, invite and calendar links are all
//     bearer credentials in the path; any one of them in an event would let
//     whoever reads Sentry act as that customer.
//   * Free text (messages, exception values, breadcrumbs) has emails, phone
//     numbers, JWTs, bearer tokens and API keys masked, because a database
//     error or a thrown message can quote a value it was handed.
//
// Form field values are never collected in the first place: no session
// replay, no DOM breadcrumbs, no console breadcrumbs (see sentry-browser.ts).

// ── URLs ─────────────────────────────────────────────────────────────────

/** Path shapes whose segments are credentials: the segments to match, and
 *  which of the segments after them to mask. Kept in step with the `$token`
 *  routes under src/routes (tests/error-monitoring.test.ts checks that every
 *  such route is covered). */
const TOKEN_PATHS: Array<{ prefix: string[]; mask: number[] }> = [
  // /portal/:slug/:token/...  (the slug is public, the token is the session)
  { prefix: ["portal"], mask: [1] },
  // /pay/i/:token
  { prefix: ["pay", "i"], mask: [0] },
  // /q/:token (a quote someone was sent)
  { prefix: ["q"], mask: [0] },
  // /track/:token (live tracking link)
  { prefix: ["track"], mask: [0] },
  // /invite/:token
  { prefix: ["invite"], mask: [0] },
  // /api/public/calendar/:token (an .ics feed a phone subscribes to)
  { prefix: ["api", "public", "calendar"], mask: [0] },
];

const TOKEN_PLACEHOLDER = "[token]";

function maskPath(pathname: string): string {
  const segs = pathname.split("/");
  // segs[0] is "" for an absolute path.
  const absolute = segs[0] === "";
  const body = absolute ? segs.slice(1) : segs;
  for (const rule of TOKEN_PATHS) {
    if (body.length <= rule.prefix.length) continue;
    if (!rule.prefix.every((p, i) => body[i] === p)) continue;
    for (const offset of rule.mask) {
      const i = rule.prefix.length + offset;
      if (i < body.length && body[i] !== "") body[i] = TOKEN_PLACEHOLDER;
    }
    break;
  }
  return (absolute ? "/" : "") + body.join("/");
}

/** A URL with its query string and fragment removed and its token segments
 *  masked. Accepts absolute URLs and bare paths; anything unparseable comes
 *  back with everything after `?` or `#` cut, which is the part that matters. */
export function scrubUrl(input: string): string {
  if (typeof input !== "string" || input === "") return input;
  const cut = input.split(/[?#]/, 1)[0];
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i.exec(cut);
  if (m) return m[1] + maskPath(m[2] ?? "");
  if (cut.startsWith("/")) return maskPath(cut);
  return cut;
}

// ── Free text ────────────────────────────────────────────────────────────

const TEXT_RULES: Array<[RegExp, string | ((s: string) => string)]> = [
  // URLs first, so a token inside one is handled by the path rules rather
  // than half-matched by the ones below.
  [/\b(?:https?|capacitor):\/\/[^\s"'<>)]+/gi, (u) => scrubUrl(u)],
  [/\/(?:portal|pay\/i|q|track|invite|api\/public\/calendar)\/[^\s"'<>)]+/g, (p) => scrubUrl(p)],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [token]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[jwt]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[key]"],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, "[key]"],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, "[key]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // Phone numbers in the shapes this product stores and people type: E.164,
  // and North American with separators or as a bare 10/11-digit run. Kept
  // narrow on purpose: a looser "nine digits with separators" rule also ate
  // dates ("2026-10-03 12") and the last group of every UUID, which are
  // exactly what a developer reads an error for.
  [/\+\d{8,15}\b/g, "[phone]"],
  [/(?<![\w-])\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?![\w-])/g, "[phone]"],
  [/(?<![\w-])1?\d{10}(?![\w-])/g, "[phone]"],
];

/** Mask the personal and secret values a message can carry. */
export function scrubText(input: string): string {
  if (typeof input !== "string" || input === "") return input;
  let out = input;
  for (const [re, rep] of TEXT_RULES) {
    out = typeof rep === "string" ? out.replace(re, rep) : out.replace(re, rep);
  }
  return out;
}

// ── Identity ─────────────────────────────────────────────────────────────

export type MonitoringIdentity = { userId: string; orgId?: string | null };

/** The only user object an event may carry. Built from ids alone, so a caller
 *  that hands over a whole profile still sends nothing else. */
export function identityUser(
  identity: MonitoringIdentity | null | undefined,
): { id: string } | null {
  if (!identity || typeof identity.userId !== "string" || identity.userId === "") return null;
  return { id: identity.userId };
}

// ── The event ────────────────────────────────────────────────────────────

/** The parts of a Sentry event this file touches. Structural, so the server's
 *  hand-built events and the browser SDK's both fit without importing it. */
export type ScrubbableEvent = {
  message?: unknown;
  user?: Record<string, unknown> | null;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    env?: unknown;
  } | null;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: Array<{ vars?: unknown; abs_path?: string; filename?: string }>;
      };
    }>;
  } | null;
  breadcrumbs?: Array<{
    category?: string;
    message?: string;
    data?: Record<string, unknown>;
  }> | null;
  tags?: Record<string, unknown> | null;
  extra?: Record<string, unknown> | null;
  contexts?: Record<string, unknown> | null;
  transaction?: string;
  server_name?: string;
};

/** Breadcrumb data keys that hold a URL. */
const URL_KEYS = ["url", "from", "to"];

/** Keys whose value is personal or secret whatever it looks like: a name does
 *  not match any pattern, so the key is the only thing that gives it away. */
const PERSONAL_KEYS =
  /^(?:e-?mail|name|first_?name|last_?name|full_?name|display_?name|customer_?name|client_?name|phone|phone_?number|mobile|address|street|username|ip_?address|password|token|secret|cookie|authorization)$/i;

/** Scrub every string in a value. With `dropPersonalKeys`, also drop keys in
 *  PERSONAL_KEYS. Off for `contexts`, where `name` is the browser's or the
 *  OS's ("Chrome", "iOS") and dropping it would lose the one fact a
 *  device-specific bug needs. */
function scrubValue(v: unknown, dropPersonalKeys: boolean, depth = 0): unknown {
  if (typeof v === "string") return scrubText(v);
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, dropPersonalKeys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (dropPersonalKeys && PERSONAL_KEYS.test(k)) continue;
    out[k] = scrubValue(val, dropPersonalKeys, depth + 1);
  }
  return out;
}

/** Strip everything personal from an event, in place, and return it. */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  // User: the id survives, nothing else. Sentry's own fields (email,
  // username, ip_address) and anything a future caller adds are all dropped.
  if (event.user) {
    const id = typeof event.user.id === "string" ? event.user.id : undefined;
    event.user = id ? { id } : null;
  }

  if (event.request) {
    const r = event.request;
    const ua = r.headers
      ? Object.entries(r.headers).find(([k]) => k.toLowerCase() === "user-agent")?.[1]
      : undefined;
    event.request = {
      ...(r.url ? { url: scrubUrl(r.url) } : {}),
      ...(r.method ? { method: r.method } : {}),
      ...(ua ? { headers: { "User-Agent": ua } } : {}),
    };
  }

  if (typeof event.message === "string") {
    event.message = scrubText(event.message);
  } else if (event.message && typeof event.message === "object") {
    const m = event.message as { message?: string; formatted?: string };
    if (typeof m.message === "string") m.message = scrubText(m.message);
    if (typeof m.formatted === "string") m.formatted = scrubText(m.formatted);
  }

  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === "string") ex.value = scrubText(ex.value);
    for (const f of ex.stacktrace?.frames ?? []) {
      // Local variables would be the whole of somebody's form.
      delete f.vars;
      if (typeof f.abs_path === "string") f.abs_path = scrubUrl(f.abs_path);
      if (typeof f.filename === "string") f.filename = scrubUrl(f.filename);
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      // A click or keypress breadcrumb names the element by its attributes,
      // and an aria-label can be a customer's name. Never collected (dom:
      // false), and dropped here too in case a later change turns it on.
      .filter((b) => !(b.category ?? "").startsWith("ui."))
      .map((b) => {
        const data = b.data ? { ...b.data } : undefined;
        if (data) {
          for (const key of URL_KEYS) {
            if (typeof data[key] === "string") data[key] = scrubUrl(data[key] as string);
          }
        }
        return {
          ...b,
          ...(typeof b.message === "string" ? { message: scrubText(b.message) } : {}),
          ...(data ? { data: scrubValue(data, true) as Record<string, unknown> } : {}),
        };
      });
  }

  if (event.extra) event.extra = scrubValue(event.extra, true) as Record<string, unknown>;
  if (event.tags) event.tags = scrubValue(event.tags, true) as Record<string, unknown>;
  // Strings only: see scrubValue on why `name` survives here.
  if (event.contexts) event.contexts = scrubValue(event.contexts, false) as Record<string, unknown>;
  if (typeof event.transaction === "string") event.transaction = scrubUrl(event.transaction);
  // The Worker's hostname is meaningless and the browser's is the device's.
  delete event.server_name;
  return event;
}

// ── Expected or not ──────────────────────────────────────────────────────
//
// Server functions throw `new Error("...")` for two very different reasons,
// and monitoring only wants one of them:
//
//   * A deliberate refusal the user is meant to read: "Not authorized",
//     "Invoice already paid", "Client not found", a zod validation failure.
//     Those are the product working. Reporting them would bury the real
//     faults under every double-click.
//   * A fault: `throw new Error(error.message)` after a Supabase call (443 of
//     the ~1,200 throws in src/ are exactly that), a TypeError, a failed
//     fetch to Stripe or QuickBooks, a missing secret.
//
// Both are plain `Error`, so the class cannot tell them apart. What can is the
// MESSAGE, because the two are written by different authors. Our copy is a
// sentence: it starts with a capital and reads like one. Postgres and PostgREST
// write lowercase diagnostics ("duplicate key value violates unique
// constraint", "permission denied for table invoices", "new row violates
// row-level security policy") or a handful of fixed capitalised ones that are
// listed below. Measured against the codebase on 2026-10-03: of the 305
// distinct literal messages thrown in src/, 14 start lowercase, and every one
// of those is a programmer error that SHOULD be reported (a hook used outside
// its provider) or a wrapped database failure.
//
// So: lowercase is a fault, a sentence is a refusal, unless it says it failed.
// It is a heuristic and is wrong at the edges; the tests pin the cases that
// matter, and a deliberate refusal that leaks through shows up in Sentry as a
// single grouped issue, which is cheap to ignore and cheap to add here.

/** Classes thrown on purpose, with a message written for the user. Matched by
 *  `name` or `code` as well as the constructor, because a bundler may rename
 *  classes. */
const EXPECTED_NAMES = new Set([
  "ZodError",
  "AiGenerationError",
  "PlanUpgradeRequiredError",
  "ImpersonationExpiredError",
  "RefundRefused",
  "TipRefused",
  "PlanMirrorRefusal",
  "HostDidNotResolve",
  "MissingPhotoError",
  // Stripe: a declined card is the customer's bank answering, not a bug.
  "StripeCardError",
]);
const EXPECTED_CODES = new Set(["PORTAL_PREVIEW_READ_ONLY", "PORTAL_VERIFICATION_REQUIRED"]);

/** Always a refusal, whatever the case: auth, tenancy and lookups, including
 *  the lowercase spellings some SQL functions raise ("forbidden", "visit not
 *  found"). Postgres's own GRANT and RLS failures are NOT here: "permission
 *  denied for table x" is a missing grant, which is a fault. */
const ALWAYS_EXPECTED: RegExp[] = [
  /^(?:not authori[sz]ed|unauthori[sz]ed|forbidden|not authenticated)\b/i,
  /^[\w\s'".-]{1,60}\bnot found\.?$/i,
  /^PLAN_UPGRADE_REQUIRED\b/,
  /^PORTAL_VERIFICATION_REQUIRED$/,
  /^invalid portal (?:token|link)\b/i,
  /\bnot in (?:this |the )?org(?:anization)?\b/i,
];

/** A capitalised message that is nonetheless a fault: something failed, is
 *  missing, timed out, or answered 5xx, or a PostgREST diagnostic. */
const FAULT_SIGNATURES: RegExp[] = [
  /\bfail(?:ed|ure)\b/i,
  /\bnot configured\b/i,
  /\bmissing\b/i,
  /\btime(?:d)? ?out\b/i,
  /\b(?:ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up)\b/,
  /\bunexpected\b/i,
  /\binternal (?:server )?error\b/i,
  /\b5\d\d\b/,
  /^JSON object requested/,
  /^Could not (?:find|choose|embed)\b/,
  /^Results contain \d+ rows/,
  // The general shape of a prefix wrapped around a lowercase diagnostic:
  // "Upload failed: new row violates row-level security policy".
  /:\s+[a-z]/,
];

/** Browser network failures: a phone in a dead zone, not a bug. A server that
 *  is actually down is reported by the server (or by its absence). */
const NETWORK_NOISE: RegExp[] = [
  /^Failed to fetch$/,
  /^Load failed$/,
  /^NetworkError when attempting to fetch resource\.?$/,
  /^The network connection was lost\.?$/,
  /^ResizeObserver loop/,
];

/** The standard-schema validator in TanStack Start throws
 *  `new Error(JSON.stringify(issues))`: a JSON array of `{ message, path }`. */
function isValidationIssues(message: string): boolean {
  if (!message.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(message);
    return (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((i) => i && typeof i === "object" && "message" in i)
    );
  } catch {
    return false;
  }
}

/** True when `err` is the product saying no, or control flow, rather than a
 *  fault somebody should look at. */
export function isExpectedError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== "object") return false;

  // Router control flow: redirect() is a Response, notFound() is a tagged
  // object. Neither is an error.
  if (typeof Response !== "undefined" && err instanceof Response) return true;
  const o = err as Record<string, unknown>;
  if (o.isNotFound === true || o.isRedirect === true) return true;

  // An HTTP error that already decided it was the caller's fault.
  for (const key of ["statusCode", "status"] as const) {
    const s = o[key];
    if (typeof s === "number" && s >= 400 && s < 500) return true;
  }

  const name = typeof o.name === "string" ? o.name : "";
  const ctor = (o as { constructor?: { name?: unknown } }).constructor;
  const ctorName = typeof ctor?.name === "string" ? ctor.name : "";
  if (EXPECTED_NAMES.has(name) || EXPECTED_NAMES.has(ctorName)) return true;
  if (typeof o.type === "string" && EXPECTED_NAMES.has(o.type)) return true;
  if (typeof o.code === "string" && EXPECTED_CODES.has(o.code)) return true;

  const message = typeof o.message === "string" ? o.message.trim() : "";
  if (NETWORK_NOISE.some((re) => re.test(message))) return true;

  // Only a plain Error (or a plain object such as a PostgREST error) is
  // judged by its message. TypeError, RangeError and every other class are
  // faults by construction.
  const isPlain = name === "Error" || name === "";
  if (!isPlain) return false;
  if (message === "") return false;
  if (isValidationIssues(message)) return true;
  if (ALWAYS_EXPECTED.some((re) => re.test(message))) return true;
  if (FAULT_SIGNATURES.some((re) => re.test(message))) return false;
  // A sentence written for a person: capitalised first letter.
  return /^[A-Z]/.test(message);
}
