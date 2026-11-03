import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { toastNotSent } from "@/lib/send-report";
import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { useServiceLines } from "@/components/CommercialOnly";
import { ServiceLinesChoices } from "@/components/ServiceLinesChoices";
import { DayEndPanel } from "@/components/SetupDayEndPanel";
import { useMyRole, usePermissions } from "@/hooks/useMyRole";
import { useMyProfile } from "@/hooks/useMyProfile";
import { useFormDraft } from "@/hooks/useFormDraft";
import { DraftRestoredNotice } from "@/components/DraftRestoredNotice";
import {
  getOnboardingStatus,
  ONBOARDING_STEP_IDS,
  type OnboardingStep,
  type OnboardingStepId,
  type PricePart,
} from "@/lib/onboarding.functions";
import { getOrgBranding, updateOrgBranding } from "@/lib/org.functions";
import { countryFromAddress } from "@/lib/distance-unit";
import { setServiceLines } from "@/lib/org-features.functions";
import { setupAsksServiceLines, type ServiceLine } from "@/lib/service-lines";
import {
  preselectedServiceLines,
  requestedServiceLine,
  setupStartingLines,
} from "@/lib/signup-service";
import { useServiceLineAvailability } from "@/hooks/useServiceLineAvailability";
import { getDispatchSettings, updateDispatchSettings } from "@/lib/visits.functions";
import { createZone, geocodePostal } from "@/lib/zones.functions";
import { createOrgInvite, listStaffAddresses, setStaffRouting } from "@/lib/users.functions";
import { upsertFacility } from "@/lib/stations.functions";
import { getStripeConnectStatus } from "@/lib/stripe-connect.functions";
import { deviceTimezone, suggestSetupTimezone, timezoneOptions } from "@/lib/org-timezone";
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import {
  closeSetupGuide,
  nextOpenStep,
  openSetupGuide,
  readRememberedStep,
  rememberStep,
  startingStep,
  stepsFor,
  useSetupGuide,
} from "@/lib/setup-guide";
import { titleHead } from "@/lib/page-title";
import { setupProgressPct } from "@/lib/setup-progress";
import { APP_NAME } from "@/lib/scoop";

// ── THE GUIDED SETUP ──────────────────────────────────────────────────────
//
// Six steps, each done HERE rather than described: at the end of them the
// business has an address and a time zone, a price, a client, somebody who
// runs the route, a place the route ends, and (if they want it now) payouts.
// The step list and whether each is done come from getOnboardingStatus, the
// same call the dashboard checklist draws, so the two cannot disagree.
//
// It replaced a spotlight tour that floated over the app and, on every
// tablet and desktop width, placed its own Next button off the top of the
// screen at step 6; see src/lib/setup-guide.ts. This is a page, so every control is an ordinary button in the document flow, and
// the step lives in the URL: a reload, or a trip to /clients/new and back,
// lands on the same step.

const STEP_IDS = ONBOARDING_STEP_IDS as readonly string[];

export const Route = createFileRoute("/_authenticated/setup")({
  head: () => titleHead("Set up your business"),
  validateSearch: (
    s: Record<string, unknown>,
  ): { step?: OnboardingStepId; service?: ServiceLine } => ({
    step:
      typeof s.step === "string" && STEP_IDS.includes(s.step)
        ? (s.step as OnboardingStepId)
        : undefined,
    // The line a visitor came for (site-r2-03). Only an offered id survives;
    // step 1 preselects it in place of the bare pet-waste default.
    service: requestedServiceLine(s.service),
  }),
  component: SetupPage,
});

