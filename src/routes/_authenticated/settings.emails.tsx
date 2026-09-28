import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getEmailSettings, updateEmailSettings } from "@/lib/email-settings.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const key = ["email-settings"] as const;

export const Route = createFileRoute("/_authenticated/settings/emails")({
  head: () => ({ meta: [{ title: "Email notifications · HoundStack" }] }),
  component: EmailSettingsPage,
});

const ROWS: Array<{ key: keyof Settings; label: string; help: string }> = [
  { key: "notify_email_welcome", label: "Welcome email", help: "Sent to a new client when their record is created." },
  { key: "notify_email_invoice_sent", label: "Invoice sent", help: "Sent when you email a new invoice from the invoice page." },
  { key: "notify_email_quote_sent", label: "Quote sent", help: "Sent when you press Send on a quote, with a link the customer accepts or declines from. Off means Send only marks the quote sent, and you share the link yourself." },
  { key: "notify_email_payment_received", label: "Payment received (receipt)", help: "Sent automatically when a payment is confirmed." },
  { key: "notify_email_overdue", label: "Overdue reminder", help: "Sent by the nightly worker when an invoice is past due." },
  { key: "notify_email_visit_completed", label: "Visit completed", help: "Sent after a tech marks a visit complete. Off by default (can be chatty)." },
  { key: "notify_email_visit_reminder", label: "Day-before visit reminder", help: "Sent early each morning to every client with a visit the next day, with a link to skip or reschedule. Replies go to your business email." },
  { key: "notify_email_weather_reschedule", label: "Weather reschedule", help: "Sent when a visit is bumped due to weather." },
];

type Settings = Awaited<ReturnType<typeof getEmailSettings>>;

function EmailSettingsPage() {
  const load = useServerFn(getEmailSettings);
  const save = useServerFn(updateEmailSettings);
  const { data, refetch } = useSuspenseQuery(queryOptions({ queryKey: key, queryFn: () => load() }));
  const [values, setValues] = useState<Settings>(data);
  useEffect(() => setValues(data), [data]);

  const mut = useMutation({
    mutationFn: () => save({ data: values }),
    onSuccess: () => { toast.success("Email preferences saved"); refetch(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Email notifications</h2>
        <p className="text-sm text-muted-foreground">
          Choose which emails your organization sends to clients.
        </p>
      </div>
      <Card>
        <CardHeader><CardTitle>Notifications</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {ROWS.map((r) => (
            <label key={r.key} className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={values[r.key]}
                onChange={(e) => setValues({ ...values, [r.key]: e.target.checked })}
              />
              <div>
                <div className="font-medium">{r.label}</div>
                <div className="text-xs text-muted-foreground">{r.help}</div>
              </div>
            </label>
          ))}
        </CardContent>
      </Card>
      <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
        {mut.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
