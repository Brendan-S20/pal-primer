import type { ClientSmsConsentWording } from "@/lib/client-sms-consent";

/**
 * The client consent sentence with the business's Terms and Privacy as real
 * links (#538). The stored text carries the same URLs written out
 * (`wording.text`); here they open in a new tab so following one does not
 * lose a half-filled form.
 */
export function ClientSmsConsentWordingText({ wording }: { wording: ClientSmsConsentWording }) {
  const links = [
    wording.termsUrl ? { label: "Terms", url: wording.termsUrl } : null,
    wording.privacyUrl ? { label: "Privacy Policy", url: wording.privacyUrl } : null,
  ].filter((l): l is { label: string; url: string } => l !== null);
  if (!links.length) return <>{wording.lead}</>;
  return (
    <>
      {wording.lead} {wording.displayName}{" "}
      {links.map((l, i) => (
        <span key={l.label}>
          {i > 0 && " "}
          <a href={l.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
            {l.label}
          </a>
          {i === links.length - 1 ? "." : ","}
        </span>
      ))}
    </>
  );
}
