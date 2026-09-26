// The signup machine: instant quote, details, card payment. ONE copy.
//
// This used to live inline in routes/signup.$slug.tsx, where only a prospect
// with the public link could reach it. Canvassing walk mode needs the same
// flow at somebody's front door: the tech taps "Sign up" and hands the phone
// over, and pressing that button must start a real signup rather than record
// a hope. Two surfaces, one machine — the pricing copy, the step gating and
// the payment handling drift the moment there are two copies, which is the
// standing failure this repo keeps writing tests about.
//
// `variant` changes LAYOUT only: "page" is the public two-column with the
// sticky quote aside, exactly as the route always rendered it; "sheet" stacks
// the same sections for a phone-width drawer. `onPaid` is the seam the two
// callers genuinely differ on — the public page navigates to the success
// screen, the walk-mode sheet stays put and marks the door.
import { appUrl } from "@/lib/app-origin";
import { PORTAL_FREQUENCY_VALUES, frequencyLabel } from "@/lib/frequency-request";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSignupQuote, createSignupPaymentIntent } from "@/lib/signup.functions";
import { stripeAppearance } from "@/lib/stripe-appearance";

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

// Canonical labels for the portal-selectable cadences (I3 shared map) — the
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

export function SignupFlow({
  slug,
  variant = "page",
  prefill,
  onPaid,
}: {
  slug: string;
  variant?: "page" | "sheet";
  prefill?: SignupPrefill;
  /** Called after the card is confirmed WITHOUT a redirect. When absent, the
   *  flow navigates to /signup/success, which is what the public page wants.
   *  A redirect-based payment method still leaves the page either way — the
   *  return_url lands on the success screen, so nothing is lost, only the
   *  caller's chance to react in place. */
  onPaid?: (signupRequestId: string) => void;
}) {
  const getQuote = useServerFn(getSignupQuote);
  const createIntent = useServerFn(createSignupPaymentIntent);

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
  });

  const quoteMut = useMutation({
    mutationFn: () =>
      getQuote({
        data: {
          slug,
          postal_code: form.postal_code,
          dog_count: Number(form.dog_count),
          frequency: form.frequency as any,
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
          name: form.name,
          email: form.email,
          phone: form.phone,
          street: form.street,
          city: form.city,
          region: form.region,
        },
      }),
    onSuccess: (r) => setIntent(r),
    onError: (e: Error) => toast.error(e.message),
  });

  const quote = quoteMut.data && quoteMut.data.available ? quoteMut.data.quote : null;

  const canQuote = form.postal_code.trim().length >= 3 && Number(form.dog_count) >= 1;

  const canCheckout = !!quote && form.name.trim() && form.email.trim() && form.street.trim();

  const serviceCard = (
    <div className="rounded-2xl border bg-card p-6">
      <h2 className="text-base font-semibold">1. Your service</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="postal_code">ZIP code</Label>
          <Input
            id="postal_code"
            inputMode="numeric"
            maxLength={12}
            value={form.postal_code}
            onChange={(e) => setFormField({ ...form, postal_code: e.target.value })}
            placeholder="e.g. 78704"
          />
        </div>
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
        <div className="space-y-1.5">
          <Label htmlFor="frequency">Frequency</Label>
          <Select value={form.frequency} onValueChange={(v) => setFormField({ ...form, frequency: v })}>
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
      </div>
      <div className="mt-4">
        <Button
          onClick={() => quoteMut.mutate()}
          disabled={!canQuote || quoteMut.isPending}
          variant="secondary"
        >
          {quoteMut.isPending ? "Pricing…" : "Get instant price"}
        </Button>
      </div>
      {quoteMut.data && !quoteMut.data.available ? (
        <p className="mt-3 text-sm text-destructive">We don't serve that ZIP yet. Check back soon.</p>
      ) : null}
    </div>
  );

  const detailsCard = (
    <div className="rounded-2xl border bg-card p-6">
      <h2 className="text-base font-semibold">2. Your details</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Full name *</Label>
          <Input
            id="name"
            value={form.name}
            onChange={(e) => setFormField({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email *</Label>
          <Input
            id="email"
            type="email"
            value={form.email}
            onChange={(e) => setFormField({ ...form, email: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            type="tel"
            value={form.phone}
            onChange={(e) => setFormField({ ...form, phone: e.target.value })}
          />
        </div>
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
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="street">Street address *</Label>
          <Input
            id="street"
            value={form.street}
            onChange={(e) => setFormField({ ...form, street: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            value={form.city}
            onChange={(e) => setFormField({ ...form, city: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="region">State</Label>
          <Input
            id="region"
            value={form.region}
            onChange={(e) => setFormField({ ...form, region: e.target.value })}
          />
        </div>
      </div>
    </div>
  );

  const quotePanel = (
    <aside
      className={
        variant === "page"
          ? "h-fit rounded-2xl border bg-card p-6 lg:sticky lg:top-24"
          : "rounded-2xl border bg-card p-6"
      }
    >
      <h2 className="text-base font-semibold">Your quote</h2>
      {!quote ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Enter your ZIP and dogs, then hit <em>Get instant price</em>.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {quote.zone_name}
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-sm">First cleanup (one-time)</div>
            <div className="font-medium">{money(quote.initial_cleanup_cents, quote.currency)}</div>
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-sm">Ongoing ({FREQ_LABELS[form.frequency]})</div>
            {/* PER VISIT, not per month. `public_quote` returns
                `round(base_visit_cents × frequency_multiplier)`, and
                pricing.ts documents it as "Per-visit price after the
                frequency multiplier" — the multipliers price LESS frequent
                visits HIGHER (weekly 1.0, biweekly 1.7, monthly 3.2), which
                only makes sense per visit. Every other surface says /visit;
                this one said /mo and the line below sold "a prepaid first
                month" for what buys ONE visit. Weekly service at $25 read
                "$25.00/mo". */}
            <div className="font-medium">{money(quote.recurring_price_cents, quote.currency)}/visit</div>
          </div>
          <div className="border-t pt-3 text-xs text-muted-foreground">
            Charged today:{" "}
            <strong className="text-foreground">
              {money(quote.initial_cleanup_cents + quote.recurring_price_cents, quote.currency)}
            </strong>
            , which covers your first cleanup plus your first scheduled visit. After that you are
            billed for visits as they happen. Cancel anytime.
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
            <Button
              className="w-full"
              disabled={!canCheckout || checkoutMut.isPending}
              onClick={() => checkoutMut.mutate()}
            >
              {checkoutMut.isPending ? "Preparing payment…" : "Continue to payment"}
            </Button>
          )}
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
    <div className="grid gap-10 lg:grid-cols-[1fr_360px]">
      <div className="space-y-8">
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
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing…
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
