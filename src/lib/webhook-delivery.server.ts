// Sending outbound webhooks: signing, the SSRF check at send time, the HTTP
// request, and the retry schedule.
//
// The outbox is filled by database triggers (20260929080000) and drained by
// /api/public/hooks/webhook-deliveries, which pg_cron calls every minute when
// something is due, and by the settings page's "Send test event" button,
// which delivers one row immediately so the owner sees the answer.
//
// ── THE SIGNATURE ─────────────────────────────────────────────────────────
//
//   HoundStack-Signature: t=1759132800,v1=<hex HMAC-SHA256>
//
// The MAC is over `${t}.${body}`, keyed with the whole secret string
// (`whsec_...`, prefix included) as UTF-8 bytes. The same shape Stripe uses,
// on purpose: every receiver that has verified a Stripe webhook already knows
// how to verify this one, and Zapier, Make and n8n all have a recipe for it.
// The timestamp is inside the MAC so a captured request cannot be replayed
// later with a fresh one; receivers should refuse a `t` more than five
// minutes old (verifyWebhookSignature below does).
//
// ── SSRF, AND WHAT THIS RUNTIME CAN AND CANNOT DO ─────────────────────────
//
// Production runs on Cloudflare Workers (the `cloudflare-module` Nitro preset
// from @lovable.dev/vite-tanstack-config, with nodejs_compat). Local dev and
// the tests run on Node. The check is the same in both; how the hostname gets
// resolved is not:
//
//   1. node:dns lookup({ all: true })   Node. Uses the OS resolver, i.e. the
//                                       same answer fetch will get.
//   2. node:dns resolve4 + resolve6     Workers, where lookup() is not
//                                       implemented but resolve4/6 are
//                                       (answered over DNS-over-HTTPS by
//                                       Cloudflare).
//   3. DNS-over-HTTPS to 1.1.1.1        if neither exists in the runtime.
//
// If all three fail to answer, the send is REFUSED, not waved through: an
// endpoint whose address cannot be checked is not sent to. (A name that
// simply does not exist is also refused, for the more boring reason.)
//
// Known limits, stated rather than hidden:
//
//   * Time-of-check to time-of-use. fetch() resolves the name again when it
//     connects, and neither runtime lets us hand it the address we checked.
//     A hostile DNS server with a zero TTL can answer "public" to the check
//     and "private" to the connect (DNS rebinding). On Workers that second
//     answer does not reach anything: a Worker's subrequest leaves from
//     Cloudflare's edge, which has no route to this app's private network and
//     refuses hostnames that resolve to private or loopback addresses (their
//     error 1000). On a Node host the gap is real and the fix would be an
//     undici Agent with a pinned `lookup`, which Workers does not support.
//   * On Workers, (2) may answer for one family only. We check every address
//     we are given; we cannot check addresses we are not given.
//
// Redirects are never followed (`redirect: "manual"`): a public URL that
// answers 302 Location: http://169.254.169.254/ is the oldest way around a
// check like this one. A 3xx is recorded as a failed attempt that says so.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { checkResolvedAddresses, checkWebhookUrl, isIPv4Literal } from "@/lib/webhook-url-safety";
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TEST_EVENT } from "@/lib/webhooks";

// ── Schedule ─────────────────────────────────────────────────────────────

/** How long to wait after attempt N fails before attempt N+1: 1m, 5m, 30m,
 *  2h, 12h. After the sixth attempt fails the delivery is marked failed. */
export const RETRY_DELAYS_SECONDS = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 12 * 60 * 60] as const;

/** One first try plus one per retry delay. */
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** Deliveries in a row that end failed (every retry used) before the
 *  endpoint is switched off and the owners are told. Five failed deliveries
 *  is at least fourteen and a half hours of an endpoint answering nothing
 *  useful, which is long enough not to be a blip and short enough that the
 *  owner hears about it the same day. */
export const AUTO_DISABLE_AFTER = 5;

/** Per request. A receiver that has not answered in ten seconds is not
 *  going to, and the worker has other receivers to get to. */
export const SEND_TIMEOUT_MS = 10_000;

/** Rows claimed per worker run, how many are in flight at once, and how
 *  long a claimed row is hidden from an overlapping run. 20 at 5 wide is at
 *  most four rounds of ten seconds, inside pg_net's sixty. */
