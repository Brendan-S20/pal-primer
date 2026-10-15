import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { KpiValueBone, ListSkeleton } from "@/components/PageSkeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/LoadError";
import { PullToRefresh } from "@/components/motion/PullToRefresh";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import {
  listInvoices,
  getCollectedThisMonth,
  generateInvoicesForOrg,
  createManualInvoice,
  bulkVoidInvoices,
  bulkMarkInvoicesPaid,
  voidInvoice,
} from "@/lib/invoices.functions";
import { sendInvoiceEmail } from "@/lib/notifications.functions";
import { formatDay } from "@/lib/format";
import { listClients } from "@/lib/clients.functions";
import { getMyOrg } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ChevronDown,
  Download,
  FileText,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv";
import { lineTotalCents, parseQuantity } from "@/lib/invoice-lines";
import { HelpTip } from "@/components/HelpTip";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useRecordPaymentDialog, type RecordPaymentAnswer } from "@/components/RecordPaymentDialog";
import { FieldCollectionsCard } from "@/components/FieldCollectionsCard";
import { EmptyState, SectionLabel } from "@/components/client-detail/primitives";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { InvoiceCard, InvoiceRow } from "@/components/InvoiceRow";
import type { RowAction } from "@/components/RowActions";
import { invoiceOutstandingCents } from "@/lib/ar";
import { useRowSelection } from "@/hooks/useRowSelection";
import { cn } from "@/lib/utils";
import { titleHead } from "@/lib/page-title";
import { byWhatNeedsDoing } from "@/lib/invoice-order";
import { useOrgToday } from "@/hooks/useOrgToday";
import { useMotionList } from "@/lib/motion/use-motion-list";

export const Route = createFileRoute("/_authenticated/invoices/")({
  head: () => titleHead("Invoices"),
  // `?new` opens the manual-invoice dialog on arrival, so the phone's ➕ sheet
  // can offer "New invoice" as something that CREATES rather than as one more
  // row that lands you on a list and leaves you to find the button. See the
  // header of src/components/CreateSheet.tsx for why that distinction is
  // enforced rather than left to taste.
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === true || search.new === "true" || search.new === "1" ? true : undefined,
  }),
  component: InvoicesPage,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format((c ?? 0) / 100);
}

const STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
type StatusKey = (typeof STATUSES)[number] | "all";

