import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DateField, TimeField } from "@/components/fields";
import { PetCareFields } from "@/components/PetCareFields";
import { PortalVisitReport } from "@/components/portal/VisitReport";
import {
  PORTAL_PET_NAME_MAX,
  portalAddPet,
  portalListStays,
  portalRequestStay,
} from "@/lib/portal-stays.functions";
import { money, usePortalCtx, usePortalTimezone } from "@/lib/portal-ui";
import { orgToday } from "@/lib/org-day";
import {
  DEFAULT_DROP_IN_WINDOW,
  DEFAULT_OVERNIGHT_ARRIVAL,
  stayDatesLabel,
  stayDatesProblem,
  stayKindFor,
  stayVisitCount,
  stayWindowsProblem,
  arrivalWindowProblem,
  STAY_STATUS_LABEL,
} from "@/lib/stays";
import {
  cleanMeds,
  medsProblem,
  PET_SPECIES,
  PET_SPECIES_LABEL,
  SPECIES_NOTE_MAX,
  speciesLabel,
  type PetCare,
  type PetSpecies,
} from "@/lib/pets";

const selectClass = "min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

export function usePortalStays() {
  const { token, verified } = usePortalCtx();
  const fn = useServerFn(portalListStays);
  return useQuery({
    queryKey: ["portal", token, "stays"],
    queryFn: () => fn({ data: { token } }),
    enabled: verified,
    staleTime: 30_000,
  });
}