export const BATCH_SIZE = 20;
export const CONCURRENCY = 5;
export const LEASE_SECONDS = 120;

export type AttemptPlan =
  | { succeeded: true; final: true; nextAttemptAt: null }
  | { succeeded: false; final: true; nextAttemptAt: null }
  | { succeeded: false; final: false; nextAttemptAt: Date };

/**
 * What happens after an attempt. `attemptsMade` counts the one just made
 * (the claim increments it before the send), so the first failure is 1.
 */
export function planAfterAttempt(attemptsMade: number, succeeded: boolean, now: Date): AttemptPlan {
  if (succeeded) return { succeeded: true, final: true, nextAttemptAt: null };
  if (attemptsMade >= MAX_ATTEMPTS) return { succeeded: false, final: true, nextAttemptAt: null };
  const delay = RETRY_DELAYS_SECONDS[Math.max(0, attemptsMade - 1)];
  return { succeeded: false, final: false, nextAttemptAt: new Date(now.getTime() + delay * 1000) };
}

/** The same threshold webhook_record_attempt is handed, as a predicate. */
export function shouldAutoDisable(consecutiveFailedDeliveries: number): boolean {
  return consecutiveFailedDeliveries >= AUTO_DISABLE_AFTER;
}

// ── Secrets and signatures ───────────────────────────────────────────────

/** 32 random bytes. Shown to the owner once, stored encrypted. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/** What a receiver does with the header. Here so the tests can prove the
 *  scheme round-trips, and so there is one reference implementation to copy
 *  into the help text. */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  opts: { now?: Date; toleranceSeconds?: number } = {},
): boolean {
  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const i = piece.indexOf("=");
    if (i <= 0) continue;
    const k = piece.slice(0, i).trim();
    parts.set(k, [...(parts.get(k) ?? []), piece.slice(i + 1).trim()]);
  }
  const t = Number(parts.get("t")?.[0]);
  if (!Number.isInteger(t)) return false;
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex"),
    "utf8",
  );
  return (parts.get("v1") ?? []).some((sig) => {
    const got = Buffer.from(sig, "utf8");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// ── DNS ──────────────────────────────────────────────────────────────────

export type Resolver = (hostname: string) => Promise<string[]>;

export class HostDidNotResolve extends Error {
  constructor(host: string) {
    super(`${host} does not resolve`);
    this.name = "HostDidNotResolve";
  }
}

/** Error codes that mean "the name does not exist or has no address", as
 *  opposed to "this runtime cannot do that". */
const DNS_MISS = new Set([
  "ENOTFOUND",
  "ENODATA",
  "ESERVFAIL",
  "EREFUSED",
  "ETIMEOUT",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EAI_NONAME",
  "ENONAME",
  "EBADNAME",
]);

function isDnsMiss(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && DNS_MISS.has(code);
}

async function resolveOverHttps(hostname: string, fetchImpl: typeof fetch): Promise<string[]> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    const res = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`DNS-over-HTTPS answered ${res.status}`);
    const j = (await res.json()) as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(String(a.data));
  }
  if (!out.length) throw new HostDidNotResolve(hostname);
  return out;
}

/** The resolver chain described at the top of this file. */
export const defaultResolver: Resolver = async (hostname) => {
  let dns: any = null;
  try {
    dns = await import("node:dns");
  } catch {
    dns = null;
  }
  const p = dns?.promises ?? dns?.default?.promises;

  if (typeof p?.lookup === "function") {
    try {
      const r: Array<{ address: string }> = await p.lookup(hostname, { all: true, verbatim: true });
      return r.map((x) => x.address);
    } catch (e) {
      if (isDnsMiss(e)) throw new HostDidNotResolve(hostname);
      // Not implemented here (Workers): try the next method.
    }
  }

  if (typeof p?.resolve4 === "function" && typeof p?.resolve6 === "function") {
    const settled = await Promise.allSettled([p.resolve4(hostname), p.resolve6(hostname)]);
    const addrs = settled.flatMap((s) => (s.status === "fulfilled" ? (s.value as string[]) : []));
    if (addrs.length) return addrs;
    if (settled.every((s) => s.status === "rejected" && isDnsMiss(s.reason))) {
      throw new HostDidNotResolve(hostname);
    }
  }

  return resolveOverHttps(hostname, fetch);
};

