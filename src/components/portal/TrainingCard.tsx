import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { portalGetTraining } from "@/lib/portal-training.functions";
import { usePortalCtx, fmtDayShort } from "@/lib/portal-ui";

/** The way in to the Training page, on Home and on Visits (lessons are
 *  visits, and the portal's six tabs have no room for a seventh at 320px).
 *  Drawn only for a client the page is for:
 *  one with a package, or of a business that runs training and sells one.
 *  Shares its query with the page, so opening it costs nothing more. */
export function TrainingCard() {
  const { token, slug, verified } = usePortalCtx();
  const getFn = useServerFn(portalGetTraining);
  const q = useQuery({
    queryKey: ["portal", token, "training"],
    queryFn: () => getFn({ data: { token } }),
    staleTime: 30_000,
    enabled: verified,
  });
  const data = q.data;
  if (!data?.visible) return null;
  const active = data.packages.filter((p) => p.state === "active");
  const left = active.reduce((n, p) => n + p.left, 0);
  const next = data.packages
    .flatMap((p) => p.upcoming)
    .sort((a, b) => a.scheduledOn.localeCompare(b.scheduledOn))[0];
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <GraduationCap className="h-4 w-4 shrink-0" /> Training
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm">
        <div className="min-w-0">
          <div className="font-medium">
            {active.length
              ? `${left} session${left === 1 ? "" : "s"} left`
              : "Lesson packages, notes and homework"}
          </div>
          <div className="text-xs text-muted-foreground">
            {next
              ? `Next lesson ${fmtDayShort(next.scheduledOn)}${next.startTime ? ` at ${next.startTime}` : ""}`
              : active.length
                ? "Request your next lesson from your package."
                : "See the packages we offer."}
          </div>
        </div>
        <Button asChild size="sm" variant="outline" className="gap-1">
          <Link to="/portal/$slug/$token/training" params={{ slug, token }}>
            Open training <ArrowRight className="h-3.5 w-3.5 shrink-0" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