export function PortalStayRequest() {
  const q = usePortalStays();
  const { token, invalidatePortal } = usePortalCtx();
  const qc = useQueryClient();
  const request = useServerFn(portalRequestStay);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [serviceChoice, setService] = useState("");
  const [propertyChoice, setProperty] = useState("");
  const [startsOn, setStart] = useState("");
  // A stay does not start on a day that is already over (#654).
  const portalToday = orgToday(usePortalTimezone());
  const [endsOn, setEnd] = useState("");
  const [windows, setWindows] = useState([DEFAULT_DROP_IN_WINDOW]);
  const [arrival, setArrival] = useState(DEFAULT_OVERNIGHT_ARRIVAL);
  const [petIds, setPets] = useState<string[]>([]);
  const [care, setCare] = useState<Record<string, PetCare>>({});
  const [notes, setNotes] = useState("");
  const [sent, setSent] = useState(false);
  const opts = q.data;
  const serviceId = serviceChoice || opts?.services[0]?.id || "";
  const propertyId = propertyChoice || opts?.properties[0]?.id || "";
  const kind = stayKindFor(opts?.services.find((s) => s.id === serviceId)?.price_unit);
  const pets = opts?.pets.filter((p) => p.propertyId === propertyId) ?? [];
  const selected = pets.filter((p) => petIds.includes(p.id));
  const problem =
    stayDatesProblem(kind, startsOn, endsOn) ??
    (kind === "overnight" ? arrivalWindowProblem(arrival) : stayWindowsProblem(windows)) ??
    selected.map((p) => medsProblem(cleanMeds((care[p.id] ?? p.care).meds))).find(Boolean) ??
    (selected.length === 0 ? "Choose at least one pet." : null);
  const mut = useMutation({
    mutationFn: () =>
      request({
        data: {
          token,
          requestKey,
          serviceId,
          propertyId,
          startsOn,
          endsOn,
          windows,
          arrival,
          petIds: selected.map((p) => p.id),
          notes,
          care: selected.map((p) => {
            const c = care[p.id] ?? p.care;
            return {
              petId: p.id,
              feeding: c.feeding ?? "",
              otherCare: c.other_care ?? "",
              meds: cleanMeds(c.meds),
            };
          }),
        },
      }),
    onSuccess: () => {
      setSent(true);
      invalidatePortal();
      qc.invalidateQueries({ queryKey: ["portal", token, "stays"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!opts?.offered)
    return q.isError ? (
      <p role="alert" className="text-sm text-destructive">
        Stay requests could not be loaded. Refresh to try again.
      </p>
    ) : null;
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <h2 className="text-lg font-semibold">Request a stay</h2>
      <p className="text-sm text-muted-foreground">
        Choose the days you need care. The office will confirm availability and send your invoice.
      </p>
      {!opts.canRequest ? (
        <p className="text-sm text-muted-foreground">
          Pet sitting is coming soon. You can still follow an existing stay on the Visits page.
        </p>
      ) : sent ? (
        <div className="space-y-3">
          <p role="status">Your stay request was sent. We will email you when it is confirmed.</p>
          <Button
            variant="outline"
            onClick={() => {
              setSent(false);
              setRequestKey(crypto.randomUUID());
              setStart("");
              setEnd("");
            }}
          >
            Request another stay
          </Button>
        </div>
      ) : opts.services.length === 0 || opts.properties.length === 0 ? (
        <p className="text-sm">Contact the office to arrange a sitting service.</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) mut.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="stay-service">Service</Label>
              <select
                id="stay-service"
                className={selectClass}
                value={serviceId}
                onChange={(e) => setService(e.target.value)}
              >
                {opts.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="stay-property">Home</Label>
              <select
                id="stay-property"
                className={selectClass}
                value={propertyId}
                onChange={(e) => {
                  setProperty(e.target.value);
                  setPets([]);
                }}
              >
                {opts.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.street}
                  </option>
                ))}
              </select>
            </div>
            <DateField
              label={kind === "overnight" ? "Check-in" : "First day"}
              value={startsOn}
              onChange={setStart}
              minISO={portalToday}
            />
            <DateField
              label={kind === "overnight" ? "Check-out" : "Last day"}
              value={endsOn}
              onChange={setEnd}
              minISO={startsOn || undefined}
            />
          </div>
          {kind === "overnight" ? (
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium">Overnight arrival</legend>
              <TimeField
                label="Earliest arrival"
                value={arrival.earliestTime}
                clearable={false}
                onChange={(v) => setArrival({ ...arrival, earliestTime: v })}
              />
              <TimeField
                label="Latest arrival"
                value={arrival.latestTime}
                clearable={false}
                onChange={(v) => setArrival({ ...arrival, latestTime: v })}
              />
            </fieldset>
          ) : (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Drop-in windows, each day</legend>
              {windows.map((w, i) => (
                <div key={i} className="space-y-2 rounded border p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TimeField
                      label={`Visit ${i + 1}, earliest arrival`}
                      value={w.earliestTime}
                      clearable={false}
                      onChange={(v) =>
                        setWindows(windows.map((x, j) => (j === i ? { ...x, earliestTime: v } : x)))
                      }
                    />
                    <TimeField
                      label={`Visit ${i + 1}, latest arrival`}
                      value={w.latestTime}
                      clearable={false}
                      onChange={(v) =>
                        setWindows(windows.map((x, j) => (j === i ? { ...x, latestTime: v } : x)))
                      }
                    />
                  </div>
                  {windows.length > 1 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setWindows(windows.filter((_, j) => j !== i))}
                    >
                      Remove window {i + 1}
                    </Button>
                  )}
                </div>
              ))}
              {windows.length < 4 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setWindows([...windows, { earliestTime: "17:00", latestTime: "19:00" }])
                  }
                >
                  Add drop-in window
                </Button>
              )}
            </fieldset>
          )}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Pets and care instructions</legend>
            {pets.map((p) => (
              <div key={p.id} className="rounded border p-3">
                <label className="flex min-h-11 items-center gap-3 break-words text-sm">
                  <input
                    type="checkbox"
                    checked={petIds.includes(p.id)}
                    onChange={(e) =>
                      setPets(
                        e.target.checked ? [...petIds, p.id] : petIds.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {p.name} ({speciesLabel(p) ?? "Dog"})
                </label>
                {petIds.includes(p.id) && (
                  <PetCareFields
                    petId={p.id}
                    value={care[p.id] ?? p.care}
                    onChange={(next) => setCare({ ...care, [p.id]: next })}
                  />
                )}
              </div>
            ))}
            {pets.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No pets on file at this home yet. Add the pets this stay is for.
              </p>
            )}
            <PortalAddPet
              key={propertyId}
              propertyId={propertyId}
              onAdded={(id) => {
                if (!petIds.includes(id)) setPets([...petIds, id]);
                qc.invalidateQueries({ queryKey: ["portal", token, "stays"] });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Care changes are sent to the office with this request. They apply after the office
              confirms it.
            </p>
          </fieldset>
          <div>
            <Label htmlFor="stay-notes">Notes for the office</Label>
            <Textarea
              id="stay-notes"
              rows={3}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {!stayDatesProblem(kind, startsOn, endsOn) && (
            <p className="text-sm">
              {stayVisitCount(kind, startsOn, endsOn, windows.length)} visits requested.
            </p>
          )}
          {problem && startsOn && <p className="text-sm text-muted-foreground">{problem}</p>}
          <Button type="submit" disabled={!!problem || mut.isPending}>
            {mut.isPending ? "Sending…" : "Send stay request"}
          </Button>
        </form>
      )}
    </section>
  );
}

