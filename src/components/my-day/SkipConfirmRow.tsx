// Confirm skip / Cancel, and why Confirm is greyed out (R2-45).
//
// A skip needs a written detail as well as a reason code — the office reads it
// when deciding whether the stop is billed. Confirm stayed disabled until the
// details box had something in it, with nothing on screen saying so, which
// left a tech in a driveway tapping a grey button. Same fault the empty add-on
// catalog and the stations marker had; same fix: say why.
//
// Presentational, so it renders in a test with no query client. The rule
// itself is unchanged: a trimmed, non-empty detail is still required.

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function SkipConfirmRow({
  reason,
  pending,
  onConfirm,
  onCancel,
}: {
  reason: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const needsDetail = !reason.trim();
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={needsDetail || pending}
          aria-describedby={needsDetail ? hintId : undefined}
          onClick={onConfirm}
        >
          {t("skip.confirm")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
      {needsDetail && (
        <p id={hintId} className="text-2xs text-muted-foreground" data-skip-details-required>
          {t("skip.detailsRequired")}
        </p>
      )}
    </div>
  );
}
