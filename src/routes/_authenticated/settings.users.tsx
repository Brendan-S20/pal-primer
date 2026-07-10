import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
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
import { toast } from "sonner";
import { useMyRole } from "@/hooks/useMyRole";
import { humanizeRole } from "@/lib/humanize";
import { MapPin, ChevronDown, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/users")({
  component: UsersPage,
});

const ROLES = [
  { value: "owner", label: "Owner" },
  { value: "office_manager", label: "Office manager" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "tech", label: "Technician" },
];

async function geocode(q: string): Promise<{ lat: number; lng: number } | null> {
  if (!q.trim()) return null;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { Accept: "application/json" } },
    );
    const j = (await r.json()) as Array<{ lat: string; lon: string }>;
    if (!j?.[0]) return null;
    return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
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
    onSuccess: () => {
      toast.success("Staff updated");
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
        <h1 className="text-2xl font-semibold">Users & roles</h1>
        <p className="text-sm text-muted-foreground">
          Owners can change roles, deactivate staff, and set each technician's route start &amp; end addresses.
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
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
                    const isTech = u.role === "tech";
                    const isOpen = u.staff_id && expanded.has(u.staff_id);
                    const staff = u.staff_id ? staffById.get(u.staff_id) : null;
                    return (
                      <>
                        <tr key={u.user_id}>
                          <td className="py-3">
                            {isTech && u.staff_id ? (
                              <button onClick={() => toggleExpand(u.staff_id)} className="text-muted-foreground hover:text-foreground">
                                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                            ) : null}
                          </td>
                          <td className="py-3 font-medium">{u.display_name ?? "—"}</td>
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
                                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant="secondary">{humanizeRole(u.role)}</Badge>
                            )}
                          </td>
                          <td className="py-3">
                            {u.active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}
                          </td>
                          <td className="py-3 text-right">
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
                      </>
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

  const roleLabel: Record<string, string> = { office_manager: "Office manager", dispatcher: "Dispatcher", tech: "Technician" };

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
            <select value={role} onChange={(e) => setRole(e.target.value as any)} className="h-10 rounded-md border bg-background px-3 text-sm">
              <option value="tech">Technician</option>
              <option value="dispatcher">Dispatcher</option>
              <option value="office_manager">Office manager</option>
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
            <ul className="divide-y">
              {invites.filter((i) => i.status === "pending").map((i) => (
                <li key={i.id} className="flex items-center justify-between py-2 text-sm">
                  <span>{i.email} <span className="text-muted-foreground">· {roleLabel[i.role] ?? i.role}</span></span>
                  <span className="flex items-center gap-3">
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
        start.trim() && start !== staff.start_address ? geocode(start) : Promise.resolve(null),
        end.trim() && end !== staff.end_address ? geocode(end) : Promise.resolve(null),
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
          <MapPin className="h-3 w-3" /> Route start (home, shop, or depot)
        </Label>
        <Input
          value={start}
          onChange={(e) => setStart(e.target.value)}
          placeholder="123 Main St, Austin, TX 78701"
          disabled={!canEdit}
        />
        {staff.start_latitude != null && (
          <p className="text-[10px] text-muted-foreground">
            Pinned: {Number(staff.start_latitude).toFixed(4)}, {Number(staff.start_longitude).toFixed(4)}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs flex items-center gap-1">
          <MapPin className="h-3 w-3" /> Route end (dump, home, shop)
        </Label>
        <Input
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          placeholder="Landfill or home address"
          disabled={!canEdit}
        />
        {staff.end_latitude != null && (
          <p className="text-[10px] text-muted-foreground">
            Pinned: {Number(staff.end_latitude).toFixed(4)}, {Number(staff.end_longitude).toFixed(4)}
          </p>
        )}
      </div>
      {/* Routing eligibility (finding #26). */}
      <div className="sm:col-span-2 flex flex-wrap items-center gap-4 border-t pt-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            defaultChecked={staff.is_field_tech ?? true}
            disabled={!canEdit}
            onChange={(e) => routingMut.mutate({ staffId: staff.id, isFieldTech: e.target.checked })}
          />
          Field technician (can be assigned routes)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            defaultChecked={staff.routing_available ?? true}
            disabled={!canEdit}
            onChange={(e) => routingMut.mutate({ staffId: staff.id, routingAvailable: e.target.checked })}
          />
          Available for routing today
        </label>
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
