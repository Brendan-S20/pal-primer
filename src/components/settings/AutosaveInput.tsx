import { useEffect, useRef, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

/** An input that saves what was typed without waiting for the person to leave
 *  it (#981).
 *
 *  Settings → Scheduling saved its time and number fields on blur. A focused
 *  field is not blurred by a reload, a closed tab or, reliably, a navigation,
 *  so a workday end changed to 17:30 and followed by F5 came back as 17:00.
 *  This one commits a short pause after the last keystroke, again on blur, and
 *  once more as it unmounts, so the value cannot sit unsaved in the box.
 *
 *  It is uncontrolled, like the fields it replaces (`defaultValue` is read at
 *  mount; the page does not render the form until its settings have arrived).
 *
 *  `onCommit(value)` returns whether the value was accepted and saved. A value
 *  that is not (out of range, empty, or refused by the server) is not
 *  remembered as committed, so a later blur tries again; on blur it is put
 *  back to the last good value so the box never shows something that is not
 *  stored. Nothing is committed when the value equals the last good one. */
export function AutosaveInput({
  defaultValue,
  onCommit,
  delayMs = 700,
  onBlur,
  ...rest
}: Omit<ComponentProps<typeof Input>, "onChange" | "value"> & {
  onCommit: (value: string) => boolean | Promise<boolean>;
  delayMs?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committed = useRef(String(defaultValue ?? ""));
  // The last thing typed. On unmount React has already detached `ref`, so the
  // cleanup flush cannot read the element.
  const latest = useRef(String(defaultValue ?? ""));
  const commit = useRef(onCommit);
  commit.current = onCommit;

  const flush = (resetIfRefused: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = ref.current?.value ?? latest.current;
    if (value === committed.current) return;
    void Promise.resolve(commit.current(value)).then((ok) => {
      if (ok) committed.current = value;
      else if (resetIfRefused && ref.current && ref.current.value === value) {
        ref.current.value = committed.current;
      }
    });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(
    () => () => {
      flushRef.current(false);
    },
    [],
  );

  return (
    <Input
      {...rest}
      ref={ref}
      defaultValue={defaultValue}
      onChange={(e) => {
        latest.current = e.target.value;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(false), delayMs);
      }}
      onBlur={(e) => {
        flush(true);
        onBlur?.(e);
      }}
    />
  );
}
