// ── A SETTINGS FORM IS NOT DRAWN UNTIL ITS SAVED VALUES ARE HERE (#945) ──
//
// After sign-in an owner opened Settings and read their business name as a
// blank field. The name was saved; the query had not answered yet, and the
// card drew `q.data?.name ?? ""` into a real input in the meantime. A blank
// field that looks editable reads as lost data, and a form that will save
// what it shows can write that blank (or a default standing in for the real
// value) over what is stored.
//
// So a card that edits saved values draws one of three things, never a fourth:
//
//   * the saved values have arrived       → the form, seeded from them
//   * the load failed and nothing is held → an error with Try again
//   * still waiting                       → skeleton fields, with no input,
//                                           select or Save button to touch
//
// "Has arrived" is `data !== undefined`, not `!isLoading`: a failed first load
// is not loading either, and that was the state in which the time zone picker
// showed the default zone, enabled, and saved it on change. A background
// refetch that fails while values ARE held keeps the form: what is on screen
// is still what was stored.
//
// The skeleton is `ui/skeleton.tsx`, which holds itself undrawn for 160ms, so
// a load that answers quickly shows nothing at all rather than a flash of
// grey (CLAUDE.md, "Motion never makes a thumb wait").

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** The part of a react-query result the gate reads. */
export type SettingsQuery<T> = {
  data: T | undefined;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
};

export function SettingsLoadGate<T>({
  query,
  what,
  fields = 2,
  children,
}: {
  query: SettingsQuery<T>;
  /** What is being loaded, for the error and the screen reader: "business details". */
  what: string;
  /** How many skeleton fields stand in for the form. */
  fields?: number;
  children: ReactNode | ((data: T) => ReactNode);
}) {
  if (query.data !== undefined) {
    return <>{typeof children === "function" ? children(query.data) : children}</>;
  }
  if (query.isError) {
    return (
      <SettingsLoadError what={what} onRetry={() => query.refetch()} retrying={query.isFetching} />
    );
  }
  return <SettingsLoadingFields what={what} fields={fields} />;
}

/** Skeleton label + field pairs, and a Save-shaped box, where a form will be. */
export function SettingsLoadingFields({ what, fields = 2 }: { what: string; fields?: number }) {
  return (
    <div role="status" aria-busy="true" data-settings-loading className="space-y-4">
      <span className="sr-only">Loading your saved {what}…</span>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-1.5" aria-hidden="true">
          <Skeleton className="h-4 w-32 max-w-full" />
          <Skeleton className="h-10 w-full max-w-sm" />
        </div>
      ))}
      <Skeleton className="h-9 w-28" aria-hidden="true" />
    </div>
  );
}

export function SettingsLoadError({
  what,
  onRetry,
  retrying = false,
}: {
  what: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div role="alert" data-settings-load-error className="space-y-3">
      <p className="text-sm text-destructive">
        We could not load your saved {what}. Nothing has been changed.
      </p>
      <Button type="button" variant="outline" onClick={onRetry} disabled={retrying}>
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </div>
  );
}
