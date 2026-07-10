import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

// Public, embeddable lead-capture form for a tenant (finding #25). Hosted at
// /lead/{slug}; also embeddable via an <iframe> (see Settings → Lead form).
// Posts to the public /api/public/leads endpoint, which routes the lead to the
// business by slug. No auth — this is a marketing intake form.
export const Route = createFileRoute("/lead/$slug")({
  ssr: false,
  head: () => ({ meta: [{ title: "Request a quote" }, { name: "robots", content: "noindex" }] }),
  component: LeadForm,
});

function LeadForm() {
  const { slug } = Route.useParams();
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

  if (sent) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-xl font-semibold">Thanks — we got your request!</h1>
        <p className="mt-2 text-sm text-muted-foreground">We'll be in touch shortly to set up your service.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md p-6">
      <h1 className="text-xl font-semibold">Request a quote</h1>
      <p className="mt-1 text-sm text-muted-foreground">Tell us about your yard and we'll get you a quote.</p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input required placeholder="Your name" value={form.name} onChange={set("name")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        <input required type="email" placeholder="Email" value={form.email} onChange={set("email")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        <input placeholder="Phone" value={form.phone} onChange={set("phone")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        <input placeholder="Service address or ZIP" value={form.location} onChange={set("location")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        <input type="number" min={0} placeholder="How many dogs?" value={form.dog_count} onChange={set("dog_count")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        <textarea placeholder="Anything else we should know?" value={form.message} onChange={set("message")} rows={3} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button type="submit" disabled={busy} className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? "Sending…" : "Request a quote"}
        </button>
      </form>
    </div>
  );
}
