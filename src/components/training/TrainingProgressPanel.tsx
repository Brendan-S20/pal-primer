import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { formatDay } from "@/lib/format";
import { useIntlLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getTrainingSession } from "@/lib/training-packages.functions";
import {
  getSessionProgress,
  saveSessionProgress,
  type LessonHistory,
} from "@/lib/training-progress.functions";

/** No lookup or UI for another service line. */
export function TrainingSessionBadge({
  visitId,
  serviceLine,
}: {
  visitId: string;
  serviceLine?: string | null;
}) {
  return serviceLine === "training" ? <SessionBadge visitId={visitId} /> : null;
}

function SessionBadge({ visitId }: { visitId: string }) {
  const { t } = useTranslation();
  const get = useServerFn(getTrainingSession);
  const { data } = useQuery({
    queryKey: ["training-session", visitId],
    queryFn: () => get({ data: { visitId } }),
  });
  if (!data) return null;
  return (
    <Badge variant="secondary" className="max-w-full whitespace-normal text-xs">
      {t("training.sessionLabel", { n: data.n, total: data.total })}
    </Badge>
  );
}

/** The dog's last few lessons, so the trainer starts where the last one left off. */
function LessonHistoryList({
  data,
}: {
  data: { dog: { name: string } | null; history: LessonHistory[] };
}) {
  const { t } = useTranslation();
  const locale = useIntlLocale();
  return (
    <section className="min-w-0 space-y-2" data-testid="training-lesson-history">
      <h4 className="text-sm font-medium">
        {data.dog ? (
          <Trans
            i18nKey="training.historyForDog"
            components={{ dog: <bdi /> }}
            values={{ dog: data.dog.name }}
          />
        ) : (
          t("training.history")
        )}
      </h4>
      {data.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("training.historyEmpty")}</p>
      ) : (
        <ol className="space-y-2">
          {data.history.map((lesson) => (
            <li
              key={lesson.visitId}
              className="min-w-0 space-y-1 rounded-md bg-muted/50 p-2 text-sm"
            >
              <p className="font-medium">{formatDay(lesson.scheduledOn, locale)}</p>
              {lesson.scores.length > 0 && (
                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                  {lesson.scores.map((s) => (
                    <li key={s.skill} className="min-w-0 break-words">
                      <bdi>{s.skill}</bdi> <span dir="ltr">{s.score}/5</span>
                    </li>
                  ))}
                </ul>
              )}
              {lesson.note && (
                <p className="break-words">
                  <span className="text-muted-foreground">{t("training.note")}: </span>
                  <bdi>{lesson.note}</bdi>
                </p>
              )}
              {lesson.trainerNote && (
                <p className="break-words">
                  <span className="text-muted-foreground">{t("training.trainerNote")}: </span>
                  <bdi>{lesson.trainerNote}</bdi>
                </p>
              )}
              {lesson.homework && (
                <p className="break-words">
                  <span className="text-muted-foreground">{t("training.homework")}: </span>
                  <bdi>{lesson.homework}</bdi>
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Scores, a note and homework for one training lesson. Other lines render nothing. */
export function TrainingProgressPanel({
  visitId,
  serviceLine,
}: {
  visitId: string;
  serviceLine?: string | null;
}) {
  if (serviceLine !== "training") return null;
  return <ProgressForm visitId={visitId} />;
}

function ProgressForm({ visitId }: { visitId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const get = useServerFn(getSessionProgress);
  const saveFn = useServerFn(saveSessionProgress);
  const q = useQuery({
    queryKey: ["session-progress", visitId],
    queryFn: () => get({ data: { visitId } }),
  });
  const [open, setOpen] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [trainerNote, setTrainerNote] = useState("");
  const [homework, setHomework] = useState("");
  const [due, setDue] = useState("");

  useEffect(() => {
    if (!q.data) return;
    const next: Record<string, number> = {};
    for (const row of q.data.scores) next[row.skill_id] = row.score;
    setScores(next);
    setNote(q.data.note);
    setTrainerNote(q.data.trainerNote);
    setHomework(q.data.homework);
    setDue(q.data.homeworkDue ?? "");
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const listed = new Set((q.data?.skills ?? []).map((s) => s.id));
      const fromList = (q.data?.skills ?? []).flatMap((s) =>
        scores[s.id] ? [{ skillId: s.id, score: scores[s.id] }] : [],
      );
      const kept = Object.entries(scores)
        .filter(([id]) => !listed.has(id))
        .map(([skillId, score]) => ({ skillId, score }));
      return saveFn({
        data: {
          visitId,
          scores: [...fromList, ...kept],
          note,
          trainerNote,
          homework,
          homeworkDue: due || null,
        },
      });
    },
    onSuccess: () => {
      toast.success(t("training.saved"));
      qc.invalidateQueries({ queryKey: ["session-progress", visitId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const skills = q.data?.skills ?? [];

  return (
    <section className="mt-3 min-w-0 rounded-md border p-3">
      <Button
        type="button"
        variant="outline"
        className="w-full justify-start"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t("training.hideProgress") : t("training.showProgress")}
      </Button>
      {q.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {q.error.message}
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-4">
          <h3 className="text-sm font-medium">{t("training.progressTitle")}</h3>
          {q.isLoading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
          {skills.length === 0 && !q.isLoading && (
            <p className="text-sm text-muted-foreground">{t("training.noSkills")}</p>
          )}
          {q.data && <LessonHistoryList data={q.data} />}
          <ul className="space-y-3">
            {skills.map((skill) => (
              <li key={skill.id} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words text-sm font-medium">
                  <bdi>{skill.name}</bdi>
                </span>
                <div
                  className="flex shrink-0 gap-1"
                  role="group"
                  aria-label={t("training.skillScore", { skill: skill.name })}
                >
                  {[1, 2, 3, 4, 5].map((n) => {
                    const on = scores[skill.id] === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={on}
                        className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border text-sm ${
                          on
                            ? "border-primary bg-primary/10 font-medium text-primary"
                            : "bg-background"
                        }`}
                        onClick={() =>
                          setScores((prev) => {
                            const next = { ...prev };
                            if (next[skill.id] === n) delete next[skill.id];
                            else next[skill.id] = n;
                            return next;
                          })
                        }
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
          <div className="space-y-1">
            <Label htmlFor={`lesson-note-${visitId}`}>
              {q.data?.shared === false
                ? t("training.noteClientDoesNotSee")
                : t("training.noteClientSees")}
            </Label>
            <Textarea
              id={`lesson-note-${visitId}`}
              value={note}
              maxLength={2000}
              placeholder={t("training.notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`lesson-trainer-note-${visitId}`}>{t("training.trainerNote")}</Label>
            <Textarea
              id={`lesson-trainer-note-${visitId}`}
              value={trainerNote}
              maxLength={2000}
              placeholder={t("training.trainerNotePlaceholder")}
              onChange={(e) => setTrainerNote(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`lesson-homework-${visitId}`}>{t("training.homework")}</Label>
            <Textarea
              id={`lesson-homework-${visitId}`}
              value={homework}
              maxLength={2000}
              placeholder={t("training.homeworkPlaceholder")}
              onChange={(e) => setHomework(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`lesson-due-${visitId}`}>{t("training.due")}</Label>
            <Input
              id={`lesson-due-${visitId}`}
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </div>
          <Button
            type="button"
            className="shrink-0"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t("training.saving") : t("training.save")}
          </Button>
        </div>
      )}
    </section>
  );
}
