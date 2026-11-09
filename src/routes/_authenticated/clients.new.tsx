import { PetSizeFields } from "@/components/client-detail/PetSizeFields";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { lookupAddressPoint } from "@/lib/geocode.functions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onboardClient, getInternalQuote } from "@/lib/clients.functions";
import { getFirstCleanupPricing } from "@/lib/first-cleanup.functions";
import { newClientWizardSteps, type NewClientStep } from "@/lib/service-lines";
import { useServiceLines } from "@/components/CommercialOnly";
import {
  firstCleanupDescription,
  firstCleanupPriceCents,
  LAST_CLEANED_QUESTION,
} from "@/lib/first-cleanup";
import { usePermissions } from "@/hooks/useMyRole";
import { getLeadForConversion, linkLeadToExistingClient } from "@/lib/leads.functions";
import { getQuote, markQuoteConverted } from "@/lib/quotes.functions";
import { convertTarget, quoteConversion, quoteToWizardPrefill } from "@/lib/quotes";
import {
  BLANK_DOG,
  EMPTY_PREFILL,
  leadBooksAGroom,
  leadConversionState,
  leadStartDate,
  leadToWizardPrefill,
  type WizardDog as Dog,
  type WizardPrefill,
} from "@/lib/lead-conversion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupSegment } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { BoundarySketch, formatArea, type PolygonGeoJSON } from "@/components/BoundarySketch";
import { AddressAutocomplete, type ResolvedAddress } from "@/components/AddressAutocomplete";
import { Check, ChevronRight, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { getEmailSendStatus } from "@/lib/notifications.functions";
import { reportQueuedSend } from "@/lib/send-report";
import { useOrgToday } from "@/hooks/useOrgToday";
import { formatDay } from "@/lib/format";
import { titleHead } from "@/lib/page-title";
import {
  effectiveServiceId,
  ServicePicker,
  useOrgServices,
} from "@/components/client-detail/ServicePicker";
import { usePickerLines } from "@/components/CommercialOnly";
import { WeekdayPicker } from "@/components/client-detail/WeekdayPicker";
import { servicePickerOptions } from "@/lib/visit-service";
import { isZonePriced, servicePriceCents } from "@/lib/services";
import {
  normalizeWeekdays,
  pickServiceDay,
  serviceDaysFor,
  serviceDaysPerWeek,
} from "@/lib/weekday-set";
import { defaultPlanWeekdays, planStartsSkipped, propertyHazardsFor } from "@/lib/new-client-plan";
import { serverErrorMessage } from "@/lib/server-outcome";
import { createFailedMessage } from "@/lib/create-client-error";
import { typedPriceCents } from "@/lib/typed-price";
import { useFormDraft } from "@/hooks/useFormDraft";
import { DraftRestoredNotice } from "@/components/DraftRestoredNotice";
import { newClientDraftForm } from "@/lib/form-drafts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/_authenticated/clients/new")({
  head: () => titleHead("New client"),
  // `fromLead` is the lead's id and nothing else. The wizard fetches the lead
  // server-side; its name, email, phone and address never go in the URL.
  validateSearch: (s: Record<string, unknown>): { fromLead?: string; fromQuote?: string } => ({
    fromLead: typeof s.fromLead === "string" && UUID.test(s.fromLead) ? s.fromLead : undefined,
    fromQuote: typeof s.fromQuote === "string" && UUID.test(s.fromQuote) ? s.fromQuote : undefined,
  }),
  component: NewClientPage,
});

type FromLead = {
  id: string;
  name: string;
  /** The lead's own dog count, before it was turned into rows. */
  dogCount: number | null;
  existingClient: { id: string; displayName: string } | null;
};

/**
 * The wizard, started either blank or from a lead.
 *
 * The wizard's state is plain useState, seeded once at mount. TanStack keeps
 * this component mounted when only the search string changes, so the `key`
 * below is what makes /clients/new?fromLead=A to ?fromLead=B, or to a blank
 * /clients/new, start again from nothing.
 *
 * Since gaps-r2-12 the wizard also keeps a draft on the device, per user and
 * organization (useFormDraft), so a reload or Android back no longer loses
 * the step and the values. Its form name carries the lead or quote id
 * (newClientDraftForm), so one lead's draft can never open under another's,
 * nor under a blank wizard.
 */
