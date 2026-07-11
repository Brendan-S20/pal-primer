import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getPublicLeadForm } from "@/lib/leads.functions";

// Public, embeddable lead-capture form for a tenant (finding #25). Hosted at
// /lead/{slug}; also embeddable via an <iframe> (see Settings → Lead form).
// Branding + which optional fields to collect are configured per tenant.
export const Route = createFileRoute("/lead/$slug")({
  ssr: false,
  head: () => ({ meta: [{ title: "Request a quote" }, { name: "robots", content: "noindex" }] }),
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
        throw new Error((b as any).error || "Something went wrong — please try again.");
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
      <div className="mx-auto max-w-md p-6 text-center">
        {cfg?.logoUrl ? <img src={cfg.logoUrl} alt={orgName ?? ""} className="mx-auto mb-4 h-12 object-contain" /> : null}
        <h1 className="text-xl font-semibold" style={accent ? { color: accent } : undefined}>Thanks — we got your request!</h1>
        <p className="mt-2 text-sm text-muted-foreground">{cfg?.confirmation}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md p-6">
      {cfg?.logoUrl ? <img src={cfg.logoUrl} alt={orgName ?? ""} className="mb-4 h-12 object-contain" /> : null}
      <h1 className="text-xl font-semibold" style={accent ? { color: accent } : undefined}>{cfg?.headline ?? "Request a quote"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{cfg?.intro}</p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input required placeholder="Your name" value={form.name} onChange={set("name")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        <input required type="email" placeholder="Email" value={form.email} onChange={set("email")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        {fields.phone && <input placeholder="Phone" value={form.phone} onChange={set("phone")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />}
        {fields.location && <input placeholder="Service address or ZIP" value={form.location} onChange={set("location")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />}
        {fields.dogCount && <input type="number" min={0} placeholder="How many dogs?" value={form.dog_count} onChange={set("dog_count")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />}
        {fields.message && <textarea placeholder="Anything else we should know?" value={form.message} onChange={set("message")} rows={3} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          style={accent ? { backgroundColor: accent } : undefined}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? "Sending…" : "Request a quote"}
        </button>
      </form>
    </div>
  );
}