const VISIT_STATUS: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  canceled: "Canceled",
  skipped: "Skipped",
  missed: "Missed",
};

export function PortalStayTimeline() {
  const q = usePortalStays();
  const { token, slug } = usePortalCtx();
  if (q.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Stay timelines could not be loaded. Refresh to try again.
      </p>
    );
  if (!q.data?.offered) return null;
  if (!q.data.stays.length)
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Your stays</h2>
        <p className="text-sm text-muted-foreground">
          No stays yet. Once the office books your stay, you can follow each visit here.
        </p>
      </section>
    );
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Your stays</h2>
      {q.data.stays.map((s) => (
        <article key={s.id} className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 break-words">
              <h3 className="font-medium">{s.serviceName}</h3>
              <p className="text-sm">{stayDatesLabel(s.kind, s.startsOn, s.endsOn)}</p>
            </div>
            <span className="text-sm text-muted-foreground">{STAY_STATUS_LABEL[s.status]}</span>
          </div>
          {s.depositDue && s.depositInvoiceId && (
            <Button asChild>
              <Link
                to="/portal/$slug/$token/pay/$invoiceId"
                params={{ slug, token, invoiceId: s.depositInvoiceId }}
              >
                Pay deposit {money(s.depositCents, q.data.currency)}
              </Link>
            </Button>
          )}
          {s.status === "requested" && (
            <p className="text-sm text-muted-foreground">Waiting for the office to confirm.</p>
          )}
          <ol className="space-y-2">
            {s.visits.map((v) => (
              <li key={v.id} className="space-y-2 rounded border p-3">
                <p className="text-xs text-muted-foreground">
                  {VISIT_STATUS[v.status] ?? v.status}
                  {v.window ? ` · ${v.window}` : ""}
                </p>
                <PortalVisitReport report={v} photoLabel="Sitting visit" />
                {v.care.length > 0 && (
                  <ul data-stay-care-log={v.id} className="space-y-1 text-sm">
                    {v.care.map((entry) => (
                      <li key={entry.id} className="min-w-0 break-words">
                        <bdi>{entry.pet}</bdi>
                        {": "}
                        {entry.line}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
}

/** "Add a pet" inside the stay request (#411): a cat, or any pet the office
 *  has not recorded yet. Name and kind only; care goes with the request. */
function PortalAddPet({
  propertyId,
  onAdded,
}: {
  propertyId: string;
  onAdded: (id: string) => void;
}) {
  const { token } = usePortalCtx();
  const add = useServerFn(portalAddPet);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [species, setSpecies] = useState<PetSpecies>("cat");
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      add({
        data: {
          token,
          propertyId,
          name,
          species,
          speciesNote: species === "other" ? note : null,
        },
      }),
    onSuccess: (r) => {
      toast.success(r.added ? `${name.trim()} added.` : `${name.trim()} is already on file.`);
      onAdded(r.id);
      setName("");
      setNote("");
      setOpen(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add a pet
      </Button>
    );
  const problem = !name.trim() ? "Enter your pet's name." : null;
  return (
    <div className="space-y-3 rounded border p-3" data-portal-add-pet>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <Label htmlFor="portal-pet-name">Pet's name</Label>
          <Input
            id="portal-pet-name"
            className="min-h-11"
            value={name}
            maxLength={PORTAL_PET_NAME_MAX}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="portal-pet-species">Kind of pet</Label>
          <select
            id="portal-pet-species"
            className={selectClass}
            value={species}
            onChange={(e) => setSpecies(e.target.value as PetSpecies)}
          >
            {PET_SPECIES.map((sp) => (
              <option key={sp} value={sp}>
                {PET_SPECIES_LABEL[sp]}
              </option>
            ))}
          </select>
        </div>
        {species === "other" && (
          <div className="min-w-0 sm:col-span-2">
            <Label htmlFor="portal-pet-note">What kind? (rabbit, bird, fish)</Label>
            <Input
              id="portal-pet-note"
              className="min-h-11"
              value={note}
              maxLength={SPECIES_NOTE_MAX}
              autoComplete="off"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!!problem || mut.isPending}
          onClick={() => mut.mutate()}
        >
          {mut.isPending ? "Adding…" : "Add pet"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={mut.isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