function SetupPage() {
  const { role } = useMyRole();
  const navigate = useNavigate({ from: "/setup" });
  const { step: stepParam } = Route.useSearch();
  const guide = useSetupGuide();
  const qc = useQueryClient();
  const statusFn = useServerFn(getOnboardingStatus);
  const { data } = useQuery({ queryKey: ["onboarding-status"], queryFn: () => statusFn() });

  const steps = useMemo(() => stepsFor(data?.steps ?? [], role), [data, role]);
  const current = useMemo(() => {
    if (!steps.length) return null;
    const wanted = stepParam ?? startingStep(steps, readRememberedStep(guide.userId));
    return steps.find((s) => s.id === wanted) ?? steps[0];
  }, [steps, stepParam, guide.userId]);

  // Opening /setup at all is choosing the guide, including from a bookmark
  // or the checklist after "Not now". Once, when the phase first resolves:
  // "Finish later" closes the guide while this page is still mounted, and a
  // reopen on every change would undo it before the navigation lands.
  const reopenChecked = useRef(false);
  useEffect(() => {
    if (guide.phase === "unknown" || reopenChecked.current) return;
    reopenChecked.current = true;
    if (guide.phase === "closed") openSetupGuide();
  }, [guide.phase]);

  // The step is the URL's; this keeps the device record in step with it so
  // the banner elsewhere can say where they were.
  useEffect(() => {
    if (current) rememberStep(guide.userId, current.id);
  }, [current, guide.userId]);

  if (!data || !role) {
    return (
      <div>
        <h1 className="text-2xl font-semibold">Set up your business</h1>
        <p className="text-sm text-muted-foreground">Loading your setup…</p>
      </div>
    );
  }

  if (!current) {
    return (
      <div>
        <h1 className="text-2xl font-semibold">Set up your business</h1>
        <p className="text-sm text-muted-foreground">
          There is nothing here for your role to set up. The owner of the business can do it.
        </p>
      </div>
    );
  }

  const index = steps.findIndex((s) => s.id === current.id);
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;
  const completed = steps.filter((s) => s.done).length;

  const goTo = (id: OnboardingStepId) => navigate({ search: { step: id }, replace: false });

  const finish = () => {
    closeSetupGuide();
    toast.success(
      completed === steps.length
        ? "Your business is set up."
        : "Setup saved. The rest is on your dashboard whenever you want it.",
    );
    void navigate({ to: "/dashboard" });
  };

  const forward = () => {
    if (isLast) return finish();
    goTo(steps[index + 1].id);
  };

  // A step's own form saved: refresh the list, then move on to the next step
  // still open (not merely the next one, which may already be done). A step
  // with parts is done when the server says every part is, never because one
  // form on it saved.
  const saved = async () => {
    await qc.invalidateQueries({ queryKey: ["onboarding-status"] });
    const fresh = qc.getQueryData<typeof data>(["onboarding-status"]);
    const list = stepsFor(fresh?.steps ?? steps, role).map((s) =>
      s.id === current.id && !s.parts ? { ...s, done: true } : s,
    );
    const next = nextOpenStep(list, current.id);
    if (next) goTo(next);
    else finish();
  };

  const finishLater = () => {
    closeSetupGuide();
    void navigate({ to: "/dashboard" });
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Set up your business</h1>
          <p className="text-sm text-muted-foreground">
            {completed} of {steps.length} done. Each step takes a minute, and you can come back to
            any of them.
          </p>
        </div>
        <Button variant="ghost" onClick={finishLater} data-setup-action="later">
          Finish later
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,42rem)] lg:items-start">
        {/* The step list. Every step is reachable from here at any time, so
            no step can strand anybody: a step they cannot finish today is
            one tap away from the next. */}
        <nav aria-label="Setup steps" className="min-w-0">
          <div className="lg:hidden">
            <Progress value={setupProgressPct(steps)} />
          </div>
          <ol className="hidden space-y-1 lg:block">
            {steps.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => goTo(s.id)}
                  aria-current={s.id === current.id ? "step" : undefined}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-start text-sm ${
                    s.id === current.id ? "bg-muted font-medium" : "hover:bg-muted/60"
                  }`}
                >
                  {s.done ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 truncate">
                    {i + 1}. {s.label}
                  </span>
                  {s.done && <span className="sr-only">(done)</span>}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section
          className="min-w-0 rounded-lg border bg-card p-4 pb-0 md:p-5 md:pb-0"
          data-setup-step={current.id}
          aria-labelledby="setup-step-title"
        >
          <p className="text-xs text-muted-foreground">
            Step {index + 1} of {steps.length}
          </p>
          <h2 id="setup-step-title" className="mt-0.5 text-lg font-semibold">
            {current.label}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>
          {current.done && (
            <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-primary">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> Done. You can change it
              here, or move on.
            </p>
          )}

          <div className="mt-4">
            <StepPanel step={current} onSaved={saved} />
          </div>

          {/* The way forward is ALWAYS here, done or not. "Skip for now" is
              not a failure path: every step can be finished later from the
              checklist, and payouts in particular waits on an email.

              And always ON SCREEN: sticky to the bottom of the viewport while
              the step is, so a step taller than a phone (the business form at
              360x780 is) still has Back and Next under the thumb without
              scrolling past the form to find them. Below `md` the office
              roles this page is for have the tab bar there, so it sits on top
              of the bar rather than behind it; that is a layout offset keyed
              on width, which is what width is for. No z-index: it comes after
              the form in the document, so it paints over it, and an address
              suggestion list (which does set one) still paints over this. */}
          <div className="sticky bottom-0 -mx-4 mt-5 flex flex-wrap items-center justify-between gap-2 rounded-b-lg border-t bg-card px-4 py-3 max-md:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))] md:-mx-5 md:px-5">
            {isFirst ? (
              <span />
            ) : (
              <Button
                variant="outline"
                onClick={() => goTo(steps[index - 1].id)}
                data-setup-action="back"
              >
                Back
              </Button>
            )}
            {current.done ? (
              <Button onClick={forward} data-setup-action={isLast ? "done" : "next"}>
                {isLast ? "Done" : "Next"}
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={forward}
                data-setup-action={isLast ? "done" : "skip"}
              >
                {isLast ? "Skip and finish" : "Skip for now"}
              </Button>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function StepPanel({ step, onSaved }: { step: OnboardingStep; onSaved: () => void }) {
  if (step.to === "/settings/services")
    return (
      <div className="space-y-3">
        <p>{step.description}</p>
        <Button asChild>
          <Link to="/settings/services">{step.cta}</Link>
        </Button>
      </div>
    );
  switch (step.id) {
    case "business":
      return <BusinessPanel onSaved={onSaved} alreadyDone={step.done} />;
    case "zones":
      return <PricingPanel step={step} onSaved={onSaved} />;
    case "clients":
      return <ClientsPanel step={step} />;
    case "staff":
      return <StaffPanel onSaved={onSaved} />;
    case "dump_site":
      return <EndOfDayPanel done={step.done} onSaved={onSaved} />;
    case "payouts":
      return <PayoutsPanel />;
  }
}

function PricingPanel({ step, onSaved }: { step: OnboardingStep; onSaved: () => void }) {
  const { lines } = useServiceLines();
  if (step.parts) return <PricesPanel step={step} parts={step.parts} onSaved={onSaved} />;
  return lines.includes("mobile_grooming") ? (
    <Button asChild className="min-h-11">
      <Link to="/settings/services">Review grooming prices, vaccines and buffer</Link>
    </Button>
  ) : (
    <ServiceAreaPanel step={step} onSaved={onSaved} />
  );
}

const fieldClass = "space-y-1.5";

// ── 1. The business ────────────────────────────────────────────────────────

function BusinessPanel({ onSaved, alreadyDone }: { onSaved: () => void; alreadyDone: boolean }) {
  const qc = useQueryClient();
  const brandingFn = useServerFn(getOrgBranding);
  const saveBrandingFn = useServerFn(updateOrgBranding);
  const dispatchFn = useServerFn(getDispatchSettings);
  const saveDispatchFn = useServerFn(updateDispatchSettings);
  const brandingQ = useQuery({ queryKey: ["org-branding"], queryFn: () => brandingFn() });
  const dispatchQ = useQuery({ queryKey: ["dispatch-settings"], queryFn: () => dispatchFn() });
  const saveLinesFn = useServerFn(setServiceLines);
  const { can } = usePermissions();
  const { lines: savedLines, known: linesKnown } = useServiceLines();
  const { service: requestedLine } = Route.useSearch();
  const availability = useServiceLineAvailability();

  // null until the owner touches it: the rows show what is stored (pet waste
  // removal for a new business, the column's default), and only a CHANGE is
  // written. Saving an untouched answer could write the fail-open default
  // over a real one whose read merely failed.
  const [lines, setLines] = useState<ServiceLine[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [tz, setTz] = useState<string | null>(null);
  // Kept on the device as it is typed (gaps-r2-12): a reload used to clear
  // the services ticked, the phone, the address and the zone. Only what was
  // touched is kept, the same null-means-untouched values as above.
  const draft = useFormDraft({
    form: "setup-business",
    value: { lines, name, phone, address, tz },
    restore: (d) => {
      setLines(d.lines);
      setName(d.name);
      setPhone(d.phone);
      setAddress(d.address);
      setTz(d.tz);
    },
    reset: () => {
      setLines(null);
      setName(null);
      setPhone(null);
      setAddress(null);
      setTz(null);
    },
  });

  const b = brandingQ.data;
  const nameVal = name ?? b?.name ?? "";
  const phoneVal = phone ?? b?.contact_phone ?? "";
  const addressVal = address ?? b?.contact_address ?? "";
  const savedTz = (dispatchQ.data?.settings as { timezone?: string | null } | undefined)?.timezone;
  // The device's zone, or the address's, unless somebody already chose one
  // (#654: this read `savedTz ?? Chicago`, and savedTz was the column default).
  // Once this step is done the stored zone is a choice, Chicago included, so a
  // reopened setup on a phone in Detroit shows it and does not rewrite it.
  const tzVal =
    tz ??
    (alreadyDone
      ? (savedTz ?? DEFAULT_ORG_TIMEZONE)
      : suggestSetupTimezone({ saved: savedTz, device: deviceTimezone(), address: addressVal }));
  const writeTz = tz !== null || !alreadyDone;
  // A visitor who came for one line (?service=, site-r2-03) sees that line
  // ticked instead of the bare pet-waste default. Only once the stored answer
  // is actually known and before this step is done, so it can never write over
  // a real answer whose read failed, or over one already chosen.
  const mayPreselect = linesKnown && !alreadyDone;
  // With no valid request, a business still holding the column's default has
  // not answered the question (F-06): pet waste was shown ticked to a groomer
  // or a trainer, who saved it without reading. It starts with nothing ticked
  // and has to pick (setupStartingLines).
  const startingLines = mayPreselect
    ? setupStartingLines({
        unanswered: setupAsksServiceLines(savedLines, linesKnown, alreadyDone),
        saved: savedLines,
        requested: requestedLine,
        preselected: preselectedServiceLines(savedLines, requestedLine, availability),
      })
    : savedLines;
  const linesVal = lines ?? startingLines;
  const linesChanged =
    (lines !== null || mayPreselect) &&
    (linesVal.length !== savedLines.length || linesVal.some((l) => !savedLines.includes(l)));

  const m = useMutation({
    mutationFn: async () => {
      // First, because it decides what the later steps ask: a business that
      // does not run pet waste is asked where its day ends, not for a dump
      // site.
      if (linesChanged) await saveLinesFn({ data: { lines: linesVal } });
      // The country, when the address says it plainly ("TX 78701" is US) and
      // nobody has chosen one yet: it decides miles or km on the board
      // (#496). A choice made in Settings > Business is never overwritten.
      const country = b?.country ? undefined : (countryFromAddress(addressVal) ?? undefined);
      await saveBrandingFn({
        data: {
          name: nameVal.trim() || undefined,
          contactPhone: phoneVal.trim() || null,
          contactAddress: addressVal.trim() || null,
          country,
        },
      });
      if (writeTz) await saveDispatchFn({ data: { timezone: tzVal } });
    },
    onSuccess: () => {
      draft.clear();
      toast.success("Business details saved");
      qc.invalidateQueries({ queryKey: ["org-branding"] });
      qc.invalidateQueries({ queryKey: ["dispatch-settings"] });
      qc.invalidateQueries({ queryKey: ["my-org"] });
      if (linesChanged) {
        setLines(null);
        qc.invalidateQueries({ queryKey: ["my-org-features"] });
        qc.invalidateQueries({ queryKey: ["services"] });
      }
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (linesVal.length === 0) {
          toast.error("Choose the services you offer.");
          return;
        }
        if (!addressVal.trim()) {
          toast.error("Add your business address. Routes start from it.");
          return;
        }
        m.mutate();
      }}
    >
      {draft.restored && <DraftRestoredNotice onDiscard={draft.discard} />}
      {/* "Which services do you offer?" (organizations.service_lines), first
          in this form. It belongs in this step rather than a seventh one,
          because it changes what the later steps ask: a dog walker's "where
          the day ends" is not a dump site. */}
      <fieldset className={fieldClass}>
        <legend className="text-sm font-medium">Which services do you offer?</legend>
        <p className="pb-1.5 text-xs text-muted-foreground">
          {APP_NAME} shows the tools for the services you run. You can change this later in
          Settings.
        </p>
        <ServiceLinesChoices
          idPrefix="setup-service-line"
          lines={linesVal}
          onChange={setLines}
          disabled={!linesKnown || !can("manage_settings") || m.isPending}
        />
      </fieldset>
      <div className={fieldClass}>
        <Label htmlFor="setup-name">Business name</Label>
        <Input
          id="setup-name"
          value={nameVal}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoComplete="organization"
        />
      </div>
      <div className={fieldClass}>
        <Label htmlFor="setup-phone">Business phone</Label>
        <Input
          id="setup-phone"
          type="tel"
          value={phoneVal}
          onChange={(e) => setPhone(e.target.value)}
          maxLength={30}
          autoComplete="tel"
        />
      </div>
      <div className={fieldClass}>
        <Label htmlFor="setup-address">Business address</Label>
        <AddressAutocomplete
          id="setup-address"
          value={addressVal}
          onChangeText={setAddress}
          onResolved={(r) => setAddress(r.address.formatted)}
          placeholder="123 Main St, Austin, TX 78701"
          maxLength={300}
        />
        <p className="text-xs text-muted-foreground">
          Where your trucks start the day, unless a tech has a start address of their own.
        </p>
      </div>
      <div className={fieldClass}>
        <Label htmlFor="setup-timezone">Time zone</Label>
        <select
          id="setup-timezone"
          value={tzVal}
          onChange={(e) => setTz(e.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm touch:min-h-11"
        >
          {timezoneOptions(tzVal).map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={m.isPending} data-setup-action="save">
        {m.isPending ? "Saving…" : "Save and continue"}
      </Button>
    </form>
  );
}

// ── 2. The service area and its price ──────────────────────────────────────

const MILES = [5, 10, 15, 25, 40] as const;

/** For a business that runs more than one service line (#639): one row per
 *  thing to price, each saying whether it is done and where to do it. The
 *  service area, when the business has one to set, is the form below the
 *  rows, the same one a one-line business gets. */
function PricesPanel({
  step,
  parts,
  onSaved,
}: {
  step: OnboardingStep;
  parts: PricePart[];
  onSaved: () => void;
}) {
  const area = parts.find((p) => p.id === "area");
  const rest = parts.filter((p) => p.id !== "area");
  const othersOpen = rest.some((p) => !p.done);
  const qc = useQueryClient();
  // Saving the area finishes one part, not the step. Refresh the parts and
  // stay here while walks, stays, grooms or lessons are still open; move on
  // only once the server says every part is done.
  const areaSaved = async () => {
    await qc.invalidateQueries({ queryKey: ["onboarding-status"] });
    const fresh = qc.getQueryData<{ steps: OnboardingStep[] }>(["onboarding-status"]);
    const now = fresh?.steps.find((s) => s.id === step.id);
    if (now?.parts?.every((p) => p.done)) onSaved();
  };
  return (
    <div className="space-y-4">
      <ul className="divide-y rounded-md border" data-setup-price-parts>
        {parts.map((part) => (
          <li
            key={part.id}
            className="flex flex-wrap items-start justify-between gap-3 p-3"
            data-setup-price-part={part.id}
          >
            <div className="flex min-w-0 flex-1 basis-60 items-start gap-2">
              {part.done ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {part.label}
                  <span className="sr-only">{part.done ? ", done" : ", not done"}</span>
                </p>
                <p className="text-sm text-muted-foreground">{part.description}</p>
              </div>
            </div>
            {part.id !== "area" && (
              <Button
                asChild
                size="sm"
                variant={part.done ? "outline" : "default"}
                className="shrink-0"
              >
                <Link to={part.to}>{part.cta}</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Each button opens Settings, Services. Come back here with the setup bar at the top of the
          page.
        </p>
      )}
      {area && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{area.label}</h3>
          <ServiceAreaPanel
            step={{ ...step, done: area.done }}
            onSaved={areaSaved}
            saveLabel={othersOpen ? "Save area" : undefined}
          />
        </div>
      )}
    </div>
  );
}

function ServiceAreaPanel({
  step,
  onSaved,
  saveLabel = "Save and continue",
}: {
  step: OnboardingStep;
  onSaved: () => void;
  saveLabel?: string;
}) {
  // Only a pet-waste business is asked for an area here (R2-47); a trainer
  // prices lessons on Settings, Services.
  const done = step.done;
  const qc = useQueryClient();
  // Done means a priced area exists. Offering the create form again on a
  // finished step reads as "you have not done this yet"; adding a second
  // area is one tap further, for the business that has one.
  const [adding, setAdding] = useState(false);
  const brandingFn = useServerFn(getOrgBranding);
  const brandingQ = useQuery({ queryKey: ["org-branding"], queryFn: () => brandingFn() });
  const createFn = useServerFn(createZone);
  const postalFn = useServerFn(geocodePostal);

  const [name, setName] = useState("Main service area");
  const [miles, setMiles] = useState<number>(15);
  const [zip, setZip] = useState("");
  const [price, setPrice] = useState("");
  const [extraDog, setExtraDog] = useState("");

  const b = brandingQ.data;
  const pinned = b?.latitude != null && b?.longitude != null;

  const m = useMutation({
    mutationFn: async () => {
      let center = pinned ? { lat: Number(b!.latitude), lng: Number(b!.longitude) } : null;
      if (!center) {
        const r = await postalFn({ data: { postalCode: zip.trim() } });
        if (!r.point) throw new Error("We could not find that ZIP code. Check it and try again.");
        center = { lat: r.point.latitude, lng: r.point.longitude };
      }
      const cents = (v: string) => Math.round(parseFloat(v) * 100);
      return createFn({
        data: {
          name: name.trim(),
          geoMatchMode: "radius",
          centerLatitude: center.lat,
          centerLongitude: center.lng,
          radiusMeters: Math.round(miles * 1609.344),
          basePriceCents: cents(price),
          perDogAddlCents: extraDog.trim() ? cents(extraDog) : 0,
        },
      });
    },
    onSuccess: () => {
      toast.success("Service area saved");
      qc.invalidateQueries({ queryKey: ["zones"] });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const priceOk = parseFloat(price) > 0;

  if (done && !adding) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          New clients in your area are quoted its price. Prices and areas can be changed on{" "}
          <Link to="/zones" className="underline">
            Zones
          </Link>
          .
        </p>
        <Button type="button" variant="outline" onClick={() => setAdding(true)}>
          Add another area
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!priceOk) {
          toast.error("Enter what you charge per visit.");
          return;
        }
        if (!pinned && zip.trim().length < 5) {
          toast.error("Enter the ZIP code at the middle of the area you serve.");
          return;
        }
        m.mutate();
      }}
    >
      <div className={fieldClass}>
        <Label htmlFor="setup-zone-name">Area name</Label>
        <Input
          id="setup-zone-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </div>
      {pinned ? (
        <p className="text-sm">
          Centered on your business address,{" "}
          <span className="text-muted-foreground">
            <bdi>{b?.contact_address}</bdi>
          </span>
        </p>
      ) : (
        <div className={fieldClass}>
          <Label htmlFor="setup-zone-zip">ZIP code at the middle of your area</Label>
          <Input
            id="setup-zone-zip"
            inputMode="numeric"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            maxLength={10}
            autoComplete="postal-code"
          />
        </div>
      )}
      <fieldset className={fieldClass}>
        <legend className="text-sm font-medium">How far you drive</legend>
        <div className="flex flex-wrap gap-2 pt-1.5">
          {MILES.map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={miles === n ? "default" : "outline"}
              aria-pressed={miles === n}
              onClick={() => setMiles(n)}
            >
              {n} miles
            </Button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={fieldClass}>
          <Label htmlFor="setup-zone-price">Price per visit ($)</Label>
          <Input
            id="setup-zone-price"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className={fieldClass}>
          <Label htmlFor="setup-zone-dog">Each extra dog ($, optional)</Label>
          <Input
            id="setup-zone-dog"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={extraDog}
            onChange={(e) => setExtraDog(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        You can draw more areas with their own prices on{" "}
        <Link to="/zones" className="underline">
          Zones
        </Link>{" "}
        later.
      </p>
      <Button type="submit" disabled={m.isPending} data-setup-action="save">
        {m.isPending ? "Saving…" : saveLabel}
      </Button>
    </form>
  );
}

// ── 3. The first client ────────────────────────────────────────────────────

function ClientsPanel({ step }: { step: OnboardingStep }) {
  const { role } = useMyRole();
  const canImport = !!step.alt && role !== null && ["owner", "office_manager"].includes(role);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        The new-client form takes their address, dogs and plan, and quotes the price from your
        service area. When you save, come back here with the setup bar at the top of the page.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild data-setup-action="add-client">
          <Link to="/clients/new">{step.cta}</Link>
        </Button>
        {canImport && step.alt && (
          <Button asChild variant="outline">
            <Link to={step.alt.to}>{step.alt.cta}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

// ── 4. Who runs the route ──────────────────────────────────────────────────

function StaffPanel({ onSaved }: { onSaved: () => void }) {
  const qc = useQueryClient();
  const { staff: me } = useMyProfile();
  const listFn = useServerFn(listStaffAddresses);
  const routingFn = useServerFn(setStaffRouting);
  const inviteFn = useServerFn(createOrgInvite);
  const staffQ = useQuery({ queryKey: ["staff-addresses"], queryFn: () => listFn() });
  const [email, setEmail] = useState("");

  const mine = (staffQ.data?.staff ?? []).find((s: any) => s.id === me?.id) as
    { id: string; is_field_tech: boolean | null } | undefined;
  const iRunRoutes = !!mine?.is_field_tech;

  const selfMut = useMutation({
    mutationFn: () => routingFn({ data: { staffId: me!.id, isFieldTech: true } }),
    onSuccess: () => {
      toast.success("You're on the schedule");
      qc.invalidateQueries({ queryKey: ["staff-addresses"] });
      qc.invalidateQueries({ queryKey: ["staff"] });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const inviteMut = useMutation({
    mutationFn: () => inviteFn({ data: { email: email.trim(), role: "tech" } }),
    // The Team page's honest wording (#568): "sent" only when the provider
    // accepted it, otherwise "not sent" and the link to send by hand (#612).
    onSuccess: (r) => {
      const to = email.trim();
      if (r.emailSent) toast.success(`Invite sent to ${to}`);
      else toastNotSent("Invite", to, r.link);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["org-invites"] });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm font-medium">I run the route myself</p>
        <p className="text-xs text-muted-foreground">
          Most businesses start this way. You get a lane on the schedule and your visits show up in
          My Day.
        </p>
        <Button
          type="button"
          variant={iRunRoutes ? "outline" : "default"}
          disabled={!me?.id || iRunRoutes || selfMut.isPending}
          onClick={() => selfMut.mutate()}
          data-setup-action="self"
        >
          {iRunRoutes ? "You run routes" : selfMut.isPending ? "Saving…" : "That's me"}
        </Button>
      </div>
      <form
        className="space-y-2 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) inviteMut.mutate();
        }}
      >
        <Label htmlFor="setup-invite">Or invite a tech</Label>
        <div className="flex flex-wrap items-start gap-2">
          <Input
            id="setup-invite"
            type="email"
            className="min-w-0 flex-1 basis-56"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tech@example.com"
            autoComplete="email"
          />
          <Button type="submit" variant="outline" disabled={!email.trim() || inviteMut.isPending}>
            {inviteMut.isPending ? "Sending…" : "Send invite"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          They get an email and join as a tech when they sign up. More people and roles are in{" "}
          <Link to="/settings/users" className="underline">
            Users &amp; roles
          </Link>
          .
        </p>
      </form>
    </div>
  );
}

// ── 5. Where the day ends ──────────────────────────────────────────────────
//
// Same step, same id, two questions. The route planner ends a tech's day at
// their own end point, else at the business's dump site. A pet-waste business
// is asked for the dump site; one that does not run pet waste has none, so it
// is asked where the day ends (DayEndPanel), and the answer is saved as each
// route-runner's end point. getOnboardingStatus words the step's title from
// the same column.

function EndOfDayPanel({ done, onSaved }: { done: boolean; onSaved: () => void }) {
  const { petWaste, known } = useServiceLines();
  if (!known) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return petWaste ? (
    <DumpSitePanel done={done} onSaved={onSaved} />
  ) : (
    <DayEndPanel done={done} onSaved={onSaved} />
  );
}

function DumpSitePanel({ done, onSaved }: { done: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const saveFn = useServerFn(upsertFacility);
  const brandingFn = useServerFn(getOrgBranding);
  const brandingQ = useQuery({ queryKey: ["org-branding"], queryFn: () => brandingFn() });
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  const m = useMutation({
    mutationFn: () =>
      saveFn({ data: { name: name.trim() || "Dump site", address: address.trim() } }),
    onSuccess: () => {
      toast.success("Dump site saved");
      qc.invalidateQueries({ queryKey: ["facilities"] });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const start = brandingQ.data?.contact_address;

  if (done && !adding) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Routes end at your dump site, or wherever a tech's own end point is. Sites are listed on{" "}
          <Link to="/waste-log" className="underline">
            Waste log
          </Link>
          .
        </p>
        <Button type="button" variant="outline" onClick={() => setAdding(true)}>
          Add another dump site
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!address.trim()) {
          toast.error("Add the dump site's address.");
          return;
        }
        m.mutate();
      }}
    >
      <p className="text-sm">
        {start ? (
          <>
            Routes start at <bdi className="font-medium">{start}</bdi>.
          </>
        ) : (
          "Routes start at your business address once you add it in step 1."
        )}
      </p>
      <div className={fieldClass}>
        <Label htmlFor="setup-dump-name">Dump site name</Label>
        <Input
          id="setup-dump-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="County transfer station"
          maxLength={200}
        />
      </div>
      <div className={fieldClass}>
        <Label htmlFor="setup-dump-address">Dump site address</Label>
        <AddressAutocomplete
          id="setup-dump-address"
          value={address}
          onChangeText={setAddress}
          onResolved={(r) => setAddress(r.address.formatted)}
          placeholder="Landfill or transfer station address"
          maxLength={300}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        If the day ends somewhere else, like home, set a start and end per person in{" "}
        <Link to="/settings/users" className="underline">
          Users &amp; roles
        </Link>
        .
      </p>
      <Button type="submit" disabled={m.isPending} data-setup-action="save">
        {m.isPending ? "Saving…" : "Save and continue"}
      </Button>
    </form>
  );
}

// ── 6. Payouts ─────────────────────────────────────────────────────────────

function PayoutsPanel() {
  const statusFn = useServerFn(getStripeConnectStatus);
  const q = useQuery({
    queryKey: ["stripe-connect-status"],
    queryFn: () => statusFn(),
    retry: false,
  });
  const s = q.data;
  return (
    <div className="space-y-3">
      {s && !s.emailVerified ? (
        <p className="text-sm">
          First, verify your email: open the link we sent when you signed up. The Payments page can
          send it again.
        </p>
      ) : s?.connected && !s.chargesEnabled ? (
        <p className="text-sm">
          Stripe has your account and is still checking it. The Payments page shows what it needs.
        </p>
      ) : (
        <p className="text-sm">
          Stripe asks for your bank account and a few details about the business. It takes about
          five minutes, and it all happens inside {APP_NAME}.
        </p>
      )}
      <Button asChild data-setup-action="payouts">
        <Link to="/payments">Set up payouts</Link>
      </Button>
    </div>
  );
}
