import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, ClipboardList, Scissors } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PortalVaccines } from "@/components/portal/PortalVaccines";
import { usePortalCtx, EmptyBox, fmtDayShort, money } from "@/lib/portal-ui";
import { portalGetGrooming, portalRequestGroom } from "@/lib/portal-groom.functions";
import {
  GROOM_REQUEST_MAX_DAYS_AHEAD,
  GROOM_WINDOWS,
  GROOM_WINDOW_KEYS,
  clockOf,
  groomRequestQuote,
  groomWindowOf,
  type GroomWindow,
} from "@/lib/groom-request";
import { groomPetLabel } from "@/lib/groom";
import { addDaysToDay } from "@/lib/reclean";

// The client's grooming: ask for a groom for one of their pets, see what it
// costs and how long it takes by the same pricing the office books with, see
// what became of earlier requests, and keep vaccine records current. The
// office confirms the start time and the groomer; nothing here books a visit.
// Asking is off while mobile grooming is not a line a customer can request
// (customerCanRequestService); the page is then vaccine records, and earlier
// requests if there are any.
//
// English, like every other portal page: the portal speaks the business's
// language, not the reader's device (see CLAUDE.md, "What stays English").

export const Route = createFileRoute("/portal/$slug/$token/grooming")({
  component: PortalGrooming,
});

type Grooming = Extract<Awaited<ReturnType<typeof portalGetGrooming>>, { visible: true }>;

const selectClass =
  "h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11";

function PortalGrooming() {
  const { token, slug, clientQ } = usePortalCtx();
  const getFn = useServerFn(portalGetGrooming);
  const runsGrooming = !!(clientQ.data as { mobile_grooming?: boolean } | undefined)
    ?.mobile_grooming;
  const q = useQuery({
    queryKey: ["portal", token, "grooming"],
    queryFn: () => getFn({ data: { token } }),
    staleTime: 30_000,
    enabled: runsGrooming,
  });

  if (!runsGrooming || (q.data && !q.data.visible)) {
    return (
      <EmptyBox
        icon={<Scissors className="h-6 w-6 shrink-0" />}
        title="Grooming isn't offered here"
        body="Your other services are on the Home page."
      />
    );
  }
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading grooming…</p>;
  if (q.error || !q.data || !q.data.visible) {
    return (
      <p role="alert" className="text-sm text-destructive">
        We can't load grooming right now. Try again in a minute.
      </p>
    );
  }
  const page = q.data;

  return (
    <div className="space-y-6">
      {page.canRequest && <RequestGroomCard page={page} />}
      {(page.canRequest || page.requests.length > 0) && <GroomRequests page={page} />}
      <PortalVaccines token={token} />
      <p className="text-center text-xs text-muted-foreground">
        <Link
          to="/portal/$slug/$token/requests"
          params={{ slug, token }}
          className="inline-flex min-h-11 items-center underline underline-offset-2"
        >
          See all your requests
        </Link>
      </p>
    </div>
  );
}

