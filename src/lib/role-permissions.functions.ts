// Settings → Roles & permissions (#863).
//
// The owner goes through each role and turns permissions on or off. What is
// stored is the DIFFERENCE from the defaults: a row per (business, role,
// permission) the owner changed, in public.role_permission_overrides. A
// toggle back to the default deletes the row rather than storing "the
// default, spelled out", so Reset to defaults is "delete this role's rows"
// and a business that never opened the screen has no rows at all.
//
// Every write goes through the owner's OWN key. The table's policies admit
// the owner alone for INSERT, UPDATE and DELETE, so the database refuses a
// non-owner that reaches the RPC some other way; the requireOwner here is the
// readable sentence, not the only lock. The CHECK on the table refuses a row
// that would hand an owner-only permission to anyone (the floor), and a
// trigger writes activity_log for every change, with the actor.

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller, type CallerContext } from "@/lib/authz.server";
import {
  ALL_PERMISSIONS,
  CONFIGURABLE_ROLES,
  OWNER_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
  isOwnerOnly,
  type ConfigurableRole,
  type Permission,
} from "@/lib/permissions";

export const ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS =
  "Only the owner can change what each role is allowed to do.";
export const THAT_PERMISSION_IS_THE_OWNERS =
  "That permission stays with the owner and cannot be turned on for another role.";

async function requireOwner(supabase: unknown, userId: string): Promise<CallerContext> {
  const caller = await resolveCaller(supabase, userId);
  if (caller.role !== "owner") throw new Error(ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS);
  return caller;
}

const roleSchema = z.enum(CONFIGURABLE_ROLES);
const permissionSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

export type RolePermissionRow = {
  permission: Permission;
  /** What the role holds now. */
  allowed: boolean;
  /** What it would hold with no override. */
  byDefault: boolean;
  /** Owner-only: shown without a switch. */
  ownerOnly: boolean;
};

export type RolePermissionsAnswer = {
  roles: Array<{
    role: ConfigurableRole;
    permissions: RolePermissionRow[];
    /** The newest change to this role, for "changed by X on Y". */
    lastChange: { by: string; at: string } | null;
    /** How many permissions differ from the defaults. */
    changed: number;
  }>;
};

/** The owner's view: every configurable role, every permission, with the
 *  default beside the stored answer. Owner only, like the screen. */
export const getRolePermissions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RolePermissionsAnswer> => {
    const { orgId } = await requireOwner(context.supabase, context.userId);
    const db = context.supabase as SupabaseClient<Database>;
    const [{ data: rows, error }, { data: staff, error: staffErr }] = await Promise.all([
      db
        .from("role_permission_overrides")
        .select("role, permission, allowed, updated_by, updated_at")
        .eq("organization_id", orgId),
      db.from("staff").select("user_id, display_name").eq("organization_id", orgId),
    ]);
    if (error) throw new Error(error.message);
    if (staffErr) throw new Error(staffErr.message);
    const names = new Map<string, string>(
      ((staff ?? []) as Array<{ user_id: string; display_name: string }>).map((s) => [
        s.user_id,
        s.display_name,
      ]),
    );
    const stored = (rows ?? []) as Array<{
      role: string;
      permission: string;
      allowed: boolean;
      updated_by: string | null;
      updated_at: string;
    }>;
    return {
      roles: CONFIGURABLE_ROLES.map((role) => {
        const mine = stored.filter((r) => r.role === role);
        const newest = mine.reduce<(typeof mine)[number] | null>(
          (best, r) => (!best || r.updated_at > best.updated_at ? r : best),
          null,
        );
        const permissions = ALL_PERMISSIONS.map((permission): RolePermissionRow => {
          const byDefault = ROLE_PERMISSIONS[role].includes(permission);
          const ownerOnly = isOwnerOnly(permission);
          const row = mine.find((r) => r.permission === permission);
          const allowed = ownerOnly
            ? false
            : typeof row?.allowed === "boolean"
              ? row.allowed
              : byDefault;
          return { permission, allowed, byDefault, ownerOnly };
        });
        return {
          role,
          permissions,
          changed: permissions.filter((p) => p.allowed !== p.byDefault).length,
          lastChange: newest
            ? {
                by:
                  (newest.updated_by && names.get(newest.updated_by)) ||
                  "Someone no longer on the team",
                at: newest.updated_at,
              }
            : null,
        };
      }),
    };
  });

/** One switch: this role may, or may not, do this. Back to the default means
 *  the row goes away. */
export const setRolePermission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ role: roleSchema, permission: permissionSchema, allowed: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requireOwner(context.supabase, context.userId);
    // The floor, said before anything is written. The table's CHECK says it
    // again for a write that does not come through here.
    if (OWNER_ONLY_PERMISSIONS.includes(data.permission)) {
      throw new Error(THAT_PERMISSION_IS_THE_OWNERS);
    }
    const db = context.supabase as SupabaseClient<Database>;
    const byDefault = ROLE_PERMISSIONS[data.role].includes(data.permission);
    if (data.allowed === byDefault) {
      const { error } = await db
        .from("role_permission_overrides")
        .delete()
        .eq("organization_id", orgId)
        .eq("role", data.role)
        .eq("permission", data.permission);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from("role_permission_overrides").upsert(
        {
          organization_id: orgId,
          role: data.role,
          permission: data.permission,
          allowed: data.allowed,
          updated_by: context.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,role,permission" },
      );
      if (error) throw new Error(error.message);
    }
    return { ok: true as const, allowed: data.allowed, byDefault };
  });

/** Every permission of one role back to the default: its rows are deleted,
 *  and the trigger logs each one as "back to the default". */
export const resetRolePermissions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ role: roleSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requireOwner(context.supabase, context.userId);
    const { error } = await (context.supabase as SupabaseClient<Database>)
      .from("role_permission_overrides")
      .delete()
      .eq("organization_id", orgId)
      .eq("role", data.role);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
