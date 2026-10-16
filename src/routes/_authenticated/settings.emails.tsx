import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getEmailSettings, updateEmailSettings } from "@/lib/email-settings.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { pageTitle } from "@/lib/page-title";
import { WeeklyDigestCard } from "@/components/settings/WeeklyDigestCard";
import { usePermissions } from "@/hooks/useMyRole";

const key = ["email-settings"] as const;

export const Route = createFileRoute("/_authenticated/settings/emails")({
  head: () => ({ meta: [{ title: pageTitle("Emails", "Settings") }] }),
  component: EmailSettingsPage,
});

// The switches. quote_followup_days is a number and gets its own control.
type SwitchKey = Exclude<keyof Settings, "quote_followup_days" | "runs_dog_walking" | "runs_pet_sitting">;

const ROWS: Array<{ key: SwitchKey; label: string; help: string }> = [
  { key: "notify_email_welcome", label: "Welcome email", help: "Sent to a new client when their record is created." },
  { key: "notify_email_invoice_sent", label: "Invoice sent", help: "Sent when you email a new invoice from the invoice page." },
  { key: "notify_email_quote_sent", label: "Quote sent", help: "Sent when you press Send on a quote, with a link the client accepts or declines from. Off means Send only marks the quote sent, and you share the link yourself." },
  { key: "notify_email_payment_received", label: "Payment received (receipt)", help: "Sent automatically when a payment is confirmed." },
  { key: "notify_email_overdue", label: "Overdue and declined-card reminders", help: "Sent by the nightly worker when an invoice is past due, and when an automatic charge to a client's card on file is declined (at most once a day per invoice), with a link to update the card or pay." },
  { key: "notify_email_visit_completed", label: "Visit completed", help: "Sent after a tech marks a visit complete. Off by default (can be chatty)." },
  { key: "notify_email_visit_reminder", label: "Day-before visit reminder", help: "Sent early each morning to every client with a visit the next day, with a link to skip or reschedule. Replies go to your business email." },
  { key: "notify_email_on_my_way", label: "On my way (when a text can't go)", help: "Sent instead of the \"on my way\" text when the client has no texting consent, no mobile number, or the text fails. Names the tech and the arrival window." },
  { key: "notify_email_weather_reschedule", label: "Weather reschedule", help: "Sent when a visit is bumped due to weather." },
];

// Dog walking only (#410): drawn for a business that runs it, and sent only
// for walks, so a pet-waste client's emails are unchanged either way.
const WALK_ROWS: Array<{ key: SwitchKey; label: string; help: string }> = [
  { key: "notify_email_walk_not_done", label: "Walk skipped or missed", help: "Sent when a walker skips a walk, with the reason in plain words, or when a walk's day passes and it did not happen." },
  { key: "notify_email_walk_schedule_change", label: "Walk schedule changed", help: "Sent when you move a walk to another day, or change the days or time window of a walk plan. One email per client each time, with the old and new times." },
];

const STAY_ROWS: Array<{ key: SwitchKey; label: string; help: string }> = [
  { key: "notify_email_stay_confirmed", label: "Stay confirmed", help: "Sent when you confirm a stay, with its dates and a link to pay the deposit when one is due." },
  { key: "notify_email_stay_ending", label: "Stay ends tomorrow", help: "Sent the day before a confirmed stay ends, once per stay." },
];

type Settings = Awaited<ReturnType<typeof getEmailSettings>>;

function EmailSettingsPage() {
  // The digest carries revenue, so its server functions ask for
  // view_financials. Drawn for the same people, so nobody gets a card that
  // answers with an error.
  const { can } = usePermissions();
  const canSeeDigest = can("view_financials");
  const load = useServerFn(getEmailSettings);
  const save = useServerFn(updateEmailSettings);
  const { data, refetch } = useSuspenseQuery(queryOptions({ queryKey: key, queryFn: () => load() }));
  const [values, setValues] = useState<Settings>(data);
  useEffect(() => setValues(data), [data]);

  const rows = [...ROWS, ...(values.runs_dog_walking ? WALK_ROWS : []), ...(values.runs_pet_sitting ? STAY_ROWS : [])];
  const mut = useMutation({
    mutationFn: () => {
      const { runs_dog_walking, runs_pet_sitting, notify_email_stay_confirmed, notify_email_stay_ending, notify_email_walk_not_done, notify_email_walk_schedule_change, ...rest } = values;
      return save({ data: {
        ...rest,
        ...(runs_dog_walking ? { notify_email_walk_not_done, notify_email_walk_schedule_change } : {}),
        ...(runs_pet_sitting ? { notify_email_stay_confirmed, notify_email_stay_ending } : {}),
      } });
    },
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
          {rows.map((r) => (
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-sm">
            <label htmlFor="quote-followup-days" className="min-w-0 font-medium">
              Follow up on an unanswered quote
            </label>
            <select
              id="quote-followup-days"
              className="h-9 rounded-md border bg-background px-2 text-sm touch:min-h-11"
              value={values.quote_followup_days}
              disabled={!values.notify_email_quote_sent}
              onChange={(e) => setValues({ ...values, quote_followup_days: Number(e.target.value) })}
            >
              <option value={0}>Never</option>
              {[2, 3, 5, 7, 14].map((d) => (
                <option key={d} value={d}>
                  After {d} days
                </option>
              ))}
            </select>
            <p className="basis-full text-xs text-muted-foreground">
              One reminder email with the same link, sent only while the quote can still be
              accepted. Uses the &ldquo;Quote sent&rdquo; email above.
            </p>
          </div>
        </CardContent>
      </Card>
      <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
        {mut.isPending ? "Saving…" : "Save"}
      </Button>

      {/* Emails the business SENDS are above; the one email HoundStack sends
          the business is here, with its own Save, because it is stored on a
          different row and a single Save for both would hide which saved. */}
      {canSeeDigest && (
        <section className="space-y-3 border-t pt-6">
          <div>
            <h2 className="text-lg font-semibold">Emails to you</h2>
            <p className="text-sm text-muted-foreground">
              What HoundStack sends you about your own business.
            </p>
          </div>
          <WeeklyDigestCard />
        </section>
      )}
    </div>
  );
}
