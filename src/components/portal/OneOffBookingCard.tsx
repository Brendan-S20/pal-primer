// "Can you come Friday as well? We have people over Saturday."
//
// The customer's side of an extra cleanup: pick one of the days on offer,
// the address if they have more than one, an optional note, and send. The
// days come from the server (portalOneOffBookingOptions), already limited to
// the org's working days from its tomorrow through 30 days out, so the list is
// a <select> rather than a calendar: every option in it is one the server will
// accept, and a phone's native picker is the best one-handed control there is.
//
// It is a REQUEST unless the owner turned auto-accept on, and the card says
// which before the customer taps, so "Send request" never reads as a booking.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarPlus, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { portalOneOffBookingOptions, portalRequestOneOff } from "@/lib/portal.functions";
import { fmtDay, fmtDayShort, money, usePortalCtx } from "@/lib/portal-ui";

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
  const [note, setNote] = useState("");
  const [done, setDone] = useState<{ day: string; bookedOn: string | null } | null>(null);

  const opts = q.data;
  useEffect(() => {
    if (!opts) return;
    if (!propertyId && opts.properties.length > 0) setPropertyId(opts.properties[0].id);
  }, [opts, propertyId]);

  const mut = useMutation({
    mutationFn: () => requestFn({ data: { token, propertyId, day, message: note.trim() } }),
    onSuccess: (r) => {
      setDone({ day, bookedOn: r.bookedOn });
      setNote("");
      setDay("");
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
              ? `You're booked for ${fmtDay(done.bookedOn)}.`
              : `Request sent for ${fmtDay(done.day)}. We'll confirm it, and you can see where it stands under Your requests.`}
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
          {opts.autoAccept
            ? `Pick a day and it's booked straight away${
                opts.priceCents != null ? `, for ${money(opts.priceCents, opts.currency)}` : ""
              }.`
            : `Pick a day and we'll confirm it${
                opts.priceCents != null
                  ? `. An extra cleanup is ${money(opts.priceCents, opts.currency)}`
                  : ""
              }.`}
        </span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
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
          {mut.isPending ? "Sending…" : opts.autoAccept ? "Book it" : "Send request"}
        </Button>
      </div>
    </div>
  );
}
