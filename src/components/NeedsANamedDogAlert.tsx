import { needsANamedDogMessage } from "@/lib/new-client-dogs";

/** The new-client wizard's inline refusal on the Dogs (or Pets) step: a
 *  residential client cannot go on with no named dog (lib/new-client-dogs).
 *  On the page, beside the rows, so it is still there after a toast would
 *  have gone; `id` is what the first name field's aria-describedby names. */
export function NeedsANamedDogAlert({ pets = false }: { pets?: boolean }) {
  return (
    <div
      id="needs-a-named-dog"
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {needsANamedDogMessage(pets)}
    </div>
  );
}
