import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
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
import {
  getSignupOrg,
  getSignupQuote,
  createSignupCheckout,
} from "@/lib/signup.functions";

export const Route = createFileRoute("/signup/$slug")({
  head: () => ({
    meta: [
      { title: "Get an instant quote" },
      {
        name: "description",
        content: "Enter your ZIP, number of dogs, and cleanup frequency to get an instant price and sign up online.",
      },
    ],
  }),
  component: SignupPage,
});

const FREQ_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every other week",
  twice_weekly: "Twice per week",
  monthly: "Once per month",
};

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
  const checkout = useServerFn(createSignupCheckout);

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

  const checkoutMut = useMutation({
    mutationFn: () =>
      checkout({
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
          origin: window.location.origin,
        },
      }),
    onSuccess: (r) => {
      if (r.url) window.location.href = r.url;
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (orgQ.isLoading) {
    return (
      <MarketingLayout>
        <div className="mx-auto max-w-2xl px-6 py-24 text-center text-muted-foreground">
          Loading…
        </div>
      </MarketingLayout>
    );
  }

  if (orgQ.error || !orgQ.data) {
    return (
      <MarketingLayout>
        <div className="mx-auto max-w-2xl px-6 py-24 text-center">
          <h1 className="text-2xl font-semibold">Signup unavailable</h1>
          <p className="mt-3 text-muted-foreground">
            This company isn't taking online signups right now.
          </p>
        </div>
      </MarketingLayout>
    );
  }

  const org = orgQ.data;
  const quote =
    quoteMut.data && quoteMut.data.available ? quoteMut.data.quote : null;

  const canQuote =
    form.postal_code.trim().length >= 3 && Number(form.dog_count) >= 1;

  const canCheckout =
    !!quote &&
    form.name.trim() &&
    form.email.trim() &&
    form.street.trim();

  return (
    <MarketingLayout>
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
                    onChange={(e) =>
                      setForm({ ...form, postal_code: e.target.value })
                    }
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
                    onChange={(e) =>
                      setForm({ ...form, dog_count: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="frequency">Frequency</Label>
                  <Select
                    value={form.frequency}
                    onValueChange={(v) => setForm({ ...form, frequency: v })}
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
                  We don't serve that ZIP yet — check back soon.
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
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="street">Street address *</Label>
                  <Input
                    id="street"
                    value={form.street}
                    onChange={(e) => setForm({ ...form, street: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="region">State</Label>
                  <Input
                    id="region"
                    value={form.region}
                    onChange={(e) => setForm({ ...form, region: e.target.value })}
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
                  <div className="text-sm">
                    Ongoing ({FREQ_LABELS[form.frequency]})
                  </div>
                  <div className="font-medium">
                    {money(quote.recurring_price_cents, quote.currency)}/mo
                  </div>
                </div>
                <div className="border-t pt-3 text-xs text-muted-foreground">
                  Charged today: <strong className="text-foreground">
                    {money(quote.initial_cleanup_cents + quote.recurring_price_cents, quote.currency)}
                  </strong> — covers your first cleanup plus a prepaid first month. Cancel anytime.
                </div>
                <Button
                  className="w-full"
                  disabled={!canCheckout || checkoutMut.isPending}
                  onClick={() => checkoutMut.mutate()}
                >
                  {checkoutMut.isPending ? "Redirecting…" : "Continue to secure checkout"}
                </Button>
              </div>
            )}
          </aside>
        </div>
      </section>
    </MarketingLayout>
  );
}
