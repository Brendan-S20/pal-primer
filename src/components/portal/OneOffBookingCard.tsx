// "Can you come Friday as well? We have people over Saturday."
//
// The customer's side of an extra visit: pick one of the days on offer, the
// address if they have more than one, what they want if the business sells
// more than one thing (phase 5: the extra cleanup, a walk, a groom), an
// optional note, and send. The days come from the server
// (portalOneOffBookingOptions), already limited to the org's working days
// from its tomorrow through 30 days out, so the list is a <select> rather than
// a calendar: every option in it is one the server will accept, and a phone's
// native picker is the best one-handed control there is. The services come
// from the same call, active and priced, in the plan picker's order. A dog
// walk also offers a Time: the business's working day in two-hour windows
// (walkWindows), "Any time" by default, and the confirmation says which.
//
// It is a REQUEST unless the owner turned auto-accept on, and the card says
// which before the customer taps, so "Send request" never reads as a booking.
// Auto-accept needs a price: a service the business has not priced waits for
// the office, exactly as an extra cleanup with no one-off price always has.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarPlus, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { portalOneOffBookingOptions, portalRequestOneOff } from "@/lib/portal.functions";
import { oneOffPriceFor } from "@/lib/one-off-booking";
import { fmtDay, fmtDayShort, money, usePortalCtx } from "@/lib/portal-ui";
import { windowLabel, type WalkWindow } from "@/lib/walk-windows";

const selectClass =
  "h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11";

export function OneOffBookingCard() {
  const { token, verified, invalidatePortal } = usePortalCtx();
  const optionsFn = useServerFn(portalOneOffBookingOptions);
  const requestFn = useServerFn(portalRequestOneOff);
  const q = useQuery({
    queryKey: ["portal", token, "one-off-options"],
    queryFn: () => optionsFn({ data: { token } }),
    enabled: verified,
    staleTime: 30_000,
  });
  const [day, setDay] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [note, setNote] = useState("");
  // A walk's time window (#410): "" is Any time, else "HH:MM-HH:MM".
  const [windowKey, setWindowKey] = useState("");
  const [done, setDone] = useState<{
    day: string;
    bookedOn: string | null;
    window: string | null;
  } | null>(null);

  const opts = q.data;
  const services = opts?.services ?? [];
  useEffect(() => {
    if (!opts) return;
    if (!propertyId && opts.properties.length > 0) setPropertyId(opts.properties[0].id);
    if (!serviceId && services.length > 0) setServiceId(services[0].id);
  }, [opts, propertyId, serviceId, services]);

  // What is being asked for: the chosen service, else the extra cleanup as the
  // card has always offered it. The pet-waste service IS the extra cleanup,
  // so it is sent as no service, and the request is the one it always was.
  const chosen = services.find((s) => s.id === serviceId) ?? services[0] ?? null;
  // The price for THIS address's pets, through the same rule the booking
  // charges (oneOffPriceFor), so what is promised before the tap is what is
  // booked after it.
  const pets = opts?.petsByProperty?.[propertyId] ?? 1;
  const priceCents = chosen ? oneOffPriceFor(chosen, pets) : (opts?.priceCents ?? null);
  const autoAccept = !!opts?.autoAccept && priceCents != null;
  // A walk is asked for in a window; nothing else offers one.
  const windows: WalkWindow[] =
    chosen?.serviceLine === "dog_walking" ? (opts?.walkWindows ?? []) : [];
  const picked = windows.find((w) => `${w.start}-${w.end}` === windowKey) ?? null;

  const mut = useMutation({
    mutationFn: () =>
      requestFn({
        data: {
          token,
          propertyId,
          day,
          message: note.trim(),
          ...(chosen && !chosen.petWaste ? { serviceId: chosen.id } : {}),
          ...(picked ? { earliestTime: picked.start, latestTime: picked.end } : {}),
        },
      }),
    onSuccess: (r) => {
      setDone({
        day,
        bookedOn: r.bookedOn,
        window: picked ? windowLabel(picked.start, picked.end) : null,
      });
      setNote("");
      setDay("");
      setWindowKey("");
      invalidatePortal();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading || !opts) return null;
  if (opts.properties.length === 0) return null;

  if (done) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-emerald-500/40 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <p>
            {done.bookedOn
              ? `You're booked for ${fmtDay(done.bookedOn)}${done.window ? `, ${done.window}` : ""}.`
              : `Request sent for ${fmtDay(done.day)}${done.window ? `, ${done.window}` : ""}. We'll confirm it, and you can see where it stands under Your requests.`}
          </p>
          <Button size="sm" variant="outline" onClick={() => setDone(null)}>
            Ask for another day
          </Button>
        </div>
      </div>
    );
  }

  if (opts.days.length === 0) {
    return (
      <p className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
        There are no open days in the next 30 to ask for. Please call us instead.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-md border bg-card p-3 text-sm">
      <p className="flex items-start gap-2 text-muted-foreground">
        <CalendarPlus className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0">
          {autoAccept
            ? `Pick a day and it's booked straight away${
                priceCents != null ? `, for ${money(priceCents, opts.currency)}` : ""
              }.`
            : `Pick a day and we'll confirm it${
                priceCents != null
                  ? `. ${chosen && !chosen.petWaste ? chosen.name : "An extra visit"} is ${money(
                      priceCents,
                      opts.currency,
                    )}`
                  : ""
              }.`}
        </span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {services.length > 1 && (
          <div className="min-w-0 space-y-1">
            <Label htmlFor="one-off-what" className="text-xs">
              What
            </Label>
            <select
              id="one-off-what"
              className={selectClass}
              value={chosen?.id ?? ""}
              onChange={(e) => setServiceId(e.target.value)}
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {oneOffPriceFor(s, pets) != null
                    ? ` (${money(oneOffPriceFor(s, pets), opts.currency)})`
                    : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="min-w-0 space-y-1">
          <Label htmlFor="one-off-day" className="text-xs">
            Day
          </Label>
          <select
            id="one-off-day"
            className={selectClass}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
            <option value="">Choose a day…</option>
            {opts.days.map((d) => (
              <option key={d} value={d}>
                {fmtDayShort(d)}
              </option>
            ))}
          </select>
        </div>
        {windows.length > 0 && (
          <div className="min-w-0 space-y-1">
            <Label htmlFor="one-off-time" className="text-xs">
              Time
            </Label>
            <select
              id="one-off-time"
              className={selectClass}
              value={windowKey}
              onChange={(e) => setWindowKey(e.target.value)}
            >
              <option value="">Any time</option>
              {windows.map((w) => (
                <option key={`${w.start}-${w.end}`} value={`${w.start}-${w.end}`}>
                  {windowLabel(w.start, w.end)}
                </option>
              ))}
            </select>
          </div>
        )}
        {opts.properties.length > 1 && (
          <div className="min-w-0 space-y-1">
            <Label htmlFor="one-off-where" className="text-xs">
              Where
            </Label>
            <select
              id="one-off-where"
              className={selectClass}
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
            >
              {opts.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label ? `${p.label}: ${p.street}` : p.street}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="one-off-note" className="text-xs">
          Anything we should know? (optional)
        </Label>
        <Textarea
          id="one-off-note"
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Having people over Saturday"
        />
      </div>
      <div className="flex justify-end">
        <Button disabled={!day || !propertyId || mut.isPending} onClick={() => mut.mutate()}>
          {mut.isPending ? "Sending…" : autoAccept ? "Book it" : "Send request"}
        </Button>
      </div>
    </div>
  );
}
