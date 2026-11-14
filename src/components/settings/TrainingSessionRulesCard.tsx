import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getTrainingSessionRules,
  saveTrainingSessionRules,
} from "@/lib/training-packages.functions";

/** Whether a no-show or a late cancel uses one of the package's sessions. */
export function TrainingSessionRulesCard({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const get = useServerFn(getTrainingSessionRules);
  const saveFn = useServerFn(saveTrainingSessionRules);
  const q = useQuery({ queryKey: ["training-session-rules"], queryFn: () => get() });
  const [hours, setHours] = useState("24");
  const [uses, setUses] = useState(true);
  const [share, setShare] = useState(true);
  const [skipClosed, setSkipClosed] = useState(true);
  useEffect(() => {
    if (!q.data) return;
    setHours(String(q.data.lateCancelHours));
    setUses(q.data.missedUsesSession);
    setShare(q.data.shareProgress);
    setSkipClosed(q.data.seriesSkipClosed);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          lateCancelHours: Number(hours),
          missedUsesSession: uses,
          shareProgress: share,
          seriesSkipClosed: skipClosed,
        },
      }),
    onSuccess: () => {
      toast.success(t("training.rulesSaved"));
      void qc.invalidateQueries({ queryKey: ["training-session-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const valid = /^\d+$/.test(hours) && Number(hours) <= 168;

  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-4 sm:p-6"
      data-testid="training-session-rules"
    >
      <div className="min-w-0">
        <h3 className="font-semibold">{t("training.rulesTitle")}</h3>
        <p className="text-sm text-muted-foreground">{t("training.rulesDescription")}</p>
      </div>
      {q.error && (
        <p role="alert" className="text-sm text-destructive">
          {q.error.message}
        </p>
      )}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0"
            checked={uses}
            disabled={!canEdit || !q.data}
            onChange={(e) => setUses(e.target.checked)}
          />
          <span className="min-w-0">{t("training.missedUsesSession")}</span>
        </label>
        <div className="max-w-xs space-y-1">
          <Label htmlFor="training-late-cancel-hours">{t("training.lateCancelHours")}</Label>
          <Input
            id="training-late-cancel-hours"
            type="number"
            inputMode="numeric"
            min={0}
            max={168}
            value={hours}
            disabled={!canEdit || !q.data || !uses}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
        <div className="space-y-1 border-t pt-4">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0"
              checked={share}
              disabled={!canEdit || !q.data}
              onChange={(e) => setShare(e.target.checked)}
            />
            <span className="min-w-0">{t("training.shareProgress")}</span>
          </label>
          <p className="text-sm text-muted-foreground">{t("training.shareProgressHint")}</p>
        </div>
        <div className="space-y-1 border-t pt-4">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0"
              checked={skipClosed}
              disabled={!canEdit || !q.data}
              onChange={(e) => setSkipClosed(e.target.checked)}
            />
            <span className="min-w-0">{t("training.seriesSkipClosed")}</span>
          </label>
          <p className="text-sm text-muted-foreground">{t("training.seriesSkipClosedHint")}</p>
        </div>
        {canEdit && (
          <Button type="submit" className="shrink-0" disabled={!q.data || !valid || save.isPending}>
            {save.isPending ? t("training.saving") : t("training.rulesSave")}
          </Button>
        )}
      </form>
    </section>
  );
}
