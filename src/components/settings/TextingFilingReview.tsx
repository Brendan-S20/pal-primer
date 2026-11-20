import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTextingFilingContext } from "@/lib/texting-filing.functions";
import { filingCopy } from "@/lib/texting-filing-copy";

/**
 * #971: what carriers will read, shown to the owner before Submit, word for
 * word. Built by the same `filingCopy` the filing uses, from the same facts
 * (lib/texting-filing.server) and the business email and website typed above,
 * so a change to either field shows here as it is typed.
 *
 * Long links have no space to wrap on, so every paragraph may break anywhere
 * rather than widen the page (CLAUDE.md: text truncates or wraps, it never
 * widens its row).
 */
export function TextingFilingReview({
  dba,
  legalName,
  businessEmail,
  websiteUrl,
}: {
  dba: string;
  legalName: string;
  businessEmail: string;
  websiteUrl: string;
}) {
  const fn = useServerFn(getTextingFilingContext);
  const q = useQuery({ queryKey: ["texting-filing-context"], queryFn: () => fn() });
  if (!q.data) return null;
  const name = q.data.businessName.trim() || dba.trim() || legalName.trim();
  const copy = filingCopy({
    businessName: name,
    lines: q.data.lines,
    portalUrl: q.data.portalUrl,
    bookingUrl: q.data.bookingUrl,
    googleReviewUrl: q.data.googleReviewUrl,
    supportEmail: businessEmail || "[your business email]",
    websiteUrl: websiteUrl || "[your website]",
  });
  const para = "whitespace-pre-line break-words [overflow-wrap:anywhere]";
  return (
    <fieldset
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-sm"
      data-testid="texting-filing-review"
    >
      <legend className="px-1 text-sm font-medium">What carriers will read</legend>
      <p className="text-xs text-muted-foreground">
        This is filed with your details, exactly as written here. It says what you text clients
        about, shows sample texts, and explains how clients agree to them.
      </p>
      <Part title="What your texts are for">
        <p className={para}>{copy.useCaseSummary}</p>
      </Part>
      <Part title="Sample texts">
        <ul className="space-y-2" data-testid="texting-filing-samples">
          {copy.samples.map((s) => (
            <li key={s} className={`rounded-md bg-muted/50 p-2 ${para}`}>
              {s}
            </li>
          ))}
        </ul>
      </Part>
      {/* The filing sends one paragraph (AdditionalInformation). The owner
          reads the same words with the three ways as a numbered list, so a
          150-word block is readable at 390 (#971 review). */}
      <Part title="How clients agree to texts">
        <p className={para}>{copy.optInIntro}:</p>
        <ol className="mt-1 list-decimal space-y-1 ps-5" data-testid="texting-filing-optin-ways">
          {copy.optInMethods.map((m) => (
            <li key={m} className={para}>
              {m}
            </li>
          ))}
        </ol>
        <p className={`mt-1 ${para}`}>{copy.optInOutro}</p>
      </Part>
      <Part title="The text a client gets when they agree">
        <p className={para}>{copy.optInConfirmationMessage}</p>
      </Part>
      <Part title="The reply to HELP">
        <p className={para}>{copy.helpMessageSample}</p>
      </Part>
    </fieldset>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="text-xs">{children}</div>
    </div>
  );
}