function statusLabel(s: StatusKey) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** P3.1 quick charge — bill a client right now, no visit required. */
function NewInvoiceDialog() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const clientsFn = useServerFn(listClients);
  const createFn = useServerFn(createManualInvoice);
  const emailFn = useServerFn(sendInvoiceEmail);
  const openedFromLink = Route.useSearch().new === true;
  const [open, setOpen] = useState(openedFromLink);
  const [clientId, setClientId] = useState("");
  // A line is a description, how many, and the price of one. Quantity starts
  // at 1, and a line of one is sent as only a total, exactly as before.
  const blankLine = { description: "", quantity: "1", price: "" };
  const [items, setItems] = useState<
    Array<{ description: string; quantity: string; price: string }>
  >([blankLine]);
  // Emailed as it is created, by default. A manual invoice has no send_after,
  // so the nightly auto-send never picks it up: before this, "Create invoice"
  // left it Open, unsent, and waiting for somebody to find the Send button on
  // a page they had just been navigated away from.
  const [sendNow, setSendNow] = useState(true);

  const clientsQ = useQuery({
    queryKey: ["clients", "picker"],
    queryFn: () => clientsFn(),
    enabled: open,
    staleTime: 60_000,
  });
  const clients: Array<{
    id: string;
    display_name: string;
    active: boolean;
    primary_email?: string | null;
  }> = (clientsQ.data as any)?.clients ?? (clientsQ.data as any) ?? [];
  const picked = clients.find((c) => c.id === clientId);
  const pickedEmail = picked?.primary_email?.trim() || null;
  const willEmail = sendNow && !!pickedEmail;

  const lines = items.map((i) => {
    const quantity = parseQuantity(i.quantity);
    const unitCents = Math.round((parseFloat(i.price) || 0) * 100);
    const amountCents = quantity === null ? 0 : lineTotalCents(quantity, unitCents);
    return { description: i.description.trim(), quantity, unitCents, amountCents };
  });
  // A quantity that is not one ("0", "1.255", "") blocks the button rather than
  // being quietly read as 1, which would bill something the form does not show.
  const badQuantity = items.some((i, j) => i.description.trim() && lines[j].quantity === null);
  const parsedItems = lines
    .filter((l) => l.description && l.quantity !== null && l.amountCents > 0)
    .map((l) =>
      l.quantity === 1
        ? { description: l.description, amountCents: l.amountCents }
        : {
            description: l.description,
            amountCents: l.amountCents,
            quantity: l.quantity!,
            unitAmountCents: l.unitCents,
          },
    );
  const totalCents = parsedItems.reduce((s, i) => s + i.amountCents, 0);

  const createM = useMutation({
    mutationFn: async () => {
      const r = await createFn({ data: { clientId, items: parsedItems } });
      if (!willEmail) return { ...r, emailed: null as null | { ok: boolean; error?: string } };
      // The invoice exists either way; a failed email must not read as a
      // failed invoice, or the retry creates a second one.
      try {
        await emailFn({ data: { invoiceId: r.invoiceId } });
        return { ...r, emailed: { ok: true } };
      } catch (e) {
        return { ...r, emailed: { ok: false, error: (e as Error).message } };
      }
    },
    onSuccess: (r) => {
      if (r.emailed?.ok) {
        toast.success(`Invoice created and emailed to ${pickedEmail}: ${fmtCents(r.totalCents)}`);
      } else if (r.emailed) {
        toast.warning(
          `Invoice created, but it was not emailed (${r.emailed.error}). Send it from the invoice.`,
        );
      } else {
        toast.success(`Invoice created: ${fmtCents(r.totalCents)}`);
      }
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setOpen(false);
      setClientId("");
      setItems([blankLine]);
      navigate({ to: "/invoices/$invoiceId", params: { invoiceId: r.invoiceId } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Drop `?new` as soon as the dialog is dismissed. Left in place, a reload or
  // a Back into this entry would reopen a dialog the person just closed.
  const setDialogOpen = (next: boolean) => {
    setOpen(next);
    if (!next && openedFromLink) {
      void navigate({ to: "/invoices", search: {}, replace: true });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4 shrink-0" /> New invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>
            Bill a client directly, no visit needed. The invoice opens immediately and is payable
            from their portal or the link in the email.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Client</label>
            <select
              // 40pt, and it is the first control in the dialog.
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm touch:min-h-11"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">Select a client…</option>
              {clients
                .filter((c) => c.active !== false)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                  </option>
                ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Line items</label>
            {items.map((item, i) => {
              const set = (patch: Partial<typeof item>) =>
                setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
              const line = lines[i];
              return (
                // Description on its own row below `sm`: three inputs and a
                // remove button across 320px leave the description about
                // forty pixels, which is where the words go.
                <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <Input
                    aria-label={`Line ${i + 1} description`}
                    placeholder="Description (e.g. Extra yard)"
                    className="min-w-0 basis-full sm:basis-auto sm:flex-1"
                    value={item.description}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                  <Input
                    aria-label={`Line ${i + 1} quantity`}
                    inputMode="decimal"
                    className="w-16 shrink-0"
                    value={item.quantity}
                    aria-invalid={item.description.trim() !== "" && line.quantity === null}
                    onChange={(e) => set({ quantity: e.target.value })}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground" aria-hidden>
                    ×
                  </span>
                  <Input
                    aria-label={`Line ${i + 1} price each`}
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    className="min-w-0 flex-1 sm:w-28 sm:flex-none"
                    value={item.price}
                    onChange={(e) => set({ price: e.target.value })}
                  />
                  {line.quantity !== null && line.quantity !== 1 && line.amountCents > 0 && (
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {fmtCents(line.amountCents)}
                    </span>
                  )}
                  {items.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 px-2 touch:min-h-11 touch:min-w-11"
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => setItems(items.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-4 w-4 shrink-0" />
                    </Button>
                  )}
                </div>
              );
            })}
            {badQuantity && (
              <p className="text-xs text-destructive">
                A quantity is a number above zero with at most two decimal places.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setItems([...items, blankLine])}
            >
              <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Add line
            </Button>
          </div>
          {totalCents > 0 && <p className="text-sm font-medium">Total: {fmtCents(totalCents)}</p>}
          {clientId && (
            <label className="flex min-h-11 items-start gap-3 text-sm">
              <Checkbox
                id="new-invoice-send-now"
                className="mt-0.5"
                checked={willEmail}
                disabled={!pickedEmail}
                onCheckedChange={(v) => setSendNow(v === true)}
              />
              <span className="min-w-0">
                {pickedEmail ? (
                  <>
                    Email it to <span className="break-all font-medium">{pickedEmail}</span> now,
                    with a link to pay
                  </>
                ) : (
                  <>This client has no email address, so the invoice will not be sent.</>
                )}
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button
            disabled={!clientId || parsedItems.length === 0 || badQuantity || createM.isPending}
            onClick={() => createM.mutate()}
          >
            {createM.isPending
              ? willEmail
                ? "Creating and sending…"
                : "Creating…"
              : `${willEmail ? "Create and send" : "Create invoice"}${totalCents > 0 ? ` · ${fmtCents(totalCents)}` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Clickable summary stat: clicking applies (or clears) the matching status filter. */
function StatCard({
  label,
  value,
  sub,
  active,
  destructive = false,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  active: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // Compact below `sm`. Measured on a 430pt phone: three of these
        // stacked full-width, plus the filter panel, pushed the first invoice
        // off the bottom of the screen entirely -- a page called Invoices that
        // opens on no invoices. They stay CONTROLS, not decoration: each one
        // still toggles its status filter, which is why they are not simply
        // hidden on a phone.
        "basis-0 grow rounded-xl border bg-card text-left shadow-sm transition-colors hover:bg-muted/30",
        "max-sm:min-h-11 max-sm:p-2 p-4",
        destructive && "border-destructive/30 bg-destructive/5 hover:bg-destructive/10",
        active && "ring-2 ring-primary/50",
      )}
    >
      <SectionLabel className="max-sm:text-3xs">{label}</SectionLabel>
      <div
        className={cn(
          "mt-1 whitespace-nowrap font-semibold tabular-nums text-2xl max-sm:mt-0.5 max-sm:text-base",
          destructive && "text-destructive",
        )}
      >
        {value}
      </div>
      {/* The explanatory line is what makes these cards tall. On a phone the
          number is the point, and "5 invoices open" under a card labelled Open
          invoices reading 5 is the least load-bearing sentence on the page. */}
      {sub && <div className="mt-0.5 text-xs text-muted-foreground max-sm:hidden">{sub}</div>}
    </button>
  );
}

function InvoicesPage() {
  const motionList = useMotionList<HTMLDivElement>();
  const { confirm, dialog } = useConfirmDialog();
  const { ask: askPayment, dialog: paymentDialog } = useRecordPaymentDialog();
  const list = useServerFn(listInvoices);
  const collectedFn = useServerFn(getCollectedThisMonth);
  const orgFn = useServerFn(getMyOrg);
  const gen = useServerFn(generateInvoicesForOrg);
  const voidBulk = useServerFn(bulkVoidInvoices);
  const paidBulk = useServerFn(bulkMarkInvoicesPaid);
  const voidOne = useServerFn(voidInvoice);
  const emailFn = useServerFn(sendInvoiceEmail);
  const qc = useQueryClient();

  const [through, setThrough] = useState(() => new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState<StatusKey>("all");
  const [search, setSearch] = useState("");
  // Typed text shows at once; the list re-filters behind it (see the same
  // note on /clients).
  const deferredSearch = useDeferredValue(search);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Counted, not merely "are any set": the trigger has to say HOW MANY, or a
  // filtered-empty list looks like missing data.
  const activeFilterCount =
    (search ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0) + (status !== "all" ? 1 : 0);
  // Row click opens the shared invoice drawer (QA round 8) instead of
  // navigating away; "Open full invoice" inside goes to the page.
  const [drawerInvoiceId, setDrawerInvoiceId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const orgQ = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn() });
  const invQ = useQuery({ queryKey: ["invoices"], queryFn: () => list() });
  // IMP-10: collected money is a question about PAYMENTS, so it is asked of the
  // server rather than derived from the invoice list in the browser. The old
  // client-side scan dated invoices by `paid_at ?? period_end` against a UTC
  // month prefix, could not see a refund, and only ever summed the invoices
  // that happened to be loaded.
  const collectedQ = useQuery({
    queryKey: ["invoices", "collected-mtd"],
    queryFn: () => collectedFn(),
    staleTime: 60_000,
  });

  const genM = useMutation({
    mutationFn: async () => {
      const org = orgQ.data?.organization;
      if (!org) throw new Error("No organization");
      return gen({ data: { orgId: org.id, through } });
    },
    onSuccess: (r) => {
      // "Generated 0 invoice(s)" with success styling read as "nothing is
      // owed" to a first-time operator (P3.1) — say what it actually means.
      if (r.generated === 0) {
        toast.info(
          "No invoices to generate. This bills completed, unbilled visits. To charge a client directly, use New invoice.",
          { duration: 8000 },
        );
      } else {
        toast.success(`Generated ${r.generated} invoice(s)`);
      }
      setAdvancedOpen(false);
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const stats = useMemo(() => {
    const all = invQ.data ?? [];
    let outstandingCents = 0;
    let openCount = 0;
    let draftCount = 0;
    for (const inv of all) {
      if (inv.status === "open") {
        openCount += 1;
        // Shared AR math (B1): open balance net of applied credit, identical
        // to the Dashboard "AR open" card and Reports "Outstanding". Counting
        // invoices is genuinely an invoice question, so it stays here.
        outstandingCents += invoiceOutstandingCents(inv as any);
      } else if (inv.status === "draft") {
        draftCount += 1;
      }
    }
    return { outstandingCents, openCount, draftCount };
  }, [invQ.data]);

  const toggleStatusFilter = (s: StatusKey) => setStatus((prev) => (prev === s ? "all" : s));

  const filtered = useMemo(() => {
    const s = deferredSearch.trim().toLowerCase();
    return (invQ.data ?? []).filter((inv) => {
      if (status !== "all" && inv.status !== status) return false;
      if (from && (inv.period_end ?? "") < from) return false;
      if (to && (inv.period_end ?? "") > to) return false;
      if (s) {
        const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
        const name = (client?.display_name ?? "").toLowerCase();
        if (!name.includes(s)) return false;
      }
      return true;
    });
  }, [invQ.data, status, deferredSearch, from, to]);

  // The phone's cards, most actionable first: see src/lib/invoice-order.ts.
  // The table keeps newest first, where columns and the status filter do the
  // sorting a phone cannot.
  const orgTodayIso = useOrgToday();
  const phoneOrder = useMemo(
    () => byWhatNeedsDoing(filtered, orgTodayIso),
    [filtered, orgTodayIso],
  );

  const filtersActive = Boolean(search || from || to || status !== "all");
  const resetFilters = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setStatus("all");
  };

  // Shared multi-select hook (same plumbing as Clients / Leads / Visits).
  // Selection clears whenever a filter changes so a bulk void/mark-paid never
  // silently mutates rows that were filtered out of view.
  const visibleIds = useMemo(() => filtered.map((i) => i.id), [filtered]);
  const sel = useRowSelection(visibleIds, `${status}|${search}|${from}|${to}`);
  const { selectedIds, allSelected: allVisibleSelected, toggleAll } = sel;
  const selectedRows = useMemo(() => filtered.filter((i) => sel.isSelected(i.id)), [filtered, sel]);
  const totalSelected = selectedRows.reduce((sum, i) => sum + (i.total_cents ?? 0), 0);
  const selectedOpen = selectedRows.filter((i) => i.status === "open");

  // A void/paid changes every money surface at once — refresh the summary
  // cards too, not just the table.
  const refreshMoney = () => {
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    qc.invalidateQueries({ queryKey: ["billing-summary"] });
  };

  const voidM = useMutation({
    mutationFn: () => voidBulk({ data: { ids: selectedIds } }),
    onSuccess: (r) => {
      // All-fail must not read as green success.
      if (r.failed) toast.error(`Voided ${r.ok} of ${r.ok + r.failed} — ${r.failed} skipped`);
      else toast.success(`Voided ${r.ok}`);
      sel.clear();
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const paidM = useMutation({
    mutationFn: (how: RecordPaymentAnswer) => paidBulk({ data: { ids: selectedIds, ...how } }),
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Recorded ${r.ok} of ${r.ok + r.failed} payments, ${r.failed} skipped`);
      else toast.success(`Recorded ${r.ok} payment${r.ok === 1 ? "" : "s"}`);
      // Separate from `failed`, and deliberately not silent. These invoices ARE
      // paid; what did not happen is the cancellation of the pay-page intent,
      // so the client can still press Pay and be charged a second time, and
      // that charge is recorded nowhere. The office needs to hear it now, while
      // it can still cancel the intent in Stripe.
      if (r.intentStillLive?.length) {
        const n = r.intentStillLive.length;
        toast.warning(
          `${n} of those still ${n === 1 ? "has" : "have"} a live payment link. Cancel ${n === 1 ? "it" : "them"} in Stripe, or the client can still be charged.`,
          { duration: 15000 },
        );
      }
      sel.clear();
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Bulk send: loops the existing single-invoice sendInvoiceEmail over the
  // selected OPEN invoices (draft/paid/void rows are skipped) — same server
  // fn + permission gate as the per-row "Send to client" action.
  const sendM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((invoiceId) => emailFn({ data: { invoiceId, reminder: false } })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Sent ${r.ok} of ${r.ok + r.failed} invoice emails, ${r.failed} failed`);
      else toast.success(`Queued ${r.ok} invoice email${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const exportSelectedCsv = () =>
    downloadCsv(
      `invoices-selected-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        "Invoice ID",
        "Client",
        "Status",
        "Period start",
        "Period end",
        "Total",
        "Issued",
        "Due",
        "Paid",
      ],
      selectedRows.map((inv) => {
        const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
        return [
          inv.id,
          client?.display_name ?? "",
          inv.status,
          inv.period_start ?? "",
          inv.period_end ?? "",
          ((inv.total_cents ?? 0) / 100).toFixed(2),
          (inv.issued_at ?? "").slice(0, 10),
          inv.due_on ?? "",
          (inv.paid_at ?? "").slice(0, 10),
        ];
      }),
    );

  // ── Per-row ••• actions (Salesforce-style row actions) ────────────────────
  // These reuse the exact server fns the drawer / bulk bar already use:
  // sendInvoiceEmail, bulkMarkInvoicesPaid (with one id), voidInvoice.
  const rowEmailM = useMutation({
    mutationFn: (v: { invoiceId: string; reminder: boolean }) => emailFn({ data: v }),
    onSuccess: (r: any, v) => {
      toast.success(
        `${v.reminder ? "Reminder" : "Invoice"} queued for ${r.recipient ?? "the client"}`,
      );
      // A first send stamps sent_at — refresh so the row chips update.
      if (!v.reminder) qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rowPaidM = useMutation({
    mutationFn: (v: { id: string } & RecordPaymentAnswer) => {
      const { id, ...how } = v;
      return paidBulk({ data: { ids: [id], ...how } });
    },
    onSuccess: (r) => {
      if (r.ok) toast.success("Payment recorded. Invoice paid");
      else toast.error("The payment could not be recorded");
      if (r.intentStillLive?.length) {
        toast.warning(
          "The payment link for this invoice is still live. Cancel it in Stripe, or the client can still be charged.",
          { duration: 15000 },
        );
      }
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rowVoidM = useMutation({
    mutationFn: (id: string) => voidOne({ data: { id } }),
    onSuccess: () => {
      toast.success("Invoice voided");
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** ••• items for one row; open invoices only (mirrors the drawer's gating).
   *  "Open full invoice" + "Copy pay link" are built into InvoiceRow itself. */
  const rowActions = (inv: (typeof filtered)[number]): RowAction[] => {
    if (inv.status !== "open") return [];
    const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
    const busy = rowEmailM.isPending || rowPaidM.isPending || rowVoidM.isPending;
    return [
      {
        label: inv.sent_at ? "Send to client" : inv.send_after ? "Send now" : "Send to client",
        disabled: busy,
        onSelect: async () => {
          // Same grace-window bypass confirm as the drawer: emailing a held
          // invoice force-sends it ahead of its scheduled date.
          if (!inv.sent_at && inv.send_after) {
            const ok = await confirm({
              title: "Send this invoice now?",
              description: `This emails the invoice to ${client?.display_name ?? "the client"} right away, ahead of its scheduled send date (${formatDay(inv.send_after)}). It won't be sent again automatically.`,
              confirmLabel: "Send now",
            });
            if (!ok) return;
          }
          rowEmailM.mutate({ invoiceId: inv.id, reminder: false });
        },
      },
      {
        label: "Send reminder",
        disabled: busy,
        onSelect: () => rowEmailM.mutate({ invoiceId: inv.id, reminder: true }),
      },
      {
        label: "Record payment",
        disabled: busy,
        onSelect: async () => {
          const how = await askPayment({
            amountLine: `${fmtCents(invoiceOutstandingCents(inv as any), inv.currency ?? "usd")}, the open balance for ${client?.display_name ?? "this client"}. This marks the invoice paid and can't be undone here.`,
          });
          if (how) rowPaidM.mutate({ id: inv.id, ...how });
        },
      },
      {
        label: "Void",
        destructive: true,
        disabled: busy,
        onSelect: async () => {
          if (
            await confirm({
              title: "Void this invoice?",
              description:
                "Voiding removes this invoice from the client's balance and can't be undone.",
              destructive: true,
              confirmLabel: "Void invoice",
            })
          )
            rowVoidM.mutate(inv.id);
        },
      },
    ];
  };

  return (
    <>
      <PullToRefresh />
      {dialog}
      {paymentDialog}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Invoices</h1>
          <p className="text-sm text-muted-foreground">
            Invoices generate automatically on each client's cadence.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            disabled={!filtered.length}
            onClick={() =>
              downloadCsv(
                `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
                [
                  "Invoice ID",
                  "Client",
                  "Status",
                  "Period start",
                  "Period end",
                  "Total",
                  "Issued",
                  "Due",
                  "Paid",
                ],
                filtered.map((inv) => {
                  const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
                  return [
                    inv.id,
                    client?.display_name ?? "",
                    inv.status,
                    inv.period_start ?? "",
                    inv.period_end ?? "",
                    ((inv.total_cents ?? 0) / 100).toFixed(2),
                    (inv.issued_at ?? "").slice(0, 10),
                    inv.due_on ?? "",
                    (inv.paid_at ?? "").slice(0, 10),
                  ];
                }),
              )
            }
          >
            <Download className="mr-1 h-4 w-4 shrink-0" /> Export CSV
          </Button>
          {/* Full auto billing: generation runs nightly on each client's
              cadence, so manual generate-from-visits is demoted to an
              overflow dialog kept as a fallback. */}
          <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Advanced invoicing actions">
                <MoreHorizontal className="h-4 w-4 shrink-0" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Generate from visits (manual fallback)</DialogTitle>
                <DialogDescription>
                  Invoices generate automatically on each client's cadence, so you normally never
                  need this. Use it to bill all unbilled completed visits through a date right now,
                  for example before changing a client's cadence.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-end gap-2">
                <div>
                  <label htmlFor="invoices-through" className="text-xs text-muted-foreground">
                    Through
                  </label>
                  <Input
                    id="invoices-through"
                    type="date"
                    className="h-9 w-40"
                    value={through}
                    onChange={(e) => setThrough(e.target.value)}
                  />
                </div>
                <HelpTip article="generate-invoices" />
              </div>
              <DialogFooter>
                <Button variant="secondary" onClick={() => genM.mutate()} disabled={genM.isPending}>
                  {genM.isPending ? "Generating…" : "Generate from visits"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {/* The primary action first on a phone, where this row wraps and
              Export CSV used to lead it. At a desk it stays at the right-hand
              end, where a primary button is looked for. */}
          <div className="max-md:order-first">
            <NewInvoiceDialog />
          </div>
        </div>
      </div>

      {/* Cash and checks a tech recorded at a stop, waiting to be confirmed
          and applied. Nothing at all when there are none. */}
      <FieldCollectionsCard />

      {/* Summary stats — click one to filter by that status.

          A wrapping row, not a grid. `grid-cols-3` gave each card a third of
          the column whatever its number needed, and a third of a 320px phone
          is 90px: on the hosted Linux runner's fonts "$12,384.00" is about
          100px, so it ran out of its card and the page scrolled sideways
          (324px at 320, 350px in a 344px column at 360). The same was true of
          `lg:grid-cols-4` beside the sidebar at 1024. Here every card is
          `basis-0 grow` — equal shares of the row — but never narrower than
          its own number, and when the three numbers do not fit on one line
          the last card wraps to the next, full width. In a row wherever they
          fit (a 430pt phone, every laptop); reflowed, not overflowed, where
          they do not. */}
      <div className="flex flex-wrap gap-2 sm:gap-3">
        {/* A bone, never a figure, until the read that figure comes from has
            answered: "Outstanding $0.00" over a skeleton list is a claim that
            nobody owes anything (#420, F-05). A dash after a failed read, with
            the Retry under the row. */}
        <StatCard
          label="Outstanding"
          value={
            invQ.data ? fmtCents(stats.outstandingCents) : invQ.isError ? "-" : <KpiValueBone />
          }
          sub="Awaiting payment"
          destructive={!!invQ.data && stats.outstandingCents > 0}
          active={status === "open"}
          onClick={() => toggleStatusFilter("open")}
        />
        <StatCard
          label="Open invoices"
          value={invQ.data ? String(stats.openCount) : invQ.isError ? "-" : <KpiValueBone />}
          sub={
            !invQ.data ? (
              <Skeleton className="h-4 w-24" />
            ) : stats.openCount === 1 ? (
              "1 invoice open"
            ) : (
              `${stats.openCount} invoices open`
            )
          }
          active={status === "open"}
          onClick={() => toggleStatusFilter("open")}
        />
        <StatCard
          label="Collected this month"
          value={
            collectedQ.data ? (
              fmtCents(collectedQ.data.netCents)
            ) : collectedQ.isError ? (
              "-"
            ) : (
              <KpiValueBone />
            )
          }
          // When something came back, say so on the card. A figure that is
          // lower than expected with no explanation is the thing an owner
          // chases support about.
          sub={
            !collectedQ.data ? (
              collectedQ.isError ? undefined : (
                <Skeleton className="h-4 w-28" />
              )
            ) : collectedQ.data.reversalCount > 0 ? (
              `${fmtCents(collectedQ.data.grossCents)} received, ${fmtCents(
                collectedQ.data.refundsCents,
              )} refunded`
            ) : collectedQ.data.paymentCount === 1 ? (
              "1 payment received"
            ) : (
              `${collectedQ.data.paymentCount} payments received`
            )
          }
          active={status === "paid"}
          onClick={() => toggleStatusFilter("paid")}
        />
        {stats.draftCount > 0 && (
          <StatCard
            label="Drafts"
            value={String(stats.draftCount)}
            sub="Not yet issued"
            active={status === "draft"}
            onClick={() => toggleStatusFilter("draft")}
          />
        )}
      </div>
      {collectedQ.isError && !collectedQ.data && invQ.data && (
        <LoadError
          what="this month's collected total"
          onRetry={() => collectedQ.refetch()}
          retrying={collectedQ.isFetching}
        />
      )}

      {/* ── FILTERS ────────────────────────────────────────────────────────
          Open on a laptop, folded on a phone. Measured at 430pt: a search
          field, six status buttons and two date inputs come to roughly a full
          screen of controls sitting between the page title and the first
          invoice. Almost nobody arrives at Invoices to set a date range; they
          arrive to look at invoices.

          The count on the trigger is the part that makes folding safe — a
          filtered list with the filters hidden is how somebody concludes their
          invoices have vanished. */}
      <button
        type="button"
        onClick={() => setFiltersOpen((v) => !v)}
        aria-expanded={filtersOpen}
        aria-controls="invoices-filters"
        className="flex min-h-11 items-center justify-between rounded-xl border bg-card px-3 text-sm shadow-sm sm:hidden"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 shrink-0" />
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-2xs font-semibold text-primary-foreground">
              {activeFilterCount}
            </span>
          )}
        </span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", filtersOpen && "rotate-180")} />
      </button>

      <div
        id="invoices-filters"
        className={cn(
          "flex-wrap items-end gap-3 rounded-xl border bg-card p-3 shadow-sm sm:flex",
          filtersOpen ? "flex" : "hidden",
        )}
      >
        <div className="min-w-[200px] flex-1">
          <label htmlFor="invoices-search" className="text-xs text-muted-foreground">
            Search client
          </label>
          <Input
            id="invoices-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Client name…"
          />
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Status</span>
          <div className="flex flex-wrap gap-1">
            {(["all", ...STATUSES] as StatusKey[]).map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={status === s ? "default" : "outline"}
                onClick={() => setStatus(s)}
              >
                {statusLabel(s)}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="invoices-from" className="text-xs text-muted-foreground">
            Period from
          </label>
          <Input
            id="invoices-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="invoices-to" className="text-xs text-muted-foreground">
            Period to
          </label>
          <Input id="invoices-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset
          </Button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="flex items-center justify-between rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
          <div>
            <span className="font-medium">{selectedIds.length} selected</span>
            <span className="ml-3 tabular-nums text-muted-foreground">
              Total {fmtCents(totalSelected)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={exportSelectedCsv}>
              <Download className="mr-1 h-4 w-4 shrink-0" /> Export CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={sendM.isPending || selectedOpen.length === 0}
              title={selectedOpen.length === 0 ? "Only open invoices can be emailed" : undefined}
              onClick={async () => {
                const skipped = selectedIds.length - selectedOpen.length;
                if (
                  await confirm({
                    title: `Send ${selectedOpen.length} invoice${selectedOpen.length === 1 ? "" : "s"}?`,
                    description: `Emails each open invoice to its client now${
                      skipped
                        ? `. ${skipped} non-open selected invoice${skipped === 1 ? " is" : "s are"} skipped`
                        : ""
                    }.`,
                    confirmLabel: "Send invoices",
                  })
                )
                  sendM.mutate(selectedOpen.map((i) => i.id));
              }}
            >
              {sendM.isPending ? "Sending…" : "Send invoices"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                // Same question as the per-row action: this records money.
                const n = selectedIds.length;
                const how = await askPayment({
                  title: `Record ${n} payment${n === 1 ? "" : "s"}`,
                  amountLine: `The open balance on each of ${n} invoice${n === 1 ? "" : "s"}, received the same way on the same day. They are marked paid, and it can't be undone here.`,
                  confirmLabel: `Record ${n === 1 ? "payment" : "payments"}`,
                });
                if (how) paidM.mutate(how);
              }}
              disabled={paidM.isPending}
            >
              Record payment
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Void ${selectedIds.length} invoice(s)?`,
                    destructive: true,
                    confirmLabel: "Void invoices",
                  })
                )
                  voidM.mutate();
              }}
              disabled={voidM.isPending}
            >
              Void
            </Button>
            <Button size="sm" variant="ghost" onClick={sel.clear}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {!invQ.data ? (
        invQ.isError ? (
          <LoadError
            what="your invoices"
            onRetry={() => invQ.refetch()}
            retrying={invQ.isFetching}
          />
        ) : (
          <ListSkeleton breakpoint="md" columns={6} />
        )
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={filtersActive ? "No invoices match" : "No invoices yet"}
          description={
            filtersActive
              ? "Try widening the search, status, or period filters."
              : "Invoices generate automatically when each client's billing cycle ends. Use New invoice to bill a client directly."
          }
          actionLabel={filtersActive ? "Reset filters" : undefined}
          onAction={filtersActive ? resetFilters : undefined}
        />
      ) : (
        <>
          {/* Mobile Phase 2: below `md` invoices render as tap-through cards
              (shared InvoiceCard — same data, ••• actions, and drawer as the
              table rows). Bulk-select stays via the card checkbox. */}
          <div ref={motionList} className="motion-list space-y-3 md:hidden">
            <label className="flex min-h-10 items-center gap-2 px-1 text-xs text-muted-foreground">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all invoices"
              />
              Select all
            </label>
            {phoneOrder.map((inv) => (
              <InvoiceCard
                key={inv.id}
                invoice={inv}
                selectable
                selected={sel.isSelected(inv.id)}
                onToggleSelect={(next) => sel.toggle(inv.id, next)}
                onOpen={setDrawerInvoiceId}
                actions={rowActions(inv)}
              />
            ))}
          </div>
          <div className="relative overflow-x-auto rounded-xl border bg-card shadow-sm max-md:hidden">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all invoices"
                    />
                  </th>
                  <th className="px-4 py-2 font-semibold">Client</th>
                  <th className="px-4 py-2 font-semibold">Invoice</th>
                  <th className="px-4 py-2 font-semibold">Period</th>
                  <th className="px-4 py-2 font-semibold">Due</th>
                  <th className="px-4 py-2 text-right font-semibold">Total</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="w-28 px-4 py-2 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv) => (
                  <InvoiceRow
                    key={inv.id}
                    invoice={inv}
                    showClient
                    selectable
                    selected={sel.isSelected(inv.id)}
                    onToggleSelect={(next) => sel.toggle(inv.id, next)}
                    onOpen={setDrawerInvoiceId}
                    actions={rowActions(inv)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <InvoiceDrawer
        invoiceId={drawerInvoiceId}
        onClose={() => setDrawerInvoiceId(null)}
        onChanged={() => qc.invalidateQueries({ queryKey: ["invoices"] })}
      />
    </>
  );
}
