import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, ChevronLeft } from "lucide-react";
import { DirectoryShell } from "@/components/directory/DirectoryShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getDirectoryProfiles } from "@/lib/directory.functions";
import {
  DIRECTORY_NAME,
  directoryHead,
  directoryLineLabel,
  directoryQuoteBody,
  isDirectorySearchLine,
  type DirectoryProfile,
  type DirectoryQuoteForm,
  type DirectorySearchLine,
} from "@/lib/directory";
import { CALM_REFUSAL, ELAPSED_FIELD, HONEYPOT_FIELD } from "@/lib/public-form-guard";
import { appOrigin } from "@/lib/app-origin";
import { pageTitle } from "@/lib/page-title";

// Ask one directory business for a quote (#630, phase 1).
//
// Posts to /api/public/leads, the one way a lead gets in from outside, naming
// the business by its directory slug. The server resolves that only for a
// published profile, stores the lead as source = 'directory', runs the same
// honeypot, time-to-submit check and rate limit as every public form, merges
// a repeat from the same email within 24 hours, and tells the office. The
// visitor's details go to that business and nowhere else.

type Search = { line?: DirectorySearchLine };

export const Route = createFileRoute("/pros/$slug/quote")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    line: isDirectorySearchLine(s.line) ? s.line : undefined,
  }),
  loader: async ({ params }) => {
    let profile: DirectoryProfile | null;
    try {
      const r = await getDirectoryProfiles({ data: { slugs: [params.slug] } });
      profile = r.profiles[0] ?? null;
    } catch {
      return { profile: null as DirectoryProfile | null };
    }
    if (!profile) throw notFound();
    return { profile };
  },
  head: ({ loaderData, params }) => {
    const name = loaderData?.profile?.display_name;
    return directoryHead({
      title: pageTitle("Request a quote", name, DIRECTORY_NAME),
      description: "Ask a pet service business for a quote through HoundStack's directory.",
      path: `/pros/${encodeURIComponent(params.slug)}/quote`,
      origin: appOrigin(),
    });
  },
  component: QuotePage,
  notFoundComponent: QuoteNotListed,
});

const EMPTY: DirectoryQuoteForm = {
  name: "",
  email: "",
  phone: "",
  zip: "",
  service_line: "",
  dog_count: "",
  message: "",
};

