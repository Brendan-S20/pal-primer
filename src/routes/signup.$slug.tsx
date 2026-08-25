import { appUrl } from "@/lib/app-origin";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { PORTAL_FREQUENCY_VALUES, frequencyLabel } from "@/lib/frequency-request";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Loader2 } from "lucide-react";
import { TenantSignupShell } from "@/components/marketing/TenantSignupShell";
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
import { getSignupOrg, getSignupQuote, createSignupPaymentIntent } from "@/lib/signup.functions";
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

export const Route = createFileRoute("/signup/$slug")({
  head: () => ({
    meta: [
      { title: "Get an instant quote" },
      {
        name: "description",
        content:
          "Enter your ZIP, number of dogs, and cleanup frequency to get an instant price and sign up online.",
      },
    ],
  }),
  component: SignupPage,
});

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

function SignupPage() {
  const { slug } = useParams({ from: "/signup/$slug" });
  const getOrg = useServerFn(getSignupOrg);
  const getQuote = useServerFn(getSignupQuote);
  const createIntent = useServerFn(createSignupPaymentIntent);

  const orgQ = useQuery({
    queryKey: ["signup-org", slug],
    queryFn: () => getOrg({ data: { slug } }),
    retry: false,
  });

  const [form, setForm] = useState({
    postal_code: "",
    dog_count: "1",
    frequency: "weekly",
    name: "",
    email: "",
    phone: "",
    street: "",
    city: "",
    region: "",
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

  // Before the lookup resolves there is no tenant to be branded as, so these
  // two states carry no branding at all rather than borrowing ours. The
  // unavailable state in particular used to sit under a HoundStack header —
  // the one page a prospect reaches when a tenant's link is wrong, wearing the
  // name of a company they have never heard of.
  if (orgQ.isLoading) {
    return (
      <TenantSignupShell orgName={null}>
        <div className="mx-auto max-w-2xl px-6 py-24 text-center text-muted-foreground">
          Loading…
        </div>
      </TenantSignupShell>
    );
  }

  if (orgQ.error || !orgQ.data) {
    return (
      <TenantSignupShell orgName={null}>
        <div className="mx-auto max-w-2xl px-6 py-24 text-center">
          <h1 className="text-2xl font-semibold">Signup unavailable</h1>
          <p className="mt-3 text-muted-foreground">
            This company isn't taking online signups right now.
          </p>
        </div>
      </TenantSignupShell>
    );
  }

  const org = orgQ.data;
  const quote = quoteMut.data && quoteMut.data.available ? quoteMut.data.quote : null;

  const canQuote = form.postal_code.trim().length >= 3 && Number(form.dog_count) >= 1;

  const canCheckout = !!quote && form.name.trim() && form.email.trim() && form.street.trim();

  return (
    <TenantSignupShell orgName={org.name} logoUrl={org.logo_url} brandColor={org.brand_color}>
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-24">
        <div className="mb-8">
          <div className="text-sm text-muted-foreground">{org.name}</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Get an instant quote
          </h1>
          <p className="mt-2 text-muted-foreground">
            Tell us about your yard and we'll price it in seconds. No calls, no forms to wait on.
          </p>
        </div>

        <div className="grid gap-10 lg:grid-cols-[1fr_360px]">
          <div className="space-y-8">
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
                <p className="mt-3 text-sm text-destructive">
                  We don't serve that ZIP yet. Check back soon.
                </p>
              ) : null}
            </div>

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
                    This route is public — the person filling it in has no
                    Supabase session — and all three address server functions
                    sit behind `requireSupabaseAuth` (address.functions.ts), so
                    the control would render here and fail on every keystroke.
                    The fix is not to drop the middleware: `autocompleteAddress`
                    proxies a metered Google API and its rate limit is keyed on
                    `context.userId`, so an anonymous version of it is an open
                    door to somebody else's bill. A safe public path needs its
                    own server function, gated on the tenant slug in the URL,
                    rate-limited per IP + slug rather than per user, and biased
                    from the tenant's zones rather than from resolveCaller.
                    That is a piece of work, not a wiring change, and nobody
                    should start it before a provider is chosen. */}
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
          </div>

          <aside className="h-fit rounded-2xl border bg-card p-6 lg:sticky lg:top-24">
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
                  <div className="font-medium">
                    {money(quote.initial_cleanup_cents, quote.currency)}
                  </div>
                </div>
                <div className="flex items-baseline justify-between">
                  <div className="text-sm">Ongoing ({FREQ_LABELS[form.frequency]})</div>
                  {/* PER VISIT, not per month. `public_quote` returns
                      `round(base_visit_cents × frequency_multiplier)`, and
                      pricing.ts documents it as "Per-visit price after the
                      frequency multiplier" — the multipliers price LESS frequent
                      visits HIGHER (weekly 1.0, biweekly 1.7, monthly 3.2),
                      which only makes sense per visit. Every other surface says
                      /visit; this one said /mo and the line below sold "a
                      prepaid first month" for what buys ONE visit. Weekly
                      service at $25 read "$25.00/mo". */}
                  <div className="font-medium">
                    {money(quote.recurring_price_cents, quote.currency)}/visit
                  </div>
                </div>
                <div className="border-t pt-3 text-xs text-muted-foreground">
                  Charged today:{" "}
                  <strong className="text-foreground">
                    {money(
                      quote.initial_cleanup_cents + quote.recurring_price_cents,
                      quote.currency,
                    )}
                  </strong>
                  , which covers your first cleanup plus your first scheduled visit. After that you
                  are billed for visits as they happen. Cancel anytime.
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
                      slug={slug}
                      signupRequestId={intent.signupRequestId}
                      amountCents={intent.amountCents}
                      currency={intent.currency}
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
        </div>
      </section>
    </TenantSignupShell>
  );
}

// Inline card form for the signup prepay: confirms the PaymentIntent on this
// page and hands off to the success page, which polls provisioning status.
function SignupPayForm({
  slug,
  signupRequestId,
  amountCents,
  currency,
}: {
  slug: string;
  signupRequestId: string;
  amountCents: number;
  currency: string;
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

    window.location.assign(`/signup/success?sr=${signupRequestId}`);
  }

  void slug;

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
