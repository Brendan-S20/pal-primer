// Expenses: what the business spent, by month.
//
// The office (owner, office manager) sees every expense in the organization,
// filters by month, category and person, and adds, edits and deletes them. A
// tech, or anybody else on the team, sees and edits only their own -- the
// database decides that (20260929090000_nobody-knew-what-a-route-cost.sql),
// and this page only draws what it was given.
//
// Two shapes, not one scaled: a table from xl, one card per expense below it,
// because six columns of a vendor, a person, a category and money on a phone
// are six columns nobody can read.
//
// Dates are days on the ORGANIZATION's calendar. The month picker, the default
// date of a new expense and "not in the future" all ask the org, not the
// device.

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmButton } from "@/components/ConfirmButton";
import { supabase } from "@/integrations/supabase/client";
import {
  createExpense,
  deleteExpense,
  listExpenses,
  setMileageRate,
  updateExpense,
  type Expense,
  type ExpenseList,
} from "@/lib/expenses.functions";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  formatExpenseCents,
  formatRate,
  isExpenseCategory,
  IRS_STANDARD_MILEAGE_RATE_CENTS,
  mileageAmountCents,
  mileageRateFor,
  parseAmountCents,
  parseMiles,
  parseRateCents,
  receiptPath,
  summarizeExpenses,
  type ExpenseCategory,
} from "@/lib/expenses";
import { newExpenseId } from "@/lib/offline/expense-actions";
import { compressImage } from "@/lib/offline/compressImage";
import { formatDay } from "@/lib/format";
import { useOrgToday } from "@/hooks/useOrgToday";
import { downloadCsv } from "@/lib/csv";
import { pageTitle } from "@/lib/page-title";

type Search = { month?: string; category?: ExpenseCategory; staff?: string };

export const Route = createFileRoute("/_authenticated/expenses")({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    if (typeof s.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s.month)) out.month = s.month;
    if (isExpenseCategory(s.category)) out.category = s.category;
    if (typeof s.staff === "string" && /^([0-9a-f-]{36}|none)$/i.test(s.staff)) out.staff = s.staff;
    return out;
  },
  head: () => ({ meta: [{ title: pageTitle("Expenses") }] }),
  component: ExpensesPage,
});

const EXPENSES_KEY = "expenses";

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

type Editing = { mode: "add" } | { mode: "edit"; expense: Expense };

function ExpensesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const orgToday = useOrgToday();
  const thisMonth = orgToday.slice(0, 7);
  const month = search.month ?? thisMonth;

  const fetchList = useServerFn(listExpenses);
  const { data, isLoading, error } = useQuery({
    queryKey: [EXPENSES_KEY, month, search.category ?? "", search.staff ?? ""],
    queryFn: () =>
      fetchList({
        data: {
          month,
          ...(search.category ? { category: search.category } : {}),
          ...(search.staff ? { staffId: search.staff as string } : {}),
        },
      }),
  });

  const [editing, setEditing] = useState<Editing | null>(null);

  const setSearch = (patch: Partial<Search>) =>
    navigate({
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, ...patch } as Record<string, unknown>;
        for (const k of Object.keys(next)) if (!next[k]) delete next[k];
        if (next.month === thisMonth) delete next.month;
        return next;
      },
      replace: true,
    } as any);

  const expenses = data?.expenses ?? [];
  const summary = summarizeExpenses(expenses);
  const names = new Map((data?.staff ?? []).map((s) => [s.id, s.display_name]));
  const isOffice = !!data?.isOffice;
  const mileageMiles = expenses
    .filter((e) => e.category === "mileage")
    .reduce((n, e) => n + Number(e.miles ?? 0), 0);

  const exportCsv = () => {
    downloadCsv(
      `expenses-${month}.csv`,
      [
        "Date",
        "Category",
        "Vendor or trip",
        "Person",
        "Miles",
        "Rate (cents/mi)",
        "Amount",
        "Note",
        "Receipt",
      ],
      expenses.map((e) => [
        e.spent_on,
        EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category,
        e.vendor ?? "",
        e.staff_id ? (names.get(e.staff_id) ?? "") : "",
        e.miles ?? "",
        e.mileage_rate_cents ?? "",
        (e.amount_cents / 100).toFixed(2),
        e.note ?? "",
        e.receipt_path ? "yes" : "",
      ]),
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Expenses</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {isOffice || !data
              ? "Fuel, dump fees, supplies, equipment, repairs and mileage, by month. Techs log theirs from My Day, with a photo of the receipt."
              : "Your own expenses. Log one here or from My Day, with a photo of the receipt."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => setEditing({ mode: "add" })} disabled={!data}>
            <Plus className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" /> Add expense
          </Button>
          <Button type="button" variant="outline" onClick={exportCsv} disabled={!expenses.length}>
            <Download className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Filters. Month by arrows or by picking one; category and person as
          native selects, which a phone draws as its own picker. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => setSearch({ month: addMonths(month, -1) })}
          >
            <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Button>
          <div className="min-w-[8.5rem] px-2 text-center text-sm font-medium">
            {monthName(month)}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Next month"
            disabled={month >= thisMonth}
            onClick={() => setSearch({ month: addMonths(month, 1) })}
          >
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Button>
        </div>
        <Input
          type="month"
          aria-label="Jump to a month"
          value={month}
          max={thisMonth}
          onChange={(e) => {
            const v = e.target.value;
            if (/^\d{4}-\d{2}$/.test(v)) setSearch({ month: v });
          }}
          className="w-auto min-w-0"
        />
        <select
          aria-label="Category"
          value={search.category ?? ""}
          onChange={(e) =>
            setSearch({ category: (e.target.value || undefined) as ExpenseCategory | undefined })
          }
          className="h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm touch:min-h-11"
        >
          <option value="">Every category</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {EXPENSE_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        {isOffice && (
          <select
            aria-label="Person"
            value={search.staff ?? ""}
            onChange={(e) => setSearch({ staff: e.target.value || undefined })}
            // A <select> with no width sizes itself to its longest option,
            // which is the longest name on the team. See My Day's picker.
            className="h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm touch:min-h-11"
          >
            <option value="">Everyone</option>
            <option value="none">Nobody in particular</option>
            {(data?.staff ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
                {s.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        )}
      </div>

      {isLoading && <Card className="p-6 text-sm text-muted-foreground">Loading expenses…</Card>}
      {error && (
        <Card className="border-destructive/40 p-6 text-sm">
          Expenses could not be loaded: {(error as Error).message}
        </Card>
      )}

      {data && (
        <>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Card className="p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Total for {monthName(month)}
              </div>
              <div className="mt-1 break-words text-2xl font-semibold tabular-nums">
                {formatExpenseCents(summary.totalCents)}
              </div>
              <div className="text-xs text-muted-foreground">
                {summary.count} expense{summary.count === 1 ? "" : "s"}
                {mileageMiles > 0 && ` · ${mileageMiles.toLocaleString("en-US")} miles`}
              </div>
            </Card>
            <Card className="p-4 lg:col-span-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                By category
              </div>
              <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {EXPENSE_CATEGORIES.map((c) => (
                  <li key={c} className="flex min-w-0 items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {EXPENSE_CATEGORY_LABELS[c]}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatExpenseCents(summary.byCategory[c])}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {data.canSetRate && <MileageRateCard rateCents={data.mileageRateCents} />}

          {expenses.length === 0 ? (
            <Card className="p-6 text-sm text-muted-foreground">
              Nothing logged for {monthName(month)}
              {search.category || search.staff ? " with these filters" : ""}.
            </Card>
          ) : (
            <>
              {/* Below xl: a card per expense. With the sidebar open, xl is the first
                  width where the table fits beside it with its actions. */}
              <ul className="grid gap-3 md:grid-cols-2 xl:hidden">
                {expenses.map((e) => (
                  <li key={e.id}>
                    <Card className="p-4">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="break-words font-medium">
                            {e.vendor || EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory]}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDay(e.spent_on)} ·{" "}
                            {EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category}
                          </div>
                        </div>
                        <div className="shrink-0 text-right font-semibold tabular-nums">
                          {formatExpenseCents(e.amount_cents)}
                        </div>
                      </div>
                      <ExpenseDetail expense={e} names={names} isOffice={isOffice} />
                      <RowActions
                        expense={e}
                        onEdit={() => setEditing({ mode: "edit", expense: e })}
                      />
                    </Card>
                  </li>
                ))}
              </ul>

              {/* From xl: the table. ui/table scrolls inside itself. */}
              <Card className="hidden xl:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">Date</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>
                        {isOffice ? "Vendor or trip, and whose" : "Vendor or trip"}
                      </TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expenses.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {formatDay(e.spent_on)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category}
                          {e.category === "mileage" && e.miles != null && (
                            <span className="block text-xs text-muted-foreground">
                              {Number(e.miles)} mi at {formatRate(e.mileage_rate_cents ?? 0)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[22rem]">
                          <div className="truncate" title={e.vendor ?? ""}>
                            {e.vendor || ""}
                          </div>
                          {isOffice && e.staff_id && (
                            <div className="truncate text-xs">
                              {names.get(e.staff_id) ?? "Former team member"}
                            </div>
                          )}
                          {e.note && (
                            <div className="truncate text-xs text-muted-foreground" title={e.note}>
                              {e.note}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                          {formatExpenseCents(e.amount_cents)}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActions
                            expense={e}
                            onEdit={() => setEditing({ mode: "edit", expense: e })}
                            compact
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </>
          )}
        </>
      )}

      {data && editing && (
        <ExpenseDialog
          key={editing.mode === "edit" ? editing.expense.id : "add"}
          editing={editing}
          list={data}
          defaultStaff={search.staff && search.staff !== "none" ? search.staff : null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ExpenseDetail({
  expense: e,
  names,
  isOffice,
}: {
  expense: Expense;
  names: Map<string, string>;
  isOffice: boolean;
}) {
  const lines: string[] = [];
  if (e.category === "mileage" && e.miles != null) {
    lines.push(`${Number(e.miles)} mi at ${formatRate(e.mileage_rate_cents ?? 0)}`);
  }
  if (isOffice && e.staff_id) lines.push(names.get(e.staff_id) ?? "Former team member");
  return (
    <>
      {lines.length > 0 && (
        <div className="mt-1 break-words text-xs text-muted-foreground">{lines.join(" · ")}</div>
      )}
      {e.note && <p className="mt-2 break-words text-sm">{e.note}</p>}
    </>
  );
}

function openReceipt(path: string) {
  // A signed link for five minutes, opened in a new tab. Private bucket: the
  // storage policies decide whether this person may read it.
  // Opened synchronously, inside the tap, so a popup blocker allows it; the
  // signed link is filled in when it arrives. Not "noopener" in the features
  // string, which makes window.open return null; the opener is cut instead.
  const win = window.open("", "_blank");
  if (win) win.opener = null;
  supabase.storage
    .from("expense-receipts")
    .createSignedUrl(path, 300)
    .then(({ data, error }) => {
      if (error || !data?.signedUrl) {
        win?.close();
        toast.error("That receipt could not be opened.");
        return;
      }
      if (win) win.location.href = data.signedUrl;
      else window.location.href = data.signedUrl;
    });
}

function RowActions({
  expense,
  onEdit,
  compact = false,
}: {
  expense: Expense;
  onEdit: () => void;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const del = useServerFn(deleteExpense);
  const [busy, setBusy] = useState(false);
  return (
    // In the table the three are icons in one row that never wraps, so the
    // column is as wide as three buttons and no wider; on a card they carry
    // their words, because there is room and a phone has no hover tooltip.
    <div
      className={`flex items-center gap-2 ${compact ? "flex-nowrap justify-end" : "mt-3 flex-wrap"}`}
    >
      {expense.receipt_path && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openReceipt(expense.receipt_path!)}
          aria-label="Open the receipt"
        >
          <Paperclip className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!compact && <span className="ml-1">Receipt</span>}
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onEdit} aria-label="Edit expense">
        <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
        {!compact && <span className="ml-1">Edit</span>}
      </Button>
      <ConfirmButton
        title="Delete this expense?"
        description={`${formatExpenseCents(expense.amount_cents)} on ${formatDay(expense.spent_on)}. The receipt goes with it. This cannot be undone.`}
        confirmLabel="Delete"
        disabled={busy}
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Delete expense"
            disabled={busy}
          >
            <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {!compact && <span className="ml-1">Delete</span>}
          </Button>
        }
        onConfirm={async () => {
          setBusy(true);
          try {
            await del({ data: { id: expense.id } });
            toast.success("Expense deleted");
            qc.invalidateQueries({ queryKey: [EXPENSES_KEY] });
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function MileageRateCard({ rateCents }: { rateCents: number }) {
  const qc = useQueryClient();
  const save = useServerFn(setMileageRate);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(rateCents));
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(String(rateCents)), [rateCents]);
  const parsed = parseRateCents(value);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Mileage rate: {formatRate(rateCents)}</div>
          <p className="text-xs text-muted-foreground">
            What a mileage expense is priced at when it is logged. The IRS standard business rate is
            {formatRate(IRS_STANDARD_MILEAGE_RATE_CENTS)} (from July 2026). Changing it prices new
            trips only; every trip already logged keeps its rate.
          </p>
        </div>
        {!editing && (
          <Button type="button" variant="outline" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (parsed == null) return;
            setBusy(true);
            try {
              await save({ data: { rateCents: parsed } });
              toast.success(`New mileage is priced at ${formatRate(parsed)}`);
              qc.invalidateQueries({ queryKey: [EXPENSES_KEY] });
              qc.invalidateQueries({ queryKey: ["expense-settings"] });
              setEditing(false);
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-w-0">
            <Label htmlFor="mileage-rate">Cents per mile</Label>
            <Input
              id="mileage-rate"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-1 w-32"
            />
          </div>
          <Button type="submit" disabled={parsed == null || busy}>
            Save rate
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}
    </Card>
  );
}

function ExpenseDialog({
  editing,
  list,
  defaultStaff,
  onClose,
}: {
  editing: Editing;
  list: ExpenseList;
  defaultStaff: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const createFn = useServerFn(createExpense);
  const updateFn = useServerFn(updateExpense);
  const existing = editing.mode === "edit" ? editing.expense : null;

  const [category, setCategory] = useState<ExpenseCategory>(
    existing && isExpenseCategory(existing.category) ? existing.category : "fuel",
  );
  const [amount, setAmount] = useState(existing ? (existing.amount_cents / 100).toFixed(2) : "");
  const [miles, setMiles] = useState(existing?.miles != null ? String(Number(existing.miles)) : "");
  const [spentOn, setSpentOn] = useState(existing?.spent_on ?? list.today);
  const [vendor, setVendor] = useState(existing?.vendor ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [staffId, setStaffId] = useState<string>(
    existing ? (existing.staff_id ?? "") : list.isOffice ? (defaultStaff ?? "") : "",
  );
  const [receipt, setReceipt] = useState<File | null>(null);
  const [dropReceipt, setDropReceipt] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const mileage = category === "mileage";
  // The rate this row is, or will be, priced at: its own if it already is a
  // mileage row, the org's otherwise. The trigger applies the same rule.
  const rate = mileageRateFor(existing, list.mileageRateCents);
  const parsedMiles = parseMiles(miles);
  const parsedAmount = parseAmountCents(amount);
  const preview = mileage && parsedMiles != null ? mileageAmountCents(parsedMiles, rate) : null;
  const valid =
    !!spentOn && spentOn <= list.today && (mileage ? parsedMiles != null : parsedAmount != null);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const id = existing?.id ?? newExpenseId();
      // Whose folder the receipt is filed in: the person it belongs to, or
      // "office". A non-office caller's expense is always their own.
      const owner = list.isOffice ? staffId || null : (list.myStaff?.id ?? null);
      let receiptField: { receiptPath?: string | null } = {};
      if (receipt) {
        const { file, contentType, ext } = await compressImage(receipt);
        const path = receiptPath(list.orgId, owner, id, ext);
        const { error } = await supabase.storage
          .from("expense-receipts")
          .upload(path, file, { contentType, upsert: true });
        if (error) throw new Error(`Receipt upload failed: ${error.message}`);
        receiptField = { receiptPath: path };
      } else if (dropReceipt) {
        receiptField = { receiptPath: null };
      }
      const fields = {
        spentOn,
        category,
        ...(mileage ? { miles: parsedMiles! } : { amountCents: parsedAmount! }),
        vendor: vendor.trim() || null,
        note: note.trim() || null,
        ...receiptField,
      };
      if (existing) {
        await updateFn({
          data: { id, fields, ...(list.isOffice ? { staffId: staffId || null } : {}) },
        });
        toast.success("Expense updated");
      } else {
        await createFn({
          data: { id, fields, ...(list.isOffice ? { staffId: staffId || null } : { mine: true }) },
        });
        toast.success("Expense logged");
      }
      qc.invalidateQueries({ queryKey: [EXPENSES_KEY] });
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasReceipt = !!existing?.receipt_path && !dropReceipt;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit expense" : "Add expense"}</DialogTitle>
          <DialogDescription>
            {mileage
              ? `Mileage is priced at ${formatRate(rate)}${existing?.category === "mileage" ? ", the rate this trip was logged at" : ""}.`
              : "Dated on your business's calendar."}
          </DialogDescription>
        </DialogHeader>
        <form
          id="expense-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div>
            <Label htmlFor="expense-category">Category</Label>
            <select
              id="expense-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {EXPENSE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {mileage ? (
              <div className="min-w-0">
                <Label htmlFor="expense-dialog-miles">Miles</Label>
                <Input
                  id="expense-dialog-miles"
                  inputMode="decimal"
                  value={miles}
                  onChange={(e) => setMiles(e.target.value)}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {preview != null ? formatExpenseCents(preview) : "Up to one decimal place"}
                </p>
              </div>
            ) : (
              <div className="min-w-0">
                <Label htmlFor="expense-dialog-amount">Amount</Label>
                <Input
                  id="expense-dialog-amount"
                  inputMode="decimal"
                  placeholder="$0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="mt-1"
                />
              </div>
            )}
            <div className="min-w-0">
              <Label htmlFor="expense-dialog-date">Date</Label>
              <Input
                id="expense-dialog-date"
                type="date"
                max={list.today}
                value={spentOn}
                onChange={(e) => setSpentOn(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="expense-dialog-vendor">{mileage ? "Trip" : "Vendor"}</Label>
            <Input
              id="expense-dialog-vendor"
              maxLength={120}
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className="mt-1"
            />
          </div>

          {list.isOffice && (
            <div>
              <Label htmlFor="expense-dialog-staff">Whose expense</Label>
              <select
                id="expense-dialog-staff"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11"
              >
                <option value="">The business (nobody in particular)</option>
                {list.staff
                  .filter((s) => s.active || s.id === existing?.staff_id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          <div>
            <span className="text-sm font-medium">Receipt</span>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                setReceipt(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
            {receipt || hasReceipt ? (
              <div className="mt-1 flex min-h-11 items-center gap-2 rounded-md border px-3">
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {receipt ? receipt.name : "Receipt on file"}
                </span>
                {!receipt && existing?.receipt_path && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openReceipt(existing.receipt_path!)}
                  >
                    Open
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label="Remove the receipt"
                  onClick={() => (receipt ? setReceipt(null) : setDropReceipt(true))}
                >
                  <X className="h-4 w-4 shrink-0" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="mt-1 w-full"
                onClick={() => fileInput.current?.click()}
              >
                <Camera className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
                Attach a receipt
              </Button>
            )}
          </div>

          <div>
            <Label htmlFor="expense-dialog-note">Note</Label>
            <Textarea
              id="expense-dialog-note"
              maxLength={500}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1"
            />
          </div>
        </form>
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="expense-form" disabled={!valid || busy}>
            {busy ? "Saving…" : existing ? "Save changes" : "Add expense"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
