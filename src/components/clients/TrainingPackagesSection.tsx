import { useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateField, TimeField } from "@/components/fields";
import { TrainingOnly } from "@/components/training/TrainingOnly";
import { useOrgToday } from "@/hooks/useOrgToday";
import { usePermissions } from "@/hooks/useMyRole";
import { formatDay } from "@/lib/format";
import { formatServiceMoney } from "@/lib/services";
import { invoiceNumberLabel } from "@/lib/invoice-labels";
import { weeklySessionDates } from "@/lib/training-packages";
import type { ListedClientPackage } from "@/lib/training-packages.server";
import {
  listClientPackages,
  listTrainingBookingOptions,
  sellPackage,
  bookPackageSessions,
  bookOneSession,
  cancelClientPackage,
  extendClientPackage,
} from "@/lib/training-packages.functions";

const selectClass = "min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STATE = { active: "Active", used_up: "Used up", expired: "Expired", canceled: "Canceled" };
type Action = "sell" | "weekly" | "one" | "extend" | "cancel";

export function TrainingPackagesSection({ clientId }: { clientId: string }) {
  return (
    <TrainingOnly>
      <Packages clientId={clientId} />
    </TrainingOnly>
  );
}

function Packages({ clientId }: { clientId: string }) {
  const today = useOrgToday();
  const { can } = usePermissions();
  const canBill = can("manage_client_billing");
  const canBook = can("manage_pricing");
  const qc = useQueryClient();
  const list = useServerFn(listClientPackages);
  const optionsFn = useServerFn(listTrainingBookingOptions);
  const sell = useServerFn(sellPackage);
  const weekly = useServerFn(bookPackageSessions);
  const one = useServerFn(bookOneSession);
  const cancel = useServerFn(cancelClientPackage);
  const extend = useServerFn(extendClientPackage);
  const q = useQuery({
    queryKey: ["client-packages", clientId],
    queryFn: () => list({ data: { clientId } }),
  });
  const options = useQuery({
    queryKey: ["training-options", clientId],
    queryFn: () => optionsFn({ data: { clientId } }),
    enabled: canBill || canBook,
  });
  const [action, setAction] = useState<Action | null>(null);
  const [pack, setPack] = useState<ListedClientPackage | null>(null);
  const [servicePackageId, setServicePackageId] = useState("");
  const [dogId, setDogId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [date, setDate] = useState(today);
  const [weekday, setWeekday] = useState(1);
  const [earliest, setEarliest] = useState("");
  const [latest, setLatest] = useState("");
  const [staffId, setStaffId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [error, setError] = useState("");
  const selected = options.data?.packages.find((p) => p.id === servicePackageId);
  const dates =
    pack && date && action === "weekly"
      ? weeklySessionDates(date, weekday, pack.free, pack.expires_on)
      : [];
  const open = (a: Action, p: ListedClientPackage | null = null) => {
    setError("");
    setAction(a);
    setPack(p);
    setDate(a === "extend" ? (p?.expires_on ?? "") : today);
    setPropertyId(options.data?.properties[0]?.id ?? "");
    setEarliest("");
    setLatest("");
    setStaffId("");
    setDogId("");
    setServicePackageId(options.data?.packages[0]?.id ?? "");
    if (a === "sell") setRequestId(crypto.randomUUID());
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (action === "sell")
        return sell({ data: { clientId, servicePackageId, dogId: dogId || undefined, requestId } });
      if (!pack) throw new Error("Choose a package.");
      if (action === "cancel") return cancel({ data: { clientPackageId: pack.id } });
      if (action === "extend")
        return extend({ data: { clientPackageId: pack.id, expiresOn: date || null } });
      const base = { clientPackageId: pack.id, propertyId, staffId: staffId || undefined };
      return action === "weekly"
        ? weekly({
            data: {
              ...base,
              startOn: date,
              weekday,
              earliestTime: earliest || null,
              latestTime: latest || null,
            },
          })
        : one({
            data: {
              ...base,
              date,
              window: { earliestTime: earliest || null, latestTime: latest || null },
            },
          });
    },
    onSuccess: () => {
      setAction(null);
      for (const key of [
        ["client-packages", clientId],
        ["training-session"],
        ["client-subscriptions"],
        ["client-visits"],
        ["visits"],
        ["my-day"],
        ["client-invoices"],
      ])
        void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => setError(e.message),
  });
  const booking = action === "weekly" || action === "one";
  return (
    <section className="space-y-4" data-testid="client-training-packages">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">Training packages</h3>
          <p className="text-sm text-muted-foreground">
            Sessions booked and used against each package.
          </p>
        </div>
        {canBill && (
          <Button className="shrink-0" disabled={!options.data} onClick={() => open("sell")}>
            Sell a package
          </Button>
        )}
      </div>
      {q.isLoading && <p>Loading packages…</p>}
      {(q.error || options.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(q.error || options.error)?.message}
        </p>
      )}
      {q.data?.packages.length === 0 && (
        <p className="text-sm text-muted-foreground">No training packages sold yet.</p>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {q.data?.packages.map((p) => (
          <article key={p.id} className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="min-w-0 break-words font-medium">{p.name}</h4>
              <Badge variant="secondary">{STATE[p.state]}</Badge>
            </div>
            {p.dog_id && (
              <p className="text-sm">
                {options.data?.dogs.find((d) => d.id === p.dog_id)?.name ?? "Dog"}
              </p>
            )}
            <div>
              <p className="text-sm font-medium">
                {p.left} of {p.sessions_count} sessions left
              </p>
              <div
                role="progressbar"
                aria-label="Sessions used"
                aria-valuemin={0}
                aria-valuemax={p.sessions_count}
                aria-valuenow={p.sessions_used}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="hs-meter h-full bg-primary"
                  style={
                    {
                      "--hs-meter": `${Math.round((p.sessions_used / p.sessions_count) * 100)}%`,
                    } as CSSProperties
                  }
                />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {p.sessions_used} used, {p.held - p.sessions_used} booked, {p.free} free to book
              </p>
            </div>
            <p className="text-sm">
              {p.expires_on ? `Expires ${formatDay(p.expires_on)}` : "No expiry"}
            </p>
            {p.invoice && (
              <p className="text-sm">
                <Link
                  className="inline-flex min-h-11 items-center underline"
                  to="/invoices/$invoiceId"
                  params={{ invoiceId: p.invoice.id }}
                >
                  {invoiceNumberLabel(p.invoice)}
                </Link>
                {" · "}
                {p.invoice.status}
              </p>
            )}
            {(canBill || canBook) && (
              <div className="flex flex-wrap gap-2">
                {canBook && p.state === "active" && (
                  <>
                    <Button
                      variant="outline"
                      disabled={!options.data}
                      onClick={() => open("weekly", p)}
                    >
                      Book sessions
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!options.data}
                      onClick={() => open("one", p)}
                    >
                      Book one session
                    </Button>
                  </>
                )}
                {canBill && p.state !== "canceled" && (
                  <>
                    {p.expires_on && (
                      <Button variant="outline" onClick={() => open("extend", p)}>
                        Extend expiry
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => open("cancel", p)}>
                      Cancel package
                    </Button>
                  </>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      <Dialog
        open={action !== null}
        onOpenChange={(v) => !v && !mutation.isPending && setAction(null)}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {action === "sell"
                ? "Sell a package"
                : action === "weekly"
                  ? "Book sessions"
                  : action === "one"
                    ? "Book one session"
                    : action === "extend"
                      ? "Extend expiry"
                      : "Cancel package"}
            </DialogTitle>
            <DialogDescription>
              {action === "sell"
                ? "The package creates one invoice. The client can pay by card through the existing invoice link."
                : action === "cancel"
                  ? "Canceling stops new bookings. It does not void the invoice or cancel booked lessons. Use the existing refund or void tools for the invoice, and cancel lessons on the schedule."
                  : "Lessons use the package's sessions. They have no separate charge."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              mutation.mutate();
            }}
          >
            {action === "sell" && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="sale-package">Package</Label>
                  <select
                    id="sale-package"
                    className={selectClass}
                    required
                    value={servicePackageId}
                    onChange={(e) => setServicePackageId(e.target.value)}
                  >
                    <option value="">Choose a package</option>
                    {options.data?.packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}: {p.services.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sale-dog">Dog (optional)</Label>
                  <select
                    id="sale-dog"
                    className={selectClass}
                    value={dogId}
                    onChange={(e) => setDogId(e.target.value)}
                  >
                    <option value="">No dog selected</option>
                    {options.data?.dogs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                {selected && (
                  <p className="text-sm">
                    Creates one invoice for {formatServiceMoney(selected.price_cents)} and{" "}
                    {selected.sessions_count} sessions. Sales tax applies if configured.
                  </p>
                )}
                {options.data?.packages.length === 0 && (
                  <p className="text-sm">
                    Activate a package in Settings &gt; Services before selling it.
                  </p>
                )}
              </>
            )}
            {booking && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="lesson-property">Property</Label>
                  <select
                    id="lesson-property"
                    className={selectClass}
                    required
                    value={propertyId}
                    onChange={(e) => setPropertyId(e.target.value)}
                  >
                    <option value="">Choose a property</option>
                    {options.data?.properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.street}
                      </option>
                    ))}
                  </select>
                </div>
                {action === "weekly" && (
                  <div className="space-y-1">
                    <Label htmlFor="lesson-weekday">Weekly day</Label>
                    <select
                      id="lesson-weekday"
                      className={selectClass}
                      value={weekday}
                      onChange={(e) => setWeekday(Number(e.target.value))}
                    >
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <DateField
                    label={action === "weekly" ? "First date" : "Date"}
                    value={date}
                    onChange={setDate}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <TimeField label="Earliest arrival" value={earliest} onChange={setEarliest} />
                  </div>
                  <div className="space-y-1">
                    <TimeField label="Latest arrival" value={latest} onChange={setLatest} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lesson-trainer">Trainer</Label>
                  <select
                    id="lesson-trainer"
                    className={selectClass}
                    value={staffId}
                    onChange={(e) => setStaffId(e.target.value)}
                  >
                    <option value="">Assign later</option>
                    {options.data?.staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.display_name}
                      </option>
                    ))}
                  </select>
                </div>
                {action === "weekly" && (
                  <div className="text-sm">
                    <p>
                      {dates.length
                        ? `Books ${dates.length} weekly lessons, last one on ${formatDay(dates[dates.length - 1])}.`
                        : "No lessons fit before this package expires."}
                    </p>
                    {pack && dates.length < pack.free && (
                      <p className="text-muted-foreground">
                        The expiry cuts this booking short. Extend the expiry to book the remaining
                        sessions.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
            {action === "extend" && (
              <div className="space-y-1">
                <Label htmlFor="extend-expiry">New expiry date</Label>
                <Input
                  id="extend-expiry"
                  type="date"
                  min={pack?.expires_on ?? undefined}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
                <p className="text-sm text-muted-foreground">Leave blank for no expiry.</p>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                (action === "sell" && !selected) ||
                (action === "weekly" && !dates.length)
              }
            >
              {mutation.isPending
                ? "Saving…"
                : action === "sell"
                  ? "Create invoice and package"
                  : action === "cancel"
                    ? "Cancel package"
                    : action === "extend"
                      ? "Save expiry"
                      : "Book lessons"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
