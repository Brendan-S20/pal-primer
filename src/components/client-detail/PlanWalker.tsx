/**
 * The walker on a walk plan, in the plan's detail drawer (#731, F-17).
 *
 * New walks this plan makes go to this person when they are free that day.
 * Walks already on the schedule are not moved: the line under the select
 * says so, because a dispatcher who changes the walker would otherwise expect
 * next Tuesday to follow.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { walkerOptions } from "@/lib/walk-groups";
import { getPlanWalker, setPlanWalker } from "@/lib/plan-walker.functions";

export function PlanWalker({ subscriptionId }: { subscriptionId: string }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getPlanWalker);
  const setFn = useServerFn(setPlanWalker);
  const key = ["plan-walker", subscriptionId];
  const q = useQuery({ queryKey: key, queryFn: () => getFn({ data: { subscriptionId } }) });
  const save = useMutation({
    mutationFn: (walkerId: string | null) => setFn({ data: { subscriptionId, walkerId } }),
    onSuccess: () => {
      toast.success("Walker saved");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const people = q.data?.people ?? [];
  const walkers = people.filter((p) => p.active && p.is_field_tech);
  const current = q.data?.walkerId ?? null;
  const options = walkerOptions(walkers, people, current);
  const id = `plan-walker-${subscriptionId}`;
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Walker
      </Label>
      <select
        id={id}
        className="min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
        value={current ?? ""}
        disabled={q.isLoading || save.isPending}
        onChange={(e) => save.mutate(e.target.value || null)}
      >
        <option value="">No walker on the plan</option>
        {options.map((option) => (
          <option key={option.id} value={option.id} disabled={option.outsideList}>
            {option.label}
            {option.outsideList ? " (does not run routes)" : ""}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        New walks from this plan go to this walker when they are free that day. Walks already on the
        schedule keep whoever has them.
      </p>
      {q.error && (
        <p role="alert" className="text-xs text-destructive">
          {(q.error as Error).message}
        </p>
      )}
    </div>
  );
}