export type DeliverableCheck =
  { ok: true; href: string; host: string } | { ok: false; reason: string };

/**
 * The whole SSRF check: the URL's shape, then every address its host
 * resolves to. Used at save time by the settings functions and before every
 * send by sendWebhook.
 */
export async function checkWebhookDestination(
  raw: string,
  resolve: Resolver,
): Promise<DeliverableCheck> {
  const shape = checkWebhookUrl(raw);
  if (!shape.ok) return shape;
  const { host, href } = shape;
  // An IP literal was judged by checkWebhookUrl; there is nothing to resolve.
  if (isIPv4Literal(host) || host.includes(":")) return { ok: true, href, host };

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (e) {
    if (e instanceof HostDidNotResolve)
      return { ok: false, reason: `${host} does not resolve to any address.` };
    return {
      ok: false,
      reason: `Could not check where ${host} points (${(e as Error)?.message ?? "DNS unavailable"}), so nothing was sent.`,
    };
  }
  const verdict = checkResolvedAddresses(host, addresses);
  return verdict.ok ? { ok: true, href, host } : verdict;
}

// ── Sending ──────────────────────────────────────────────────────────────

export type SendDeps = {
  fetch: typeof fetch;
  resolve: Resolver;
  now: () => Date;
  timeoutMs?: number;
};

export type SendResult = { ok: boolean; statusCode: number | null; error: string | null };

async function snippet(res: Response): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    return value ? new TextDecoder().decode(value.slice(0, 200)).replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

