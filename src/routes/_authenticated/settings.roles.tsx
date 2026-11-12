// Settings → Roles & permissions (#863).
//
// The owner goes through each role (office manager, dispatcher, technician)
// and turns permissions on or off. Today's rules are the defaults, so a
// business that never opens this page runs exactly as before. Every switch
// saves on its own, and each role has a Reset to defaults.
//
// Owner only: the route (ROUTE_ROLES), the server functions and the table's
// policies all say so. A few permissions stay with the owner whatever is set
// here (OWNER_ONLY_PERMISSIONS); they are listed at the top without a switch
// so the owner can see the floor rather than wonder why a row is missing.
//
// Office-only, so English, like the rest of Settings outside Preferences.

import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useRoleLabel } from "@/components/CommercialOnly";
import { titleHead } from "@/lib/page-title";
import { toastServerError } from "@/lib/server-outcome";
import {
  ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS,
  getRolePermissions,
  resetRolePermissions,
  setRolePermission,
  type RolePermissionsAnswer,
} from "@/lib/role-permissions.functions";
import {
  PERMISSION_CATALOG,
  PERMISSION_GROUP_LABELS,
  type ConfigurableRole,
  type Permission,
  type PermissionGroup,
} from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/settings/roles")({
  head: () => titleHead("Roles & permissions", "Settings"),
  component: RolePermissionsSettings,
});

export const ROLE_PERMISSIONS_QUERY_KEY = ["role-permissions"] as const;

/** One line on what each role is for, over its list of switches. The role's
 *  NAME comes from humanizeRole (useRoleLabel), like everywhere else. */
function roleBlurb(role: ConfigurableRole): string {
  switch (role) {
    case "office_manager":
      return "Runs the office: clients, invoices, routes and settings.";
    case "dispatcher":
      return "Runs the schedule: books, moves and closes out visits, and texts clients.";
    case "tech":
      return "Runs the route: My Day, the visits assigned to them and field tools.";
  }
}

const GROUP_ORDER: PermissionGroup[] = ["people", "clients", "schedule", "money", "business"];

function RolePermissionsSettings() {
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const getFn = useServerFn(getRolePermissions);
  const setFn = useServerFn(setRolePermission);
  const resetFn = useServerFn(resetRolePermissions);

  const { data, error, isLoading } = useQuery({
    queryKey: ROLE_PERMISSIONS_QUERY_KEY,
    queryFn: () => getFn(),
  });

  // Which switch is mid-save, so it cannot be flipped twice before the
  // server has answered once.
  const [pending, setPending] = useState<string | null>(null);

  const setMut = useMutation({
    mutationFn: (input: { role: ConfigurableRole; permission: Permission; allowed: boolean }) =>
      setFn({ data: input }),
    onMutate: async (input) => {
      setPending(`${input.role}:${input.permission}`);
      await qc.cancelQueries({ queryKey: ROLE_PERMISSIONS_QUERY_KEY });
      const before = qc.getQueryData<RolePermissionsAnswer>(ROLE_PERMISSIONS_QUERY_KEY);
      // The switch moves at once; the server's answer confirms or reverts it.
      if (before) {
        qc.setQueryData<RolePermissionsAnswer>(ROLE_PERMISSIONS_QUERY_KEY, {
          roles: before.roles.map((r) =>
            r.role !== input.role
              ? r
              : {
                  ...r,
                  permissions: r.permissions.map((p) =>
                    p.permission === input.permission ? { ...p, allowed: input.allowed } : p,
                  ),
                },
          ),
        });
      }
      return { before };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.before) qc.setQueryData(ROLE_PERMISSIONS_QUERY_KEY, ctx.before);
      toastServerError(err, {
        fallback: "That permission could not be saved.",
        refused: ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS,
      });
    },
    onSuccess: (_r, input) => {
      toast.success(
        `${labelOf(input.permission)} ${input.allowed ? "turned on" : "turned off"} for ${roleLabel(input.role).toLowerCase()}s`,
      );
    },
    onSettled: () => {
      setPending(null);
      void qc.invalidateQueries({ queryKey: ROLE_PERMISSIONS_QUERY_KEY });
      // Anyone of that role picks the change up on their next shell load;
      // the owner's own answer does not change.
      void qc.invalidateQueries({ queryKey: ["my-org"] });
    },
  });

  const resetMut = useMutation({
    mutationFn: (role: ConfigurableRole) => resetFn({ data: { role } }),
    onSuccess: (_r, role) => {
      toast.success(`${roleLabel(role)} is back to the defaults`);
    },
    onError: (err) =>
      toastServerError(err, {
        fallback: "That role could not be reset.",
        refused: ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ROLE_PERMISSIONS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["my-org"] });
    },
  });

  const ownerOnly = PERMISSION_CATALOG.filter((c) =>
    data?.roles[0]?.permissions.some((p) => p.permission === c.permission && p.ownerOnly),
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Roles &amp; permissions</h2>
        <p className="text-sm text-muted-foreground">
          Go through each role and turn permissions on or off. Today's rules are the defaults, so
          nothing changes until you change it. A change takes effect on the person's next request;
          nobody has to sign out. Each change is logged with who made it and when. The owner always
          has everything.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : "Could not load role permissions."}
        </p>
      ) : null}

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
                Always the owner's
              </CardTitle>
              <CardDescription>
                These stay with the owner whatever is set below. So does changing or turning off the
                owner, handing the business to someone else, and deleting it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {ownerOnly.map((c) => (
                  <li key={c.permission} className="py-3">
                    <p className="text-sm font-medium">{c.label}</p>
                    <p className="text-sm text-muted-foreground">{c.explanation}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {data.roles.map((r) => (
            <RoleCard
              key={r.role}
              role={r.role}
              label={roleLabel(r.role)}
              permissions={r.permissions}
              changed={r.changed}
              lastChange={r.lastChange}
              pending={pending}
              onToggle={(permission, allowed) =>
                setMut.mutate({ role: r.role, permission, allowed })
              }
              onReset={() => resetMut.mutate(r.role)}
              resetting={resetMut.isPending && resetMut.variables === r.role}
            />
          ))}
        </>
      )}
    </div>
  );
}

