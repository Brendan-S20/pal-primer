// Server half of the account lock (spec NP-12): who is locked, and the check
// every server function passes through (registered in src/start.ts).
//
// ── WHY THE TOKEN IS DECODED, NOT VERIFIED, HERE ──────────────────────────
//
// This runs ahead of requireSupabaseAuth, which is per function. Verifying the
// token twice would cost a second round trip on every call. Reading its `sub`
// unverified is safe for this purpose because the SAME token is verified
// immediately after, by requireSupabaseAuth: a forged `sub` belongs to a token
// whose signature fails there, and the call is refused anyway. A function that
// never verifies the caller does not act as the caller either.
//
// ── CACHING ───────────────────────────────────────────────────────────────
//
// Only "not locked" is cached (60 s), never "locked". Choosing a plan must
// unlock at once; a lock arriving a minute late, at the end of day 14, is fine.
import {
  ACCOUNT_LOCKED_MESSAGE,
  accountLockFor,
  serverFnOpenWhenLocked,
  type AccountLock,
} from "@/lib/account-lock";

const ORG_LOCK_COLUMNS =
  "plan_status, billing_status, trial_ends_at, stripe_subscription_id, created_at, is_comped, current_period_end, suspended_at";

export async function lockForOrg(orgId: string, now: Date = new Date()): Promise<AccountLock> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("organizations")
    .select(ORG_LOCK_COLUMNS)
    .eq("id", orgId)
    .maybeSingle();
  return accountLockFor(data ?? null, now);
}

export async function lockForUser(
  userId: string,
  now: Date = new Date(),
): Promise<{ orgId: string | null; lock: AccountLock }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  const orgId = (data?.organization_id as string | undefined) ?? null;
  if (!orgId) return { orgId: null, lock: { locked: false } };
  return { orgId, lock: await lockForOrg(orgId, now) };
}

/** The `sub` claim of a bearer JWT, unverified. Null for anything else. */
export function subFromBearer(authorization: string | null | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

const OPEN_FOR_MS = 60_000;
const openUntil = new Map<string, number>();

/** For tests: forget every cached "not locked". */
export function forgetAccountLocks(): void {
  openUntil.clear();
}

export class AccountLockedError extends Error {
  readonly code = "ACCOUNT_LOCKED";
  constructor() {
    super(ACCOUNT_LOCKED_MESSAGE);
    this.name = "AccountLockedError";
  }
}

/**
 * Throws AccountLockedError when the caller's account is locked and this server
 * function is not one a locked account may use. A call with no bearer token
 * (the portal, signup, webhooks) is not this check's business.
 */
export async function refuseIfLocked(input: {
  authorization: string | null | undefined;
  meta: { name?: string; filename?: string } | null | undefined;
  now?: Date;
  lookup?: (userId: string, now: Date) => Promise<{ lock: AccountLock }>;
}): Promise<void> {
  if (serverFnOpenWhenLocked(input.meta)) return;
  const sub = subFromBearer(input.authorization);
  if (!sub) return;
  const now = input.now ?? new Date();
  const cached = openUntil.get(sub);
  if (cached && cached > now.getTime()) return;
  let lock: AccountLock;
  try {
    ({ lock } = await (input.lookup ?? lockForUser)(sub, now));
  } catch (e) {
    // A lookup that fails says nothing about the account. Failing closed here
    // would turn a database blip into every customer locked out of everything;
    // the route guard and the next call will ask again.
    console.error("account lock lookup failed (call allowed)", (e as Error).message);
    return;
  }
  if (!lock.locked) {
    openUntil.set(sub, now.getTime() + OPEN_FOR_MS);
    return;
  }
  throw new AccountLockedError();
}
