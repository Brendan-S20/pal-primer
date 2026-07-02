import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listOrgUsers, changeUserRole, setStaffActive } from "@/lib/users.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useMyRole } from "@/hooks/useMyRole";

export const Route = createFileRoute("/_authenticated/settings/users")({
  component: UsersPage,
});

const ROLES = [
  { value: "owner", label: "Owner" },
  { value: "office_manager", label: "Office manager" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "tech", label: "Technician" },
];

function UsersPage() {
  const qc = useQueryClient();
  const { role: myRole } = useMyRole();
  const canEdit = myRole === "owner";

  const listFn = useServerFn(listOrgUsers);
  const changeFn = useServerFn(changeUserRole);
  const activeFn = useServerFn(setStaffActive);

  const { data, isLoading } = useQuery({ queryKey: ["org-users"], queryFn: () => listFn() });

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users & roles</h1>
        <p className="text-sm text-muted-foreground">
          Owners can change roles and deactivate staff. Techs only see their own routes.
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
                    <th className="pb-2">Name</th>
                    <th className="pb-2">Email</th>
                    <th className="pb-2">Role</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(data?.users ?? []).map((u: any) => (
                    <tr key={u.user_id}>
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
                          <Badge variant="secondary">{u.role}</Badge>
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
                  ))}
                  {(data?.users ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-muted-foreground">
                        No team members yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            To invite a new teammate, share the sign-up link and then assign their role here after they create an account.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