function labelOf(permission: Permission): string {
  return PERMISSION_CATALOG.find((c) => c.permission === permission)?.label ?? permission;
}

function RoleCard({
  role,
  label,
  permissions,
  changed,
  lastChange,
  pending,
  onToggle,
  onReset,
  resetting,
}: {
  role: ConfigurableRole;
  label: string;
  permissions: RolePermissionsAnswer["roles"][number]["permissions"];
  changed: number;
  lastChange: { by: string; at: string } | null;
  pending: string | null;
  onToggle: (permission: Permission, allowed: boolean) => void;
  onReset: () => void;
  resetting: boolean;
}) {
  const when = lastChange
    ? new Date(lastChange.at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  return (
    <Card data-role-card={role}>
      {/* A title and description on one side and an action on the other:
          flex-wrap, so on a phone the button drops under the text instead of
          squeezing it (a-width-floor-is-not-a-shrink-floor). */}
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle>{label}</CardTitle>
          <CardDescription>{roleBlurb(role)}</CardDescription>
          <p className="mt-1 text-xs text-muted-foreground">
            {changed === 0
              ? "The defaults."
              : `${changed} ${changed === 1 ? "permission" : "permissions"} changed from the defaults.`}
            {lastChange && when ? (
              <>
                {" "}
                Last changed by <bdi>{lastChange.by}</bdi> on {when}.
              </>
            ) : null}
          </p>
        </div>
        <ConfirmButton
          variant="outline"
          size="sm"
          disabled={changed === 0 || resetting}
          title={`Reset ${label.toLowerCase()} to the defaults?`}
          description={`Every permission for ${label.toLowerCase()}s goes back to the default. ${changed} ${changed === 1 ? "change is" : "changes are"} undone. This is logged.`}
          confirmLabel="Reset to defaults"
          onConfirm={onReset}
        >
          Reset to defaults
        </ConfirmButton>
      </CardHeader>
      <CardContent className="space-y-5">
        {GROUP_ORDER.map((group) => {
          const rows = PERMISSION_CATALOG.filter((c) => c.group === group)
            .map((c) => ({ ...c, state: permissions.find((p) => p.permission === c.permission) }))
            .filter((c) => c.state && !c.state.ownerOnly);
          if (!rows.length) return null;
          return (
            <section key={group} aria-label={`${PERMISSION_GROUP_LABELS[group]} for ${label}`}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {PERMISSION_GROUP_LABELS[group]}
              </h3>
              <ul className="divide-y">
                {rows.map((c) => {
                  const state = c.state!;
                  const id = `rp-${role}-${c.permission}`;
                  const differs = state.allowed !== state.byDefault;
                  return (
                    <li key={c.permission} className="flex items-start justify-between gap-4 py-3">
                      <div className="min-w-0 flex-1">
                        <label htmlFor={id} className="text-sm font-medium">
                          {c.label}
                        </label>
                        {differs ? (
                          <Badge variant="secondary" className="ms-2 align-middle">
                            Changed
                          </Badge>
                        ) : null}
                        <p className="text-sm text-muted-foreground">{c.explanation}</p>
                      </div>
                      {/* The switch's own 44px hit area is a ::before on touch
                          (ui/switch.tsx); the row's top padding keeps it clear
                          of the row above. */}
                      <Switch
                        id={id}
                        className="mt-1"
                        aria-label={`${c.label} for ${label.toLowerCase()}s`}
                        checked={state.allowed}
                        disabled={pending === `${role}:${c.permission}` || resetting}
                        onCheckedChange={(v) => onToggle(c.permission, v)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
