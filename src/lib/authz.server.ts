import type { AppRole } from "@/hooks/useMyRole";
import { hasPermission, type Permission } from "@/lib/permissions";

export type CallerContext = {
  orgId: string;
  role: AppRole;
};

/**
 * IMP-4: the exact query surface this module needs from a Supabase client, and
 * nothing more.
 *
 * These functions were typed `supabase: any`, which is worse here than almost
 * anywhere else in the codebase: this is the authorization boundary, so a typo
 * in the column list or a misspelled table would compile happily and fail at
 * runtime, inside the one code path whose job is to say no.
 *
 * Deliberately structural rather than `SupabaseClient<Database>`. Three
 * different shapes are passed in — the request-scoped client from the auth
 * middleware, the service-role client, and the minimal stubs the test suite
 * uses — and they only have this chain in common. Naming the chain types the
 * lookup AND documents the boundary's entire data dependency in one place:
 * user_roles, two columns, one row.
 *
 * Split into named interfaces rather than one nested type literal so the
 * compiler resolves them lazily.
 */

/** The row this boundary reads. Values are `unknown` until narrowed in
 *  resolveCaller, so a malformed row cannot walk in as a valid caller. */
export interface UserRoleLookup {
  // PromiseLike, not Promise: Supabase's query builder is a thenable that only
  // executes when awaited, and it has no .catch/.finally. Requiring a full
  // Promise here rejects the real client.
  maybeSingle(): PromiseLike<{
    data: { organization_id?: unknown; role?: unknown } | null;
    error: { message: string } | null;
  }>;
}

export interface AuthzQueryFilter {
  eq(column: string, value: string): UserRoleLookup;
}

export interface AuthzQueryTable {
  select(columns: string): AuthzQueryFilter;
}

export interface AuthzQueryClient {
  // Pinned to the literal "user_roles" rather than `string`: this boundary
  // reads exactly one table, and saying so keeps the type honest about its
  // dependency.
  from(table: "user_roles"): AuthzQueryTable;
}

/**
 * Resolve the caller's org membership from user_roles.
 * Throws if the user belongs to no organization.
 *
 * Assumes ONE organization per user — `.maybeSingle()` rejects a second row
 * rather than picking one. That is correct today and deliberately strict:
 * silently choosing among several memberships would resolve a caller into an
 * org they did not ask for, which at this layer means answering an
 * authorization question wrongly. BUILD-6 (Enterprise parent/child) is where
 * multi-org membership arrives, and it must revisit this function rather than
 * work around it — see docs/MASTER_BRIEF.md.
 */
export async function resolveCaller(
  // `unknown`, narrowed once below — deliberately NOT `AuthzQueryClient` on the
  // signature and deliberately not `any`.
  //
  // Declaring the structural type here makes every caller pay a structural
  // comparison against the generated Database generics, and in org.functions.ts
  // that tipped the compiler past its instantiation-depth limit (TS2589). The
  // errors migrated between call sites as each was annotated — it is the file's
  // total budget, not any one call — and an intermittent compile failure is a
  // worse outcome than the `any` this item exists to remove.
  //
  // `unknown` differs from `any` in the way that matters: `any` would silently
  // disable checking on everything downstream of it, whereas `unknown` forces
  // exactly one explicit, documented narrowing and leaves the whole chain below
  // fully typed against AuthzQueryClient. The unsoundness is confined to the
  // next line instead of leaking through the authorization gate.
  supabase: unknown,
  userId: string,
): Promise<CallerContext> {
  const db = supabase as AuthzQueryClient;

  // BUG-2: an impersonated session past its window is no longer a valid
  // identity. Checking here — ahead of the role lookup — means every server
  // function that goes through requirePermission stops honoring an expired
  // impersonation, rather than continuing to serve the target user's data
  // because their JWT still refreshes. A no-op for ordinary sessions.
  const { assertImpersonationSessionActive } = await import("@/lib/impersonation-session.server");
  await assertImpersonationSessionActive();

  const { data, error } = await db
    .from("user_roles")
    .select("organization_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");

  // Narrow explicitly instead of asserting. A row that reached here without a
  // usable org id or role is not a caller we can make an authorization decision
  // about, and `as string` would have quietly turned that into undefined
  // flowing onward as an org id.
  const orgId = data.organization_id;
  const role = data.role;
  if (typeof orgId !== "string" || typeof role !== "string") {
    throw new Error("No organization for user");
  }
  return { orgId, role: role as AppRole };
}

/**
 * The single server-side permission gate. Resolves the caller's role once and
 * throws a uniform error if the role lacks the capability. Use this in every
 * server function that performs a sensitive read or write — route-level
 * gating is cosmetic and must never be the only check.
 */
export async function requirePermission(
  // Passed straight through to resolveCaller — see the note there on why this
  // is `unknown` rather than the structural type or `any`.
  supabase: unknown,
  userId: string,
  permission: Permission,
): Promise<CallerContext> {
  const caller = await resolveCaller(supabase, userId);
  if (!hasPermission(caller.role, permission)) {
    throw new Error("Not authorized");
  }
  return caller;
}
