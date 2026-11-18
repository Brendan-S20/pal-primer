import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { getDispatchSettings } from "@/lib/visits.functions";
import { formatClock } from "@/lib/format";
import { SETUP_WORKDAY_DEFAULTS, workdayField } from "@/lib/setup-workday";

/** The workday, on /setup, in one line, whenever step 1 is done (#987).
 *
 *  Step 1 is done once the business address is saved (onboarding.functions.ts),
 *  and an owner who saved it in Settings first is opened on the first OPEN step,
 *  so they never met the workday question and the 08:00-17:00 column default
 *  applied without anybody seeing it (#769 acceptance 2). This line shows the
 *  hours the business is running on, and Change takes them to step 1, where
 *  the same two fields are editable in place. No new column: it reads the same
 *  dispatch settings step 1 does.
 *
 *  Not drawn on step 1 itself, which already shows the fields. */
export function SetupWorkdayLine({ onChange }: { onChange: () => void }) {
  const fn = useServerFn(getDispatchSettings);
  const q = useQuery({ queryKey: ["dispatch-settings"], queryFn: () => fn() });
  const s = q.data?.settings as
    | { workday_start?: string | null; workday_end?: string | null }
    | undefined;

  let text: string;
  if (q.isPending) text = "Workday: loading…";
  else if (q.isError && !s) text = "Workday: couldn't be read.";
  else {
    const start = workdayField(s?.workday_start, SETUP_WORKDAY_DEFAULTS.start);
    const end = workdayField(s?.workday_end, SETUP_WORKDAY_DEFAULTS.end);
    text = `Workday ${formatClock(start)} to ${formatClock(end)}`;
  }

  return (
    <div
      data-setup-workday-line
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-1 text-sm"
    >
      <span className="min-w-0" role="status">
        {text}
      </span>
      {q.isError && !s ? (
        <Button variant="link" className="h-11 px-1 md:h-8" onClick={() => void q.refetch()}>
          Try again
        </Button>
      ) : (
        <Button
          variant="link"
          className="h-11 px-1 md:h-8"
          onClick={onChange}
          disabled={q.isPending}
          aria-label="Change your workday"
        >
          Change
        </Button>
      )}
    </div>
  );
}