export async function sendWebhook(
  args: { url: string; secret: string; body: string; eventType: string; deliveryId: string },
  deps: SendDeps,
): Promise<SendResult> {
  // Again, at send time: DNS can change after the endpoint was saved.
  const dest = await checkWebhookDestination(args.url, deps.resolve);
  if (!dest.ok) return { ok: false, statusCode: null, error: `Refused: ${dest.reason}` };

  const timestamp = Math.floor(deps.now().getTime() / 1000);
  const timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS;

  let res: Response;
  try {
    res = await deps.fetch(dest.href, {
      method: "POST",
      // Never follow. See the header of this file.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HoundStack-Webhooks/1.0",
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(args.secret, timestamp, args.body),
        "HoundStack-Event": args.eventType,
        "HoundStack-Delivery": args.deliveryId,
      },
      body: args.body,
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        statusCode: null,
        error: `No answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      };
    }
    return {
      ok: false,
      statusCode: null,
      error: `Could not connect: ${(e as Error)?.message ?? String(e)}`.slice(0, 500),
    };
  }

  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    const where = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      statusCode: res.status || null,
      error: `Redirected${where ? ` to ${where.slice(0, 200)}` : ""}. Redirects are not followed; use the final URL.`,
    };
  }

  if (res.status >= 200 && res.status < 300) {
    await res.body?.cancel().catch(() => {});
    return { ok: true, statusCode: res.status, error: null };
  }

  const text = await snippet(res);
  return {
    ok: false,
    statusCode: res.status,
    error: `HTTP ${res.status}${text ? `: ${text}` : ""}`,
  };
}

// ── The worker ───────────────────────────────────────────────────────────

type ClaimedRow = {
  delivery_id: string;
  organization_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret_ciphertext: string | null;
};

export type WorkerDeps = SendDeps & {
  decrypt: (ciphertext: string) => string;
  notifyDisabled: (args: {
    orgId: string;
    endpointId: string;
    url: string;
    failures: number;
  }) => Promise<void>;
};

export type WorkerSummary = {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  disabled: number;
  results: Array<{
    delivery_id: string;
    ok: boolean;
    status_code: number | null;
    error: string | null;
  }>;
};

/** Minimal surface of the service-role client this needs. */
export type RpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: any; error: { message: string } | null }>;
};

/**
 * Claim due deliveries (or exactly one, for a test send), send each, and
 * record what happened.
 */
export async function processWebhookDeliveries(
  admin: RpcClient,
  deps: WorkerDeps,
  opts: { only?: string; limit?: number } = {},
): Promise<WorkerSummary> {
  const { data, error } = await admin.rpc("webhook_claim_deliveries", {
    _limit: opts.only ? 1 : (opts.limit ?? BATCH_SIZE),
    _lease_seconds: LEASE_SECONDS,
    _only: opts.only ?? null,
  });
  if (error) throw new Error(`could not claim webhook deliveries: ${error.message}`);
  const rows = (data ?? []) as ClaimedRow[];

  const summary: WorkerSummary = {
    claimed: rows.length,
    succeeded: 0,
    retrying: 0,
    failed: 0,
    disabled: 0,
    results: [],
  };

  const readSecret = (row: ClaimedRow): { secret: string } | { error: string } => {
    if (!row.secret_ciphertext) {
      return { error: "This endpoint has no signing secret. Rotate the secret to fix it." };
    }
    try {
      return { secret: deps.decrypt(row.secret_ciphertext) };
    } catch (e) {
      return { error: `Could not read the signing secret: ${(e as Error).message}` };
    }
  };

  const handle = async (row: ClaimedRow) => {
    const key = readSecret(row);
    const result: SendResult =
      "error" in key
        ? { ok: false, statusCode: null, error: key.error }
        : await sendWebhook(
            {
              url: row.url,
              secret: key.secret,
              body: JSON.stringify(row.payload),
              eventType: row.event_type,
              deliveryId: row.delivery_id,
            },
            deps,
          );

    // A test event is one try: the owner is watching the page for the
    // answer, and retrying it for half a day afterwards would be noise.
    const plan = planAfterAttempt(
      row.event_type === WEBHOOK_TEST_EVENT ? MAX_ATTEMPTS : row.attempts,
      result.ok,
      deps.now(),
    );
    const { data: rec, error: recError } = await admin.rpc("webhook_record_attempt", {
      _delivery_id: row.delivery_id,
      _succeeded: plan.succeeded,
      _final: plan.final,
      _next_attempt_at: plan.nextAttemptAt ? plan.nextAttemptAt.toISOString() : null,
      _status_code: result.statusCode,
      _error: result.error,
      _disable_after: AUTO_DISABLE_AFTER,
    });
    if (recError) console.error("webhook_record_attempt failed", row.delivery_id, recError.message);

    if (plan.succeeded) summary.succeeded++;
    else if (plan.final) summary.failed++;
    else summary.retrying++;
    summary.results.push({
      delivery_id: row.delivery_id,
      ok: result.ok,
      status_code: result.statusCode,
      error: result.error,
    });

    if (rec?.disabled_now && row.event_type !== WEBHOOK_TEST_EVENT) {
      summary.disabled++;
      try {
        await deps.notifyDisabled({
          orgId: row.organization_id,
          endpointId: row.endpoint_id,
          url: row.url,
          failures: Number(rec.consecutive_failures ?? AUTO_DISABLE_AFTER),
        });
      } catch (e) {
        console.error("webhook disabled notification failed", (e as Error).message);
      }
    }
  };

  let next = 0;
  const lanes = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        await handle(row);
      } catch (e) {
        // One row's failure is not the batch's. Its lease expires and it is
        // tried again.
        console.error("webhook delivery crashed", row.delivery_id, (e as Error).message);
      }
    }
  });
  await Promise.all(lanes);
  return summary;
}

/** The production dependencies: real fetch, the resolver chain, the app's
 *  key, and an in-app notification to the people who can fix the endpoint. */
export async function productionWorkerDeps(): Promise<WorkerDeps> {
  const { decryptSecret } = await import("@/lib/secret-encryption.server");
  return {
    fetch: (input, init) => fetch(input, init),
    resolve: defaultResolver,
    now: () => new Date(),
    decrypt: (c) => decryptSecret(c),
    notifyDisabled: async ({ orgId, url, failures }) => {
      const { notifyRoles } = await import("@/lib/notify-center.server");
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep the raw string */
      }
      await notifyRoles(["owner", "office_manager"], {
        orgId,
        type: "webhook_disabled",
        title: "A webhook was switched off",
        body: `${host} failed ${failures} deliveries in a row, so HoundStack stopped sending to it. Fix the receiver, then switch it back on in Settings.`,
        link: "/settings/webhooks",
      });
    },
  };
}
