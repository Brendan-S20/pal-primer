/**
 * Time off and route endpoints for one person, opened from the board.
 *
 * Both of these existed only in Settings → Users, which is the wrong place for
 * them. The moment you need them is the moment you are looking at the board and
 * can see that Jordan's Tuesday is empty or that their route is starting from
 * the wrong side of town — and going to Settings means leaving the day you were
 * reading, finding the person in a list of everyone including office staff, and
 * coming back to find your date and filters reset.
 *
 * They are together in one dialog because they are the same question asked two
 * ways: where does this person's day start and end, and which days do they have
 * one at all.
 */
import { useState } from "react";
import { lookupAddressPoint } from "@/lib/geocode.functions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarOff, MapPin, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import {
  addTimeOff,
  listTimeOff,
  previewTimeOff,
  removeTimeOff,
  setStaffAddresses,
} from "@/lib/users.functions";

/** Nominatim, same as Settings → Users. Kept a plain fetch rather than routed
 *  through a server fn: it is a public endpoint, the query is an address the
 *  user just typed, and a failure here is recoverable — the address saves
 *  without a pin and the optimizer falls back to the org default. */
async function geocode(q: string): Promise<{ lat: number; lng: number } | null> {
  // Through the server rather than straight at Nominatim: the throttle, the
  // User-Agent their policy asks for, and one origin IP instead of every
  // tenant's. See src/lib/geocode.functions.ts.
  const query = q.trim();
  if (query.length < 3) return null;
  try {
    const { geo } = await lookupAddressPoint({ data: { query } });
    return geo ? { lat: geo.latitude, lng: geo.longitude } : null;
  } catch {
    return null;
  }
}

