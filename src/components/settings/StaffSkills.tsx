/**
 * Which services a technician can do, on Users & roles.
 *
 * One tickbox per active service. Nothing ticked means any service, which is
 * what every technician could do before skills existed (20261010200000), so
 * a business that never touches this routes exactly as before. With two or
 * more services a walk and a cleanup are different jobs and the planner
 * needs to know who does which; with one there is nothing to choose, so the
 * block is not drawn at all rather than drawn as a single pointless tick.
 *
 * Each tick saves on its own, like the two routing tickboxes beside it. The
 * rows are 44px on touch (`touch:min-h-11`): a tickbox is a control.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { listServices } from "@/lib/services.functions";
import { listStaffServices, setStaffServices } from "@/lib/staff-services.functions";

export const STAFF_SERVICES_KEY = ["staff-services"] as const;

export function StaffSkills({ staffId, canEdit }: { staffId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const servicesFn = useServerFn(listServices);
  const skillsFn = useServerFn(listStaffServices);
  const saveFn = useServerFn(setStaffServices);

  const servicesQ = useQuery({
    queryKey: ["services", "active"],
    queryFn: () => servicesFn({ data: {} }),
  });
  const skillsQ = useQuery({ queryKey: STAFF_SERVICES_KEY, queryFn: () => skillsFn() });

  const services = servicesQ.data?.services ?? [];
  const mine = new Set(
    (skillsQ.data?.rows ?? []).filter((r) => r.staff_id === staffId).map((r) => r.service_id),
  );

  const save = useMutation({
    mutationFn: (serviceIds: string[]) => saveFn({ data: { staffId, serviceIds } }),
    onSuccess: () => {
      toast.success("Services updated");
      qc.invalidateQueries({ queryKey: STAFF_SERVICES_KEY });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (services.length < 2) return null;

  return (
    <div className="sm:col-span-2 space-y-2 border-t pt-3">
      <Label className="text-xs">Services this person can do</Label>
      <p className="text-xs text-muted-foreground">
        Nothing ticked means any service. Auto-routing only gives a visit to someone who can do it,
        and names any visit nobody picked can take.
      </p>
      <div className="grid gap-1 sm:grid-cols-2">
        {services.map((s) => {
          const on = mine.has(s.id);
          return (
            <label
              key={s.id}
              className={`flex items-center gap-2 rounded-md px-1 text-sm touch:min-h-11 ${save.isPending ? "opacity-60" : ""}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!canEdit || save.isPending || skillsQ.isLoading}
                onChange={(e) => {
                  const next = new Set(mine);
                  if (e.target.checked) next.add(s.id);
                  else next.delete(s.id);
                  save.mutate([...next]);
                }}
              />
              <span className="min-w-0 truncate">{s.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
