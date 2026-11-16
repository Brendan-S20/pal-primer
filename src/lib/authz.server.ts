import type { AppRole } from "@/hooks/useMyRole";
import {
  hasPermission,
  overridesFromRows,
  type Permission,
  type PermissionOverrides,
} from "@/lib/permissions";

export type CallerContext = {
  orgId: string;
  role: AppRole;
  /**
   * What this business's owner turned on or off for this role (#863),
   * already resolved for THIS caller's business and role, so a call site
   * passes it straight to hasPermission. Undefined for an owner, who holds
   * everything, and for a caller resolved by a test double that returns only
   * the two fields above: then hasPermission answers from the defaults.
   */
  overrides?: PermissionOverrides;
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
 * user_roles, two columns, one row; and access_turned_off(), which answers for
 * the JWT's own user (so it says nothing through the service-role client).
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

/** The overrides read: every row for one (business, role), as a list. */
export interface OverrideRowsLookup extends PromiseLike<{
  data: Array<{ permission?: unknown; allowed?: unknown }> | null;
  error: { message: string } | null;
}> {
  eq(column: string, value: string): OverrideRowsLookup;
}

export interface OverridesQueryTable {
  select(columns: string): OverrideRowsLookup;
}

export interface AuthzQueryClient {
  // Pinned to the literal table names rather than `string`: this boundary
  // reads exactly two tables, and saying so keeps the type honest about its
  // dependency. user_roles answers who the caller is; role_permission_overrides
  // answers what their business's owner changed for their role (#863).
  from(table: "user_roles"): AuthzQueryTable;
  from(table: "role_permission_overrides"): OverridesQueryTable;
  // And one function: is this person turned off (20261009180000)?
  rpc(fn: "access_turned_off"): PromiseLike<{
    data: Array<{ organization_id?: unknown; organization_name?: unknown }> | null;
    error: { message: string; code?: string } | null;
  }>;
}

/**
 * What a person whose staff row is turned off gets from every server function
 * that resolves a caller. A fixed string, so the app can tell it from any
 * other failure and send them to /access-off instead of showing an error.
 */
export const ACCESS_TURNED_OFF =
  "Your access to this business has been turned off. Ask the owner to reactivate you.";

export function isAccessTurnedOff(e: unknown): boolean {
  return e instanceof Error && e.message.includes(ACCESS_TURNED_OFF);
}

/** PostgREST's "no such function in the schema cache". */
const FUNCTION_NOT_DEPLOYED = "PGRST202";

/**
 * The organizations in which the signed-in person is turned off: normally
 * none, at most the one they belong to.
 *
 * Asked through access_turned_off(), a SECURITY DEFINER function, because the
 * person's own staff row is exactly what RLS stops them reading once they are
 * off -- a plain select would come back empty for "off" and for "no staff
 * row" alike.
 *
 * Fails CLOSED on any error but one: a deploy that reaches the server before
 * its migration reaches the database. Then the function does not exist, the
 * database is not enforcing the rule either, and refusing everybody would take
 * the whole app down for nothing.
 */
export async function accessTurnedOff(
  supabase: unknown,
): Promise<Array<{ organizationId: string; organizationName: string }>> {
  const db = supabase as AuthzQueryClient;
  const { data, error } = await db.rpc("access_turned_off");
  if (error) {
    if (error.code === FUNCTION_NOT_DEPLOYED) return [];
    throw new Error(error.message);
  }
  return (data ?? []).flatMap((r) =>
    typeof r.organization_id === "string"
      ? [
          {
            organizationId: r.organization_id,
            organizationName: typeof r.organization_name === "string" ? r.organization_name : "",
          },
        ]
      : [],
  );
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

  // Both reads at once: the second costs no extra round trip.
  const [{ data, error }, off] = await Promise.all([
    db.from("user_roles").select("organization_id, role").eq("user_id", userId).maybeSingle(),
    accessTurnedOff(db),
  ]);
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

  // Off means off: a person whose staff row in this organization is turned
  // off is not a caller in it, whatever user_roles says. Checked here so every
  // server function that resolves a caller -- including the ones that go on
  // to use the service-role client, which RLS cannot stop -- refuses them.
  if (off.some((o) => o.organizationId === orgId)) throw new Error(ACCESS_TURNED_OFF);

  // What the owner changed for this role (#863). An owner is never asked
  // about: they hold everything, so there is nothing to read.
  if (role === "owner") return { orgId, role };
  const overrides = await readPermissionOverrides(db, orgId, role as AppRole);
  // The key is there only when the owner changed something, so a caller with
  // the defaults is the same two-field answer this function always gave.
  if (!Object.keys(overrides).length) return { orgId, role: role as AppRole };
  return { orgId, role: role as AppRole, overrides };
}

/**
 * The business's overrides for one role, from public.role_permission_overrides.
 *
 * Read with whatever client the caller came in with: with the person's own
 * key the table's SELECT policy admits any member of the business, and with
 * the service role there is no policy to pass. An error is an error, as it
 * is for the user_roles read above: answering "the defaults" when the read
 * failed would quietly undo a permission the owner turned OFF, and the
 * server functions that go on to use the service-role client would then do
 * the thing RLS was no longer there to refuse.
 *
 * A test double that does not know the table, and gives back something that
 * is not a `{ data, error }` answer, reads as "no rows": the defaults. That
 * is the matrix every such test was written against.
 */
async function readPermissionOverrides(
  db: AuthzQueryClient,
  orgId: string,
  role: AppRole,
): Promise<PermissionOverrides> {
  // Step by step, so a double whose chain stops short (a `from` that only
  // answers maybeSingle, an `eq` that is not chainable) is "no rows" rather
  // than a TypeError inside the authorization gate. A real client has every
  // step; a real failure comes back as `error`, below, and is thrown.
  const table = db.from("role_permission_overrides") as Partial<OverridesQueryTable> | undefined;
  const selected = typeof table?.select === "function" ? table.select("permission, allowed") : null;
  const byOrg =
    selected && typeof selected.eq === "function" ? selected.eq("organization_id", orgId) : null;
  const byRole = byOrg && typeof byOrg.eq === "function" ? byOrg.eq("role", role) : null;
  if (!byRole || typeof byRole.then !== "function") return {};
  const answer = await byRole;
  if (answer && typeof answer === "object" && "error" in answer && answer.error) {
    throw new Error(answer.error.message);
  }
  const rows = answer && typeof answer === "object" && "data" in answer ? answer.data : null;
  return overridesFromRows(Array.isArray(rows) ? rows : null);
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
  if (!hasPermission(caller.role, permission, caller.overrides)) {
    throw new Error("Not authorized");
  }
  return caller;
}

/**
 * hasPermission for a caller resolveCaller already answered: the role AND
 * the business's overrides for it (#863). For the handful of server
 * functions that branch on a permission after resolving the caller rather
 * than requiring one, so they read the configured set too.
 */
export function callerHasPermission(caller: CallerContext, permission: Permission): boolean {
  return hasPermission(caller.role, permission, caller.overrides);
}
