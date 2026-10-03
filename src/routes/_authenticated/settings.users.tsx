import { createFileRoute } from "@tanstack/react-router";
import { lookupAddressPoint } from "@/lib/geocode.functions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useState } from "react";
import {
  listOrgUsers,
  changeUserRole,
  setStaffActive,
  setStaffRouting,
  listStaffAddresses,
  setStaffAddresses,
  createOrgInvite,
  listOrgInvites,
  revokeOrgInvite,
  resendOrgInvite,
} from "@/lib/users.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { toast } from "sonner";
import { useMyRole } from "@/hooks/useMyRole";
import { humanizeRole } from "@/lib/humanize";
import { MapPin, ChevronDown, ChevronRight } from "lucide-react";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/settings/users")({
  head: () => titleHead("Users & roles", "Settings"),
  component: UsersPage,
});

/** Every role this page can assign, in the order it offers them. Only the
 *  values live here — the words come from humanizeRole, the same helper the
 *  read-only badge two lines away from the picker already used. The picker
 *  having its own copy meant one cell of one table could show a role spelled
 *  two ways depending on whether you were allowed to change it.
 *
 *  `INVITE_ROLES` is a subset, not a second list: `users.functions.ts` refuses
 *  an invite for `owner` (inviteRoleEnum), so offering it here would be a form
 *  that fails on submit. */
const ROLES = ["owner", "office_manager", "dispatcher", "tech"] as const;
const INVITE_ROLES = ["tech", "dispatcher", "office_manager"] as const;

async function geocode(q: string): Promise<{ lat: number; lng: number } | null> {
  // Through the server rather than straight at Nominatim: the throttle, the
  // User-Agent their policy asks for, and one origin IP instead of every
  // tenant's. See src/lib/geocode.functions.ts.
  const query = q.trim();
  if (query.length < 3) return null;
  try {
    const { geo } = await lookupAddressPoint({ data: { query } });
    return geo ? { lat: geo.latitude, lng: geo.longitude } : null;
  } catch {
    return null;
  }
}

