import { rejectionAdvice } from "@/lib/texting-rejection";

/**
 * #972: under the status card of a rejected filing, what Twilio's reason
 * means and what to change on this page, for the codes carriers use most
 * (lib/texting-rejection). Twilio's own sentence stays in the status card
 * above; this is the plain-words half. Nothing for a code we have no advice
 * for: an invented explanation is worse than Twilio's own.
 */
export function TextingRejectionAdvice({
  code,
  reason,
}: {
  code: string | null | undefined;
  reason: string | null | undefined;
}) {
  const advice = rejectionAdvice(code, reason);
  if (!advice) return null;
  return (
    <div
      className="min-w-0 space-y-1 rounded-lg border border-destructive/40 bg-card p-4 text-sm"
      data-testid="texting-rejection-advice"
    >
      <div className="font-medium">What to fix: {advice.title}</div>
      <p className="break-words text-xs text-muted-foreground">{advice.fix}</p>
    </div>
  );
}
