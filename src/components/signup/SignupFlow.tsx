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
//   2. Name, email, phone, address, a note.
//   3. The visitor chooses. "Start service" is the signup it always was: card
//      here, client + property + subscription from the webhook. "Just send me
//      a quote" writes a lead the office follows up. Where there is no price
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
import { appUrl } from "@/lib/app-origin";
import { PORTAL_FREQUENCY_VALUES, frequencyLabel } from "@/lib/frequency-request";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  createSignupPaymentIntent,
} from "@/lib/signup.functions";
import { LAST_CLEANED_QUESTION } from "@/lib/first-cleanup";
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

// Canonical labels for the portal-selectable cadences (I3 shared map): the
// public signup page uses the same wording as the portal and office.
const FREQ_LABELS: Record<string, string> = Object.fromEntries(
  PORTAL_FREQUENCY_VALUES.map((v) => [v, frequencyLabel(v)]),
);

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

export function SignupFlow({
  slug,
  variant = "page",
  prefill,
  onPaid,
  offerQuoteRequest = true,
  channel = "page",
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
  /** Offer "Just send me a quote". Off in walk mode, which has its own
   *  fallback for a prospect who will not pay at the door. */
  offerQuoteRequest?: boolean;
  /** Where this signup happens, for the label on the lead it writes. */
  channel?: "page" | "door";
}) {
  const getQuote = useServerFn(getSignupQuote);
  const createIntent = useServerFn(createSignupPaymentIntent);
  const getForm = useServerFn(getPublicSignupForm);

  // Who the business is, what its form asks, whether it sells online, and
  // the first-cleanup answers. Same query key as the public route, so on
  // /signup/{slug} this is the lookup the page already made.
  const formQ = useQuery({
    queryKey: ["signup-form", slug],
    queryFn: () => getForm({ data: { slug } }),
    retry: false,
  });
  const instantStart = !!formQ.data?.instantStart;
  const tiers =
    instantStart && formQ.data?.firstCleanup?.mode === "by_last_cleaned"
      ? formQ.data.firstCleanup.tiers
      : [];
  const asksLastCleaned = tiers.length > 0;
  const fields: FormFields = askedFields(
    formQ.data?.form?.fields ?? { phone: true, location: true, dogCount: true, message: true },
    instantStart,
  );
  const copy = formQ.data ? formCopy(formQ.data.form, instantStart) : null;

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
  });

  // The spam filters' two fields (lib/public-form-guard.ts), sent with both
  // buttons. The honeypot is an input nobody can see or reach, so a person
  // leaves it empty and a form-filling script does not. The clock starts
  // when the form is on screen, not when the page began loading, so a slow
  // lookup is not counted as typing time.
  const [honeypot, setHoneypot] = useState("");
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (formQ.data && shownAt.current == null) shownAt.current = Date.now();
  }, [formQ.data]);
  const guardFields = () => ({
    [HONEYPOT_FIELD]: honeypot,
    [ELAPSED_FIELD]: shownAt.current == null ? 0 : Date.now() - shownAt.current,
  });

  const quoteMut = useMutation({
    mutationFn: () =>
      getQuote({
        data: {
          slug,
          postal_code: form.postal_code,
          dog_count: Number(form.dog_count),
          frequency: form.frequency as any,
          last_cleaned: form.last_cleaned,
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
          frequency: form.frequency as any,
          // The answer, as a tier id. The price is not sent: the server asks
          // the database for it and charges that.
          last_cleaned: form.last_cleaned,
          name: form.name,
          email: form.email,
          phone: form.phone,
          street: form.street,
          city: form.city,
          region: form.region,
          message: form.message,
          channel,
          ...guardFields(),
        },
      }),
    onSuccess: (r) => setIntent(r),
    onError: (e: Error) => toast.error(e.message),
  });

  // "Just send me a quote": the hosted lead form's own endpoint, unchanged,
  // so a quote request is exactly the `leads` row it always was.
  const [sent, setSent] = useState(false);
  const leadMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/public/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...leadBodyFromForm(slug, form), ...guardFields() }),
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
  const canCheckout =
    branch.canStartService && firstCleanupCents != null && hasContact && !!form.street.trim();

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

  const serviceCard = (
    <div className="rounded-2xl border bg-card p-(--card-pad)">
      <h2 className="text-base font-semibold">1. Your service</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
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
            <Label htmlFor="dog_count">Dogs</Label>
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
        <div className="space-y-1.5">
          <Label htmlFor="frequency">Frequency</Label>
          <Select
            value={form.frequency}
            onValueChange={(v) => setFormField({ ...form, frequency: v })}
          >
            <SelectTrigger id="frequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(FREQ_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
      </div>
      {instantStart && (
        <div className="mt-4">
          <Button
            onClick={() => quoteMut.mutate()}
            disabled={!canQuote || quoteMut.isPending}
            variant="secondary"
          >
            {quoteMut.isPending ? "Pricing…" : "Get instant price"}
          </Button>
        </div>
      )}
      {branch.reason === "no-zone" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          We don't have online pricing for that ZIP yet.
          {branch.canRequestQuote ? " Add your details and we'll send you a quote." : ""}
        </p>
      ) : null}
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
              <Label htmlFor="street">Street address{instantStart ? " *" : ""}</Label>
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
        {fields.message && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="message">
              Anything else? <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="message"
              rows={3}
              maxLength={2000}
              placeholder="Gate code, dog names, preferred days…"
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
        disabled={!hasContact || leadMut.isPending}
        onClick={() => leadMut.mutate()}
      >
        {leadMut.isPending
          ? "Sending…"
          : branch.canStartService || branch.reason === "not-priced-yet"
            ? "Just send me a quote"
            : "Request a quote"}
      </Button>
      {!hasContact && (
        <p className="text-xs text-muted-foreground">Add your name and email to send it.</p>
      )}
      {leadMut.error ? (
        <p className="text-sm text-destructive">{(leadMut.error as Error).message}</p>
      ) : null}
      <p className="text-center text-2xs text-muted-foreground">{QUOTE_REQUEST_DISCLOSURE}</p>
    </div>
  ) : null;

  const quotePanel = (
    <aside
      className={
        variant === "page"
          ? "h-fit min-w-0 rounded-2xl border bg-card p-6 lg:sticky lg:top-24"
          : "min-w-0 rounded-2xl border bg-card p-6"
      }
    >
      <h2 className="text-base font-semibold">Your quote</h2>
      {!quote ? (
        <div className="mt-3 space-y-4">
          <p className="text-sm text-muted-foreground">
            {branch.reason === "not-priced-yet" ? (
              <>
                Enter your ZIP and dogs, then hit <em>Get instant price</em>.
              </>
            ) : branch.reason === "no-zone" ? (
              <>We'll price your yard ourselves and get back to you.</>
            ) : (
              <>Tell us about your yard and we'll get back to you with a price.</>
            )}
          </p>
          {quoteRequestButton}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {quote.zone_name}
          </div>
          {(firstCleanupCents == null || firstCleanupCents > 0) && (
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
                {firstCleanupCents == null
                  ? "Answer above"
                  : money(firstCleanupCents, quote.currency)}
              </div>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0 text-sm">Ongoing ({FREQ_LABELS[form.frequency]})</div>
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
              {money(quote.recurring_price_cents, quote.currency)}/visit
            </div>
          </div>
          <div className="border-t pt-3 text-xs text-muted-foreground">
            {firstCleanupCents == null ? (
              <>Tell us when your yard was last cleaned to see today's total.</>
            ) : (
              <>
                Charged today if you start service:{" "}
                <strong className="text-foreground">
                  {money(firstCleanupCents + quote.recurring_price_cents, quote.currency)}
                </strong>
                {firstCleanupCents > 0
                  ? ", which covers your first cleanup plus your first scheduled visit."
                  : ", which covers your first scheduled visit."}{" "}
                After that you are billed for visits as they happen. Cancel anytime.
              </>
            )}
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
          ) : (
            <div className="space-y-2">
              <Button
                className="w-full"
                disabled={!canCheckout || checkoutMut.isPending}
                onClick={() => checkoutMut.mutate()}
              >
                {checkoutMut.isPending ? "Preparing payment…" : "Start service"}
              </Button>
              {!canCheckout && firstCleanupCents != null && (
                <p className="text-xs text-muted-foreground">
                  Add your name, email and street address to start.
                </p>
              )}
            </div>
          )}
          {!intent && quoteRequestButton}
        </div>
      )}
    </aside>
  );

  if (variant === "sheet") {
    return (
      <div className="space-y-4">
        {serviceCard}
        {detailsCard}
        {quotePanel}
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
        // appUrl(): Stripe returns the buyer here after paying.
        return_url: appUrl(`/signup/success?sr=${signupRequestId}`),
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
