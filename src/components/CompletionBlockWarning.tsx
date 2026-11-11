// The warning every Complete button shows for a client the owner's BLOCK
// rule holds (#851 follow-up; the rules are in src/lib/completion-block.ts).
//
//   const block = useCompletionBlockWarning();
//   ...
//   const go = await block.check(visitId);
//   if (go === "cancelled") return;          // nothing was saved
//   complete({ ..., blockAcknowledged: go === "acknowledged" });
//   ...
//   return <>{block.dialog}...</>
//
// It never refuses. A lookup that fails (no signal, a server error) is read
// as "not blocked" so the Complete is never stuck behind it; the server
// works the block out again when the completion lands and records it either
// way. My Day prefetches the answer for a groom (usePrefetchCompletionBlock),
// so a tech in a dead zone still sees the warning from the cached answer.
//
// Shared by My Day (a tech screen, so every word is t()) and the office's
// drawer, board and client Visits tab.
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { getCompletionBlockWarning } from "@/lib/completion-block.functions";
import { completionBlockReason, type CompletionBlockWarning } from "@/lib/completion-block";
import { formatDay } from "@/lib/format";
import { useIntlLocale } from "@/lib/i18n";
import { useOrgTimezone } from "@/hooks/useOrgToday";

export type CompletionBlockAnswer = "clear" | "acknowledged" | "cancelled";

const blockKey = (visitId: string) => ["completion-block", visitId] as const;

/** My Day: fetch a groom's answer while the card is on screen, so the warning
 *  can still be shown from cache when the signal drops before Complete. */
export function usePrefetchCompletionBlock(visitId: string, enabled: boolean) {
  const get = useServerFn(getCompletionBlockWarning);
  useQuery({
    queryKey: blockKey(visitId),
    queryFn: () => get({ data: { visitId } }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** The dialog's words, without the dialog. Exported for the tests. */
export function CompletionBlockDescription({ warning }: { warning: CompletionBlockWarning }) {
  const { t } = useTranslation();
  const locale = useIntlLocale();
  const tz = useOrgTimezone();
  const reason = completionBlockReason(warning);
  const who = warning.setBy ?? t("completionBlock.theOwner");
  return (
    <>
      <p className="break-words font-medium text-foreground" data-testid="completion-block-reason">
        {reason ? (
          <>
            {t("completionBlock.reasonLabel")} <bdi>{reason}</bdi>
          </>
        ) : (
          t("completionBlock.noReason")
        )}
      </p>
      <p className="break-words">
        {warning.setAt
          ? t("completionBlock.setByOn", { who, when: formatDay(warning.setAt, locale, tz) })
          : t("completionBlock.setBy", { who })}
      </p>
      <p>{t("completionBlock.body")}</p>
    </>
  );
}

export function useCompletionBlockWarning() {
  const { t } = useTranslation();
  const get = useServerFn(getCompletionBlockWarning);
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();

  /** Shows the warning for `warning`, or answers "clear" when there is none. */
  const ask = useCallback(
    async (warning: CompletionBlockWarning | null | undefined): Promise<CompletionBlockAnswer> => {
      if (!warning) return "clear";
      const ok = await confirm({
        title: t("completionBlock.title"),
        description: <CompletionBlockDescription warning={warning} />,
        confirmLabel: t("completionBlock.continue"),
        cancelLabel: t("common.cancel"),
      });
      return ok ? "acknowledged" : "cancelled";
    },
    [confirm, t],
  );

  /** Asks the server (fresh), falling back to the cached answer, then asks
   *  the person if the visit is blocked. */
  const check = useCallback(
    async (visitId: string): Promise<CompletionBlockAnswer> => {
      let warning: CompletionBlockWarning | null | undefined;
      try {
        warning = await qc.fetchQuery({
          queryKey: blockKey(visitId),
          queryFn: () => get({ data: { visitId } }),
          staleTime: 0,
          retry: false,
        });
      } catch {
        warning = qc.getQueryData<CompletionBlockWarning | null>(blockKey(visitId));
      }
      return ask(warning);
    },
    [ask, get, qc],
  );

  return { check, ask, dialog };
}