const fmt = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export function StaffRoutingDialog({
  staff,
  open,
  onOpenChange,
}: {
  staff: any;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listTimeOff);
  const addFn = useServerFn(addTimeOff);
  const removeFn = useServerFn(removeTimeOff);
  const previewFn = useServerFn(previewTimeOff);
  const addrFn = useServerFn(setStaffAddresses);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [start, setStart] = useState(staff?.start_address ?? "");
  const [end, setEnd] = useState(staff?.end_address ?? "");
  // Coordinates that arrived with a matched address, so save() can use them
  // instead of re-geocoding the string. Dropped on any hand edit: a pin for
  // the address that was in the box a moment ago is worse than no pin, since
  // the optimizer has no way to doubt it.
  const [startPin, setStartPin] = useState<{ lat: number; lng: number } | null>(null);
  const [endPin, setEndPin] = useState<{ lat: number; lng: number } | null>(null);
  const [savingAddr, setSavingAddr] = useState(false);

  const timeOffQ = useQuery({
    queryKey: ["time-off", staff?.id],
    queryFn: () => listFn({ data: {} }),
    enabled: open && Boolean(staff?.id),
  });

  const mine = (timeOffQ.data?.timeOff ?? []).filter((t: any) => t.staff_id === staff?.id);

  /** What the proposed range would strand, asked BEFORE saving.
   *
   *  Only runs once both dates are present and the range is the right way
   *  round — a half-typed date is not a question worth asking the server, and
   *  an inverted range would return a confusing zero rather than an error. */
  const rangeValid = Boolean(from && to && to >= from);
  const impactQ = useQuery({
    queryKey: ["time-off-impact", staff?.id, from, to],
    queryFn: () => previewFn({ data: { staffId: staff.id, from, to } }),
    enabled: open && Boolean(staff?.id) && rangeValid,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["time-off"] });
    // The board reads time off per lane, so it has to redraw too.
    qc.invalidateQueries({ queryKey: ["visits"] });
    qc.invalidateQueries({ queryKey: ["staff"] });
  };

  const addMut = useMutation({
    mutationFn: () =>
      addFn({ data: { staffId: staff.id, startsOn: from, endsOn: to, reason: reason || undefined } }),
    onSuccess: () => {
      // Says what it did NOT do, because that is the surprising part: the
      // visits already on those days are still there, still assigned.
      const n = impactQ.data?.total ?? 0;
      toast.success(
        n > 0
          ? `Time off saved. ${n} visit${n === 1 ? "" : "s"} still assigned. Use Cover to move them.`
          : "Time off saved.",
      );
      setFrom("");
      setTo("");
      setReason("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Time off removed.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveAddresses = async () => {
    setSavingAddr(true);
    try {
      // Only geocode what actually changed. Re-pinning an untouched address
      // burns a Nominatim call and, worse, can move a pin the dispatcher
      // placed deliberately.
      const [sGeo, eGeo] = await Promise.all([
        startPin ??
          (start.trim() && start !== staff.start_address ? geocode(start) : Promise.resolve(null)),
        endPin ?? (end.trim() && end !== staff.end_address ? geocode(end) : Promise.resolve(null)),
      ]);
      await addrFn({
        data: {
          staffId: staff.id,
          startAddress: start.trim() || null,
          startLatitude:
            sGeo?.lat ?? (start === staff.start_address ? staff.start_latitude : null),
          startLongitude:
            sGeo?.lng ?? (start === staff.start_address ? staff.start_longitude : null),
          endAddress: end.trim() || null,
          endLatitude: eGeo?.lat ?? (end === staff.end_address ? staff.end_latitude : null),
          endLongitude: eGeo?.lng ?? (end === staff.end_address ? staff.end_longitude : null),
        },
      });
      // Naming the consequence rather than saying "Saved": the optimizer
      // measures every leg from the start address, so changing it changes
      // every ETA on that lane the next time it runs.
      toast.success("Route endpoints saved. Re-optimize to update their ETAs.");
      qc.invalidateQueries({ queryKey: ["staff"] });
      qc.invalidateQueries({ queryKey: ["staff-addresses"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingAddr(false);
    }
  };

  if (!staff) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{staff.display_name}</DialogTitle>
          <DialogDescription>
            Days off and where their route starts and ends.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <CalendarOff className="h-4 w-4 shrink-0" /> Time off
            </div>

            {mine.length > 0 && (
              <ul className="divide-y rounded-md border text-sm">
                {mine.map((t: any) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div>
                        {fmt(t.starts_on)}
                        {t.ends_on !== t.starts_on ? ` – ${fmt(t.ends_on)}` : ""}
                      </div>
                      {t.reason && (
                        <div className="truncate text-2xs text-muted-foreground">{t.reason}</div>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeMut.mutate(t.id)}
                      disabled={removeMut.isPending}
                      aria-label={`Remove time off starting ${t.starts_on}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {/* One column below sm: an iOS date control will not draw
                narrower than its value (~195px), which is wider than half a
                phone-width dialog. Same fault as the timesheet dialog. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <Label className="text-xs">First day off</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="min-w-0 space-y-1">
                <Label className="text-xs">Last day off</Label>
                <Input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </div>
            <Input
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />

            {/* Both ends inclusive, said out loud — "12th to the 19th" means
                different things to different people, and getting it wrong by
                one day puts somebody on a route while they are away. */}
            {rangeValid && (
              <p className="text-2xs text-muted-foreground">
                Off {fmt(from)}
                {to !== from ? ` through ${fmt(to)}` : ""}, back{" "}
                {fmt(new Date(new Date(`${to}T12:00:00`).getTime() + 864e5).toISOString().slice(0, 10))}
                .
                {impactQ.data
                  ? impactQ.data.total > 0
                    ? ` ${impactQ.data.total} visit${impactQ.data.total === 1 ? "" : "s"} already assigned across ${impactQ.data.days.length} day${impactQ.data.days.length === 1 ? "" : "s"}. Saving this does not move them.`
                    : " Nothing assigned on those days."
                  : ""}
              </p>
            )}
            {from && to && to < from && (
              <p className="text-2xs text-destructive">
                The last day off is before the first.
              </p>
            )}

            <Button
              size="sm"
              onClick={() => addMut.mutate()}
              disabled={!rangeValid || addMut.isPending}
            >
              {addMut.isPending ? "Saving…" : "Add time off"}
            </Button>
          </section>

          <section className="space-y-2 border-t pt-4">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <MapPin className="h-4 w-4 shrink-0" /> Route start and end
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Starts from</Label>
              {/* Same control as Settings → Users, and for the same reason:
                  this is the second entry point for the same two fields, and
                  a smart one there with a dumb one here is how the two drift
                  apart. Not a customer address, but in the same town as the
                  customers, so the workspace bias suits it. */}
              <AddressAutocomplete
                value={start}
                onChangeText={(t) => {
                  setStart(t);
                  setStartPin(null);
                }}
                onResolved={(r) => {
                  setStart(r.address.formatted);
                  setStartPin(
                    r.address.latitude != null && r.address.longitude != null
                      ? { lat: r.address.latitude, lng: r.address.longitude }
                      : null,
                  );
                }}
                placeholder="Home, shop, or depot"
              />
              {staff.start_latitude != null && start === staff.start_address && (
                <p className="text-3xs text-muted-foreground">
                  Pinned {Number(staff.start_latitude).toFixed(4)},{" "}
                  {Number(staff.start_longitude).toFixed(4)}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ends at</Label>
              <AddressAutocomplete
                value={end}
                onChangeText={(t) => {
                  setEnd(t);
                  setEndPin(null);
                }}
                onResolved={(r) => {
                  setEnd(r.address.formatted);
                  setEndPin(
                    r.address.latitude != null && r.address.longitude != null
                      ? { lat: r.address.latitude, lng: r.address.longitude }
                      : null,
                  );
                }}
                placeholder="Dump, home, or shop"
              />
              {staff.end_latitude != null && end === staff.end_address && (
                <p className="text-3xs text-muted-foreground">
                  Pinned {Number(staff.end_latitude).toFixed(4)},{" "}
                  {Number(staff.end_longitude).toFixed(4)}
                </p>
              )}
            </div>
            <Button size="sm" variant="secondary" onClick={saveAddresses} disabled={savingAddr}>
              {savingAddr ? "Saving…" : "Save endpoints"}
            </Button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
