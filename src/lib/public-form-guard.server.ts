// The server half of public-form-guard.ts: the rate limit, which needs the
// database. Import inside handlers only (`await import(...)`).
//
// The counter is `public_form_attempts`, reached only through
// `take_public_form_turn` (20261009220000) with the service role. It is the
// portal_code_attempts pattern (an attempt log counted over a window) with the
// roadmap poll's two refinements: the address is hashed before it is stored,
// and the check and the write are one statement under an advisory lock, so two
// requests in the same instant cannot both read "one under the limit".

import { RATE_LIMIT } from "@/lib/public-form-guard";

export type TurnVerdict = { ok: true } | { ok: false; reason: "address" | "business" };

/**
 * A salted SHA-256 of the address. The salt is in this file, so this is not
 * proof against someone holding both the source and the table enumerating
 * IPv4; it is proof against the table itself being a list of who submitted
 * from where, and every row is pruned a day after it is written. Said here
 * rather than calling it "hashed" and leaving it (the roadmap poll's words).
 */
export async function hashAddress(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(`houndstack-public-form:v1:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Ask for a turn to write a lead for this business from this address. A turn
 * that is granted is counted; one that is refused is not, so a refusal writes
 * nothing at all.
 *
 * A limiter that ERRORS is not a limiter that says no. The migration may not
 * be applied yet (the app deploys on merge, the migration after it), or the
 * database may be having a bad minute; either way a real customer's quote
 * request must not be the casualty, so an error lets the submission through
 * and says so in the log. The same rule as the entitlement gate in
 * createSignupPaymentIntent.
 */
export async function takePublicFormTurn(
  admin: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  orgId: string,
  ip: string | null,
): Promise<TurnVerdict> {
  try {
    const { data, error } = await admin.rpc("take_public_form_turn", {
      _org_id: orgId,
      _ip_hash: ip ? await hashAddress(ip) : null,
      _per_address: RATE_LIMIT.perAddress,
      _per_business: RATE_LIMIT.perBusiness,
      _window_seconds: RATE_LIMIT.windowSeconds,
    });
    if (error) throw new Error(error.message);
    if (data === "address" || data === "business") return { ok: false, reason: data };
    return { ok: true };
  } catch (e) {
    console.error("public form rate limit unavailable; letting the submission through", orgId, e);
    return { ok: true };
  }
}
