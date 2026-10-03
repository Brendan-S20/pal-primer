import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, ExternalLink, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { DISPUTE_COPY } from "@/lib/disputes";
import { getDisputeQueue, setDisputesInAnalytics } from "@/lib/disputes.functions";
import { pageTitle } from "@/lib/page-title";

// BUILD-12 — the dispute queue.
//
// Owner: "If the invoice is disputed, it should end-up in a dispute queue; then
// that can either be toggled into the analytics or toggled out, it should
// definitely show as an issue/lost."
//
// Its own page rather than a filter on /review, because the two are different
// jobs. The review queue is "records the software could not settle on its own";
// this is "money a customer's bank took back". They need different urgency,
// different vocabulary, and this one has a deadline attached — evidence in
// Stripe is time-boxed, and a dispute buried under visit-timestamp warnings is
// a dispute nobody answers.
//
// Deliberately read-only about the OUTCOME. The decision is Stripe's, and a
// "mark as won" button here would let the app's story diverge from the money.
// What it offers instead is the one lever that is genuinely the owner's: how
// open disputes are counted in their own analytics.

export const Route = createFileRoute("/_authenticated/disputes")({
  head: () => ({ meta: [{ title: pageTitle("Disputes") }] }),
  component: DisputesPage,
});

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);

function DisputesPage() {
  const qc = useQueryClient();
  const getFn = useServerFn(getDisputeQueue);
  const toggleFn = useServerFn(setDisputesInAnalytics);

  const q = useQuery({ queryKey: ["disputes"], queryFn: () => getFn() });

  const toggle = useMutation({
    mutationFn: (include: boolean) => toggleFn({ data: { include } }),
    onSuccess: (_r, include) => {
      toast.success(
        include
          ? "Open disputes are now counted in your analytics"
          : "Open disputes are now deducted from your analytics",
      );
      qc.invalidateQueries({ queryKey: ["disputes"] });
      // Every revenue surface reads this, so none of them may keep a stale
      // number after the lens changes.
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      qc.invalidateQueries({ queryKey: ["reports"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = q.data;
  const t = data?.totals;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldAlert className="h-6 w-6 shrink-0" /> Disputes
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          When a client&apos;s bank queries or reverses a payment, it lands here. An
          INQUIRY is a question and takes nothing; a CHARGEBACK has already left the
          account. This is where you see which is which, what is still contestable, and
          what is settled.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : !data ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Inquiries"
              value={money(t?.inquiryCents ?? 0)}
              sub={`${t?.inquiryCount ?? 0} queried, nothing taken`}
              tone={(t?.inquiryCount ?? 0) > 0 ? "warn" : undefined}
            />
            <Stat
              label="Open"
              value={money(t?.openCents ?? 0)}
              sub={`${t?.openCount ?? 0} still contestable`}
              tone={(t?.openCount ?? 0) > 0 ? "warn" : undefined}
            />
            <Stat
              label="Lost"
              value={money(t?.lostCents ?? 0)}
              sub={`${t?.lostCount ?? 0} decided against you`}
              tone={(t?.lostCount ?? 0) > 0 ? "danger" : undefined}
            />
            <Stat
              label="Won"
              value={money(t?.wonCents ?? 0)}
              sub={`${t?.wonCount ?? 0} recovered`}
            />
          </div>

          <Card>
            <CardContent className="flex flex-wrap items-start justify-between gap-4 pt-6">
              <div className="max-w-xl">
                <Label htmlFor="disputes-analytics" className="text-sm font-medium">
                  Count open disputes as revenue in analytics
                </Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  Off by default, because the money has genuinely left your account. Turn it on
                  to see revenue as though the open disputes hold, useful if you expect to win
                  them, and easy to forget you did, so the figures say which way this is set.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This is a lens on your own analytics only. It never changes your tax reports,
                  which read what actually happened.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="disputes-analytics"
                  checked={data.includeOpenInAnalytics}
                  disabled={toggle.isPending}
                  onCheckedChange={(v) => toggle.mutate(v)}
                />
                <span className="text-sm text-muted-foreground">
                  {data.includeOpenInAnalytics ? "Counted" : "Deducted"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Every dispute</CardTitle>
            </CardHeader>
            <CardContent>
              {data.disputes.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-sm font-medium">No disputes. </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Nothing has been charged back. If one arrives you&apos;ll see it here and in
                    Needs review.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {data.disputes.map((d) => {
                    const copy = DISPUTE_COPY[d.outcome];
                    return (
                      // Keyed on the dispute, not the payment: a payment can
                      // carry more than one and React would collapse them.
                      <div
                        key={`${d.paymentId}:${d.disputeId}`}
                        className="rounded-md border p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{d.clientName}</span>
                              <Badge
                                variant={
                                  copy.tone === "danger"
                                    ? "destructive"
                                    : copy.tone === "warn"
                                      ? "secondary"
                                      : "outline"
                                }
                              >
                                {copy.label}
                              </Badge>
                              <span className="text-sm font-medium tabular-nums">
                                {money(d.amountCents)}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {copy.whatItMeans}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Opened {d.openedOn}
                              {d.decidedOn ? ` · decided ${d.decidedOn}` : ""}
                            </p>
                          </div>
                          {d.invoiceId && (
                            <Link
                              to="/invoices"
                              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                            >
                              Invoice <ExternalLink className="h-3 w-3 shrink-0" />
                            </Link>
                          )}
                        </div>
                        {d.outcome === "open" && (
                          <div className="mt-2 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                            <span>
                              Evidence is submitted in Stripe, not here. HoundStack is told the
                              outcome, it doesn&apos;t decide it. The window is short and closes
                              whether or not anyone replies.
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "warn" | "danger";
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div
          className={`mt-1 text-2xl font-semibold tabular-nums ${
            tone === "danger"
              ? "text-destructive"
              : tone === "warn"
                ? "text-amber-600 dark:text-amber-400"
                : ""
          }`}
        >
          {value}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}
