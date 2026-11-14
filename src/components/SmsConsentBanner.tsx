import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { MessageSquareOff } from "lucide-react";
import { getSmsConsentCoverage } from "@/lib/clients.functions";
import { useMyRole } from "@/hooks/useMyRole";
import { useClientTexting } from "@/hooks/useClientTexting";
import { useDismissed } from "@/lib/dismissible";
import { DismissButton } from "@/components/DismissButton";

/**
 * How much of the book can actually be texted.
 *
 * The consent guard turned texting off for every client who had never been
 * asked — correctly, but silently. Without this the only way to discover the
 * gap is one failed send at a time, and an owner whose reminders stopped going
 * out has no way to find out why from any screen.
 *
 * Shown only when there IS a gap. A banner that says "316 of 316, all good"
 * every day is furniture, and furniture is not read on the day it changes.
 *
 * DISMISSIBLE SINCE 2026-10-03, pinned to the two numbers it states. Once the
 * owner has read "56 of 198" it can go; it comes back when either number
 * moves (a new client without consent, one who opted in, a phone added), which
 * is exactly the day it has something new to say. No timed snooze: an
 * unchanged gap is not news. Rule in src/lib/dismissible.ts.
 */
export function SmsConsentBanner() {
  const fn = useServerFn(getSmsConsentCoverage);
  const q = useQuery({ queryKey: ["sms-consent-coverage"], queryFn: () => fn() });
  const { orgId } = useMyRole();
  const texting = useClientTexting();
  const d = q.data;
  const missing = d ? d.withPhone - d.consented : 0;
  const { dismissed, dismiss } = useDismissed(
    "sms-consent-gap",
    d && d.withPhone > 0 && missing > 0 ? `${missing}/${d.withPhone}` : null,
    { orgId },
  );
  if (!d || d.withPhone === 0) return null;
  if (missing <= 0) return null;
  if (dismissed) return null;

  return (
    <div className="flex items-start gap-1 rounded-lg border border-amber-300 bg-amber-50 py-3 ps-3 pe-1 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <MessageSquareOff className="h-4 w-4 shrink-0" />
        <span>
          <strong>
            {missing} of {d.withPhone}
          </strong>{" "}
          clients with a phone number have no texting consent on file,{" "}
          {texting ? (
            "so reminders and notifications will not reach them."
          ) : (
            // #930: Managed texting is on sale, so a business without it is
            // told to set it up, not that texting is coming.
            <>
              so they won&apos;t get texts once you set up texting.{" "}
              <Link
                to="/settings/sms"
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                Set up texting
              </Link>
            </>
          )}
        </span>
        {/* Says what to do, not just what is wrong. Both routes are real: the
            client opts in from their portal, or you record consent you already
            hold on their Communication tab. */}
        <span className="text-amber-800 dark:text-amber-300">
          Ask them to opt in from their portal, or record consent you already have on a
          client&apos;s Communication tab.
        </span>
      </div>
      <DismissButton onClick={dismiss} label="Hide the texting consent notice" className="-my-3" />
    </div>
  );
}
