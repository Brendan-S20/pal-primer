import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { getTrainingSession } from "@/lib/training-packages.functions";

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
