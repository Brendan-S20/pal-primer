// "Invoice this visit" on a completed visit (#605, decision D2: invoice at
// completion). Drawn by CompletedVisitActions, so the shared visit drawer and
// the client's Visits tab both have it.
//
// The invoice it makes names the visit on its line, and marks the visit's
// pending add-ons invoiced, so the billing run and Generate from visits leave
// that work alone. Once the visit is on an invoice this says which one.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { usePermissions } from "@/hooks/useMyRole";
import { getVisitInvoicing, invoiceVisit } from "@/lib/invoices.functions";
import { getEmailSendStatus, sendInvoiceEmail } from "@/lib/notifications.functions";
import { reportQueuedSend } from "@/lib/send-report";
import { formatLineItemDescription } from "@/lib/invoice-labels";
import { formatCents } from "@/lib/digest-alerts";

export function InvoiceThisVisit({ visitId }: { visitId: string }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canBill = can("manage_client_billing");
  const getFn = useServerFn(getVisitInvoicing);
  const invoiceFn = useServerFn(invoiceVisit);
  const emailFn = useServerFn(sendInvoiceEmail);
  const statusFn = useServerFn(getEmailSendStatus);
  const { confirm, dialog } = useConfirmDialog();

  const q = useQuery({
    queryKey: ["visit-invoicing", visitId],
    queryFn: () => getFn({ data: { visitId } }),
    enabled: canBill,
  });

  const m = useMutation({
    mutationFn: () => invoiceFn({ data: { visitId } }),
    onSuccess: (r) => {
      toast.success(`Invoice created: ${formatCents(r.totalCents)}`, {
        action: {
          label: "Email it",
          onClick: () => {
            emailFn({ data: { invoiceId: r.invoiceId } }).then(
              (sent) =>
                reportQueuedSend(sent, {
                  what: "Invoice",
                  poll: statusFn,
                  onSent: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
                }),
              (e: Error) => toast.error(e.message),
            );
          },
        },
      });
      qc.invalidateQueries({ queryKey: ["visit-invoicing", visitId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["client-activity"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!canBill || !q.data) return null;
  const s = q.data;

  if (s.state === "invoiced") {
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-sm">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          On invoice{" "}
          <Link
            to="/invoices/$invoiceId"
            params={{ invoiceId: s.invoiceId }}
            className="font-medium text-primary underline"
          >
            {s.invoiceLabel}
          </Link>
        </span>
      </p>
    );
  }

  if (s.state === "blocked") {
    return <p className="text-xs text-muted-foreground">{s.reason}</p>;
  }

  async function go() {
    if (s.state !== "ready") return;
    const ok = await confirm({
      title: `Invoice this visit for ${formatCents(s.totalCents)}?`,
      description: (
        <>
          <ul className="list-disc space-y-1 ps-5">
            {s.lines.map((l, i) => (
              <li key={i}>
                {formatLineItemDescription(l.description)}: {formatCents(l.amountCents)}
              </li>
            ))}
          </ul>
          <p>
            The invoice opens now. This visit will not be billed again at the end of the client's
            cycle.
          </p>
        </>
      ),
      confirmLabel: "Create invoice",
    });
    if (ok) m.mutate();
  }

  return (
    <div>
      {dialog}
      <Button size="sm" onClick={go} disabled={m.isPending}>
        <FileText className="mr-1.5 h-4 w-4 shrink-0" />
        {m.isPending ? "Invoicing…" : `Invoice this visit · ${formatCents(s.totalCents)}`}
      </Button>
    </div>
  );
}
