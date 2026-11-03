// The one form a stranger meets: price the yard, then start service or ask for
// a quote. ONE copy.
//
// Two jobs used to be two pages. /signup/{slug} ran this machine (instant
// quote, details, card payment); /lead/{slug} was a separate form that asked
// most of the same questions and wrote a lead. Since 2026-10-08 they are one
// page, and this is its machine (rules in lib/new-customer-form.ts):
//
//   1. ZIP, dogs, how often. Where the business sells online and prices that
//      ZIP, "Get instant price" shows the price.
//   2. Name, email, phone, address, what the first visit needs (the pets by
//      name, how to get in, when to start: lib/booking-details.ts, #527),
//      a note.
//   3. The visitor chooses. "Start service" is the signup it always was: card
//      here, client + property + subscription from the webhook. "Get a quote
//      by email" writes a lead the office follows up. Where there is no price
//      (instant start switched off, a ZIP outside every zone, payments not
//      ready) the quote request is the only button, so nobody hits a wall.
//
// It also runs in canvassing walk mode at a prospect's front door: the tech
// taps "Sign up" and hands the phone over, and pressing that button must
// start a real signup rather than record a hope. Two surfaces, one machine:
// the pricing copy, the step gating and the payment handling drift the moment
// there are two copies, which is the standing failure this repo keeps writing
// tests about.
//
// `variant` changes LAYOUT only: "page" is the public two-column with the
// sticky quote aside; "sheet" stacks the same sections for a phone-width
// drawer. `onPaid` is the seam the two callers genuinely differ on: the public
// page navigates to the success screen, the walk-mode sheet stays put and
// marks the door. `offerQuoteRequest` is off in walk mode, which has its own
// fallback (mark the door, the office finishes it).
import { linkUrl } from "@/lib/app-origin";
import {
  ADD_ON_COPY,
  BOOKING_COPY,
  GROOM_COPY,
  STAY_COPY,
  UNPRICED_COPY,
  perVisitLineLabel,
  requestPanelHint,
  bookingCadence,
  bookingCadenceLabel,
  bookingLine,
  chargedTodayCovers,
  perVisitBillingSentence,
  stayStartDateHint,
} from "@/lib/booking-copy";
import { useEffect, useRef, useState } from "react";
import { ClientSmsConsentWordingText } from "@/components/ClientSmsConsentWordingText";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
// The /pure entry adds js.stripe.com only when loadStripe() runs, on a
// payment screen. The bare entry adds it the moment this module is imported,
// which put Stripe on every page, /auth included (R2-52).
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js/pure";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getPublicSignupForm,
  getSignupQuote,
  getPublicGroomTimes,
  createSignupPaymentIntent,
} from "@/lib/signup.functions";
import { LAST_CLEANED_QUESTION } from "@/lib/first-cleanup";
import { outOfAreaAnswer } from "@/lib/booking-page";
import { stripeAppearance } from "@/lib/stripe-appearance";
import {
  QUOTE_REQUEST_DISCLOSURE,
  askedFields,
  decideFormBranch,
  formCopy,
  leadBodyFromForm,
  type FormFields,
} from "@/lib/new-customer-form";
import { ELAPSED_FIELD, HONEYPOT_FIELD } from "@/lib/public-form-guard";
import {
  ACCESS_NOTES_MAX,
  MAX_START_DAYS_OUT,
  PET_BREED_MAX,
  PET_NAME_MAX,
  addDays,
  bookingDetailsProblem,
  cleanPets,
  earliestStartDate,
  localToday,
  normalizeBookingDetails,
  resizePets,
  type PetEntry,
} from "@/lib/booking-details";
import {
  asksAboutTheYard,
  offersAChoice,
  publicServiceChoices,
  publicServiceOptionLabel,
  publicServiceOptions,
  quotedPublicService,
  requestedBecause,
} from "@/lib/public-services";
import {
  NO_EXTRAS,
  addOnsFor,
  cleanPetSizes,
  petSizeLabel,
  sizePricesFor,
} from "@/lib/booking-extras";
import { PET_SIZES } from "@/lib/groom";
import {
  ONE_TIME_COPY,
  PACKAGE_COPY,
  effectivePublicBookingMode,
} from "@/lib/public-booking-mode";
import { groomTimeLabel } from "@/lib/groom-online";
import type { ServiceLine } from "@/lib/service-lines";

// Module-scoped Stripe.js cache keyed by publishable key + connected account
// (Connect direct charges must be scoped to the tenant's account).
const stripePromiseCache = new Map<string, Promise<StripeJs | null>>();
function getStripe(pk: string, stripeAccount?: string) {
  const cacheKey = `${pk}|${stripeAccount ?? ""}`;
  let p = stripePromiseCache.get(cacheKey);
  if (!p) {
    p = loadStripe(pk, stripeAccount ? { stripeAccount } : undefined);
    stripePromiseCache.set(cacheKey, p);
  }
  return p;
}

function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export type SignupPrefill = Partial<{
  postal_code: string;
  street: string;
  city: string;
  region: string;
  name: string;
  phone: string;
}>;

const EMAIL_RE = /.+@.+\..+/;

/** How long the form lookup is fresh. The public route seeds it from its
 *  loader (#524), and a fresh entry is not fetched again on hydration. */
export const SIGNUP_FORM_STALE_MS = 5 * 60_000;

/** The width the page variant lays out in two columns at (Tailwind's `lg`).
 *  Below it the quote panel is under the whole form, so the price has to be
 *  shown where the visitor tapped (#523). */
const TWO_COLUMNS = "(min-width: 1024px)";

