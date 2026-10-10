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
}: {
  state: AccessOffState;
  onCheckAgain: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
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
        <Button onClick={onCheckAgain} disabled={state.kind === "checking"}>
          {t("accessOff.checkAgain")}
        </Button>
        <Button variant="outline" onClick={onSignOut}>
          {t("nav.signOut")}
        </Button>
      </div>
    </div>
  );
}
