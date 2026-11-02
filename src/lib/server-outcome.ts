// What a server call said, said to the person who made it (#662).
//
// A server function can answer in three ways that are not "done":
//
//   * it throws. TanStack serializes the Error into a 200 response and the
//     client rethrows it, so it arrives at the mutation's onError. What it
//     carries is sometimes a sentence the product wrote and sometimes the
//     database's own words: a Postgres RAISE (SQLSTATE P0001, sometimes with
//     the code in front) or a row-level security refusal, which reads
//     'new row violates row-level security policy for table "subscriptions"'.
//   * it returns `{ error }`: a refusal as data, on a 200.
//   * it returns a result with `assignWarning`: the work was done, but not all
//     of it (a booking that could not be put on the tech's route).
//
// Each of these used to be handled, or not, at each call site. These two
// functions are the one place they are turned into a toast.

import { toast } from "sonner";
import { readableError } from "@/lib/readable-error";

/** Shown for a row-level security refusal when the caller has nothing more
 *  specific to say. The policy's own text names a table, not a reason. */
export const NOT_ALLOWED_MESSAGE =
  "Your role is not allowed to make this change, so nothing was saved. Ask the owner, or someone who can, to do it.";

const RLS = /row-level security|permission denied for (table|relation)/i;
const SQLSTATE_PREFIX = /^(?:ERROR:\s*)?P0001:\s*/i;

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string")
    return (err as { message: string }).message;
  return "";
}

function rawCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string")
    return (err as { code: string }).code;
  return undefined;
}

export type ServerErrorOptions = {
  /** When the server said nothing a person can read (an empty message, a
   *  validator's issue list). */
  fallback: string;
  /** In place of NOT_ALLOWED_MESSAGE, for a refusal by row-level security. */
  refused?: string;
};

/** The sentence a person reads for a failed server call. */
export function serverErrorMessage(err: unknown, opts: ServerErrorOptions): string {
  const message = rawMessage(err).trim().replace(SQLSTATE_PREFIX, "");
  if (RLS.test(message) || rawCode(err) === "42501") return opts.refused ?? NOT_ALLOWED_MESSAGE;
  return readableError(message, opts.fallback);
}

/** onError for a mutation: the server's refusal, in words, as an error toast. */
export function toastServerError(err: unknown, opts: ServerErrorOptions): void {
  toast.error(serverErrorMessage(err, opts));
}

/** The parts of a server result this reads. Anything else is the caller's. */
export type ServerOutcome = {
  error?: unknown;
  assignWarning?: string | null;
};

export type OutcomeToast = {
  /** What happened, when it happened: "Visit booked for Sat, Nov 7 with Ana". */
  success: string;
  /** Further things the person should know that the server did not say,
   *  each a sentence (a booking that landed on a different day). */
  warnings?: Array<string | null | undefined | false>;
  /** For `result.error`. */
  fallback: string;
  refused?: string;
};

export type OutcomeKind = "error" | "warning" | "success";

/**
 * onSuccess for a mutation: `result.error` is an error toast, and the caller
 * should treat the call as failed (leave the dialog open). An `assignWarning`
 * or any caller warning turns the success toast into a warning that still
 * says what was done, with the warnings as its description.
 */
export function toastServerOutcome(
  result: ServerOutcome | null | undefined,
  opts: OutcomeToast,
): OutcomeKind {
  if (result?.error) {
    toast.error(serverErrorMessage(result.error, opts));
    return "error";
  }
  const warnings = [...(opts.warnings ?? []), result?.assignWarning].filter(
    (w): w is string => typeof w === "string" && w.trim() !== "",
  );
  if (warnings.length) {
    toast.warning(opts.success, { description: warnings.join(" "), duration: 12_000 });
    return "warning";
  }
  toast.success(opts.success);
  return "success";
}
