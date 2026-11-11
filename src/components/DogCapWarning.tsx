// The warning every assign control shows before a walk goes over its
// walker's dog cap (#731, "warn but allow"; the rules are in
// src/lib/dog-cap.ts). The same shape as #872's CompletionBlockWarning:
//
//   const dogCap = useDogCapWarning();
//   ...
//   const r = await dogCap.run((ack) => assign({ data: { ..., overCapAcknowledged: ack } }));
//   if (r === null) return;                  // cancelled: nothing was saved
//   ...
//   return <>{dogCap.dialog}...</>
//
// `run` sends the write once without the confirmation. If the database
// refused it for the cap, nothing was saved; the warning is shown, and
// "Assign anyway" sends the same write again with the confirmation, which
// saves it and records who went over and by how much. Cancel sends nothing.
//
// Office screens only (the Group walks panel, the board, the visit drawer),
// so the words are English, like the rest of those screens.
import { useCallback } from "react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { dogCapSentence, runWithDogCapWarning, type DogCapWarning } from "@/lib/dog-cap";

/** The dialog's words, without the dialog. Exported for the tests. */
export function DogCapWarningDescription({
  warning,
  count = 1,
}: {
  warning: DogCapWarning;
  /** How many visits Cover could not fit under anyone's cap. */
  count?: number;
}) {
  return (
    <>
      <p className="break-words font-medium text-foreground" data-testid="dog-cap-warning">
        {dogCapSentence(warning)}
      </p>
      {warning.walker ? (
        <p className="break-words">
          <bdi>{warning.walker}</bdi> walks up to {warning.cap} dogs at a time.
        </p>
      ) : null}
      {count > 1 ? (
        <p>
          {count} visits would go over a walker's dog cap; this is the first of them. Assign anyway
          moves all {count}.
        </p>
      ) : null}
      <p>
        You can still assign it. It will be saved, recorded as over the cap by{" "}
        {warning.dogs - warning.cap}, and flagged on the board and in My Day until it is back under.
      </p>
    </>
  );
}

export function useDogCapWarning() {
  const { confirm, dialog } = useConfirmDialog();

  /** Shows the warning; true when the person chose "Assign anyway". */
  const ask = useCallback(
    (warning: DogCapWarning, count?: number) =>
      confirm({
        title: "Over the dog cap",
        description: <DogCapWarningDescription warning={warning} count={count} />,
        confirmLabel: "Assign anyway",
        cancelLabel: "Cancel",
      }),
    [confirm],
  );

  /** Sends `attempt(false)`; on a dog cap refusal asks, and on "Assign
   *  anyway" sends `attempt(true)`. Null when the person cancelled. */
  const run = useCallback(
    <T,>(attempt: (acknowledged: boolean) => Promise<T>): Promise<T | null> =>
      runWithDogCapWarning(attempt, ask),
    [ask],
  );

  return { run, ask, dialog };
}