function RequestGroomCard({ page }: { page: Grooming }) {
  const { token } = usePortalCtx();
  const qc = useQueryClient();
  const requestFn = useServerFn(portalRequestGroom);
  const tomorrow = addDaysToDay(page.today, 1);
  const lastDay = addDaysToDay(page.today, GROOM_REQUEST_MAX_DAYS_AHEAD);
  const [dogId, setDogId] = useState(page.pets.length === 1 ? page.pets[0].id : "");
  const [serviceId, setServiceId] = useState(page.services.length === 1 ? page.services[0].id : "");
  const [picked, setPicked] = useState<string[]>([]);
  const firstOpenDay = (() => {
    for (let i = 0; i < 7; i++) {
      const d = addDaysToDay(tomorrow, i);
      if (page.workDays.includes(new Date(`${d}T12:00:00Z`).getUTCDay())) return d;
    }
    return tomorrow;
  })();
  const [day, setDay] = useState(firstOpenDay);
  const [timeOfDay, setTimeOfDay] = useState<GroomWindow>("any");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const pet = page.pets.find((p) => p.id === dogId) ?? null;
  const service = page.services.find((s) => s.id === serviceId) ?? null;
  const quote =
    pet && service
      ? groomRequestQuote({
          service,
          rules: page.rules,
          pet,
          addons: page.addons,
          picked: picked.map((id) => ({ addonServiceId: id, quantity: 1 })),
          bufferMin: page.bufferMin,
        })
      : null;
  const workDay = page.workDays.includes(new Date(`${day}T12:00:00Z`).getUTCDay());

  const send = useMutation({
    mutationFn: () =>
      requestFn({
        data: {
          token,
          dogId,
          serviceId,
          addons: picked.map((id) => ({ addonServiceId: id, quantity: 1 })),
          day,
          window: timeOfDay,
          message,
        },
      }),
    onSuccess: (r) => {
      setSent(
        r.alreadyAsked
          ? `You already asked for ${pet?.name ?? "this pet"} on ${fmtDayShort(day)}. We'll be in touch about it.`
          : `Request sent for ${pet?.name ?? "your pet"} on ${fmtDayShort(day)}. We'll confirm the start time.`,
      );
      setMessage("");
      setPicked([]);
      qc.invalidateQueries({ queryKey: ["portal", token] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (page.pets.length === 0) {
    return (
      <EmptyBox
        icon={<Scissors className="h-6 w-6 shrink-0" />}
        title="No pets on file yet"
        body="Text the office and we'll add your pet, then you can ask for a groom here."
      />
    );
  }
  if (page.services.length === 0) {
    return (
      <EmptyBox
        icon={<Scissors className="h-6 w-6 shrink-0" />}
        title="Grooms aren't open for requests yet"
        body="Call or text us to book a groom."
      />
    );
  }

  const ready = !!pet && !!service && !!day && day >= tomorrow && day <= lastDay && workDay;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex min-w-0 items-start gap-2">
        <CalendarPlus className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Request a groom</h2>
          <p className="text-sm text-muted-foreground">
            Pick a day and a time of day that suits you. We'll confirm the start time and your
            groomer.
          </p>
        </div>
      </div>

      {sent && (
        <p
          role="status"
          className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
        >
          {sent}
        </p>
      )}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) send.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="groom-pet">Pet</Label>
            <select
              id="groom-pet"
              className={selectClass}
              value={dogId}
              onChange={(e) => {
                setDogId(e.target.value);
                setSent(null);
              }}
            >
              <option value="">Choose a pet</option>
              {page.pets.map((p) => (
                <option key={p.id} value={p.id}>
                  {groomPetLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="groom-service">Groom</Label>
            <select
              id="groom-service"
              className={selectClass}
              value={serviceId}
              onChange={(e) => {
                setServiceId(e.target.value);
                setSent(null);
              }}
            >
              <option value="">Choose a groom</option>
              {page.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {page.addons.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Add-ons</legend>
            <ul className="grid gap-2 sm:grid-cols-2">
              {page.addons.map((a) => {
                const on = picked.includes(a.id);
                return (
                  <li key={a.id}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={on}
                        onCheckedChange={(v) =>
                          setPicked((prev) =>
                            v === true ? [...prev, a.id] : prev.filter((x) => x !== a.id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-medium">{a.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {money(a.unit_price_cents)}
                          {a.duration_min > 0 ? ` · ${a.duration_min} min` : ""}
                        </span>
                        {a.description && (
                          <span className="block break-words text-xs text-muted-foreground">
                            {a.description}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="groom-day">Preferred day</Label>
            <Input
              id="groom-day"
              type="date"
              min={tomorrow}
              max={lastDay}
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="w-full min-w-0"
            />
            {day && !workDay && (
              <p className="text-xs text-destructive">
                We don't groom that day. Please pick another.
              </p>
            )}
          </div>
          <fieldset className="min-w-0 space-y-1">
            <legend className="text-sm font-medium">Time of day</legend>
            <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
              {GROOM_WINDOW_KEYS.map((k) => (
                <label
                  key={k}
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${
                    timeOfDay === k ? "border-primary ring-1 ring-primary" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="groom-window"
                    value={k}
                    checked={timeOfDay === k}
                    onChange={() => setTimeOfDay(k)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0">{GROOM_WINDOWS[k].label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="space-y-1">
          <Label htmlFor="groom-note">Anything we should know (optional)</Label>
          <Textarea
            id="groom-note"
            rows={2}
            maxLength={1000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Matting behind the ears, a shorter cut this time"
          />
        </div>

        {quote && (
          <div className="rounded-md bg-muted/50 p-3 text-sm" aria-live="polite">
            <p className="font-medium">
              {quote.cents != null ? money(quote.cents) : "Price confirmed by the office"}
              {quote.minutes > 0 ? ` · about ${quote.minutes} min` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Worked out from {pet?.name}'s size and coat and the add-ons you picked. The office
              confirms it when they book.
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={!ready || send.isPending} className="w-full sm:w-auto">
            {send.isPending ? "Sending…" : "Send request"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function GroomRequests({ page }: { page: Grooming }) {
  if (page.requests.length === 0) return null;
  const petName = (id: string | null) => page.pets.find((p) => p.id === id)?.name ?? "Your pet";
  const serviceName = (id: string | null) =>
    page.services.find((s) => s.id === id)?.name ?? "Groom";
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <ClipboardList className="h-4 w-4 shrink-0" /> Your groom requests
      </h2>
      <ul className="space-y-2">
        {page.requests.map((r) => {
          const asked = groomWindowOf(r.from, r.until);
          const at = clockOf(r.bookedAt);
          return (
            <li key={r.id} className="rounded-md border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words font-medium">
                    {serviceName(r.serviceId)} for {petName(r.dogId)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.bookedOn
                      ? `Booked for ${fmtDayShort(r.bookedOn)}${at ? ` at ${at}` : ""}`
                      : `Asked for ${r.requestedOn ? fmtDayShort(r.requestedOn) : ""}, ${GROOM_WINDOWS[asked].label.toLowerCase()}`}
                    {r.quotedCents != null ? ` · ${money(r.quotedCents)}` : ""}
                  </p>
                </div>
                {r.bookedOn ? (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600">Booked</Badge>
                ) : r.status === "resolved" ? (
                  <Badge variant="secondary">Not booked</Badge>
                ) : (
                  <Badge variant="secondary">Received</Badge>
                )}
              </div>
              {r.note && !r.bookedOn && (
                <div className="mt-2 rounded border-l-2 border-emerald-500 bg-emerald-50 p-2 text-xs text-emerald-900">
                  <strong>Office reply:</strong> {r.note}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
