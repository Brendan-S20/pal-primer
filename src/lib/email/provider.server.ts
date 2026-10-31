// Whether there is a mail provider to hand a message to at all. Every sender
// in this product goes through Resend, and with RESEND_API_KEY unset nothing
// leaves: the direct sends return false and the queue processor refuses to
// run. Asked BEFORE a caller tells a person "sent" (#612).

export function emailProviderConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}
