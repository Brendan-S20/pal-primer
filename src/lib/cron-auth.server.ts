// One authorization check for every unattended cron endpoint.
//
// ── WHY THE ANON KEY IS NOT A CREDENTIAL ───────────────────────────────────
//
// The project's anon/publishable key ships in the browser bundle. Anyone who
// has loaded the app once can read it out of their network tab. It identifies
// the PROJECT; it authenticates nobody.
//
// It was accepted by three cron endpoints (the Lovable scheduled-jobs pattern),
// each of which does something a stranger should not be able to trigger:
//
//   nightly              overdue SMS dunning + invoice emails for EVERY org,
//                        autopay charges, franchise settlement generation
//   weekly-digest        an AI-generated email to every opted-in org owner,
//                        which also spends AI allowance per call
//   announcement-emails  platform-wide outbound email
//
// Each is idempotent, which is why it was tolerated. Idempotent is not the same
// as harmless: re-firing the dunning run texts every tenant's overdue customers
// again, and no amount of re-running undoes a message somebody received.
//
// ── WHY IT LIVES HERE ──────────────────────────────────────────────────────
//
// Because it was written three times, and the three had already drifted:
// nightly took CRON_SECRET, service role, or anon; announcement-emails took
// CRON_SECRET or anon; weekly-digest took anon and NOTHING else. Three copies
// of a security check is how one of them ends up weaker than the others — and
// the weakest one is the whole platform's exposure.

export type CronAuth =
  | { ok: true; via: "cron_secret" | "service_role" }
  | { ok: false; reason: string; detail: Record<string, unknown> };

/**
 * Authorize an unattended cron request from a PRIVATE credential only.
 *
 * Accepts the generated CRON_SECRET (header or `?s=`), or the service role key
 * as a Bearer token — the pattern pg_cron already uses, reading the key from
 * Supabase Vault.
 */
export function authorizeCronRequest(request: Request): CronAuth {
  const cronSecret = process.env.CRON_SECRET;
  const serviceKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  const providedSecret =
    request.headers.get("x-cron-secret") ?? new URL(request.url).searchParams.get("s");
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  if (cronSecret && providedSecret === cronSecret) return { ok: true, via: "cron_secret" };
  if (serviceKey && bearer === serviceKey) return { ok: true, via: "service_role" };

  // Self-diagnosing on purpose. The one way tightening this can bite is a
  // service key rotated in the app without updating the Vault secret the cron
  // reads — after which the job simply stops, overnight, with nothing to say
  // why. Name the likely cause instead of returning a bare 401.
  return {
    ok: false,
    reason: "no private credential",
    detail: {
      presentedBearer: !!bearer,
      presentedSecret: !!providedSecret,
      // Never the keys themselves — only enough to tell "absent" from
      // "mismatched", which are different problems with different fixes.
      serviceKeyConfigured: !!serviceKey,
      cronSecretConfigured: !!cronSecret,
      hint: bearer
        ? "A Bearer token was sent but does not match SERVICE_ROLE_KEY. If the key was rotated, update the 'cron_service_role_key' Vault secret that pg_cron reads."
        : "No Bearer token and no matching CRON_SECRET. pg_cron should send Authorization: Bearer <service role key>.",
    },
  };
}

/** Reject and log, in the shape every cron handler wants. */
export function cronUnauthorized(endpoint: string, auth: Extract<CronAuth, { ok: false }>) {
  console.error(`${endpoint} rejected: ${auth.reason}`, auth.detail);
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
