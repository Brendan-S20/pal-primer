// The welcome email a new client can be sent when the office creates them.
//
// OPT-IN, everywhere, and unchecked by default. Until 2026-11-09 it went to
// every new client with an email address the moment Create client was
// pressed, with no warning and nothing on the form saying it would. The
// onboarding audit (D4) found it the way a pilot would: the first client
// typed in during setup step 3 was emailed "Welcome to <business>" from
// notify.houndstack.com, and the only sign was a toast after the fact.
//
// The rule is the same in and out of setup, because a box that is ticked
// for you outside setup is the same surprise one screen later. The server
// enforces it too (shouldSendWelcome in clients.functions.ts): an absent
// flag sends nothing.

/** The new-client wizard's starting value for "Email them a welcome". */
export const WELCOME_EMAIL_DEFAULT_CHECKED = false;

/**
 * What the box says will be sent, shown before anything is. The subject is
 * the welcome template's own (src/lib/email-templates/welcome.tsx), and a
 * test pins the two together.
 */
export function welcomeEmailPreview(orgName: string | null | undefined): {
  subject: string;
  summary: string;
} {
  return {
    subject: `Welcome to ${orgName?.trim() || "our service"}`,
    summary:
      "A short welcome from your business with their private portal link, where they see upcoming visits and invoices.",
  };
}

/**
 * The client page's "Send welcome email": ask first, naming the recipient
 * and the subject, and send only on yes. Nothing is sent from a click alone.
 */
export async function confirmThenSendWelcome<D>({
  email,
  orgName,
  confirm,
  send,
  describe,
}: {
  email: string;
  orgName: string | null | undefined;
  confirm: (opts: { title: string; description: D; confirmLabel: string }) => Promise<boolean>;
  send: () => void;
  /** Builds the dialog's body from what will be sent. */
  describe: (what: { email: string; subject: string; summary: string }) => D;
}): Promise<boolean> {
  const preview = welcomeEmailPreview(orgName);
  const ok = await confirm({
    title: "Send the welcome email?",
    description: describe({ email, ...preview }),
    confirmLabel: "Send welcome email",
  });
  if (ok) send();
  return ok;
}
