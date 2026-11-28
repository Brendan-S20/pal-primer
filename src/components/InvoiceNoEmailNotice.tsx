import { Link } from "@tanstack/react-router";

/** Shown in place of any send date when the client has no email (#1065). It
 *  offers only what the screen can really do: add an address, or hand the
 *  invoice over yourself with the pay link or the PDF. */
export function InvoiceNoEmailNotice({
  clientId,
  hasPayLink,
  onAddEmail,
  className = "",
}: {
  clientId: string;
  hasPayLink: boolean;
  onAddEmail?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm ${className}`}
    >
      <p className="font-medium">This invoice can't be emailed. There's no email address.</p>
      <p className="mt-1 text-muted-foreground">
        <Link
          to="/clients/$clientId"
          params={{ clientId }}
          search={{ edit: true }}
          onClick={onAddEmail}
          className="font-medium text-primary underline underline-offset-2"
        >
          Add an email
        </Link>
        , or deliver it yourself: {hasPayLink ? "copy the pay link or " : ""}download the PDF.
      </p>
    </div>
  );
}