function UsersPage() {
  const qc = useQueryClient();
  const { role: myRole } = useMyRole();
  const canEdit = myRole === "owner";

  const listFn = useServerFn(listOrgUsers);
  const changeFn = useServerFn(changeUserRole);
  const activeFn = useServerFn(setStaffActive);
  const addrFn = useServerFn(listStaffAddresses);

  const { data, isLoading } = useQuery({ queryKey: ["org-users"], queryFn: () => listFn() });
  const { data: staffData } = useQuery({ queryKey: ["staff-addresses"], queryFn: () => addrFn() });
  const staffById = new Map<string, any>((staffData?.staff ?? []).map((s: any) => [s.id, s]));

  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: any }) => changeFn({ data: v }),
    onSuccess: () => {
      toast.success("Role updated");
      qc.invalidateQueries({ queryKey: ["org-users"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: (v: { staffId: string; active: boolean }) => activeFn({ data: v }),
    onSuccess: (r: any) => {
      toast.success("Staff updated");
      // THE SEAT COUNT JUST CHANGED, AND THE BILLING SIDE MAY NOT HAVE.
      //
      // The staff row is written by the RPC above and is correct either way;
      // reconciling the Stripe seat-overage quantity is deliberately
      // best-effort so a Stripe outage cannot stop somebody deactivating an
      // employee. What it must not be is invisible.
      //
      // Nothing reconciles seats on a schedule. The only healing is the next
      // toggle, the next invite accepted, or somebody opening Billing, so a
      // failure here can sit for as long as none of those happens. The
      // direction that hurts is deactivating an employee and going on charging
      // for the seat, which is why this is a warning rather than a line in the
      // success toast.
      //
      // `skipped` is not a failure: no live subscription, not a per-employee
      // plan, or no Stripe key. Those are ordinary and say nothing.
      if (r?.seats?.state === "failed" || r?.seats?.state === "unknown") {
        toast.warning(
          "The billing seat count was not updated. Open Billing to reconcile it, or your next invoice may not match your team.",
          { duration: 12000 },
        );
      }
      qc.invalidateQueries({ queryKey: ["org-users"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Users & roles</h2>
        {/* One name for one idea. This used to say "appears on routes", "field
            worker" and "show up in routing" in a single sentence, for the same
            flag — while the control itself was labelled "Field technician". The
            server's own error now points people here by the words on the
            checkbox, so those words have to match. */}
        <p className="text-sm text-muted-foreground">
          Change roles, deactivate people, and choose who runs routes. Only people who run routes
          appear on the dispatch board, can be assigned visits, or show up in tech reports.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm min-w-[540px]">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2 w-6"></th>
                    <th className="pb-2">Name</th>
                    <th className="pb-2">Email</th>
                    <th className="pb-2">Role</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(data?.users ?? []).map((u: any) => {
                    const isOpen = u.staff_id && expanded.has(u.staff_id);
                    const staff = u.staff_id ? staffById.get(u.staff_id) : null;
                    // Routing state, shown for EVERY active person with a staff
                    // record — not only for deliberate overrides.
                    //
                    // It used to render a badge only when someone had been
                    // explicitly flagged in or out, on the reasoning that a role
                    // default is not worth announcing. The effect was that the
                    // most common case of all — an ordinary tech who does run
                    // routes — displayed nothing whatsoever, so the column could
                    // not answer the one question it exists to answer. Reading
                    // it, you could not tell "runs routes" from "no staff record
                    // at all"; both were blank.
                    const runsRoutes = Boolean(staff?.is_field_tech);
                    const offToday = runsRoutes && !staff?.routing_available;
                    return (
                      <Fragment key={u.user_id}>
                        <tr key={u.user_id}>
                          <td className="py-3">
                            {u.staff_id ? (
                              <button
                                onClick={() => toggleExpand(u.staff_id)}
                                // MEASURED 2026-08-19: 16.0px — a bare glyph with
                                // no box at all, x7 rows.
                                className="text-muted-foreground hover:text-foreground max-md:inline-flex touch:min-h-11 touch:min-w-11 max-md:items-center max-md:justify-center"
                              >
                                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                              </button>
                            ) : null}
                          </td>
                          <td className="py-3 font-medium">{u.display_name ?? "-"}</td>
                          <td className="py-3 text-muted-foreground">{u.email}</td>
                          <td className="py-3">
                            {canEdit ? (
                              <Select
                                value={u.role}
                                onValueChange={(v) => changeRole.mutate({ userId: u.user_id, role: v })}
                              >
                                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {ROLES.map((r) => (
                                    <SelectItem key={r} value={r}>
                                      {humanizeRole(r)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant="secondary">{humanizeRole(u.role)}</Badge>
                            )}
                          </td>
                          <td className="py-3">
                            {u.active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}
                            {/* Surface routing eligibility in the row (punch
                                list #12 / G8) — the controls live in the expander,
                                but their state shouldn't hide there. */}
                            {u.active && staff && (
                              offToday ? (
                                <Badge variant="outline" className="ml-1.5 border-amber-400 text-amber-700">
                                  Away today
                                </Badge>
                              ) : runsRoutes ? (
                                <Badge variant="outline" className="ml-1.5 border-emerald-400 text-emerald-700">
                                  Runs routes
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="ml-1.5 text-muted-foreground">
                                  Office only
                                </Badge>
                              )
                            )}
                          </td>
                          <td className="py-3 text-right">
                            {u.staff_id && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="mr-1 text-xs"
                                onClick={() => toggleExpand(u.staff_id)}
                              >
                                Routing &amp; addresses
                              </Button>
                            )}
                            {canEdit && u.staff_id && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => toggleActive.mutate({ staffId: u.staff_id, active: !u.active })}
                              >
                                {u.active ? "Deactivate" : "Reactivate"}
                              </Button>
                            )}
                          </td>
                        </tr>
                        {isOpen && staff && (
                          <tr key={u.user_id + "-addr"} className="bg-muted/20">
                            <td colSpan={6} className="p-4">
                              <StaffAddressEditor staff={staff} canEdit={canEdit} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {(data?.users ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-muted-foreground">
                        No team members yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit && <InvitePanel />}
    </div>
  );
}

// Finding #40: real invite flow — email + pre-assigned role, pending list with
// revoke, and auto-assignment on the invitee's first sign-in.
function InvitePanel() {
  const qc = useQueryClient();
  const createFn = useServerFn(createOrgInvite);
  const listFn = useServerFn(listOrgInvites);
  const revokeFn = useServerFn(revokeOrgInvite);
  const resendFn = useServerFn(resendOrgInvite);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"office_manager" | "dispatcher" | "tech">("tech");

  const invitesQ = useQuery({ queryKey: ["org-invites"], queryFn: () => listFn() });
  const invites: any[] = (invitesQ.data as any)?.invites ?? [];

  const createMut = useMutation({
    mutationFn: () => createFn({ data: { email: email.trim(), role } }),
    onSuccess: () => { toast.success("Invite sent"); setEmail(""); qc.invalidateQueries({ queryKey: ["org-invites"] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeFn({ data: { id } }),
    onSuccess: () => { toast.success("Invite revoked"); qc.invalidateQueries({ queryKey: ["org-invites"] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const resendMut = useMutation({
    mutationFn: (id: string) => resendFn({ data: { id } }),
    onSuccess: () => toast.success("Invite resent"),
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite a teammate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); if (email.trim()) createMut.mutate(); }}
        >
          <div className="min-w-56 flex-1">
            <Label className="text-xs">Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" required />
          </div>
          <div>
            <Label className="text-xs">Role</Label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as any)}
              // MEASURED 2026-08-19: 40.0px, four short.
              className="h-10 rounded-md border bg-background px-3 text-sm touch:min-h-11"
            >
              {INVITE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {humanizeRole(r)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={createMut.isPending || !email.trim()}>
            {createMut.isPending ? "Sending…" : "Send invite"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          They'll get an email; their role is assigned automatically when they sign up with this address.
        </p>

        {invites.filter((i) => i.status === "pending").length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Pending invites</div>
            {/* Resend and Revoke are the only two things these rows are for, and
                an invited address is long enough to push both off the right of a
                phone. `min-w-0` lets the address side give way instead;
                `break-words` breaks the address once it is the widest thing
                left. */}
            <ul className="divide-y">
              {invites.filter((i) => i.status === "pending").map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 break-words">{i.email} <span className="text-muted-foreground">· {humanizeRole(i.role)}</span></span>
                  <span className="flex shrink-0 items-center gap-3">
                    <button className="text-xs underline disabled:opacity-50" onClick={() => resendMut.mutate(i.id)} disabled={resendMut.isPending}>Resend</button>
                    <button className="text-xs text-destructive underline" onClick={() => revokeMut.mutate(i.id)}>Revoke</button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StaffAddressEditor({ staff, canEdit }: { staff: any; canEdit: boolean }) {
  const qc = useQueryClient();
  const saveFn = useServerFn(setStaffAddresses);
  const routingFn = useServerFn(setStaffRouting);
  const [start, setStart] = useState(staff.start_address ?? "");
  const [end, setEnd] = useState(staff.end_address ?? "");
  // A pin that came back with a matched address. Held so save() can skip the
  // Nominatim round trip below and store the provider's own coordinates,
  // which are the point of matching in the first place. Cleared the moment
  // the text is edited by hand — coordinates for the address that used to be
  // in the box would send the optimizer to the wrong start.
  const [startPin, setStartPin] = useState<{ lat: number; lng: number } | null>(null);
  const [endPin, setEndPin] = useState<{ lat: number; lng: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const routingMut = useMutation({
    mutationFn: (v: { staffId: string; isFieldTech?: boolean; routingAvailable?: boolean }) =>
      routingFn({ data: v }),
    onSuccess: () => {
      toast.success("Routing updated");
      qc.invalidateQueries({ queryKey: ["staff-addresses"] });
      qc.invalidateQueries({ queryKey: ["staff"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const save = async () => {
    setSaving(true);
    try {
      const [sGeo, eGeo] = await Promise.all([
        startPin ??
          (start.trim() && start !== staff.start_address ? geocode(start) : Promise.resolve(null)),
        endPin ?? (end.trim() && end !== staff.end_address ? geocode(end) : Promise.resolve(null)),
      ]);
      await saveFn({
        data: {
          staffId: staff.id,
          startAddress: start.trim() || null,
          startLatitude: sGeo?.lat ?? (start === staff.start_address ? staff.start_latitude : null),
          startLongitude: sGeo?.lng ?? (start === staff.start_address ? staff.start_longitude : null),
          endAddress: end.trim() || null,
          endLatitude: eGeo?.lat ?? (end === staff.end_address ? staff.end_latitude : null),
          endLongitude: eGeo?.lng ?? (end === staff.end_address ? staff.end_longitude : null),
        },
      });
      toast.success("Route endpoints saved");
      qc.invalidateQueries({ queryKey: ["staff-addresses"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label className="text-xs flex items-center gap-1">
          <MapPin className="h-3 w-3 shrink-0" /> Route start (home, shop, or depot)
        </Label>
        {/* A route endpoint is a home, shop or depot, not a customer address —
            but it is in the same town as the customers, so the workspace bias
            the proxy applies is exactly right for it. Stored as one line, so
            a match writes the provider's formatted address rather than the
            split fields a property gets. */}
        <AddressAutocomplete
          value={start}
          onChangeText={(t) => {
            setStart(t);
            setStartPin(null);
          }}
          onResolved={(r) => {
            setStart(r.address.formatted);
            setStartPin(
              r.address.latitude != null && r.address.longitude != null
                ? { lat: r.address.latitude, lng: r.address.longitude }
                : null,
            );
          }}
          placeholder="123 Main St, Austin, TX 78701"
          disabled={!canEdit}
        />
        {staff.start_latitude != null && (
          <p className="text-3xs text-muted-foreground">
            Pinned: {Number(staff.start_latitude).toFixed(4)}, {Number(staff.start_longitude).toFixed(4)}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs flex items-center gap-1">
          <MapPin className="h-3 w-3 shrink-0" /> Route end (dump, home, shop)
        </Label>
        <AddressAutocomplete
          value={end}
          onChangeText={(t) => {
            setEnd(t);
            setEndPin(null);
          }}
          onResolved={(r) => {
            setEnd(r.address.formatted);
            setEndPin(
              r.address.latitude != null && r.address.longitude != null
                ? { lat: r.address.latitude, lng: r.address.longitude }
                : null,
            );
          }}
          placeholder="Landfill or home address"
          disabled={!canEdit}
        />
        {staff.end_latitude != null && (
          <p className="text-3xs text-muted-foreground">
            Pinned: {Number(staff.end_latitude).toFixed(4)}, {Number(staff.end_longitude).toFixed(4)}
          </p>
        )}
      </div>
      {/* Routing eligibility (finding #26).
          These two sat side by side as "Field technician (can be assigned
          routes)" and "Available for routing today" with no explanation of
          either, and nothing said that the second only means anything when the
          first is on. They are a permanent fact and a temporary one; the copy
          now says which is which, and the second is disabled when it cannot
          apply rather than sitting there tickable and inert. */}
      <div className="sm:col-span-2 space-y-3 border-t pt-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            defaultChecked={staff.is_field_tech ?? true}
            disabled={!canEdit}
            onChange={(e) => routingMut.mutate({ staffId: staff.id, isFieldTech: e.target.checked })}
          />
          <span>
            <span className="font-medium">Runs routes</span>
            <span className="block text-xs text-muted-foreground">
              Gets a lane on the dispatch board and can be assigned visits. Tick it for an owner or
              office manager who also runs a truck; untick it for a tech who has moved inside.
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${staff.is_field_tech ? "" : "opacity-50"}`}>
          <input
            type="checkbox"
            className="mt-1"
            defaultChecked={staff.routing_available ?? true}
            disabled={!canEdit || !staff.is_field_tech}
            onChange={(e) => routingMut.mutate({ staffId: staff.id, routingAvailable: e.target.checked })}
          />
          <span>
            <span className="font-medium">Available right now</span>
            <span className="block text-xs text-muted-foreground">
              {staff.is_field_tech
                ? "Untick while someone is on leave, sick or training. They stay on the board, greyed out, and auto-assign and Optimize skip them, but you can still schedule their work for a later day."
                : "Only applies to people who run routes."}
            </span>
          </span>
        </label>
        {/* "Daily capacity (min)" was here, and it was removed on 2026-08-26.
            Nobody had ever set it: 0 of 11 staff rows, across 0 of 4
            organizations. The planner reads COALESCE(daily_capacity_minutes,
            480), so every technician has always been sized at a flat eight
            hours and the field changed nothing for anyone.

            It asked for a number in MINUTES, next to two address fields and
            two tickboxes, from somebody running two trucks. The honest answer
            for an unused control that expensive to understand is to take it
            away rather than explain it better. If per-person capacity is
            wanted later it should be a workday in hours, not 480. */}
      </div>
      {canEdit && (
        <div className="sm:col-span-2 flex justify-end">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save addresses"}
          </Button>
        </div>
      )}
    </div>
  );
}
