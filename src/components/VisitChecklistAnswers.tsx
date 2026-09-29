import { CheckCircle2, Circle } from "lucide-react";
import type { ChecklistAnswer } from "@/lib/visit-checklist";

/**
 * A visit's checklist as the tech answered it: every item, ticked or not.
 *
 * Shared by the office's visit drawer and the tech's own completed card, so
 * both read the same record the same way. The labels are the ones copied onto
 * the visit when it was completed, not the owner's list as it reads today.
 *
 * A label wraps rather than truncates: "Waste bagged and disposed in the
 * customer's green bin, not the grey one" is a sentence somebody wrote to be
 * read, and `[overflow-wrap:anywhere]` keeps even one long unbroken word
 * inside a 320px card instead of widening it.
 */
export function VisitChecklistAnswers({ answers }: { answers: readonly ChecklistAnswer[] }) {
  if (answers.length === 0) return null;
  const done = answers.filter((a) => a.checked).length;
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        Checklist · {done} of {answers.length}
      </h3>
      <ul className="space-y-1">
        {answers.map((a) => (
          <li key={a.id} className="flex items-start gap-2 text-sm">
            {a.checked ? (
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
                aria-hidden="true"
              />
            ) : (
              <Circle
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span
              className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${a.checked ? "" : "text-muted-foreground"}`}
            >
              {a.label}
              <span className="sr-only">{a.checked ? ": checked" : ": not checked"}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
