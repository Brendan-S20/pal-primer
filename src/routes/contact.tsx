import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitLead } from "@/lib/leads.functions";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: `Contact — ${APP_NAME}` },
      {
        name: "description",
        content:
          "Request a demo or ask a question. We reply within one business day, usually much faster.",
      },
      { property: "og:title", content: `Contact — ${APP_NAME}` },
      { property: "og:description", content: "Request a demo of Scoop CRM." },
      { property: "og:url", content: "https://pal-primer.lovable.app/contact" },
    ],
    links: [{ rel: "canonical", href: "https://pal-primer.lovable.app/contact" }],
  }),
  component: ContactPage,
});

function ContactPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    company: "",
    location: "",
    dog_count: "",
    frequency: "",
    message: "",
  });
  const [done, setDone] = useState(false);
  const fn = useServerFn(submitLead);

  const mut = useMutation({
    mutationFn: (payload: typeof form) =>
      fn({
        data: {
          ...payload,
          dog_count: payload.dog_count ? Number(payload.dog_count) : undefined,
        },
      }),
    onSuccess: () => {
      setDone(true);
      toast.success("Thanks — we'll be in touch shortly.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) {
      toast.error("Name and email are required.");
      return;
    }
    mut.mutate(form);
  };

  return (
    <MarketingLayout>
      <section className="mx-auto grid max-w-6xl gap-12 px-6 pt-20 pb-24 lg:grid-cols-2">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Let's talk.</h1>
          <p className="mt-4 text-muted-foreground">
            Tell us about your route and we&rsquo;ll set up a short walkthrough. No pitch decks,
            no pressure — just a live tour of {APP_NAME} on your data.
          </p>
          <div className="mt-8 space-y-3 text-sm text-muted-foreground">
            <div>• 15-minute demo, screen-shared</div>
            <div>• We import your first 20 clients for free</div>
            <div>• Cancel anytime — your data is yours</div>
          </div>
        </div>
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          {done ? (
            <div className="py-10 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                ✓
              </div>
              <h2 className="mt-4 text-lg font-semibold">Message received</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                We&rsquo;ll get back to you within one business day.
              </p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    maxLength={120}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                    maxLength={255}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    maxLength={40}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="company">Company</Label>
                  <Input
                    id="company"
                    value={form.company}
                    onChange={(e) => setForm({ ...form, company: e.target.value })}
                    maxLength={120}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="location">City / service area</Label>
                  <Input
                    id="location"
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    maxLength={200}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dog_count">Active clients today</Label>
                  <Input
                    id="dog_count"
                    type="number"
                    min={0}
                    max={999}
                    value={form.dog_count}
                    onChange={(e) => setForm({ ...form, dog_count: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="message">What are you hoping to improve?</Label>
                <Textarea
                  id="message"
                  rows={4}
                  maxLength={2000}
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                />
              </div>
              <Button type="submit" disabled={mut.isPending} className="w-full">
                {mut.isPending ? "Sending…" : "Request demo"}
              </Button>
              <p className="text-xs text-muted-foreground">
                By submitting, you agree to be contacted about {APP_NAME}. We&rsquo;ll never
                share your info.
              </p>
            </form>
          )}
        </div>
      </section>
    </MarketingLayout>
  );
}
