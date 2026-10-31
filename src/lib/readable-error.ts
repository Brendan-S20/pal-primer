import { isValidationIssues } from "@/lib/monitoring/policy";

/**
 * The text a toast shows for a failed server call.
 *
 * A server function whose input fails its validator throws the issue list as
 * JSON, and a toast of `e.message` then shows a person brackets and field
 * paths (#608: every grooming skip reason did this). That message is for a
 * developer, so it becomes `fallback`, which the caller writes in the user's
 * language. Any other message is the product saying no in words, and is
 * shown as it is.
 */
export function readableError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message.trim() || isValidationIssues(message.trim())) return fallback;
  return message;
}