function QuotePage() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const loaded = Route.useLoaderData();
  const fetchProfiles = useServerFn(getDirectoryProfiles);
  const q = useQuery({
    queryKey: ["directory-profile", slug],
    queryFn: () => fetchProfiles({ data: { slugs: [slug] } }).then((r) => r.profiles[0] ?? null),
    initialData: loaded.profile ?? undefined,
    staleTime: 60_000,
    retry: false,
  });

  const [form, setForm] = useState<DirectoryQuoteForm>(EMPTY);
  const [honeypot, setHoneypot] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const shownAt = useRef<number | null>(null);

  const p = q.data ?? null;
  useEffect(() => {
    if (p && shownAt.current == null) shownAt.current = Date.now();
  }, [p]);
  useEffect(() => {
    if (!p || form.service_line) return;
    const first =
      search.line && p.service_lines.includes(search.line) ? search.line : p.service_lines[0];
    if (first) setForm((f) => ({ ...f, service_line: first }));
  }, [p, search.line, form.service_line]);

  if (q.isLoading) {
    return (
      <DirectoryShell>
        <p className="text-muted-foreground" role="status">
          Loading…
        </p>
      </DirectoryShell>
    );
  }
  if (!p) return <QuoteNotListed />;

  const set = (k: keyof DirectoryQuoteForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const canSend =
    form.name.trim() !== "" && /\S+@\S+\.\S+/.test(form.email) && /^\d{5}$/.test(form.zip.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSend || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/public/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...directoryQuoteBody(slug, form),
          [HONEYPOT_FIELD]: honeypot,
          [ELAPSED_FIELD]: shownAt.current == null ? 0 : Date.now() - shownAt.current,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(
          res.status === 400 && body?.error === "Invalid input"
            ? "Please check your details and try again."
            : body?.error && res.status !== 500
              ? body.error
              : CALM_REFUSAL,
        );
        return;
      }
      setSent(true);
    } catch {
      setError(CALM_REFUSAL);
    } finally {
      setSending(false);
    }
  }

  return (
    <DirectoryShell>
      <div className="mx-auto max-w-2xl space-y-6">
        <Link
          to="/pros/$slug"
          params={{ slug: p.slug }}
          className="inline-flex min-h-11 max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
          <span className="shrink-0">Back to</span>
          <bdi className="block min-w-0 truncate">{p.display_name}</bdi>
        </Link>

        {sent ? (
          <div
            className="space-y-3 rounded-lg border bg-card p-6 text-center"
            data-directory-quote-sent
          >
            <CheckCircle2 className="mx-auto h-10 w-10 shrink-0 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-semibold break-words">
              Sent to <bdi>{p.display_name}</bdi>
            </h1>
            <p className="text-muted-foreground">
              They'll get back to you by email{form.phone.trim() ? " or phone" : ""}. Your details
              went to this business only.
            </p>
            <Button asChild variant="outline" className="min-h-11">
              <Link to="/pros">Back to the directory</Link>
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold tracking-tight break-words">
                Request a quote from <bdi>{p.display_name}</bdi>
              </h1>
              <p className="text-muted-foreground">
                Tell them what you need. Your details go to this business only.
              </p>
            </div>

            <form
              onSubmit={submit}
              className="relative grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 sm:p-6"
              noValidate
            >
              {/* The honeypot, as on /signup: invisible, out of the tab order
                  and the accessibility tree, zero-sized inside this relative
                  form so it cannot widen the page. */}
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

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="dq-line">Service</Label>
                <select
                  id="dq-line"
                  value={form.service_line}
                  onChange={(e) => set("service_line")(e.target.value)}
                  className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base sm:text-sm"
                >
                  {p.service_lines.map((l) => (
                    <option key={l} value={l}>
                      {directoryLineLabel(l)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dq-name">Your name *</Label>
                <Input
                  id="dq-name"
                  autoComplete="name"
                  className="h-11"
                  value={form.name}
                  onChange={(e) => set("name")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dq-email">Email *</Label>
                <Input
                  id="dq-email"
                  type="email"
                  autoComplete="email"
                  className="h-11"
                  value={form.email}
                  onChange={(e) => set("email")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dq-phone">Phone (optional)</Label>
                <Input
                  id="dq-phone"
                  type="tel"
                  autoComplete="tel"
                  className="h-11"
                  value={form.phone}
                  onChange={(e) => set("phone")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dq-zip">ZIP code *</Label>
                <Input
                  id="dq-zip"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  maxLength={5}
                  className="h-11"
                  value={form.zip}
                  onChange={(e) => set("zip")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dq-dogs">How many dogs?</Label>
                <Input
                  id="dq-dogs"
                  type="number"
                  min={0}
                  max={20}
                  inputMode="numeric"
                  className="h-11"
                  value={form.dog_count}
                  onChange={(e) => set("dog_count")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="dq-message">What do you need?</Label>
                <Textarea
                  id="dq-message"
                  rows={4}
                  maxLength={1500}
                  value={form.message}
                  onChange={(e) => set("message")(e.target.value)}
                  placeholder="When you'd like to start, how often, anything about your pets."
                />
              </div>
              {error ? (
                <p className="text-sm text-destructive sm:col-span-2" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button type="submit" className="min-h-11" disabled={!canSend || sending}>
                  {sending ? "Sending…" : "Send quote request"}
                </Button>
                <p className="min-w-0 text-xs text-muted-foreground">
                  The business may email or call you about this request. HoundStack won't text you.
                </p>
              </div>
            </form>
          </>
        )}
      </div>
    </DirectoryShell>
  );
}

function QuoteNotListed() {
  return (
    <DirectoryShell>
      <div className="space-y-3 py-12 text-center">
        <h1 className="text-2xl font-semibold">This business isn't listed</h1>
        <p className="text-muted-foreground">
          It may have left the directory, so it can't take a quote request here.
        </p>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/pros">Search the directory</Link>
        </Button>
      </div>
    </DirectoryShell>
  );
}
