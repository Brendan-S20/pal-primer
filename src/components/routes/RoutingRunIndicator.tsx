/**
 * "Planning routes…" in the app header, while auto-routing runs somewhere the
 * person is not looking.
 *
 * ── WHY IT IS IN THE HEADER ───────────────────────────────────────────────
 *
 * The owner asked for auto-routing to be dismissable into the background.
 * Something has to say it is still going, on whatever page the person went to
 * next, and has to be the way back to it. The header is the one strip every
 * office page has at every width, so that is where it lives: beside the bell,
 * a 44px pill that is icon-only below `sm` and grows a label above it.
 *
 * It renders nothing at all when there is no run, so the header a person sees
 * every day is unchanged.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────
 *
 *   running   a spinner and the stage ("Road times 2/5"), with a bar where
 *             the progress is knowable. Tap: /routes, panel open.
 *   ready     "Routes ready, review". Tap: /routes, where the panel replays
 *             the run's result and marks it seen.
 *   failed    "Routing did not finish". Tap: the same, with the reason.
 *
 * And it is the half of the watcher that is always mounted: when a run
 * finishes while the panel is closed, this is what raises the toast. The
 * panel announces it instead when it is open (routingUi.claim decides which).
 *
 * Its words go through t(): it is drawn on My Day, which is a technician's
 * screen and speaks their language (tests/support/tech-screens.ts), and on a
 * one-truck business the person who routes is also the person on My Day.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { useMyRole } from "@/hooks/useMyRole";
import { routingUi, useRoutingRuns, useRoutingUi } from "@/hooks/useRoutingRuns";
import { indicatorState, isActive, progressFraction, type RoutingRunRow } from "@/lib/routing-run";

/** Where every tap goes. The page opens the panel; the panel does the rest. */
export const ROUTES_REVIEW_HREF = "/routes?autoroute=review";

export function RoutingRunIndicator() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { role } = useMyRole();
  // Only the roles can_write_org lets route. A technician's phone never polls.
  const canRoute = role === "owner" || role === "office_manager" || role === "dispatcher";
  const { runs, serverNow } = useRoutingRuns(canRoute);
  const { panelOpen } = useRoutingUi();
  const state = indicatorState(runs, serverNow);

  const open = () => void navigate({ href: ROUTES_REVIEW_HREF });

  // ── The watcher: a run this tab saw running has finished. ─────────────
  const lastStatus = useRef(new Map<string, RoutingRunRow["status"]>());
  useEffect(() => {
    for (const run of runs) {
      const before = lastStatus.current.get(run.id);
      lastStatus.current.set(run.id, run.status);
      if (!before || !isActive(before) || isActive(run.status)) continue;
      // The board behind whatever page this is may be showing the old order.
      if (run.status === "succeeded") qc.invalidateQueries({ queryKey: ["visits"] });
      if (routingUi.get().panelOpen) continue;
      if (!routingUi.claim(`finished:${run.id}`)) continue;
      if (run.status === "succeeded") {
        toast.success(t("routingRun.readyToast"), {
          description: t("routingRun.readyToastBody"),
          duration: 12000,
          action: { label: t("routingRun.review"), onClick: open },
        });
      } else {
        toast.error(t("routingRun.failedToast"), {
          duration: 12000,
          action: { label: t("routingRun.review"), onClick: open },
        });
      }
    }
    // `open` and `t` are stable enough; re-running on them would re-read the
    // same statuses and do nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  if (state.kind === "idle") return null;
  // On /routes with the panel open, the panel shows all of this already.
  if (panelOpen) return null;

  const run = state.run;
  const fraction = state.kind === "running" ? progressFraction(run) : null;
  const label =
    state.kind === "running"
      ? run.stage === "saving"
        ? t("routingRun.stageSaving")
        : run.stage === "optimizing"
          ? t("routingRun.stageOptimizing", { done: run.days_done, total: run.days_total })
          : run.stage === "road_times"
            ? t("routingRun.stageRoadTimes", { done: run.days_done, total: run.days_total })
            : t("routingRun.planning")
      : state.kind === "ready"
        ? t("routingRun.ready")
        : t("routingRun.failed");
  const aria =
    state.kind === "running"
      ? t("routingRun.openPlanning")
      : state.kind === "ready"
        ? t("routingRun.openReview")
        : t("routingRun.openFailed");

  return (
    <button
      type="button"
      onClick={open}
      aria-label={aria}
      title={aria}
      data-routing-run={state.kind}
      // 44px square below `sm` (the glyph alone), a pill with its label above.
      // `shrink-0` so the search field beside it, which is `flex-1`, cannot
      // squeeze it under the floor at 320px.
      className={`relative flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-xs font-medium transition-colors sm:max-w-[14rem] ${
        state.kind === "ready"
          ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
          : state.kind === "failed"
            ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/10"
            : "bg-background/60 text-foreground hover:bg-muted"
      }`}
    >
      {state.kind === "running" ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      ) : state.kind === "ready" ? (
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      )}
      <span className="hidden min-w-0 truncate sm:inline">{label}</span>
      {fraction != null && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
          <span
            className="hs-meter block h-full bg-primary"
            style={{ "--hs-meter": `${Math.round(fraction * 100)}%` } as CSSProperties}
          />
        </span>
      )}
    </button>
  );
}
