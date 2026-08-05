import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  getAutomationSettings,
  updateAutomationSettings,
} from "@/lib/automation.functions";
import {
  NET_DAYS_MIN,
  NET_DAYS_MAX,
  GRACE_DAYS_MIN,
  GRACE_DAYS_MAX,
} from "@/lib/billing-settings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const key = ["automation"] as const;

// B9: the discoverable home for client-invoicing settings (net terms, grace
// period, auto-send). Lives in the Financial settings group next to the
// platform-subscription "Billing" page, which is HoundStack's OWN SaaS bill,
// not the tenant's client invoicing. Both this page and Settings > Automation
// read/write the same org columns through the one owning server fn
// (updateAutomationSettings), which patches only the fields each page sends.
export const Route = createFileRoute("/_authenticated/settings/invoicing")({
  head: () => ({ meta: [{ title: "Invoicing · HoundStack" }] }),
  component: InvoicingPage,
});

function InvoicingPage() {
  const load = useServerFn(getAutomationSettings);
  const save = useServerFn(updateAutomationSettings);
  const opts = queryOptions({ queryKey: key, queryFn: () => load() });
  const { data, refetch } = useSuspenseQuery(opts);

  const [autoInv, setAutoInv] = useState<boolean>(data.auto_invoice_enabled);
  const [netDays, setNetDays] = useState<number>(data.invoice_net_days ?? 15);
  const [graceDays, setGraceDays] = useState<number>(data.invoice_grace_days ?? 3);

  useEffect(() => {
    setAutoInv(data.auto_invoice_enabled);
    setNetDays(data.invoice_net_days ?? 15);
    setGraceDays(data.invoice_grace_days ?? 3);
  }, [data]);

  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          autoInvoiceEnabled: autoInv,
          invoiceNetDays: netDays,
          invoiceGraceDays: graceDays,
        },
      }),
    onSuccess: () => {
      toast.success("Invoicing settings saved");
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Invoicing</h2>
        <p className="text-sm text-muted-foreground">
          How invoices to your clients are dated, held for review, and sent. This is separate from
          your own HoundStack subscription under{" "}
          <Link to="/settings/billing" className="text-primary underline">
            Settings &rsaquo; Billing
          </Link>
          .
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payment terms</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-xs">
            <Label htmlFor="netdays">Net terms (days)</Label>
            <Input
              id="netdays"
              type="number"
              min={NET_DAYS_MIN}
              max={NET_DAYS_MAX}
              value={netDays}
              onChange={(e) => setNetDays(Number(e.target.value))}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Invoices are due {netDays} day{netDays === 1 ? "" : "s"} after they're sent (net{" "}
            {netDays}). Open invoices past their due date show as overdue on the Invoices page and
            in the client portal.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Automatic invoicing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoInv}
              onChange={(e) => setAutoInv(e.target.checked)}
            />
            Bill clients automatically on each client's cadence
          </label>
          <p className="text-xs text-muted-foreground">
            When on, invoices for completed and billable-skipped postpaid visits are generated at
            the end of each client's billing cycle (set per client), held for the grace period
            below, then emailed automatically. A nightly worker runs this.
          </p>

          <div className="max-w-xs pt-1">
            <Label htmlFor="gracedays">Grace period (days)</Label>
            <Input
              id="gracedays"
              type="number"
              min={GRACE_DAYS_MIN}
              max={GRACE_DAYS_MAX}
              value={graceDays}
              onChange={(e) => setGraceDays(Number(e.target.value))}
              disabled={!autoInv}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Auto-generated invoices wait {graceDays} day{graceDays === 1 ? "" : "s"} for review
            before they send, so you can edit or void them first. Set 0 to send the same day.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoice sending lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Held (scheduled to send)</span> — a
            freshly auto-generated invoice waits out its grace period. On the Invoices page and in
            the invoice drawer it shows a{" "}
            <span className="font-medium text-foreground">Scheduled to send {"{date}"}</span> chip.
          </p>
          <p>
            <span className="font-medium text-foreground">Send now</span> — open a held invoice and
            use <span className="font-medium text-foreground">Send now</span> to email it right
            away, bypassing the remaining grace. It stamps the invoice as sent and takes it out of
            the nightly auto-send loop, so the client never gets it twice.
          </p>
          <p>
            <span className="font-medium text-foreground">Sent</span> — once emailed (automatically
            at the end of grace, or via Send now), the invoice shows a{" "}
            <span className="font-medium text-foreground">Sent {"{date}"}</span> chip and starts its
            net-terms countdown to the due date.
          </p>
        </CardContent>
      </Card>

      <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
        {mut.isPending ? "Saving…" : "Save invoicing settings"}
      </Button>
    </div>
  );
}