function NewClientPage() {
  const { fromLead, fromQuote } = Route.useSearch();
  const getLeadFn = useServerFn(getLeadForConversion);
  const leadQ = useQuery({
    enabled: !!fromLead,
    queryKey: ["lead-for-conversion", fromLead],
    queryFn: () => getLeadFn({ data: { id: fromLead! } }),
    // Read fresh on every open: a cached copy is how a lead converted in
    // another tab gets offered for conversion again. (onboardClient re-checks
    // on save regardless; this is so the owner is not walked through five
    // steps to be refused at the end.)
    staleTime: 0,
    gcTime: 0,
    // But never re-read while the wizard is open. A failed background refetch
    // puts the query in its error state, which would unmount the wizard and
    // throw away everything typed into it.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // An accepted quote to a prospect, being turned into a client. It may carry
  // a lead too (a quote sent from /leads), and the lead is converted with it.
  if (fromQuote) {
    return (
      <NewClientFromQuote
        key={fromQuote}
        quoteId={fromQuote}
        leadId={fromLead ?? null}
        lead={leadQ.data ?? null}
        leadPending={!!fromLead && leadQ.isPending}
      />
    );
  }

  if (!fromLead) return <NewClientWizard key="blank" prefill={EMPTY_PREFILL} fromLead={null} />;

  if (leadQ.isPending) {
    return (
      <WizardShell backTo="leads">
        <Card className="p-6 text-sm text-muted-foreground">Loading the lead…</Card>
      </WizardShell>
    );
  }
  if (leadQ.isError) {
    return (
      <WizardShell backTo="leads">
        <Card className="space-y-3 p-6 text-sm">
          <p role="alert">{(leadQ.error as Error).message || "That lead could not be loaded."}</p>
          <Button asChild variant="outline">
            <Link to="/leads">Back to leads</Link>
          </Button>
        </Card>
      </WizardShell>
    );
  }

  const { lead, existingClient } = leadQ.data;
  const state = leadConversionState(lead);
  if (state.kind !== "convertible") {
    return (
      <WizardShell backTo="leads">
        <Card className="space-y-3 p-6 text-sm">
          <p className="break-words font-medium">
            {state.kind === "linked"
              ? `${lead.name} is already a client.`
              : `${lead.name} is already marked converted.`}
          </p>
          <p className="text-muted-foreground">
            {state.kind === "linked"
              ? "Converting the lead again would put the same household on the books twice."
              : "It was marked converted from the status menu, not through this form, so there is no client record to open. Change the lead's status first if they still need one."}
          </p>
          <div className="flex flex-wrap gap-2">
            {state.kind === "linked" && (
              <Button asChild>
                <Link to="/clients/$clientId" params={{ clientId: state.clientId }}>
                  Open client
                </Link>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to="/leads">Back to leads</Link>
            </Button>
          </div>
        </Card>
      </WizardShell>
    );
  }

  return (
    <NewClientWizard
      key={lead.id}
      prefill={leadToWizardPrefill(lead)}
      fromLead={{ id: lead.id, name: lead.name, dogCount: lead.dog_count, existingClient }}
    />
  );
}

type FromQuote = {
  id: string;
  label: string;
  /** The quote's per-visit total, or null when it has no recurring line. */
  priceCents: number | null;
  oneTimeCents: number;
};

/**
 * The wizard started from an accepted quote to somebody who is not a client
 * yet. Refuses anything else: a quote for an existing client converts from
 * that client's Services tab, and an unanswered or already-converted quote
 * has nothing to convert.
 */
function NewClientFromQuote({
  quoteId,
  leadId,
  lead,
  leadPending,
}: {
  quoteId: string;
  leadId: string | null;
  lead: Awaited<ReturnType<typeof getLeadForConversion>> | null;
  leadPending: boolean;
}) {
  const getQuoteFn = useServerFn(getQuote);
  const quoteQ = useQuery({
    queryKey: ["quote-for-conversion", quoteId],
    queryFn: () => getQuoteFn({ data: { id: quoteId } }),
    // Read fresh, and never re-read while the wizard is open: the same two
    // reasons as the lead query above.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (quoteQ.isPending || leadPending) {
    return (
      <WizardShell backTo="quotes">
        <Card className="p-6 text-sm text-muted-foreground">Loading the quote…</Card>
      </WizardShell>
    );
  }
  if (quoteQ.isError) {
    return (
      <WizardShell backTo="quotes">
        <Card className="space-y-3 p-6 text-sm">
          <p role="alert">{(quoteQ.error as Error).message || "That quote could not be loaded."}</p>
          <Button asChild variant="outline">
            <Link to="/quotes">Back to quotes</Link>
          </Button>
        </Card>
      </WizardShell>
    );
  }

  const { quote, lines } = quoteQ.data;
  const target = convertTarget({
    status: quote.status,
    client_id: quote.clientId,
    lead_id: quote.leadId,
    converted_at: quote.convertedAt,
  });
  if (target.kind !== "prospect") {
    return (
      <WizardShell backTo="quotes">
        <Card className="space-y-3 p-6 text-sm">
          <p className="break-words font-medium">
            {target.kind === "client"
              ? `${quote.label} is for an existing client. Add the service from their Services tab.`
              : target.reason}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/quotes/$quoteId" params={{ quoteId: quote.id }}>
                Open {quote.label}
              </Link>
            </Button>
          </div>
        </Card>
      </WizardShell>
    );
  }

  // The lead is used only if it can still be converted. One that already
  // became a client (or was marked converted by hand) would stop the wizard
  // with the lead's refusal, and the quote is reason enough to go on.
  const convertibleLead =
    leadId &&
    lead &&
    lead.lead.id === leadId &&
    leadConversionState(lead.lead).kind === "convertible"
      ? lead
      : null;
  const conversion = quoteConversion(lines);
  return (
    <NewClientWizard
      key={`${quote.id}:${convertibleLead?.lead.id ?? "no-lead"}`}
      prefill={
        convertibleLead ? leadToWizardPrefill(convertibleLead.lead) : quoteToWizardPrefill(quote)
      }
      fromLead={
        convertibleLead
          ? {
              id: convertibleLead.lead.id,
              name: convertibleLead.lead.name,
              dogCount: convertibleLead.lead.dog_count,
              existingClient: convertibleLead.existingClient,
            }
          : null
      }
      fromQuote={{ id: quote.id, label: quote.label, ...conversion }}
    />
  );
}

function WizardShell({
  backTo,
  children,
}: {
  backTo: "clients" | "leads" | "quotes";
  children: ReactNode;
}) {
  return (
    <>
      <div>
        {backTo === "quotes" ? (
          <Link to="/quotes" className="text-sm text-muted-foreground hover:underline">
            ← Quotes
          </Link>
        ) : backTo === "leads" ? (
          <Link to="/leads" className="text-sm text-muted-foreground hover:underline">
            ← Leads
          </Link>
        ) : (
          <Link to="/clients" className="text-sm text-muted-foreground hover:underline">
            ← Clients
          </Link>
        )}
        <h1 className="mt-2 text-2xl font-semibold">New client</h1>
      </div>
      {children}
    </>
  );
}

const FREQS = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "twice_weekly", label: "Twice weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "one_time", label: "One-time" },
] as const;

// The wizard's steps come from newClientWizardSteps (lib/service-lines): the
// Outline step is pet-waste-only. Steps are addressed by NAME below, never by
// position, so dropping one cannot move the Plan step's quote onto Dogs.

/** The next calendar day after an org-calendar day (YYYY-MM-DD). */
function tomorrowOf(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday, the numbering subscriptions.preferred_weekdays uses. */
function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format((cents ?? 0) / 100);
}

/** "Base $40.00 + 8 stations $48.00" for a commercial quote's line. */
function commercialBasis(
  c: { baseCents: number; unitCents: number; acreageCents: number; stationCents: number } | null,
  units: number,
  stations: number,
): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  if (!c) return `Based on ${n(units, "unit")} and ${n(stations, "station")}`;
  const parts = [`Base ${money(c.baseCents)}`];
  if (c.unitCents) parts.push(`${n(units, "unit")} ${money(c.unitCents)}`);
  if (c.stationCents) parts.push(`${n(stations, "station")} ${money(c.stationCents)}`);
  if (c.acreageCents) parts.push(`grounds ${money(c.acreageCents)}`);
  return parts.join(" + ");
}

function polyAreaSqm(g: PolygonGeoJSON): number {
  const ring = g.coordinates[0];
  if (!ring || ring.length < 4) return 0;
  const R = 6378137;
  const latMean = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const cosLat = Math.cos(latMean);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const x1 = xi * (Math.PI / 180) * R * cosLat;
    const y1 = yi * (Math.PI / 180) * R;
    const x2 = xj * (Math.PI / 180) * R * cosLat;
    const y2 = yj * (Math.PI / 180) * R;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

type WizardProps = {
  prefill: WizardPrefill;
  fromLead: FromLead | null;
  fromQuote?: FromQuote | null;
};

/** "Discard draft" puts the wizard back to how it opened by remounting it:
 *  thirty-odd fields and the step, all seeded at mount. */
function NewClientWizard(props: WizardProps) {
  const [generation, setGeneration] = useState(0);
  return (
    <NewClientWizardForm
      key={generation}
      {...props}
      onDiscarded={() => setGeneration((g) => g + 1)}
    />
  );
}

function NewClientWizardForm({
  prefill,
  fromLead,
  fromQuote = null,
  onDiscarded,
}: WizardProps & { onDiscarded: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const onboardFn = useServerFn(onboardClient);
  const emailStatusFn = useServerFn(getEmailSendStatus);
  const convertedFn = useServerFn(markQuoteConverted);
  const quoteFn = useServerFn(getInternalQuote);
  const geocodeFn = useServerFn(lookupAddressPoint);
  const linkFn = useServerFn(linkLeadToExistingClient);

  const [step, setStep] = useState(0);
  const { petWaste, lines, known: linesKnown } = useServiceLines();
  const pickerLines = usePickerLines();
  const sitting = lines.includes("pet_sitting");
  const grooming = lines.includes("mobile_grooming");
  // A grooming lead books a groom, priced from the size grid, once the
  // client exists; the recurring Plan step would price it as a weekly plan
  // at the service's base price (#657). Settled once the services have
  // loaded, since the lead's service is what decides. The owner can still
  // choose a recurring plan instead.
  const { services: orgServices, isLoading: servicesLoading } = useOrgServices();
  const leadServiceLine = prefill.serviceId
    ? (orgServices.find((x) => x.id === prefill.serviceId)?.service_line ?? null)
    : null;
  const groomLead =
    !!fromLead &&
    !fromQuote &&
    !(prefill.serviceId && servicesLoading) &&
    leadBooksAGroom(leadServiceLine, lines);
  const [groomInstead, setGroomInstead] = useState(true);
  const booksGroom = groomLead && groomInstead;
  const steps = newClientWizardSteps(petWaste).filter((s) => !(booksGroom && s === "Plan"));
  // Clamped: if the answer arrives while somebody is on the last step, the
  // list can be one shorter than the index they were on.
  const current: NewClientStep = steps[Math.min(step, steps.length - 1)];
  // Every step opened at the BOTTOM. Next and Back sit at the foot of the
  // card, the step is swapped in place, and the window keeps the scroll
  // offset the press was made at — so the new step started at its buttons
  // and its first field was a screen above. The page scrolls on the window
  // (the shell's <main> is not a scroller). Skipped on mount, which is the
  // router's scroll to decide.
  const stepMounted = useRef(false);
  useEffect(() => {
    if (!stepMounted.current) {
      stepMounted.current = true;
      return;
    }
    window.scrollTo({ top: 0 });
  }, [step]);
  // Turn on inline "required" messages after the user tries to advance —
  // showing red text on first render would be too noisy.
  const [attempted, setAttempted] = useState(false);

  // contact
  const [displayName, setDisplayName] = useState(prefill.displayName);
  const [accountType, setAccountType] = useState<"residential" | "commercial">("residential");
  const [primaryEmail, setPrimaryEmail] = useState(prefill.primaryEmail);
  const [primaryPhone, setPrimaryPhone] = useState(prefill.primaryPhone);
  const [officeNote, setOfficeNote] = useState(prefill.officeNote);

  // property
  const [street, setStreet] = useState(prefill.street);
  const [city, setCity] = useState(prefill.city);
  const [region, setRegion] = useState(prefill.region);
  const [postalCode, setPostalCode] = useState(prefill.postalCode);
  const [gateCode, setGateCode] = useState("");
  // The lead's "Gate code or access notes" (#657), for properties.access_notes.
  const [accessNotes, setAccessNotes] = useState(prefill.accessNotes);
  const [parkingNotes, setParkingNotes] = useState("");
  const [hazardNotes, setHazardNotes] = useState("");
  // P3.5 optional on-site visit contact (tenant/property manager)
  const [vcName, setVcName] = useState("");
  const [vcPhone, setVcPhone] = useState("");
  const [vcEmail, setVcEmail] = useState("");
  const [hz, setHz] = useState({
    doNotEnterIfDogOut: false,
    aggressiveDog: false,
    escapeRisk: false,
    invisibleFence: false,
    dogInYardDuringService: false,
    beesWasps: false,
    sharpObjects: false,
    slipperySurfaces: false,
  });

  // yard boundary
  const [boundary, setBoundary] = useState<PolygonGeoJSON | null>(null);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  // Geocode outcome for the Outline step, so a failure surfaces a clear message
  // instead of silently rendering a zoomed-out world map (finding #13).
  const [geoStatus, setGeoStatus] = useState<"idle" | "loading" | "ok" | "notfound" | "error">(
    "idle",
  );
  const boundaryAreaSqm = useMemo(() => (boundary ? polyAreaSqm(boundary) : null), [boundary]);

  // Address entry, same contract as PropertyDrawer: a matched address fills
  // every field at once and brings its own coordinates, and any hand edit
  // afterwards throws those coordinates away.
  //
  // Throwing them away matters more here than it looks. The Outline step's
  // geocode effect is guarded by `if (geo) return;`, so a pin left over from
  // the address the user has just corrected would be the pin they draw a
  // boundary on — for the wrong house, with no way to tell from the map.
  function applyResolvedAddress(r: ResolvedAddress) {
    setStreet(r.address.street);
    setCity(r.address.city);
    if (r.address.region) setRegion(r.address.region);
    setPostalCode(r.address.postalCode);
    if (r.address.latitude != null && r.address.longitude != null) {
      // A provider match is a better pin than the Outline step's Nominatim
      // lookup, and it saves the round trip: the effect there is a fallback
      // for hand-typed addresses now.
      setGeo({ lat: r.address.latitude, lng: r.address.longitude });
      setGeoStatus("ok");
    } else {
      setGeo(null);
      setGeoStatus("idle");
    }
  }
  function setAddressField(set: (v: string) => void, v: string) {
    set(v);
    setGeo(null);
    setGeoStatus("idle");
  }

  // Best-effort geocode when entering the Outline step
  useEffect(() => {
    if (current !== "Outline") return;
    if (geo) return;
    const q = [street, city, region, postalCode].filter(Boolean).join(", ");
    if (q.length < 6) {
      setGeoStatus("notfound");
      return;
    }
    // A `cancelled` flag rather than an AbortController: a server function
    // takes no signal, so the guard this needs is against a STALE result
    // landing after the address changed, which is what the abort was doing
    // here anyway.
    let cancelled = false;
    setGeoStatus("loading");
    (async () => {
      try {
        const { geo: g } = await geocodeFn({ data: { query: q } });
        if (cancelled) return;
        if (g) {
          setGeo({ lat: g.latitude, lng: g.longitude });
          setGeoStatus("ok");
        } else {
          setGeoStatus("notfound");
        }
      } catch {
        if (cancelled) return;
        setGeoStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current, street, city, region, postalCode, geo, geocodeFn]);

  // dogs
  const [dogs, setDogs] = useState<Dog[]>(() => prefill.dogs.map((d) => ({ ...d })));
  // Only a named dog is saved as a dog record: the database refuses a blank or
  // placeholder name, and a tech cannot use one.
  const validDogs = dogs.filter((d) => d.name.trim().length > 0);
  // The plan is priced from the ROWS on the Dogs step, named or not. It used to
  // count named dogs only, which was harmless while the step always opened on
  // one blank row, and wrong once a lead that said "3 dogs" opens it on three:
  // an owner who has not learned the names yet would have priced one dog.
  const dogCount = Math.max(1, dogs.length);

  // plan
  const [frequency, setFrequency] = useState<(typeof FREQS)[number]["value"]>(
    prefill.frequency ?? "weekly",
  );
  const [billingCadence, setBillingCadence] = useState<"postpaid" | "prepaid">("postpaid");
  const [unitCount, setUnitCount] = useState("1");
  // A commercial property's waste stations: created with the client, and
  // counted by the zone's per-station rate (#658).
  const [stationCount, setStationCount] = useState("");
  const unitsN = Math.max(1, parseInt(unitCount, 10) || 1);
  const stationsN = Math.min(200, Math.max(0, parseInt(stationCount, 10) || 0));
  // From a quote, the price the customer accepted, not the zone's.
  const [priceOverride, setPriceOverride] = useState<string>(() =>
    fromQuote?.priceCents != null ? (fromQuote.priceCents / 100).toFixed(2) : "",
  );
  // null until the owner touches it: then the line decides (F-04). A business
  // that only sits, grooms or trains books the stay, groom or lesson after
  // the client exists, so the box starts ticked; a scooping or walking
  // business starts on a plan, as before.
  const [skipPlanChoice, setSkipPlan] = useState<boolean | null>(null);
  const skipPlan = skipPlanChoice ?? planStartsSkipped(lines, linesKnown);
  // No subscription is written for a groom lead: the groom is booked next.
  const planSkipped = skipPlan || booksGroom;
  // When the service starts, on the business's calendar. Tomorrow by default:
  // today, created in the evening, meant a visit that night after the route
  // had ended, with nobody on it and nobody told (persona review, 2026-09-27).
  // From a lead, the day it asked to start (#657), unless that has passed.
  const orgTodayStr = useOrgToday();
  const [startedOn, setStartedOn] = useState(() =>
    leadStartDate(prefill.startDate, orgTodayStr, tomorrowOf(orgTodayStr)),
  );
  const askedStartPassed = !!prefill.startDate && prefill.startDate < orgTodayStr;
  const [serviceDays, setServiceDays] = useState<number[] | null>(null);
  // What the chips show is what is saved: no more days than the cadence runs
  // on (R2-44), even after switching from Twice weekly to Weekly.
  const effectiveServiceDays = serviceDaysFor(serviceDays ?? [weekdayOf(startedOn)], frequency);

  // ── Which service (the catalog) ─────────────────────────────────────────
  // A business that sells more than one thing picks it here; one that sells
  // only pet waste removal has nothing to pick, sees no picker, and its plan
  // takes the business's default on insert, exactly as before the catalog.
  // Started from a lead, the service the lead asked for, when it is one of
  // the business's; the plan form's picker (ServicesTab) is the same control.
  const [serviceId, setServiceId] = useState<string>(prefill.serviceId ?? "");
  // A business without pet waste is not offered (or started on) the seeded
  // "Pet waste removal" it still has (RC3), and its one service is the plan's
  // service even with no picker to show: a walker with one walk was quoted
  // from a zone, as a cleanup.
  const offersServicePicker = servicePickerOptions(orgServices, null, pickerLines).length > 1;
  const chosenService =
    offersServicePicker || (linesKnown && !petWaste)
      ? (orgServices.find(
          (x) => x.id === effectiveServiceId(serviceId, orgServices, pickerLines),
        ) ?? null)
      : null;
  // A walk, a sit or a groom: priced from its service through the one rule
  // (servicePriceCents), never from a zone, and sold by the day of the week.
  const walkLike = !!chosenService && !isZonePriced(chosenService);
  const serviceCents = walkLike ? servicePriceCents(chosenService!, { pets: dogCount }) : null;
  // The days a weekly plan runs on until the owner says: Monday to Friday
  // for a walk, the first visit's weekday for anything else (F-04).
  const [weekdayChoice, setWeekdays] = useState<number[] | null>(null);
  const weekdays =
    weekdayChoice ?? defaultPlanWeekdays(chosenService?.service_line, weekdayOf(startedOn));
  const setDays = walkLike && frequency === "weekly";
  const needsDays = !planSkipped && setDays && weekdays.length === 0;

  // Auto-quote. Residential from dogs; commercial from units and stations
  // (#658, R2-21: a commercial account was never quoted, and its plan was
  // saved with no zone).
  const commercial = accountType === "commercial";
  const quoteKey = useMemo(
    () => ({
      postalCode: postalCode.trim(),
      accountType,
      dogCount,
      frequency: frequency === "one_time" ? "weekly" : frequency,
      boundaryAreaSqm: boundaryAreaSqm ?? undefined,
      ...(commercial ? { unitCount: unitsN, stationCount: stationsN } : {}),
    }),
    [postalCode, accountType, dogCount, frequency, boundaryAreaSqm, commercial, unitsN, stationsN],
  );

  const quoteQ = useQuery({
    enabled:
      current === "Plan" &&
      !planSkipped &&
      !walkLike &&
      quoteKey.postalCode.length >= 3 &&
      frequency !== "one_time",
    queryKey: ["internal-quote", quoteKey],
    queryFn: () => quoteFn({ data: quoteKey as any }),
    staleTime: 30_000,
  });
  // The zone's answer, only while the plan is zone-priced: a query turned
  // off keeps its last data, and that was the cleanup's price, not the walk's.
  const zoneQuote =
    !walkLike && quoteQ.data && "quote" in (quoteQ.data as any) ? (quoteQ.data as any).quote : null;

  const suggestedCents = walkLike
    ? serviceCents
    : zoneQuote
      ? ((zoneQuote.recurringPriceCents as number | null) ?? null)
      : null;

  // Booking, not pricing (#728): a dispatcher starts a plan at the set price,
  // the one shown above, and the server refuses any other. Billing it in
  // advance is a billing decision, which stays with whoever manages billing.
  const { can: canPlan } = usePermissions();
  const setsPrices = canPlan("manage_pricing");
  const billsClients = canPlan("manage_client_billing");

  // No zone quote and nothing typed means no price, not $25. The old
  // fallback saved $25.00 for anyone who left the box empty, while the box
  // showed a grey placeholder that looked like a suggestion.
  const priceCents = (() => {
    if (!setsPrices) return suggestedCents;
    const override = typedPriceCents(priceOverride);
    if (override != null) return override;
    if (suggestedCents != null) return suggestedCents;
    return null;
  })();
  const needsPrice = !planSkipped && priceCents == null;

  // ── The first cleanup ────────────────────────────────────────────────────
  // Offered when the owner prices one, to someone who may bill, and not when
  // the client comes from a quote that already carries one-time charges —
  // those are billed from the quote, and offering it here would bill twice.
  // Nothing is picked by default: the office decides per client.
  const { can } = usePermissions();
  const firstCleanupFn = useServerFn(getFirstCleanupPricing);
  const firstCleanupQ = useQuery({
    queryKey: ["first-cleanup-pricing"],
    queryFn: () => firstCleanupFn(),
    staleTime: 60_000,
  });
  const fcPricing = firstCleanupQ.data?.pricing ?? null;
  const offersFirstCleanup =
    !!fcPricing &&
    fcPricing.mode !== "off" &&
    accountType === "residential" &&
    // A first cleanup is a pet-waste thing; a walk has no yard to catch up on.
    !walkLike &&
    can("manage_client_billing") &&
    !(fromQuote && fromQuote.oneTimeCents > 0);
  // "" = no first cleanup; "flat" = the zone's fee; otherwise a tier id.
  const [fcChoice, setFcChoice] = useState("");
  const [fcOverride, setFcOverride] = useState("");
  const zoneFlatCents = zoneQuote ? (zoneQuote.initialCleanupCents as number) : null;
  const fcSuggestedCents =
    fcPricing && fcChoice
      ? firstCleanupPriceCents(fcPricing, {
          zoneFlatCents,
          dogCount,
          tierId: fcChoice === "flat" ? null : fcChoice,
        })
      : null;
  const fcCents = (() => {
    if (!offersFirstCleanup || !fcChoice) return null;
    const override = parseFloat(fcOverride);
    if (!isNaN(override) && override >= 0) return Math.round(override * 100);
    return fcSuggestedCents;
  })();
  const fcTierLabel =
    fcPricing?.mode === "by_last_cleaned"
      ? (fcPricing.tiers.find((t) => t.id === fcChoice)?.label ?? null)
      : null;

  // ── The draft (gaps-r2-12) ───────────────────────────────────────────────
  // Everything typed, and the step, kept on this device for this user and
  // this business. Not the gate code: an access code does not sit in browser
  // storage (lib/form-drafts.ts strips one by name as well). Not the geocode
  // status either; it follows from the pin.
  const draft = useFormDraft({
    form: newClientDraftForm(fromLead, fromQuote),
    value: {
      step,
      groomInstead,
      displayName,
      accountType,
      primaryEmail,
      primaryPhone,
      officeNote,
      street,
      city,
      region,
      postalCode,
      accessNotes,
      parkingNotes,
      hazardNotes,
      vcName,
      vcPhone,
      vcEmail,
      hz,
      boundary,
      geo,
      dogs,
      frequency,
      billingCadence,
      unitCount,
      stationCount,
      priceOverride,
      // The owner's own choices (null until touched), not the values the line
      // derives (F-04), so a restored draft starts from the line again.
      skipPlan: skipPlanChoice,
      startedOn,
      serviceDays,
      serviceId,
      weekdays: weekdayChoice,
      fcChoice,
      fcOverride,
    },
    restore: (d) => {
      setStep(d.step);
      setGroomInstead(d.groomInstead);
      setDisplayName(d.displayName);
      setAccountType(d.accountType);
      setPrimaryEmail(d.primaryEmail);
      setPrimaryPhone(d.primaryPhone);
      setOfficeNote(d.officeNote);
      setStreet(d.street);
      setCity(d.city);
      setRegion(d.region);
      setPostalCode(d.postalCode);
      setAccessNotes(d.accessNotes);
      setParkingNotes(d.parkingNotes);
      setHazardNotes(d.hazardNotes);
      setVcName(d.vcName);
      setVcPhone(d.vcPhone);
      setVcEmail(d.vcEmail);
      setHz(d.hz);
      setBoundary(d.boundary);
      setGeo(d.geo);
      setGeoStatus(d.geo ? "ok" : "idle");
      setDogs(d.dogs);
      setFrequency(d.frequency);
      setBillingCadence(d.billingCadence);
      setUnitCount(d.unitCount);
      setStationCount(d.stationCount);
      setPriceOverride(d.priceOverride);
      setSkipPlan(d.skipPlan);
      // A start day that has passed since the draft was kept is not offered.
      if (d.startedOn >= orgTodayStr) setStartedOn(d.startedOn);
      setServiceDays(d.serviceDays);
      setServiceId(d.serviceId);
      setWeekdays(d.weekdays);
      setFcChoice(d.fcChoice);
      setFcOverride(d.fcOverride);
    },
    reset: onDiscarded,
  });

  // Why the last Create client did not finish, kept on the page under the
  // button until the next try (#784). The toast alone was gone in four
  // seconds, after which the wizard read exactly as if the press had done
  // nothing: still open, button enabled, no client.
  const [createError, setCreateError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      onboardFn({
        data: {
          displayName,
          accountType,
          primaryEmail: primaryEmail || undefined,
          primaryPhone: primaryPhone || undefined,
          street,
          city,
          region: region || undefined,
          postalCode,
          // The pin this screen showed (the picker's match, or the Yard
          // step's lookup), so the server stores the point the boundary was
          // drawn on instead of geocoding the address a second time.
          latitude: geo?.lat,
          longitude: geo?.lng,
          gateCode: gateCode || undefined,
          parkingNotes: parkingNotes || undefined,
          accessNotes: accessNotes.trim() || undefined,
          hazardNotes: hazardNotes || undefined,
          visitContactName: vcName || undefined,
          visitContactPhone: vcPhone || undefined,
          visitContactEmail: vcEmail || undefined,
          hazards: hz,
          boundary: boundary ?? undefined,
          boundaryAreaSqm: boundaryAreaSqm ?? undefined,
          stationCount: accountType === "commercial" && stationsN > 0 ? stationsN : undefined,
          dogs: validDogs.length
            ? validDogs.map((d) => ({
                name: d.name.trim(),
                breed: d.breed || undefined,
                weightClass: d.weightClass || undefined,
                ...(grooming
                  ? {
                      coatType: d.coatType || null,
                      weightLb: d.weightLb ? Math.round(Number(d.weightLb) * 10) / 10 : null,
                    }
                  : {}),
                temperament: d.temperament,
                notes: d.notes || undefined,
              }))
            : undefined,
          subscription: planSkipped
            ? undefined
            : {
                frequency,
                priceCents: priceCents ?? 0,
                startedOn,
                preferredWeekdays:
                  frequency === "one_time" || setDays ? undefined : effectiveServiceDays,
                // A weekly walk's days each week; the set is its whole schedule.
                weekdays: setDays ? normalizeWeekdays(weekdays) : undefined,
                // Only when the business had something to pick: a pet-waste
                // business's plan takes its default on insert, as always.
                serviceId: chosenService?.id,
                dogCount: accountType === "residential" ? dogCount : undefined,
                unitCount: accountType === "commercial" ? unitsN : undefined,
                zoneId: zoneQuote ? (zoneQuote.zoneId as string) : undefined,
                billingCadence: billsClients ? billingCadence : "postpaid",
              },
          officeNote: officeNote.trim() || undefined,
          fromLeadId: fromLead?.id,
          firstCleanup:
            !planSkipped && fcCents != null && fcCents > 0
              ? { priceCents: fcCents, description: firstCleanupDescription(fcTierLabel, dogCount) }
              : undefined,
        },
      }),
    onSuccess: ({
      id,
      firstVisitOn,
      welcomeEmailed,
      welcomeStatusHandle,
      welcomeTurnedOff,
      welcomeLink,
      officeNoteSaved,
      leadLinked,
      firstCleanupInvoiced,
    }) => {
      // A 200 with no client in it is not a client.
      if (!id) {
        const msg = createFailedMessage(null);
        setCreateError(msg);
        toast.error(msg);
        return;
      }
      draft.clear();
      const parts = ["Client created."];
      if (firstVisitOn) parts.push(`First visit ${formatDay(firstVisitOn)}.`);
      if (firstCleanupInvoiced) parts.push("First cleanup invoiced.");
      toast.success(parts.join(" "), { duration: 8000 });
      // "Welcome email sent" only once the provider has taken it; with email
      // off, "not sent" and the portal link to send by hand (#612). Quiet when
      // the owner turned welcome emails off in Settings: nothing is missing.
      if (primaryEmail && !welcomeTurnedOff) {
        void reportQueuedSend(
          {
            ok: welcomeEmailed,
            statusHandle: welcomeStatusHandle,
            recipient: primaryEmail,
            link: welcomeLink,
          },
          { what: "Welcome email", poll: emailStatusFn },
        );
      }
      if (!officeNoteSaved)
        toast.error("The office note did not save. Add it from the client's Notes.");
      if (firstCleanupInvoiced === false)
        toast.error(
          "The first-cleanup invoice was not created. Create it from Invoices, New invoice.",
        );
      if (leadLinked === false)
        toast.error("The lead could not be marked converted. Mark it from the Leads page.");
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["my-org"] });
      if (fromLead) qc.invalidateQueries({ queryKey: ["leads"] });
      if (fromQuote) {
        // Best effort: the client exists either way.
        convertedFn({ data: { id: fromQuote.id, clientId: id } })
          .catch(() =>
            toast.error(
              `The client was created, but ${fromQuote.label} could not be marked as converted.`,
            ),
          )
          .finally(() => qc.invalidateQueries({ queryKey: ["quotes"] }));
      }
      if (booksGroom) {
        // Book a groom opens on the client's Visits tab with the lead's
        // service, every pet and the day it asked for; the price is the
        // size grid's, read there (#657).
        navigate({
          to: "/clients/$clientId",
          params: { clientId: id },
          search: {
            tab: "visits",
            bookGroom: true,
            groomService: leadServiceLine === "mobile_grooming" ? prefill.serviceId! : undefined,
            groomOn: startedOn,
          },
        });
        return;
      }
      navigate({ to: "/clients/$clientId", params: { clientId: id } });
    },
    // A role the subscriptions policy refuses (a dispatcher at the plan step)
    // gets the policy's own words back, which name a table and not a reason
    // (#662).
    onError: (e) => {
      const opts = {
        fallback: "The client could not be saved. Try again.",
        refused: planSkipped
          ? undefined
          : 'Your role is not allowed to set up this subscription. Tick "Skip subscription for now" to save the client without one, and ask the owner to add it.',
      };
      // One sentence, in the toast and under the button: the server's reason,
      // or, when no answer came, a word to check before pressing again.
      const msg = createFailedMessage(e, serverErrorMessage(e, opts));
      toast.error(msg);
      setCreateError(msg);
    },
  });

  // The lead's email already belongs to a client. The old one-tap conversion
  // quietly reused that client; the wizard is about to create one, so it asks.
  const linkMutation = useMutation({
    mutationFn: (clientId: string) => linkFn({ data: { leadId: fromLead!.id, clientId } }),
    onSuccess: ({ clientId }) => {
      draft.clear();
      toast.success("Lead linked to the existing client");
      qc.invalidateQueries({ queryKey: ["leads"] });
      navigate({ to: "/clients/$clientId", params: { clientId } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const canNext = (() => {
    if (current === "Contact") return displayName.trim().length > 0;
    // Region/State is required — the property is unusable downstream without it
    // (routing, zone pricing, geocoding all need it). Finding #13.
    if (current === "Property") return !!(street && city && region && postalCode);
    if (current === "Outline") return true; // outline sketch optional
    if (current === "Dogs") return true;
    return true;
  })();

  return (
    <WizardShell backTo={fromQuote ? "quotes" : fromLead ? "leads" : "clients"}>
      {draft.restored && <DraftRestoredNotice onDiscard={draft.discard} />}
      {fromQuote && (
        <div role="status" className="space-y-1 rounded-md border bg-primary/5 p-3 text-sm">
          <p className="break-words">
            Started from accepted quote <strong>{fromQuote.label}</strong>.{" "}
            {fromQuote.priceCents != null
              ? "The price per visit on the Plan step is the quote's recurring total."
              : "The quote has no per-visit line, so set the price on the Plan step."}
          </p>
          {fromQuote.oneTimeCents > 0 && (
            <p className="text-muted-foreground">
              Its one-time charges ({money(fromQuote.oneTimeCents)}) are not billed by creating the
              client. Once the work is done, press &ldquo;Invoice one-time charges&rdquo; on the
              quote.
            </p>
          )}
        </div>
      )}
      {fromLead && (
        <div className="space-y-2 rounded-md border bg-primary/5 p-3 text-sm">
          <p className="break-words">
            Started from the lead <strong>{fromLead.name}</strong>. Check each step: nothing is
            saved until you press Create client, and the lead is marked converted when you do.
          </p>
          {groomLead && (
            <label className="flex min-h-11 items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0"
                checked={groomInstead}
                onChange={(e) => setGroomInstead(e.target.checked)}
              />
              <span className="min-w-0">
                Book the groom next. The client is created without a recurring plan, then Book a
                groom opens with these pets
                {prefill.startDate ? `, on ${formatDay(startedOn)},` : ""} at the size grid&apos;s
                price.
              </span>
            </label>
          )}
          {fromLead.existingClient && (
            <div
              role="status"
              className="space-y-2 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-amber-900"
            >
              <p className="break-words">
                <strong>{fromLead.existingClient.displayName}</strong> already has this lead's email
                address. If they are the same household, link the lead to them instead of creating a
                second client.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={linkMutation.isPending || mutation.isPending}
                  onClick={() => linkMutation.mutate(fromLead.existingClient!.id)}
                >
                  {/* Not the client's name: a button does not wrap, and a
                      46-character household name would push it off a phone. */}
                  Link lead to this client
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link to="/clients/$clientId" params={{ clientId: fromLead.existingClient.id }}>
                    Open client
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stepper.
          MEASURED 2026-08-19: five numbered chips, their labels and four
          chevrons come to 565px, so at 360px steps 3, 4 and 5 hung off the
          side of the screen and the page scrolled sideways. At 768px step 5
          still did.
          This is the case CLAUDE.md names outright — "wide content … wide
          toolbars — scrolls inside its own `overflow-x: auto` container. The
          page body does not." A stepper is a toolbar: it has a natural width,
          it is read left to right, and squeezing it is worse than scrolling
          it. `shrink-0` on each chip so they scroll at full size rather than
          being compressed into each other, and the dots take the touch floor
          because a completed step is a button you can go back to.

          …and scrolling it was still wrong on a phone, reported 2026-09-27:
          the scroller's edge falls wherever it falls, so at 360px it cut a
          step name mid-word ("Prop") with nothing to say there was more.
          Below `lg` the row is now the five dots alone — 5 × 44px and four
          gaps is 252px, inside a 320px phone — and the current step's name
          is its own line underneath, where it truncates with an ellipsis
          rather than being cut. `lg` rather than `md` because from 768 the
          docked sidebar takes 256px of the width, and the full row with
          touch-sized dots is ~645px; it fits the 672px column only once
          that column exists. */}
      <div>
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 text-sm">
          {steps.map((stepLabel, i) => {
            const label = stepLabel === "Dogs" && sitting ? "Pets" : stepLabel;
            const state = i < step ? "done" : i === step ? "current" : "todo";
            return (
              <div key={label} className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => i < step && setStep(i)}
                  disabled={i > step}
                  // The name is hidden below `lg`, so the dot has to say it.
                  aria-label={`Step ${i + 1}: ${label}`}
                  aria-current={state === "current" ? "step" : undefined}
                  className={
                    "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium touch:h-11 touch:w-11 " +
                    (state === "done"
                      ? "bg-primary text-primary-foreground"
                      : state === "current"
                        ? "bg-primary/15 text-primary ring-2 ring-primary"
                        : "bg-muted text-muted-foreground")
                  }
                >
                  {state === "done" ? <Check className="h-3.5 w-3.5 shrink-0" /> : i + 1}
                </button>
                <span
                  className={`hidden lg:inline ${
                    state === "current" ? "font-medium" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </span>
                {i < steps.length - 1 && (
                  <ChevronRight className="mx-1 hidden h-4 w-4 shrink-0 text-muted-foreground lg:block" />
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 truncate text-sm font-medium lg:hidden">
          Step {step + 1} of {steps.length}: {current === "Dogs" && sitting ? "Pets" : current}
        </p>
      </div>

      <Card className="p-6">
        {/* STEP 0 — Contact */}
        {current === "Contact" && (
          <div className="space-y-5">
            <div className="space-y-2">
              {/* MEASURED 2026-08-19: as two radio dots these were 16.0px, the
                  last finding on this page. A radio cannot be grown to 44px —
                  the border is on the element, so height and padding both
                  enlarge the visible circle. Two mutually exclusive options
                  with short labels are a segmented control anyway, and a
                  segment is 44px without argument.
                  Still a Radix radiogroup underneath, so the arrow keys, the
                  single tab stop and the ARIA all survive the change. */}
              <Label id="account-type-label">Account type</Label>
              <RadioGroup
                aria-labelledby="account-type-label"
                value={accountType}
                onValueChange={(v) => setAccountType(v as typeof accountType)}
                className="flex gap-2"
              >
                <RadioGroupSegment value="residential">Residential</RadioGroupSegment>
                <RadioGroupSegment value="commercial">Commercial / HOA</RadioGroupSegment>
              </RadioGroup>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dn">Display name</Label>
              <Input
                id="dn"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={accountType === "commercial" ? "Oakwood HOA" : "Jane Doe"}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="em">Email</Label>
                <Input
                  id="em"
                  type="email"
                  value={primaryEmail}
                  onChange={(e) => setPrimaryEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ph">Phone</Label>
                <Input
                  id="ph"
                  value={primaryPhone}
                  onChange={(e) => setPrimaryPhone(e.target.value)}
                  placeholder="(555) 123-4567"
                />
              </div>
            </div>
            <div className="space-y-2">
              {/* Saved as an office note: the client's Notes tab shows it and
                  RLS keeps it from technicians. Not `clients.notes`, which is
                  where the old lead conversion put the lead's message and
                  which no screen in the app displays. */}
              <Label htmlFor="on">Office note (optional)</Label>
              <Textarea
                id="on"
                rows={fromLead ? 4 : 2}
                maxLength={4000}
                value={officeNote}
                onChange={(e) => setOfficeNote(e.target.value)}
                placeholder="Anything the office should know. Technicians do not see this."
              />
            </div>
          </div>
        )}

        {/* STEP 1 — Property */}
        {current === "Property" && (
          <div className="space-y-5">
            {attempted && !(street && city && region && postalCode) && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Please fill in Street, City, State, and ZIP to continue.
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 space-y-2">
                <Label htmlFor="st">Street address</Label>
                {/* Autocomplete when a provider is configured, a plain text
                    input when none is — which is the state today. Nothing
                    about the required-field validation below changes either
                    way: it reads `street`, which this writes on every
                    keystroke exactly as the bare <Input> did. */}
                <AddressAutocomplete
                  id="st"
                  required
                  value={street}
                  onChangeText={(t) => setAddressField(setStreet, t)}
                  onResolved={applyResolvedAddress}
                  ariaInvalid={attempted && !street ? true : undefined}
                  className={
                    attempted && !street
                      ? "border-destructive focus-visible:ring-destructive"
                      : undefined
                  }
                />
                {attempted && !street && (
                  <p className="text-xs text-destructive">Street address is required.</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="ci">City</Label>
                <Input
                  id="ci"
                  required
                  value={city}
                  onChange={(e) => setAddressField(setCity, e.target.value)}
                  aria-invalid={attempted && !city ? true : undefined}
                  className={
                    attempted && !city
                      ? "border-destructive focus-visible:ring-destructive"
                      : undefined
                  }
                />
                {attempted && !city && (
                  <p className="text-xs text-destructive">City is required.</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="rg">State/Region</Label>
                  <Input
                    id="rg"
                    required
                    value={region}
                    onChange={(e) => setAddressField(setRegion, e.target.value)}
                    aria-invalid={attempted && !region ? true : undefined}
                    className={
                      attempted && !region
                        ? "border-destructive focus-visible:ring-destructive"
                        : undefined
                    }
                  />
                  {attempted && !region && <p className="text-xs text-destructive">Required.</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pc">ZIP / Postal</Label>
                  <Input
                    id="pc"
                    required
                    value={postalCode}
                    onChange={(e) => setAddressField(setPostalCode, e.target.value)}
                    aria-invalid={attempted && !postalCode ? true : undefined}
                    className={
                      attempted && !postalCode
                        ? "border-destructive focus-visible:ring-destructive"
                        : undefined
                    }
                  />
                  {attempted && !postalCode && (
                    <p className="text-xs text-destructive">Required.</p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gc">Gate code (optional)</Label>
                <Input id="gc" value={gateCode} onChange={(e) => setGateCode(e.target.value)} />
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="park">Parking notes (optional)</Label>
                <textarea
                  id="park"
                  rows={2}
                  maxLength={1000}
                  value={parkingNotes}
                  onChange={(e) => setParkingNotes(e.target.value)}
                  placeholder="Where to park"
                  className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="min-w-0 space-y-2 sm:col-span-2">
                <Label htmlFor="access">Access notes (optional)</Label>
                <textarea
                  id="access"
                  rows={2}
                  maxLength={500}
                  value={accessNotes}
                  onChange={(e) => setAccessNotes(e.target.value)}
                  placeholder="How to get in: side gate, key box, which door"
                  className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
              {/* No yard-size picker. It is derived from the property
                  boundary by a database trigger, and properties.functions.ts
                  says so where it stopped writing the field: "yard_size is
                  derived from the boundary by a DB trigger now; the field is
                  still accepted (older forms send it) but never written."
                  This wizard was the older form. A hand-picked size is worse
                  than none, because the tech reading it in the field cannot
                  tell a guess from a measurement — and nothing here has a
                  boundary to measure yet, since one is drawn afterwards. */}
            </div>

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                On-site visit contact <span className="normal-case font-normal">(optional)</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                For rentals/managed properties: this person gets visit texts and emails. Invoices
                still go to the account contact from the previous step.
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="vc-name" className="text-xs">
                    Name
                  </Label>
                  <Input
                    id="vc-name"
                    value={vcName}
                    onChange={(e) => setVcName(e.target.value)}
                    placeholder="Tenant / manager"
                  />
                </div>
                <div>
                  <Label htmlFor="vc-phone" className="text-xs">
                    Phone
                  </Label>
                  <Input
                    id="vc-phone"
                    type="tel"
                    value={vcPhone}
                    onChange={(e) => setVcPhone(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="vc-email" className="text-xs">
                    Email
                  </Label>
                  <Input
                    id="vc-email"
                    type="email"
                    value={vcEmail}
                    onChange={(e) => setVcEmail(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Safety & access
              </div>
              <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {/* The yard's hazards are asked of a business that scoops
                    (F-06); propertyHazardsFor keeps one that is ticked. */}
                {propertyHazardsFor(lines, hz).map(({ key: k, label }) => (
                  <label key={k} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={(hz as any)[k]}
                      onChange={() => setHz((s) => ({ ...s, [k]: !(s as any)[k] }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <div className="mt-2 space-y-1">
                <Label htmlFor="hn" className="text-xs">
                  Notes for the tech
                </Label>
                <Input
                  id="hn"
                  value={hazardNotes}
                  onChange={(e) => setHazardNotes(e.target.value)}
                  placeholder="e.g. Latch is tricky, pool uncovered in summer"
                />
              </div>
            </div>
          </div>
        )}

        {/* STEP 2 — Outline (optional boundary sketch) */}
        {current === "Outline" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-medium">Sketch the property outline (optional)</h2>
              <p className="text-sm text-muted-foreground">
                Draw the service area on the satellite map so the tech and pricing know the exact
                footprint. Skip to price a flat visit instead.
              </p>
            </div>
            {(geoStatus === "notfound" || geoStatus === "error") && (
              <div className="rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900">
                {geoStatus === "error"
                  ? "We couldn't reach the map service to locate this address. Check your connection, or draw the service area manually on the map below."
                  : "We couldn't find this address on the map. Double-check the address on the previous step, or draw the service area manually on the map below."}
              </div>
            )}
            <BoundarySketch
              center={geo}
              initial={boundary}
              areaSqm={boundaryAreaSqm}
              onSave={(poly) => {
                setBoundary(poly);
                toast.success(poly ? "Boundary saved" : "Boundary cleared");
              }}
            />
            {boundaryAreaSqm != null && (
              <p className="text-xs text-muted-foreground">
                Saved area: <strong>{formatArea(boundaryAreaSqm)}</strong>. If your zone uses
                per-sqft or per-acre pricing, the plan step will price from this area.
              </p>
            )}
          </div>
        )}

        {/* STEP 3 — Dogs */}
        {current === "Dogs" && (
          <div className="space-y-4">
            {accountType === "commercial" && (
              <p className="text-sm text-muted-foreground">
                Skip if this is a commercial/HOA account. Otherwise add any resident dogs.
              </p>
            )}
            {fromLead && (fromLead.dogCount ?? 0) > 0 && (
              <p className="text-sm text-muted-foreground">
                The lead said {fromLead.dogCount} dog{fromLead.dogCount === 1 ? "" : "s"}, so there
                {dogs.length === 1 ? " is a row" : ` are ${dogs.length} rows`} below. Name them now
                or later: the plan is priced for one dog per row, and a row without a name is not
                saved as a dog.
              </p>
            )}
            {dogs.map((d, i) => (
              <div key={i} className="rounded-md border bg-muted/10 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={d.name}
                      onChange={(e) => {
                        const next = [...dogs];
                        next[i] = { ...next[i], name: e.target.value };
                        setDogs(next);
                      }}
                      placeholder="Bailey"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Breed</Label>
                    <Input
                      value={d.breed}
                      onChange={(e) => {
                        const next = [...dogs];
                        next[i] = { ...next[i], breed: e.target.value };
                        setDogs(next);
                      }}
                      placeholder="Lab mix"
                    />
                  </div>
                  <PetSizeFields
                    size={d.weightClass}
                    coatType={d.coatType ?? ""}
                    weightLb={d.weightLb ?? ""}
                    grooming={grooming}
                    onChange={(patch) =>
                      setDogs(
                        dogs.map((dog, index) =>
                          index === i
                            ? {
                                ...dog,
                                ...(patch.size !== undefined ? { weightClass: patch.size } : {}),
                                ...(patch.coatType !== undefined
                                  ? { coatType: patch.coatType }
                                  : {}),
                                ...(patch.weightLb !== undefined
                                  ? { weightLb: patch.weightLb }
                                  : {}),
                              }
                            : dog,
                        ),
                      )
                    }
                  />
                  <div className="space-y-1">
                    <Label className="text-xs">Temperament</Label>
                    <select
                      value={d.temperament}
                      onChange={(e) => {
                        const next = [...dogs];
                        next[i] = { ...next[i], temperament: e.target.value as any };
                        setDogs(next);
                      }}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="unknown">Unknown</option>
                      <option value="friendly">Friendly</option>
                      <option value="nervous">Nervous</option>
                      <option value="aggressive">Aggressive</option>
                    </select>
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  {dogs.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDogs(dogs.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5 shrink-0" /> Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDogs([...dogs, { ...BLANK_DOG }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Add another dog
            </Button>
          </div>
        )}

        {/* STEP 3 — Plan */}
        {current === "Plan" && (
          <div className="space-y-5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={skipPlan}
                onChange={(e) => setSkipPlan(e.target.checked)}
              />
              <span>Skip subscription for now (I'll set it up later)</span>
            </label>

            {!skipPlan && (
              <>
                {offersServicePicker && (
                  <ServicePicker
                    id="nc-service"
                    value={serviceId}
                    currentId={null}
                    services={orgServices}
                    isLoading={servicesLoading}
                    onChange={setServiceId}
                    lines={pickerLines}
                  />
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Frequency</Label>
                    <select
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value as any)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      {FREQS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>Billing</Label>
                    <select
                      value={billsClients ? billingCadence : "postpaid"}
                      onChange={(e) => setBillingCadence(e.target.value as any)}
                      disabled={!billsClients}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="postpaid">Bill after each visit</option>
                      {billsClients && <option value="prepaid">Prepaid credits</option>}
                    </select>
                  </div>
                  {accountType === "commercial" && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="nc-units">Units</Label>
                        <Input
                          id="nc-units"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          value={unitCount}
                          onChange={(e) => setUnitCount(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="nc-stations">Waste stations</Label>
                        <Input
                          id="nc-stations"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={200}
                          placeholder="0"
                          value={stationCount}
                          onChange={(e) => setStationCount(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Added as Station 1, Station 2… Rename them on the client&apos;s Stations
                          tab.
                        </p>
                      </div>
                    </>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="started-on">First visit</Label>
                    <Input
                      id="started-on"
                      type="date"
                      min={orgTodayStr}
                      value={startedOn}
                      // The service day follows this date until the owner picks days.
                      onChange={(e) => setStartedOn(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      If that isn&apos;t a work day or a service day, it moves to the next one.
                    </p>
                    {askedStartPassed && (
                      <p className="text-xs text-muted-foreground">
                        The lead asked to start on {formatDay(prefill.startDate!)}, which has
                        passed.
                      </p>
                    )}
                  </div>
                  {setDays && (
                    <div className="min-w-0 space-y-2">
                      <WeekdayPicker
                        id="nc-weekdays"
                        label="Days each week"
                        value={weekdays}
                        onChange={setWeekdays}
                        invalid={weekdays.length === 0}
                      />
                      <p className="text-xs text-muted-foreground">
                        {weekdays.length === 0
                          ? "Choose at least one day."
                          : "One visit on each day, every week, billed per visit. Blackout days and client holds are skipped, not moved."}
                      </p>
                    </div>
                  )}
                  {frequency !== "one_time" && !setDays && (
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium">
                        {serviceDaysPerWeek(frequency) === 2 ? "Service days" : "Service day"}
                      </legend>
                      <p id="nc-service-day-hint" className="text-xs text-muted-foreground">
                        {serviceDaysPerWeek(frequency) === 2
                          ? "Pick the two days each week."
                          : "One visit on this day. For more days a week, choose Twice weekly."}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {WEEKDAYS.map((label, d) => {
                          const on = effectiveServiceDays.includes(d);
                          return (
                            <button
                              key={label}
                              type="button"
                              aria-pressed={on}
                              onClick={() =>
                                setServiceDays(pickServiceDay(effectiveServiceDays, d, frequency))
                              }
                              className={`h-9 min-w-11 shrink-0 rounded-md border px-2 text-sm touch:min-h-11 ${
                                on
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-input bg-background"
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}
                </div>

                {(accountType === "residential" || !walkLike) && (
                  <div className="rounded-md border bg-primary/5 p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">
                          Suggested price / visit
                        </div>
                        {quoteQ.isFetching && (
                          <div className="text-sm text-muted-foreground">Calculating…</div>
                        )}
                        {!quoteQ.isFetching && suggestedCents != null && (
                          <div className="text-2xl font-semibold">
                            {money(suggestedCents, (quoteQ.data as any)?.quote?.currency)}
                          </div>
                        )}
                        {!walkLike &&
                          !quoteQ.isFetching &&
                          quoteQ.data &&
                          !("quote" in (quoteQ.data as any)) && (
                            <div className="text-sm text-amber-600">
                              {setsPrices
                                ? `No zone matches ZIP ${postalCode}. Set price manually below.`
                                : `No zone matches ZIP ${postalCode}, so there is no set price.`}
                            </div>
                          )}
                        {walkLike && serviceCents == null && (
                          <div className="text-sm text-amber-600">
                            {chosenService!.name} has no price yet. Set one below, or in Settings →
                            Services.
                          </div>
                        )}
                        {commercial &&
                          !quoteQ.isFetching &&
                          zoneQuote &&
                          suggestedCents == null && (
                            <div className="text-sm text-amber-600">
                              {zoneQuote.zoneName} has no commercial rates. Set the price below, or
                              add them in Settings → Zones & pricing.
                            </div>
                          )}
                      </div>
                      {zoneQuote && <Badge variant="secondary">Zone: {zoneQuote.zoneName}</Badge>}
                      {walkLike && serviceCents != null && (
                        <Badge variant="secondary">From the {chosenService!.name} price</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {commercial
                        ? commercialBasis(zoneQuote?.commercial ?? null, unitsN, stationsN)
                        : `Based on ${dogCount} dog${dogCount === 1 ? "" : "s"}`}{" "}
                      ·{" "}
                      {setDays
                        ? `${weekdays.length} day${weekdays.length === 1 ? "" : "s"} a week`
                        : FREQS.find((f) => f.value === frequency)?.label}
                      {walkLike &&
                      chosenService!.price_unit === "hour" &&
                      chosenService!.default_duration_min != null
                        ? ` · ${chosenService!.default_duration_min} min at $${((chosenService!.base_price_cents ?? 0) / 100).toFixed(2)} per hour`
                        : ""}
                    </p>
                  </div>
                )}

                {!setsPrices ? (
                  <div className="space-y-1 text-sm">
                    {suggestedCents != null ? (
                      <p>
                        Price per visit: <strong>{money(suggestedCents)}</strong>, the set price.
                        Only an owner or office manager can change it.
                      </p>
                    ) : (
                      !quoteQ.isFetching && (
                        <p role="alert" className="text-amber-600">
                          There is no set price for this plan. Tick "Skip subscription for now" to
                          save the client, and ask an owner or office manager to add the plan.
                        </p>
                      )
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="po">
                      {suggestedCents != null ? "Price per visit (override)" : "Price per visit"}
                    </Label>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">$</span>
                      <Input
                        id="po"
                        inputMode="decimal"
                        placeholder={
                          suggestedCents != null
                            ? (suggestedCents / 100).toFixed(2)
                            : "Enter a price"
                        }
                        value={priceOverride}
                        onChange={(e) => setPriceOverride(e.target.value)}
                        className="max-w-[160px]"
                      />
                      {priceCents != null && (
                        <span className="text-xs text-muted-foreground">
                          Final: <strong>{money(priceCents)}</strong> / visit
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {offersFirstCleanup && fcPricing && (
                  <div className="space-y-3 rounded-md border p-4">
                    <div>
                      <div className="text-sm font-medium">First cleanup</div>
                      <p className="text-xs text-muted-foreground">
                        One-time, billed on its own invoice when the client is created.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor="fc-choice">
                          {fcPricing.mode === "by_last_cleaned"
                            ? LAST_CLEANED_QUESTION.replace("your yard", "the yard")
                            : "Charge a first cleanup?"}
                        </Label>
                        <select
                          id="fc-choice"
                          value={fcChoice}
                          onChange={(e) => {
                            setFcChoice(e.target.value);
                            setFcOverride("");
                          }}
                          className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:min-h-11"
                        >
                          <option value="">No first-cleanup charge</option>
                          {fcPricing.mode === "flat" ? (
                            <option value="flat">Yes, the zone&apos;s first-cleanup fee</option>
                          ) : (
                            fcPricing.tiers.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                      {fcChoice && (
                        <div className="space-y-2">
                          <Label htmlFor="fc-price">First-cleanup price</Label>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-muted-foreground">$</span>
                            <Input
                              id="fc-price"
                              inputMode="decimal"
                              placeholder={
                                fcSuggestedCents != null
                                  ? (fcSuggestedCents / 100).toFixed(2)
                                  : "Enter a price"
                              }
                              value={fcOverride}
                              onChange={(e) => setFcOverride(e.target.value)}
                              className="max-w-[160px]"
                            />
                            {fcCents != null && (
                              <span className="text-xs text-muted-foreground">
                                Invoiced: <strong>{money(fcCents)}</strong>
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Nav */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              step === 0
                ? navigate({ to: fromQuote ? "/quotes" : fromLead ? "/leads" : "/clients" })
                : setStep(step - 1)
            }
          >
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < steps.length - 1 ? (
            <Button
              type="button"
              onClick={() => {
                if (!canNext) {
                  setAttempted(true);
                  return;
                }
                setAttempted(false);
                setStep(step + 1);
              }}
            >
              Continue
            </Button>
          ) : (
            <div className="flex min-w-0 flex-col items-end gap-1">
              <Button
                type="button"
                disabled={mutation.isPending || linkMutation.isPending || needsPrice || needsDays}
                onClick={() => {
                  setCreateError(null);
                  mutation.mutate();
                }}
              >
                {mutation.isPending
                  ? "Creating…"
                  : booksGroom
                    ? "Create and book groom"
                    : "Create client"}
              </Button>
              {needsPrice && (
                <p className="text-xs text-muted-foreground">Set a price per visit first.</p>
              )}
              {!needsPrice && needsDays && (
                <p className="text-xs text-muted-foreground">Choose at least one day first.</p>
              )}
              {createError && !mutation.isPending && (
                <p
                  role="alert"
                  data-testid="create-client-error"
                  className="max-w-md break-words text-end text-sm text-destructive"
                >
                  {createError}
                </p>
              )}
            </div>
          )}
        </div>
      </Card>
    </WizardShell>
  );
}