export function SignupFlow({
  slug,
  variant = "page",
  prefill,
  onPaid,
  offerQuoteRequest = true,
  channel = "page",
  onLineChange,
}: {
  slug: string;
  variant?: "page" | "sheet";
  prefill?: SignupPrefill;
  /** Called after the card is confirmed WITHOUT a redirect. When absent, the
   *  flow navigates to /signup/success, which is what the public page wants.
   *  A redirect-based payment method still leaves the page either way: the
   *  return_url lands on the success screen, so nothing is lost, only the
   *  caller's chance to react in place. */
  onPaid?: (signupRequestId: string) => void;
  /** Offer "Get a quote by email". Off in walk mode, which has its own
   *  fallback for a prospect who will not pay at the door. */
  offerQuoteRequest?: boolean;
  /** Where this signup happens, for the label on the lead it writes. */
  channel?: "page" | "door";
  /** Told the line the page speaks for whenever it changes, so the route
   *  can word its headline for it (#560). */
  onLineChange?: (line: ServiceLine) => void;
}) {
  const getQuote = useServerFn(getSignupQuote);
  const createIntent = useServerFn(createSignupPaymentIntent);
  const getGroomTimes = useServerFn(getPublicGroomTimes);
  const getForm = useServerFn(getPublicSignupForm);

  // Who the business is, what its form asks, whether it sells online, and
  // the first-cleanup answers. Same query key as the public route, so on
  // /signup/{slug} this is the lookup the page already made.
  const formQ = useQuery({
    queryKey: ["signup-form", slug],
    queryFn: () => getForm({ data: { slug } }),
    staleTime: SIGNUP_FORM_STALE_MS,
    retry: false,
  });
  const instantStart = !!formQ.data?.instantStart;

  const [form, setForm] = useState({
    postal_code: prefill?.postal_code ?? "",
    dog_count: "1",
    frequency: "weekly",
    name: prefill?.name ?? "",
    email: "",
    phone: prefill?.phone ?? "",
    street: prefill?.street ?? "",
    city: prefill?.city ?? "",
    region: prefill?.region ?? "",
    last_cleaned: "",
    message: "",
    // What the first visit needs (#527). One pet row per pet in step 1;
    // the date is seeded with the earliest the business allows once its
    // settings have loaded (below), so "2 days out" is the default.
    pets: [] as PetEntry[],
    access_notes: "",
    preferred_start_date: "",
    // The service picked (phase 5). "" until the visitor picks, which reads
    // as the default (the business's pet-waste service, else the first
    // listed). Sent only when the business offers more than one.
    service_id: "",
    // The extras picked for that service (#560): add-on ids, and a size per
    // pet where the service prices by size. Ids and sizes only.
    add_on_ids: [] as string[],
    pet_sizes: [] as string[],
    // A groom booked online (#560): the start time picked from the open
    // times on the groom's day (preferred_start_date).
    groom_start_time: "",
  });

  // What the business sells (public_services, through the form lookup). A
  // business that sells one thing, or lists nothing online, gets no picker
  // and sends no service id anywhere: its form is the form it always was.
  const services = publicServiceChoices(
    formQ.data?.services,
    formQ.data?.serviceLines ?? { bookable: [], customerRequestable: [] },
  );
  const pickService = offersAChoice(services);
  // The service quoted: the one picked, or the business's only service when
  // it is not zone-priced (a walking-only business). Sent by id, so the
  // server prices THAT and adds no first cleanup to a walk.
  const chosen = quotedPublicService(services, form.service_id);
  const serviceField = chosen ? { service_id: chosen.id } : {};

  // The words that depend on what is being sold (lib/booking-copy.ts, #525):
  // the service picked, else the business's only one, else pet waste. The
  // cadence list is the line's, so the frequency sent is one it showed.
  const line = bookingLine(services, chosen, formQ.data?.lines);
  const lineCopy = BOOKING_COPY[line];
  // How the owner starts this service on the link (#574): a repeating plan
  // (and the form as it always was, with nothing chosen), one visit, or a
  // package. One visit and a package have no cadence to pick; the server
  // prices them as one visit or the package whatever is sent.
  const mode = chosen ? effectivePublicBookingMode(chosen) : "recurring";
  const oneTime = mode === "one_time";
  const pack = mode === "package" ? (chosen?.package ?? null) : null;
  const repeats = mode === "recurring";
  const frequency = repeats ? bookingCadence(line, form.frequency) : "weekly";
  useEffect(() => {
    onLineChange?.(line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line]);

  // What this service adds to its base price (#560): its line's add-ons, and
  // a size per pet when it prices by size. None for pet waste.
  const extras = formQ.data?.extras ?? NO_EXTRAS;
  // A package is sold at its own price, so it has no extras.
  const offeredAddOns = pack ? [] : addOnsFor(extras, chosen);
  const sizePrices = pack ? [] : sizePricesFor(extras, chosen);
  const pickedAddOnIds = offeredAddOns
    .filter((a) => form.add_on_ids.includes(a.id))
    .map((a) => a.id);
  const petSizes = sizePrices.length
    ? cleanPetSizes(form.pet_sizes, Number(form.dog_count) || 0)
    : [];
  const extrasField =
    chosen && chosen.service_line !== "pet_waste"
      ? { add_on_ids: pickedAddOnIds, pet_sizes: petSizes }
      : {};

  // A stay (priced per night: an Overnight stay, a House sit) is asked for,
  // never started (#546): no cadence, no instant price, no card. The quote
  // request is its path, and it sends no frequency, so the lead is not a
  // "weekly" anything. A service with no price yet is asked for the same
  // way, and a groom is priced and then asked for (#560). `sellsHere` is
  // whether Get instant price is on offer.
  const request = requestedBecause(chosen, sizePrices.length > 0);
  const stay = request === "stay";
  const groom = request === "groom";
  // Asked for, with no price and no card: a service with no price yet, or
  // one the owner takes by request only (#574).
  const asksOnly = request === "unpriced" || request === "request_only";
  const sellsHere = instantStart && !stay && !asksOnly;

  // The pet-waste questions apply when nothing was picked and for the
  // pet-waste service; a walk has no yard to ask about.
  const tiers =
    sellsHere && formQ.data?.firstCleanup?.mode === "by_last_cleaned" && asksAboutTheYard(chosen)
      ? formQ.data.firstCleanup.tiers
      : [];
  const asksLastCleaned = tiers.length > 0;
  const fields: FormFields = askedFields(
    formQ.data?.form?.fields ?? { phone: true, location: true, dogCount: true, message: true },
    instantStart,
  );
  const copy = formQ.data ? formCopy(formQ.data.form, instantStart) : null;

  // The first visit's questions (#527): which are asked, which required,
  // and the first day the date picker offers.
  const details = normalizeBookingDetails(formQ.data?.form?.details);
  const today = localToday();
  const earliestStart = earliestStartDate(today, details);
  const petRows = resizePets(form.pets, form.dog_count);
  const petSingular = lineCopy.petLabel === "Dogs" ? "Dog" : "Pet";
  // Seeded once, when the settings arrive and nothing has been picked.
  const seededStart = useRef(false);
  useEffect(() => {
    if (!formQ.data || seededStart.current) return;
    seededStart.current = true;
    if (details.startDate !== "off") {
      setForm((f) => (f.preferred_start_date ? f : { ...f, preferred_start_date: earliestStart }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formQ.data]);
  // The answers as both buttons send them. A question the owner turned off
  // sends nothing, and the server stores nothing for it either way.
  const detailsBody = {
    pets: details.pets === "off" ? [] : cleanPets(petRows),
    access_notes: details.access === "off" ? "" : form.access_notes,
    preferred_start_date: details.startDate === "off" ? "" : form.preferred_start_date,
  };
  const detailsProblem = bookingDetailsProblem(
    details,
    {
      pets: detailsBody.pets,
      dogCount: Number(form.dog_count) || 1,
      accessNotes: detailsBody.access_notes,
      preferredStartDate: detailsBody.preferred_start_date,
    },
    today,
  );
  const markRequired = (a: "off" | "optional" | "required") =>
    a === "required" ? (
      " *"
    ) : (
      <span className="font-normal text-muted-foreground"> (optional)</span>
    );

  // The spam filters' two fields (lib/public-form-guard.ts), sent with both
  // buttons. The honeypot is an input nobody can see or reach, so a person
  // leaves it empty and a form-filling script does not. The clock starts
  // when the form is on screen, not when the page began loading, so a slow
  // lookup is not counted as typing time.
  // The texting opt-in (#538): unticked until the visitor ticks it, and
  // nothing about booking depends on it.
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (formQ.data && shownAt.current == null) shownAt.current = Date.now();
  }, [formQ.data]);
  const guardFields = () => ({
    [HONEYPOT_FIELD]: honeypot,
    [ELAPSED_FIELD]: shownAt.current == null ? 0 : Date.now() - shownAt.current,
  });

  // The ZIP is the mutation's variable, so the answer can name the ZIP it
  // answered for even after the field is edited.
  const quoteMut = useMutation({
    mutationFn: (postalCode: string) =>
      getQuote({
        data: {
          slug,
          postal_code: postalCode,
          dog_count: Number(form.dog_count),
          frequency,
          last_cleaned: form.last_cleaned,
          ...serviceField,
          ...extrasField,
        },
      }),
    onError: (e: Error) => toast.error(e.message),
  });

  // Payment happens right here (no redirect to Stripe): this mints the
  // PaymentIntent and swaps the quote panel into the card form.
  const [intent, setIntent] = useState<Awaited<ReturnType<typeof createIntent>> | null>(null);
  // Any edit after the payment form appears invalidates the quoted amount
  // and the recorded signup details, so drop back to the quote step.
  const setFormField = (next: typeof form) => {
    setForm(next);
    if (intent) setIntent(null);
  };
  const checkoutMut = useMutation({
    mutationFn: () =>
      createIntent({
        data: {
          slug,
          postal_code: form.postal_code,
          dog_count: Number(form.dog_count),
          frequency,
          // The answer, as a tier id. The price is not sent: the server asks
          // the database for it and charges that.
          last_cleaned: form.last_cleaned,
          // The service picked, and its extras, as ids, for the same reason.
          ...serviceField,
          ...extrasField,
          name: form.name,
          email: form.email,
          phone: form.phone,
          street: form.street,
          city: form.city,
          region: form.region,
          message: form.message,
          ...detailsBody,
          // A groom is booked for its day and time, whatever the start-date
          // setting (#560).
          ...(groom
            ? {
                preferred_start_date: form.preferred_start_date,
                groom_start_time: form.groom_start_time,
              }
            : {}),
          sms_opt_in: smsOptIn && !!form.phone.trim(),
          channel,
          ...guardFields(),
        },
      }),
    onSuccess: (r) => setIntent(r),
    onError: (e: Error) => toast.error(e.message),
  });

  // "Get a quote by email": the hosted lead form's own endpoint, unchanged,
  // so a quote request is exactly the `leads` row it always was.
  const [sent, setSent] = useState(false);
  const leadMut = useMutation({
    mutationFn: async () => {
      // The lead form's own body and the spam filters' two fields, plus the
      // service picked when there was one to pick, and the first visit's
      // answers as the owner's settings shape them (#527).
      const lead = { ...leadBodyFromForm(slug, form), ...guardFields(), ...detailsBody };
      const res = await fetch("/api/public/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The cadence the line offered, which form.frequency may not be
        // after the service changed. None for a stay (#546).
        body: JSON.stringify({
          ...lead,
          frequency: stay || !repeats ? "" : frequency,
          ...serviceField,
          ...extrasField,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as any).error || "Something went wrong. Please try again.");
      }
    },
    onSuccess: () => setSent(true),
  });

  const branch = decideFormBranch({
    instantStart,
    answer: quoteMut.data ?? null,
    offerQuoteRequest,
    stay,
    request: asksOnly ? "unpriced" : null,
  });
  const quote = branch.quote;

  const canQuote =
    form.postal_code.trim().length >= 3 &&
    Number(form.dog_count) >= 1 &&
    (!asksLastCleaned || !!form.last_cleaned);

  // The first cleanup as the database priced it. Priced by tier, the quote
  // carries every answer's price for this yard, so changing the answer after
  // quoting updates the line without a round trip; the charge is still
  // re-priced on the server from the id at checkout.
  const quoteOptions = quote?.first_cleanup_options ?? [];
  const pickedOption = quoteOptions.find((o) => o.id === form.last_cleaned) ?? null;
  const firstCleanupCents: number | null = !quote
    ? null
    : quote.first_cleanup_mode === "by_last_cleaned"
      ? (pickedOption?.priceCents ?? null)
      : (quote.initial_cleanup_cents ?? 0);

  const hasContact = form.name.trim().length > 0 && EMAIL_RE.test(form.email.trim());
  // The first cleanup is a yard's: never shown for a walk, a sit or a groom.
  const showsFirstCleanup =
    asksAboutTheYard(chosen) && (firstCleanupCents == null || firstCleanupCents > 0);
  // A groom booked online (#560): the open start times on the groom's day,
  // for these pets and add-ons, once it is priced. The server works out how
  // long the groom holds the van and checks the time again before the card.
  const groomDay = form.preferred_start_date;
  const groomTimesQ = useQuery({
    queryKey: [
      "groom-times",
      slug,
      chosen?.id,
      groomDay,
      form.dog_count,
      petSizes.join(","),
      pickedAddOnIds.join(","),
    ],
    queryFn: () =>
      getGroomTimes({
        data: {
          slug,
          service_id: chosen!.id,
          dog_count: Number(form.dog_count) || 1,
          date: groomDay,
          add_on_ids: pickedAddOnIds,
          pet_sizes: petSizes,
        },
      }),
    enabled: groom && !!quote && !!chosen && /^\d{4}-\d{2}-\d{2}$/.test(groomDay),
    retry: false,
  });
  const groomTimes = groomTimesQ.data?.times ?? [];
  const groomTime = groomTimes.includes(form.groom_start_time) ? form.groom_start_time : "";
  const canCheckout =
    branch.canStartService &&
    firstCleanupCents != null &&
    hasContact &&
    !!form.street.trim() &&
    !detailsProblem &&
    (!groom || !!groomTime);

  // ── Where the answer goes below `lg` (#523) ────────────────────────────
  const narrowOnly = variant === "page" ? "lg:hidden" : "";
  const answerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelPriceRef = useRef<HTMLDivElement>(null);
  const twoColumns = () =>
    variant === "page" &&
    typeof window !== "undefined" &&
    !!window.matchMedia?.(TWO_COLUMNS).matches;

  // Each new answer is brought into view and given focus, so a phone shows
  // the price (or the out-of-area answer) the moment it arrives and a screen
  // reader reads it. Not at `lg`: the sticky panel beside the form already
  // shows it, and moving focus there would pull a mouse user's place away.
  useEffect(() => {
    if (!quoteMut.data || twoColumns()) return;
    const el = answerRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteMut.data]);

  // The compact bar shows while neither the answer nor the panel is on
  // screen, which is exactly while the visitor is in step 2.
  const priced = !!quote;
  const [answerInView, setAnswerInView] = useState(true);
  const [panelInView, setPanelInView] = useState(false);
  useEffect(() => {
    if (!priced || typeof IntersectionObserver === "undefined") return;
    const answer = answerRef.current;
    const io = answer ? new IntersectionObserver(([e]) => setAnswerInView(e.isIntersecting)) : null;
    if (answer) io?.observe(answer);
    // The panel counts as reached once its price lines, the thing the bar
    // repeats, have come wholly above the bottom of the part of the screen a
    // person can see. That is the visual viewport: on a phone the keyboard
    // covers the bottom of the layout viewport, and a price under it is not
    // on screen. It used to
    // be "the panel is in the top 60%", a stand-in for the keyboard that
    // stopped holding at 768x1024 once step 2 grew (#545): the panel sat at
    // y=770 with its prices showing, and the bar drew over its own total
    // (#552). One-sided on purpose: prices scrolled up past the top still
    // count as reached, so the bar stays away over Start service and the
    // payment form below them. Scroll is listened for in the capture phase
    // because in walk mode the sheet scrolls, not the window, and an
    // element's scroll does not bubble.
    const price = panelPriceRef.current;
    const measure = () => {
      if (!price) return;
      const r = price.getBoundingClientRect();
      const vv = window.visualViewport;
      const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      setPanelInView(r.height > 0 && r.bottom <= bottom + 1);
    };
    measure();
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      io?.disconnect();
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [priced]);
  const showBar = !answerInView && !panelInView;

  // "Continue" under the answer: step 2's first field, so the next step is
  // the one the cursor is in.
  const goToDetails = () => {
    const el = document.getElementById("name");
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
  };
  // "Continue" on the compact bar: the panel with Start service in it.
  const goToPanel = () => {
    const el = panelRef.current;
    el?.scrollIntoView({ block: "start" });
    el?.focus({ preventScroll: true });
  };

  if (formQ.isLoading) {
    return <p className="py-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (formQ.error || !formQ.data) {
    return <p className="py-6 text-sm text-destructive">This page isn't available.</p>;
  }

  // Walk mode with nothing to hand over: the business sells online but a card
  // cannot be taken right now (Stripe not ready, or the plan has lapsed). The
  // sheet's own "just mark the door" button sits under this.
  if (!instantStart && !offerQuoteRequest) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Online signup can't take a card for this business right now. Mark the door and the office
        will finish the signup.
      </p>
    );
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border bg-card p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-6 w-6 shrink-0" aria-hidden="true" />
        </div>
        <h2 className="text-xl font-semibold">Thanks, we got your request!</h2>
        <p className="mt-2 text-sm text-muted-foreground">{copy?.confirmation}</p>
      </div>
    );
  }

  const quotedZip = quoteMut.variables ?? form.postal_code;
  const outOfArea = outOfAreaAnswer(formQ.data.name, quotedZip);
  const perVisit =
    quote && quote.recurring_price_cents != null
      ? money(quote.recurring_price_cents, quote.currency)
      : "";
  const todayCents =
    quote && firstCleanupCents != null && quote.recurring_price_cents != null
      ? firstCleanupCents + quote.recurring_price_cents
      : null;
  const extraLines = quote?.extra_lines ?? [];
  // How the quote was priced (#574), as the server said: the price lines
  // word what was quoted, not what the picker shows now.
  const quotedMode = quote?.booking_mode ?? "recurring";
  const quotedPack = quotedMode === "package" ? (quote?.package ?? null) : null;
  const quotedOnce = quotedMode === "one_time";
  const quotedRepeats = quotedMode === "recurring";

  // The price lines, drawn twice below `lg`: in the answer under step 1 and
  // in the quote panel at the bottom. One copy of the markup, so the two
  // cannot disagree.
  const priceLines = quote ? (
    <>
      {showsFirstCleanup && (
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 text-sm">
            First cleanup (one-time)
            {pickedOption && (
              <span className="block break-words text-xs text-muted-foreground">
                Last cleaned: {pickedOption.label}
              </span>
            )}
          </div>
          <div className="shrink-0 font-medium">
            {firstCleanupCents == null ? "Answer above" : money(firstCleanupCents, quote.currency)}
          </div>
        </div>
      )}
      {extraLines.map((l, i) => (
        <div key={`${i}-${l.label}`} className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 break-words text-sm text-muted-foreground">{l.label}</div>
          <div className="shrink-0 text-sm text-muted-foreground">
            {l.addOn ? "+" : ""}
            {money(l.cents, quote.currency)}
          </div>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 text-sm">
          {quotedPack
            ? PACKAGE_COPY.lineLabel(quotedPack.name, quotedPack.sessions_count)
            : quotedOnce
              ? ONE_TIME_COPY.lineLabel
              : `${perVisitLineLabel(line, groom)} (${bookingCadenceLabel(line, frequency)})`}
        </div>
        {/* PER VISIT, not per month. `public_quote` returns
            `round(base_visit_cents × frequency_multiplier)`, and
            pricing.ts documents it as "Per-visit price after the
            frequency multiplier": the multipliers price LESS frequent
            visits HIGHER (weekly 1.0, biweekly 1.7, monthly 3.2), which
            only makes sense per visit. Every other surface says /visit;
            this one said /mo and the line below sold "a prepaid first
            month" for what buys ONE visit. Weekly service at $25 read
            "$25.00/mo". */}
        <div className="shrink-0 font-medium">
          {quotedRepeats ? `${perVisit}/${lineCopy.visit}` : perVisit}
        </div>
      </div>
      <div className="border-t pt-3 text-xs text-muted-foreground">
        {firstCleanupCents == null ? (
          <>Tell us when your yard was last cleaned to see today's total.</>
        ) : quotedPack ? (
          <>
            {PACKAGE_COPY.chargedTodayLead}{" "}
            <strong className="text-foreground">{money(todayCents ?? 0, quote.currency)}</strong>.{" "}
            {PACKAGE_COPY.sessionsTracked(quotedPack.sessions_count)}
          </>
        ) : quotedOnce ? (
          <>
            {ONE_TIME_COPY.chargedTodayLead}{" "}
            <strong className="text-foreground">{money(todayCents ?? 0, quote.currency)}</strong>.{" "}
            {ONE_TIME_COPY.chargedOnce}
            {groom && <span className="mt-2 block">{GROOM_COPY.orRequest}</span>}
          </>
        ) : (
          <>
            {groom ? GROOM_COPY.chargedTodayLead : "Charged today if you start service:"}{" "}
            <strong className="text-foreground">{money(todayCents ?? 0, quote.currency)}</strong>
            {chargedTodayCovers(line, showsFirstCleanup)}{" "}
            {perVisitBillingSentence(line, money(quote.recurring_price_cents, quote.currency))}
            {groom && <span className="mt-2 block">{GROOM_COPY.orRequest}</span>}
          </>
        )}
      </div>
    </>
  ) : null;

  // The answer to Get instant price, right under the button (#523). On a
  // phone the quote panel is below the whole contact form, about 1,100 px
  // down at 390 px, so tapping the button used to change nothing the visitor
  // could see. At `lg` and up the panel sits beside the form, sticky, and
  // this is not drawn (`lg:hidden`); the sheet is always narrow, so it
  // always is. The out-of-area answer gets the same place (#526's words).
  const answered = !!quote || branch.reason === "no-zone";
  const quoteAnswer = answered ? (
    <div
      ref={answerRef}
      tabIndex={-1}
      aria-live="polite"
      className={`mt-4 space-y-3 rounded-xl border bg-muted/40 p-4 outline-none ${narrowOnly}`}
    >
      {quote ? (
        <>
          {pickService && chosen && (
            <div className="min-w-0 break-words text-sm font-medium">{chosen.name}</div>
          )}
          {priceLines}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{outOfArea}</p>
      )}
      {quote || branch.canRequestQuote ? (
        <Button className="w-full sm:w-auto" onClick={goToDetails}>
          Continue
        </Button>
      ) : null}
    </div>
  ) : null;

  const serviceCard = (
    <div className="rounded-2xl border bg-card p-(--card-pad)">
      <h2 className="text-base font-semibold">1. Your service</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {pickService && (
          <div className="min-w-0 space-y-1.5 sm:col-span-3">
            <Label htmlFor="service">What would you like?</Label>
            <Select
              value={chosen?.id ?? ""}
              onValueChange={(v) => {
                setFormField({ ...form, service_id: v, last_cleaned: "" });
                // A price quoted for one service says nothing about another.
                quoteMut.reset();
              }}
            >
              <SelectTrigger id="service" className="min-w-0 whitespace-normal text-left">
                <SelectValue placeholder="Pick a service" />
              </SelectTrigger>
              <SelectContent>
                {publicServiceOptions(services).map((s, i, options) => (
                  <SelectItem key={s.id} value={s.id}>
                    {publicServiceOptionLabel(s, i, options)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {fields.location && (
          <div className="space-y-1.5">
            <Label htmlFor="postal_code">ZIP code</Label>
            <Input
              id="postal_code"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={12}
              value={form.postal_code}
              onChange={(e) => setFormField({ ...form, postal_code: e.target.value })}
              placeholder="e.g. 78704"
            />
          </div>
        )}
        {fields.dogCount && (
          <div className="space-y-1.5">
            <Label htmlFor="dog_count">{lineCopy.petLabel}</Label>
            <Input
              id="dog_count"
              type="number"
              min={1}
              max={20}
              value={form.dog_count}
              onChange={(e) => setFormField({ ...form, dog_count: e.target.value })}
            />
          </div>
        )}
        {stay ? (
          <p className="min-w-0 text-sm text-muted-foreground sm:col-span-3">
            {STAY_COPY.howItWorks}
          </p>
        ) : pack ? (
          <p className="min-w-0 text-sm text-muted-foreground sm:col-span-3">
            {PACKAGE_COPY.howItWorks(pack.sessions_count)}
          </p>
        ) : oneTime ? (
          <p className="min-w-0 text-sm text-muted-foreground sm:col-span-3">
            {ONE_TIME_COPY.howItWorks}
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="frequency">Frequency</Label>
            <Select
              value={frequency}
              onValueChange={(v) => setFormField({ ...form, frequency: v })}
            >
              <SelectTrigger id="frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {lineCopy.cadences.map((k) => (
                  <SelectItem key={k} value={k}>
                    {bookingCadenceLabel(line, k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {asksLastCleaned && (
          <div className="min-w-0 space-y-1.5 sm:col-span-3">
            <Label htmlFor="last_cleaned">{LAST_CLEANED_QUESTION}</Label>
            <Select
              value={form.last_cleaned}
              onValueChange={(v) => setFormField({ ...form, last_cleaned: v })}
            >
              <SelectTrigger id="last_cleaned" className="min-w-0 whitespace-normal text-left">
                <SelectValue placeholder="Pick one" />
              </SelectTrigger>
              <SelectContent>
                {tiers.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A yard that has waited longer takes longer the first time, so this sets the price of
              your first cleanup.
            </p>
          </div>
        )}
        {/* A size per pet, where the service prices by size (#560). One
            select per pet from the count above, so the price is made of the
            pets the visitor named. "Not sure" sends nothing, and the pet is
            priced at the service's own price. */}
        {sizePrices.length > 0 && (
          <fieldset className="min-w-0 space-y-2 sm:col-span-3">
            <legend className="text-sm font-medium">{GROOM_COPY.sizeLabel}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {petSizes.map((size, i) => (
                <div key={i} className="min-w-0 space-y-1.5">
                  <Label htmlFor={`pet-size-${i}`} className="text-xs text-muted-foreground">
                    {petSingular}
                    {petSizes.length > 1 ? ` ${i + 1}` : ""}
                  </Label>
                  <Select
                    value={size || "unsure"}
                    onValueChange={(v) => {
                      const next = [...petSizes];
                      next[i] = v === "unsure" ? "" : (v as (typeof PET_SIZES)[number]);
                      setFormField({ ...form, pet_sizes: next });
                      quoteMut.reset();
                    }}
                  >
                    <SelectTrigger id={`pet-size-${i}`} className="min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unsure">Not sure</SelectItem>
                      {sizePrices.map((sp) => (
                        <SelectItem key={sp.size} value={sp.size}>
                          {petSizeLabel(sp.size)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{GROOM_COPY.sizeHint}</p>
          </fieldset>
        )}
        {/* The line's add-ons (#560), each with what it adds per visit.
            The whole row is the target, 44px tall, so a thumb can tick it. */}
        {offeredAddOns.length > 0 && (
          <fieldset className="min-w-0 space-y-1 sm:col-span-3">
            <legend className="text-sm font-medium">{ADD_ON_COPY.legend}</legend>
            {offeredAddOns.map((a) => {
              const on = pickedAddOnIds.includes(a.id);
              return (
                <label
                  key={a.id}
                  htmlFor={`add-on-${a.id}`}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1"
                >
                  <Checkbox
                    id={`add-on-${a.id}`}
                    checked={on}
                    onCheckedChange={(v) => {
                      const next = v
                        ? [...pickedAddOnIds, a.id]
                        : pickedAddOnIds.filter((id) => id !== a.id);
                      setFormField({ ...form, add_on_ids: next });
                      quoteMut.reset();
                    }}
                  />
                  <span className="min-w-0 flex-1 break-words text-sm">{a.name}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    +{money(a.unit_price_cents, formQ.data?.currency ?? "usd")}
                  </span>
                </label>
              );
            })}
            <p className="text-xs text-muted-foreground">
              {asksOnly ? ADD_ON_COPY.unpricedHint : ADD_ON_COPY.hint(lineCopy.visit)}
            </p>
          </fieldset>
        )}
      </div>
      {sellsHere && (
        <div className="mt-4">
          <Button
            onClick={() => quoteMut.mutate(form.postal_code)}
            disabled={!canQuote || quoteMut.isPending}
            variant="secondary"
          >
            {quoteMut.isPending ? "Pricing…" : "Get instant price"}
          </Button>
        </div>
      )}
      {quoteAnswer}
    </div>
  );

  const detailsCard = (
    <div className="relative rounded-2xl border bg-card p-(--card-pad)">
      <h2 className="text-base font-semibold">2. Your details</h2>
      {/* The honeypot. `invisible` (visibility: hidden) takes it out of the
          tab order and the accessibility tree as well as out of sight, and
          aria-hidden says so twice; absolute and zero-sized inside this
          `relative` card so it cannot widen the page at any width. A script
          that fills every input fills this one, and the server refuses it. */}
      <div aria-hidden="true" className="invisible absolute h-0 w-0 overflow-hidden">
        <label htmlFor={HONEYPOT_FIELD}>Leave this empty</label>
        <input
          id={HONEYPOT_FIELD}
          name={HONEYPOT_FIELD}
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Full name *</Label>
          <Input
            id="name"
            autoComplete="name"
            value={form.name}
            onChange={(e) => setFormField({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email *</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={(e) => setFormField({ ...form, email: e.target.value })}
          />
        </div>
        {fields.phone && (
          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              type="tel"
              autoComplete="tel"
              value={form.phone}
              onChange={(e) => setFormField({ ...form, phone: e.target.value })}
            />
            {/* The texting opt-in (#538): the business's own name, its own
                Terms and Privacy, unticked, and never needed to book. Only on
                the start-service branch, which is the one that makes a client
                for it to belong to. */}
            {branch.canStartService && formQ.data?.smsConsent && (
              <label
                className={`flex items-start gap-2 rounded-md border p-3 text-2xs leading-relaxed text-muted-foreground ${form.phone.trim() ? "" : "opacity-50"}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0"
                  checked={smsOptIn}
                  disabled={!form.phone.trim()}
                  onChange={(e) => setSmsOptIn(e.target.checked)}
                />
                <span className="min-w-0">
                  Optional. <ClientSmsConsentWordingText wording={formQ.data.smsConsent} />
                </span>
              </label>
            )}
          </div>
        )}
        {/* DELIBERATELY a plain input, not AddressAutocomplete.
            The public route has no Supabase session and all three address
            server functions sit behind `requireSupabaseAuth`
            (address.functions.ts), so the control would render and fail on
            every keystroke. The fix is not to drop the middleware:
            `autocompleteAddress` proxies a metered Google API and its rate
            limit is keyed on `context.userId`, so an anonymous version of it
            is an open door to somebody else's bill. A safe public path needs
            its own server function, gated on the tenant slug, rate-limited
            per IP + slug, and biased from the tenant's zones. That is a piece
            of work, not a wiring change, and nobody should start it before a
            provider is chosen. (Walk mode prefills this field from the door
            instead, which is the one case where the address is already
            known.) */}
        {fields.location && (
          <>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="street">Street address{sellsHere ? " *" : ""}</Label>
              <Input
                id="street"
                autoComplete="street-address"
                value={form.street}
                onChange={(e) => setFormField({ ...form, street: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                autoComplete="address-level2"
                value={form.city}
                onChange={(e) => setFormField({ ...form, city: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="region">State</Label>
              <Input
                id="region"
                autoComplete="address-level1"
                value={form.region}
                onChange={(e) => setFormField({ ...form, region: e.target.value })}
              />
            </div>
          </>
        )}
        {/* What the first visit needs (#527), each asked as the owner set
            it in Settings. One row per pet from step 1's count, so the
            names line up with the dogs the price was made of. */}
        {details.pets !== "off" && (
          <fieldset className="min-w-0 space-y-3 sm:col-span-2">
            <legend className="text-sm font-medium">
              Your {lineCopy.petLabel.toLowerCase()}
              {markRequired(details.pets)}
            </legend>
            {petRows.map((pet, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`pet-name-${i}`}>
                    {petSingular} {petRows.length > 1 ? `${i + 1} ` : ""}name
                  </Label>
                  <Input
                    id={`pet-name-${i}`}
                    maxLength={PET_NAME_MAX}
                    value={pet.name}
                    onChange={(e) =>
                      setFormField({
                        ...form,
                        pets: petRows.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)),
                      })
                    }
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`pet-breed-${i}`}>
                    {lineCopy.breedLabel}{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id={`pet-breed-${i}`}
                    maxLength={PET_BREED_MAX}
                    value={pet.breed}
                    onChange={(e) =>
                      setFormField({
                        ...form,
                        pets: petRows.map((p, j) =>
                          j === i ? { ...p, breed: e.target.value } : p,
                        ),
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </fieldset>
        )}
        {details.access !== "off" && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="access_notes">
              {lineCopy.accessLabel}
              {markRequired(details.access)}
            </Label>
            <Textarea
              id="access_notes"
              rows={2}
              maxLength={ACCESS_NOTES_MAX}
              placeholder={lineCopy.accessPlaceholder}
              value={form.access_notes}
              onChange={(e) => setFormField({ ...form, access_notes: e.target.value })}
            />
          </div>
        )}
        {(details.startDate !== "off" || groom) && (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="preferred_start_date">
              {stay
                ? STAY_COPY.startDateLabel
                : groom
                  ? GROOM_COPY.dayLabel
                  : "Preferred start date"}
              {groom ? (
                <span className="font-normal text-muted-foreground"> {GROOM_COPY.toBook}</span>
              ) : (
                markRequired(details.startDate)
              )}
            </Label>
            <Input
              id="preferred_start_date"
              type="date"
              min={earliestStart}
              max={addDays(today, MAX_START_DAYS_OUT)}
              value={form.preferred_start_date}
              onChange={(e) => setFormField({ ...form, preferred_start_date: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {stay
                ? stayStartDateHint(formQ.data.name ?? "The business")
                : groom
                  ? GROOM_COPY.dayHint
                  : `${formQ.data.name ?? "The business"} will confirm your first visit for on or after this date.`}
            </p>
          </div>
        )}
        {/* The groom's start time (#560): the openings on that day for a
            groom this long, once it is priced. Booking needs one; a request
            does not. */}
        {groom && (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="groom_start_time">
              {GROOM_COPY.timeLabel}
              <span className="font-normal text-muted-foreground"> {GROOM_COPY.toBook}</span>
            </Label>
            <Select
              value={groomTime}
              onValueChange={(v) => setFormField({ ...form, groom_start_time: v })}
              disabled={groomTimes.length === 0}
            >
              <SelectTrigger id="groom_start_time" className="min-w-0">
                <SelectValue placeholder={GROOM_COPY.timePlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {groomTimes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {groomTimeLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {!quote
                ? GROOM_COPY.timeNeedsPrice
                : !groomDay
                  ? GROOM_COPY.timeNeedsDay
                  : groomTimesQ.isFetching
                    ? GROOM_COPY.timeLoading
                    : (groomTimesQ.data?.problem ??
                      (groomTimesQ.error ? (groomTimesQ.error as Error).message : null) ??
                      GROOM_COPY.timeHint)}
            </p>
          </div>
        )}
        {fields.message && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="message">
              Anything else? <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="message"
              rows={3}
              maxLength={2000}
              placeholder={stay ? STAY_COPY.notePlaceholder : lineCopy.notePlaceholder}
              value={form.message}
              onChange={(e) => setFormField({ ...form, message: e.target.value })}
            />
          </div>
        )}
      </div>
    </div>
  );

  const quoteRequestButton = branch.canRequestQuote ? (
    <div className="space-y-2">
      <Button
        className="w-full"
        variant={branch.canStartService ? "outline" : "default"}
        disabled={!hasContact || !!detailsProblem || leadMut.isPending}
        onClick={() => leadMut.mutate()}
      >
        {leadMut.isPending
          ? "Sending…"
          : stay
            ? STAY_COPY.requestButton
            : groom
              ? GROOM_COPY.requestButton
              : asksOnly
                ? UNPRICED_COPY.requestButton
                : branch.canStartService || branch.reason === "not-priced-yet"
                  ? "Get a quote by email"
                  : "Request a quote"}
      </Button>
      {/* Once Start service is on offer, the one hint under it covers both
          buttons (#528): two hints for the same missing fields read as two
          different problems. */}
      {!hasContact && !(branch.canStartService && firstCleanupCents != null) && (
        <p className="text-xs text-muted-foreground">Add your name and email to send it.</p>
      )}
      {/* A first-visit answer the owner requires (#527), once the contact
          details are in, under the same rule. */}
      {hasContact && detailsProblem && !(branch.canStartService && firstCleanupCents != null) && (
        <p className="text-xs text-muted-foreground">{detailsProblem}</p>
      )}
      {leadMut.error ? (
        <p className="text-sm text-destructive">{(leadMut.error as Error).message}</p>
      ) : null}
      <p className="text-center text-2xs text-muted-foreground">{QUOTE_REQUEST_DISCLOSURE}</p>
    </div>
  ) : null;

  const quotePanel = (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className={
        variant === "page"
          ? "h-fit min-w-0 rounded-2xl border bg-card p-6 outline-none lg:sticky lg:top-24"
          : "min-w-0 rounded-2xl border bg-card p-6 outline-none"
      }
    >
      <h2 className="text-base font-semibold">Your quote</h2>
      {!quote ? (
        <div className="mt-3 space-y-4">
          <p className="text-sm text-muted-foreground">
            {branch.reason === "not-priced-yet" ? (
              <>
                {lineCopy.priceHint} <em>Get instant price</em>.
              </>
            ) : branch.reason === "no-zone" ? (
              <>{outOfArea}</>
            ) : branch.reason === "stay-request" ? (
              <>{STAY_COPY.panelHint}</>
            ) : branch.reason === "unpriced-request" ? (
              <>{requestPanelHint(line)}</>
            ) : (
              <>{requestPanelHint(line)}</>
            )}
          </p>
          {quoteRequestButton}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {/* No zone name here (#526): "MAIN" is the office's label for a
              set of ZIPs, not something a customer chose or can read. */}
          {pickService && chosen && (
            <div className="min-w-0 break-words text-sm font-medium">{chosen.name}</div>
          )}
          <div ref={panelPriceRef} className="space-y-4">
            {priceLines}
          </div>
          {intent ? (
            <Elements
              stripe={getStripe(intent.publishableKey, intent.stripeAccount)}
              options={{
                clientSecret: intent.clientSecret,
                appearance: stripeAppearance(),
              }}
            >
              <SignupPayForm
                signupRequestId={intent.signupRequestId}
                amountCents={intent.amountCents}
                currency={intent.currency}
                onPaid={onPaid}
              />
            </Elements>
          ) : branch.canStartService ? (
            <div className="space-y-2">
              <Button
                className="w-full"
                disabled={!canCheckout || checkoutMut.isPending}
                onClick={() => checkoutMut.mutate()}
              >
                {checkoutMut.isPending
                  ? "Preparing payment…"
                  : pack
                    ? PACKAGE_COPY.startButton
                    : oneTime
                      ? ONE_TIME_COPY.startButton
                      : groom
                        ? GROOM_COPY.bookButton
                        : "Start service"}
              </Button>
              {!canCheckout && firstCleanupCents != null && (
                <p className="text-xs text-muted-foreground">
                  {!hasContact || !form.street.trim()
                    ? "Add your name, email and street address to continue."
                    : (detailsProblem ?? (groom && !groomTime ? GROOM_COPY.pickTime : null))}
                </p>
              )}
            </div>
          ) : null}
          {!intent && quoteRequestButton}
        </div>
      )}
    </aside>
  );

  // The price, kept in reach while step 2 is filled in (#523): once the
  // answer under step 1 has scrolled away and until the quote panel comes
  // into view. Fixed, not sticky, so showing and hiding it moves nothing
  // else on the page; `lg:hidden` on the page, where the panel is sticky
  // beside the form instead.
  const compactBar =
    quote && showBar ? (
      <div
        className={`fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] backdrop-blur ${narrowOnly}`}
      >
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            <span className="font-medium">
              {quotedRepeats ? `${perVisit}/${lineCopy.visit}` : perVisit}
            </span>
            {todayCents != null ? (
              <span className="text-muted-foreground">
                {", "}
                {money(todayCents, quote.currency)} today
              </span>
            ) : null}
          </div>
          <Button size="sm" className="shrink-0" onClick={goToPanel}>
            Continue
          </Button>
        </div>
      </div>
    ) : null;

  if (variant === "sheet") {
    return (
      <div className="space-y-4">
        {serviceCard}
        {detailsCard}
        {quotePanel}
        {compactBar}
      </div>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-8">
        {serviceCard}
        {detailsCard}
      </div>
      {quotePanel}
      {compactBar}
    </div>
  );
}

// Inline card form for the signup prepay: confirms the PaymentIntent on this
// page. Without `onPaid` it hands off to the success page, which polls
// provisioning status; with it, the caller reacts in place (walk mode marks
// the door and stays in the walk).
function SignupPayForm({
  signupRequestId,
  amountCents,
  currency,
  onPaid,
}: {
  signupRequestId: string;
  amountCents: number;
  currency: string;
  onPaid?: (signupRequestId: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message ?? "Please check your details.");
      setSubmitting(false);
      return;
    }

    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // linkUrl(): Stripe returns the buyer here after paying.
        return_url: linkUrl(`/signup/success?sr=${signupRequestId}`),
      },
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try another card.");
      setSubmitting(false);
      return;
    }

    if (onPaid) {
      onPaid(signupRequestId);
      return;
    }
    window.location.assign(`/signup/success?sr=${signupRequestId}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <PaymentElement onReady={() => setReady(true)} />
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button
        type="submit"
        className="w-full"
        disabled={!stripe || !elements || !ready || submitting}
      >
        {submitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin shrink-0" /> Processing…
          </>
        ) : (
          <>Pay {money(amountCents, currency)}</>
        )}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Payments processed securely by Stripe. Your card details never touch our servers.
      </p>
    </form>
  );
}
