/**
 * The Summary tab's note about a client with no email address (#1043-2).
 *
 * New clients are opted in to email by default, so a client added without an
 * address was always "enabled but no address", and the tab shouted a warning
 * about a state nobody chose, on a client with nothing to email. Now it says
 * so only when there is something to email (an active service), and as a note,
 * not a warning. Display only: opt-in data and sending are untouched.
 */
export function noEmailNotice(args: {
  emailOptOut: boolean | null | undefined;
  primaryEmail: string | null | undefined;
  activeServiceCount: number;
}): string | null {
  if (args.emailOptOut !== false) return null; // opted out: nothing is promised
  if ((args.primaryEmail ?? "").trim()) return null;
  if (args.activeServiceCount <= 0) return null;
  return "No email address on file, so this client won't get reminders or receipts by email. Add one in Edit client.";
}
