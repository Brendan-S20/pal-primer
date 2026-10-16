import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/useMyRole";
import { setLessonSessionUse } from "@/lib/training-packages.functions";

/** On a missed or skipped package lesson: whether it used a session, and the
 * office's override. The business rule chose the starting answer. */
export function LessonSessionUse({
  visit,
}: {
  visit: {
    id: string;
    status: string;
    skip_billable?: boolean | null;
    client_package_id?: string | null;
  };
}) {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const setFn = useServerFn(setLessonSessionUse);
  const uses = visit.skip_billable === true;
  const save = useMutation({
    mutationFn: () => setFn({ data: { visitId: visit.id, usesSession: !uses } }),
    onSuccess: () => {
      for (const key of [["visit-detail", visit.id], ["client-packages"], ["training-session"]])
        void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!visit.client_package_id || !["skipped", "missed"].includes(visit.status)) return null;
  return (
    <section className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <p className="min-w-0 text-sm">
        {uses ? t("training.lessonUsesSession") : t("training.lessonGivenBack")}
      </p>
      {can("manage_pricing") && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {uses ? t("training.giveSessionBack") : t("training.useSession")}
        </Button>
      )}
    </section>
  );
}
