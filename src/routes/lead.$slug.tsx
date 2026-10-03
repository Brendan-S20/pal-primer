import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getPublicLeadForm } from "@/lib/leads.functions";
import { customerTitle } from "@/lib/page-title";

// Public, embeddable lead-capture form for a tenant (finding #25). Hosted at
// /lead/{slug}; also embeddable via an <iframe> (see Settings → Lead form).
// Branding + which optional fields to collect are configured per tenant.
export const Route = createFileRoute("/lead/$slug")({
  ssr: false,
  head: () => ({ meta: [{ title: customerTitle("Request a quote") }, { name: "robots", content: "noindex" }] }),
  component: LeadForm,
});

function LeadForm() {
  const { slug } = Route.useParams();
  const cfgFn = useServerFn(getPublicLeadForm);
  const cfgQ = useQuery({ queryKey: ["public-lead-form", slug], queryFn: () => cfgFn({ data: { slug } }), retry: false });
  const cfg = (cfgQ.data as any)?.config;
  const orgName = (cfgQ.data as any)?.orgName as string | null;

  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ name: "", email: "", phone: "", location: "", dog_count: "", message: "" });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/public/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name: form.name,
          email: form.email,
          phone: form.phone,
          location: form.location,
          dog_count: form.dog_count ? Number(form.dog_count) : undefined,
          message: form.message,
          source: "website",
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as any).error || "Something went wrong. Please try again.");
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const accent = cfg?.brandColor || undefined;
  const fields = cfg?.fields ?? { phone: true, location: true, dogCount: true, message: true };

  if (cfgQ.isLoading) {
    return <div className="mx-auto max-w-md p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (cfgQ.error) {
    return <div className="mx-auto max-w-md p-6 text-sm text-destructive">This form isn't available.</div>;
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-md p-4 sm:p-6">
        <div className="overflow-hidden rounded-2xl border bg-card text-center shadow-lg">
          <div className="h-1.5 w-full" style={{ backgroundColor: accent ?? "var(--primary)" }} />
          <div className="p-8">
            {cfg?.logoUrl ? <img src={cfg.logoUrl} alt={orgName ?? ""} className="mx-auto mb-4 h-12 object-contain" /> : null}
            <div
              className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-2xl text-white"
              style={{ backgroundColor: accent ?? "var(--primary)" }}
            >
              ✓
            </div>
            <h1 className="text-xl font-semibold" style={accent ? { color: accent } : undefined}>Thanks, we got your request!</h1>
            <p className="mt-2 text-sm text-muted-foreground">{cfg?.confirmation}</p>
          </div>
        </div>
      </div>
    );
  }

  // Multi-step layout: contact first (the part every business needs), then
  // service details, per-tenant fields controlled by the same config toggles.
  const hasStep2 = fields.phone || fields.location || fields.dogCount || fields.message;
  const steps = hasStep2 ? 2 : 1;
  const onLastStep = step >= steps;
  const step1Valid = form.name.trim().length > 0 && /.+@.+\..+/.test(form.email);

  const inputCls =
    "w-full rounded-lg border bg-background px-3.5 py-2.5 text-sm shadow-sm outline-none transition focus:ring-2 focus:ring-offset-0";

  return (
    <div className="mx-auto max-w-md p-4 sm:p-6">
      <div className="overflow-hidden rounded-2xl border bg-card shadow-lg">
        <div
          className="h-1.5 w-full"
          style={{ backgroundColor: accent ?? "var(--primary)" }}
        />
        <div className="p-6 sm:p-8">
          <div className="flex items-center gap-3">
            {cfg?.logoUrl ? (
              <img src={cfg.logoUrl} alt={orgName ?? ""} className="h-10 w-10 rounded-lg object-contain" />
            ) : null}
            <div>
              {orgName && <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{orgName}</div>}
              <h1 className="text-xl font-semibold leading-tight" style={accent ? { color: accent } : undefined}>
                {cfg?.headline ?? "Request a quote"}
              </h1>
            </div>
          </div>
          {cfg?.intro && <p className="mt-2 text-sm text-muted-foreground">{cfg.intro}</p>}

          {steps > 1 && (
            <div className="mt-5 flex items-center gap-2">
              {Array.from({ length: steps }).map((_, i) => (
                <div key={i} className="flex flex-1 items-center gap-2">
                  <div
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold ${
                      step > i + 1 ? "text-white" : step === i + 1 ? "text-white" : "bg-muted text-muted-foreground"
                    }`}
                    style={step >= i + 1 ? { backgroundColor: accent ?? "var(--primary)" } : undefined}
                  >
                    {i + 1}
                  </div>
                  <span className={`text-xs ${step === i + 1 ? "font-medium" : "text-muted-foreground"}`}>
                    {i === 0 ? "About you" : "Your service"}
                  </span>
                  {i < steps - 1 && <div className="h-px flex-1 bg-border" />}
                </div>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              if (!onLastStep) {
                e.preventDefault();
                if (step1Valid) setStep(step + 1);
                return;
              }
              submit(e);
            }}
            className="mt-5 space-y-3"
          >
            {step === 1 && (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Your name</span>
                  <input required placeholder="Jane Doe" value={form.name} onChange={set("name")} className={inputCls} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Email</span>
                  <input required type="email" placeholder="jane@example.com" value={form.email} onChange={set("email")} className={inputCls} />
                </label>
                {fields.phone && step === 1 && steps === 1 && (
                  <input placeholder="Phone" value={form.phone} onChange={set("phone")} className={inputCls} />
                )}
              </>
            )}

            {step === 2 && (
              <>
                {fields.phone && (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">Phone <span className="font-normal text-muted-foreground">(optional)</span></span>
                    <input placeholder="(555) 123-4567" value={form.phone} onChange={set("phone")} className={inputCls} />
                  </label>
                )}
                {/* Plain input on purpose — same reason as signup.$slug.tsx:
                    the lead form is public and address.functions.ts requires a
                    staff session. An unauthenticated proxy to a paid
                    autocomplete API, on a page whose whole job is to be linked
                    from adverts, is an abuse vector with somebody else's card
                    behind it. Also note the field takes "78701" as readily as
                    a street — half the leads that arrive here are a ZIP. */}
                {fields.location && (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">Service address or ZIP</span>
                    <input placeholder="78701" value={form.location} onChange={set("location")} className={inputCls} />
                  </label>
                )}
                {fields.dogCount && (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">How many dogs?</span>
                    <input type="number" min={0} placeholder="2" value={form.dog_count} onChange={set("dog_count")} className={inputCls} />
                  </label>
                )}
                {fields.message && (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">Anything else? <span className="font-normal text-muted-foreground">(optional)</span></span>
                    <textarea placeholder="Gate code, dog names, preferred days…" value={form.message} onChange={set("message")} rows={3} className={inputCls} />
                  </label>
                )}
              </>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center gap-2 pt-1">
              {step > 1 && (
                <button
                  type="button"
                  onClick={() => setStep(step - 1)}
                  className="rounded-lg border px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  Back
                </button>
              )}
              <button
                type="submit"
                disabled={busy || (step === 1 && !step1Valid)}
                style={accent ? { backgroundColor: accent } : undefined}
                className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition disabled:opacity-50"
              >
                {busy ? "Sending…" : onLastStep ? "Request a quote" : "Continue"}
              </button>
            </div>
            <p className="pt-1 text-center text-2xs text-muted-foreground">
              We'll only use this to follow up about your quote.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
