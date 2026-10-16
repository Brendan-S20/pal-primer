import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useServiceLines } from "@/components/CommercialOnly";
import { usePermissions } from "@/hooks/useMyRole";
import { ConfirmStayButton } from "@/components/client-detail/ConfirmStayButton";
import { listRequestedStays } from "@/lib/stay-booking.functions";
import { stayDatesLabel, type StayKind } from "@/lib/stays";
import { windowLabel } from "@/lib/walk-windows";

export function RequestedStays() {
  const { lines, known } = useServiceLines();
  const { can } = usePermissions();
  const offered = known && lines.includes("pet_sitting");
  const fn = useServerFn(listRequestedStays);
  const q = useQuery({
    queryKey: ["requested-stays"],
    queryFn: () => fn(),
    enabled: offered && can("view_client_directory"),
  });
  if (!offered) return null;
  if (q.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Stay requests could not be loaded.
      </p>
    );
  if (!q.data?.stays.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Stay requests</h2>
      <ul className="space-y-3">
        {q.data.stays.map((s) => (
          <li key={s.id} className="space-y-3 rounded-lg border bg-card p-4">
            <div className="min-w-0 break-words">
              <Link
                to="/clients/$clientId"
                params={{ clientId: s.client_id }}
                className="inline-flex min-h-11 items-center font-medium text-primary underline"
              >
                {s.clients?.display_name ?? "Client"}
              </Link>
              <p className="text-sm">
                {s.services?.name} · {stayDatesLabel(s.kind as StayKind, s.starts_on, s.ends_on)}
              </p>
              <p className="text-sm text-muted-foreground">
                {s.pet_ids.length} pets ·{" "}
                {s.kind === "overnight"
                  ? windowLabel(s.overnight_arrival_earliest, s.overnight_arrival_latest)
                  : (s.drop_in_windows as Array<{ earliest: string; latest: string }> | null)
                      ?.map((w) => windowLabel(w.earliest, w.latest))
                      .join(", ")}
              </p>
            </div>
            {s.notes && <p className="whitespace-pre-wrap break-words text-sm">{s.notes}</p>}
            {can("manage_pricing") && <ConfirmStayButton stayId={s.id} clientId={s.client_id} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
