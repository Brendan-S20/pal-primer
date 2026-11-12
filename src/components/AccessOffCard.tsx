import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { UserX } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Where /access-off is: asking, told "off" (and by which business), or unable to ask. */
export type AccessOffState =
  | { kind: "checking" }
  | { kind: "off"; business: string | null; checkedAgain: boolean }
  | { kind: "error" };

/**
 * What a person whose access the owner turned off reads (src/routes/access-off.tsx).
 * A technician reads it on their phone, so every word is t() — see
 * tests/support/tech-screens.ts. The business name is the office's own text:
 * it goes in as <business/>'s child, inside a <bdi>, never by interpolation.
 */
export function AccessOffCard({
  state,
  onCheckAgain,
  onSignOut,
  onStartOwn,
}: {
  state: AccessOffState;
  onCheckAgain: () => void;
  onSignOut: () => void;
  /**
   * Leave the business that turned this person off, so the address can start
   * or join another (#765). Absent: the button is not drawn. Resolves when
   * the person has been sent on; throws to say it could not be done.
   */
  onStartOwn?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  // Two taps, not one: leaving cannot be undone from this side.
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(false);
  const leave = async () => {
    if (!onStartOwn) return;
    setLeaveFailed(false);
    setLeaving(true);
    try {
      await onStartOwn();
    } catch {
      setLeaveFailed(true);
    } finally {
      setLeaving(false);
    }
  };
  const business =
    state.kind === "off" && state.business ? state.business : t("accessOff.thisBusiness");

  return (
    <div className="rounded-lg border bg-card p-(--card-pad) text-center">
      <UserX className="mx-auto h-8 w-8 text-muted-foreground shrink-0" aria-hidden />
      <h1 className="mt-3 text-lg font-semibold">{t("accessOff.title")}</h1>
      {state.kind === "checking" && (
        <p className="mt-2 text-sm text-muted-foreground">{t("common.loading")}</p>
      )}
      {state.kind === "off" && (
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans
            i18nKey="accessOff.body"
            components={{ business: <bdi className="font-medium text-foreground">{business}</bdi> }}
          />
        </p>
      )}
      {state.kind === "error" && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {t("accessOff.couldNotCheck")}
        </p>
      )}
      {state.kind === "off" && state.checkedAgain && (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {t("accessOff.stillOff")}
        </p>
      )}
      <div className="mt-5 flex flex-col gap-2">
        <Button onClick={onCheckAgain} disabled={state.kind === "checking" || leaving}>
          {t("accessOff.checkAgain")}
        </Button>
        {onStartOwn && state.kind === "off" && !confirming && (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            {t("accessOff.startOwn")}
          </Button>
        )}
        <Button variant="outline" onClick={onSignOut} disabled={leaving}>
          {t("nav.signOut")}
        </Button>
      </div>
      {onStartOwn && state.kind === "off" && confirming && (
        <div
          className="mt-4 min-w-0 rounded-md border p-3 text-start"
          data-testid="start-own-confirm"
        >
          <p className="break-words text-sm text-muted-foreground">
            <Trans
              i18nKey="accessOff.startOwnExplain"
              components={{
                business: <bdi className="font-medium text-foreground">{business}</bdi>,
              }}
            />
          </p>
          {leaveFailed && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {t("accessOff.startOwnFailed")}
            </p>
          )}
          <div className="mt-3 flex flex-col gap-2">
            <Button
              onClick={() => void leave()}
              disabled={leaving}
              aria-busy={leaving || undefined}
            >
              {leaving ? t("accessOff.startOwnBusy") : t("accessOff.startOwnConfirm")}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={leaving}>
              {t("accessOff.startOwnCancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
