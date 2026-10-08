import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getSignupSettings, setSignupSettings } from "@/lib/signup.functions";
import { getLeadFormConfig, setLeadFormConfig } from "@/lib/leads.functions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { appOrigin } from "@/lib/app-origin";
import { titleHead } from "@/lib/page-title";
import { FORM_DEFAULTS, normalizeFormConfig, type FormFields } from "@/lib/new-customer-form";

// Signup & quote form: the settings for a business's ONE public form.
//
// There used to be two pages here for two public forms. Settings → Lead form
// configured /lead/{slug}, a "request a quote" form; Settings → Online signup
// configured /signup/{slug}, which priced the yard and took a card. The owner,
// 2026-10-08: "there's a ton of overlap here; it should essentially be slimmed
// down to one to avoid confusion." Now /signup/{slug} prices the yard and lets
// the visitor start service OR ask for a quote, /lead/{slug} forwards to it,
// and this page holds every option either page had:
//
//   from Online signup   the switch (organizations.public_signup_enabled),
//                        now meaning "offer Start service on the form", and
//                        the optional signup-specific web address
//   from Lead form       the link, the embed code, the brand colour and logo,
//                        the headline, intro and confirmation, which optional
//                        questions to ask, and the submission counts
//
// /settings/lead-form forwards here.
//
// ── WHY THE SWITCH NO LONGER CLOSES THE PAGE ──────────────────────────────
//
// public_signup_enabled used to decide whether /signup/{slug} existed at all:
// off, and the page said "This company isn't taking online signups right
// now." It now decides only whether the price and the card are on offer. Off,
// the same page is a quote request, which is what the lead form always was.
// An owner who only wants leads turns it off and loses nothing.
//
// ── WHAT THIS REPLACES, FROM THE ORIGINAL PAGE ────────────────────────────
//
// The whole /signup/{slug} flow (instant quote, inline card form, webhook
// provisioning, welcome email) was once in the product and unreachable, in a
// way no owner could have diagnosed. It was gated on two things, and neither
// had any UI: organizations.public_signup_enabled, and the address the link
// resolves on (slug / portal_slug). `bootstrap_organization` never wrote
// `organizations.slug`, so the old lookup compared NULL to everything and
// answered nothing. Migration 20260809001000 made the lookup resolve
// `portal_slug` as well, and this page is the other half: the switch, the
// optional address, and the resulting link shown as a link, because a feature
// whose URL you have to derive by hand is a feature nobody turns on.
export const Route = createFileRoute("/_authenticated/settings/online-signup")({
  head: () => titleHead("Signup & quote form", "Settings"),
  component: SignupAndQuoteFormSettings,
});

const APP_ORIGIN = appOrigin();

function SignupAndQuoteFormSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getSignupSettings);
  const setFn = useServerFn(setSignupSettings);
  const formFn = useServerFn(getLeadFormConfig);

  const q = useQuery({ queryKey: ["signup-settings"], queryFn: () => getFn() });
  const cfg = q.data;
  const formQ = useQuery({ queryKey: ["lead-form-config"], queryFn: () => formFn() });

  const [slug, setSlug] = useState("");
  useEffect(() => {
    setSlug(cfg?.signupSlug ?? "");
  }, [cfg?.signupSlug]);

  const save = useMutation({
    mutationFn: (patch: { publicSignupEnabled?: boolean; signupSlug?: string }) =>
      setFn({ data: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signup-settings"] });
      qc.invalidateQueries({ queryKey: ["lead-form-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // The address the RPC will actually answer on, computed the same way the
  // function resolves it: portal_slug wins, the signup-specific slug is the
  // fallback. Showing anything else here would hand out a link that 404s for
  // exactly the reason this whole page exists.
  const effective = cfg?.portalSlug || (slug.trim() ? slug.trim() : cfg?.signupSlug) || null;
  const publicUrl = effective ? `${APP_ORIGIN}/signup/${effective}` : null;
  const embed = publicUrl
    ? `<iframe src="${publicUrl}?embed=1" title="Get a quote" width="100%" height="1100" style="border:0;max-width:760px"></iframe>`
    : "";

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Couldn't copy"),
    );
  };

  const instantOn = !!cfg?.publicSignupEnabled;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Signup &amp; quote form</h2>
        <p className="text-sm text-muted-foreground">
          One page for new customers. They price their yard, then start service with a card or
          ask you for a quote. Every signup and every quote request lands in{" "}
          <Link to="/leads" className="text-primary underline">
            Leads
          </Link>
          .
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="public-signup" className="text-sm font-medium">
                  Accept signups online
                </Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  On: visitors in a zone you have priced see their price and can start service
                  with a card, or ask for a quote instead. Off: the form only takes quote
                  requests, and shows no prices.
                </p>
              </div>
              <Switch
                id="public-signup"
                checked={instantOn}
                disabled={save.isPending}
                onCheckedChange={(v) => {
                  save.mutate(
                    { publicSignupEnabled: v },
                    {
                      onSuccess: () =>
                        toast.success(v ? "Online signup is on" : "Online signup is off"),
                    },
                  );
                }}
              />
            </div>

            {/* Truthful preconditions, not scares. The switch is meaningless
                without an address for the link to resolve on, and with it on
                but no Stripe account that can take a charge, the form quietly
                stays a quote request (getPublicSignupForm), which the owner
                should hear from here rather than from a customer. */}
            {instantOn && !effective ? (
              <div className="mt-3 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900">
                Online signup is on, but you have no web address yet, so there's no link to give
                anyone. Set one below (or set your portal address in Settings → Client portal, and
                the form will use that).
              </div>
            ) : null}
            {instantOn && cfg?.stripeReady === false ? (
              <div className="mt-3 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900">
                Your Stripe account can't take payments yet, so the form is taking quote requests
                only for now.{" "}
                <Link to="/settings/payments" className="underline">
                  Finish Stripe setup
                </Link>{" "}
                and Start service appears on its own.
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">Your form link</h2>
            {publicUrl ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {/* One unbreakable token, wider than a phone, in a flex row
                      that cannot shrink it: `break-all` gives it somewhere to
                      break. */}
                  <code className="break-all rounded bg-muted px-2 py-1 text-xs">{publicUrl}</code>
                  <button
                    // MEASURED 2026-08-19: 16.0px. Inline-flex plus a minimum, not padding,
                    // so the surrounding line keeps its rhythm.
                    type="button"
                    className="inline-flex items-center text-xs text-primary underline touch:min-h-11"
                    onClick={() => copy(publicUrl, "Link")}
                  >
                    Copy link
                  </button>
                  <a
                    // MEASURED 2026-08-19: 16.0px. Inline-flex plus a minimum, not padding,
                    // so the surrounding line keeps its rhythm.
                    className="inline-flex items-center text-xs text-primary underline touch:min-h-11"
                    href={publicUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview
                  </a>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Put this on your website, in your Google listing, and in your voicemail greeting.
                  It shows your logo and brand colour, not ours. Old lead form links keep working
                  and open this form.
                  {cfg?.portalSlug && cfg?.signupSlug && cfg.portalSlug !== cfg.signupSlug ? (
                    <>
                      {" "}
                      <span className="text-foreground">
                        /signup/{cfg.signupSlug} works too, and both addresses reach you.
                      </span>
                    </>
                  ) : null}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Set a web address below and your link will appear here.
              </p>
            )}
          </div>

          {publicUrl ? (
            <div className="rounded-lg border bg-card p-4">
              <h2 className="mb-2 text-sm font-medium">Embed on your website</h2>
              <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
                <code>{embed}</code>
              </pre>
              <button
                type="button"
                className="mt-2 inline-flex items-center text-xs text-primary underline touch:min-h-11"
                onClick={() => copy(embed, "Embed code")}
              >
                Copy embed code
              </button>
            </div>
          ) : null}

          <form
            className="space-y-3 rounded-lg border bg-card p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(
                { signupSlug: slug.trim() },
                { onSuccess: () => toast.success("Web address saved") },
              );
            }}
          >
            <h2 className="text-sm font-medium">Web address</h2>
            <div className="flex flex-wrap items-center gap-1 text-sm">
              <span className="min-w-0 break-all text-muted-foreground">
                {APP_ORIGIN.replace(/^https?:\/\//, "")}/signup/
              </span>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                className="h-8 w-48 max-w-full"
                placeholder={cfg?.portalSlug ?? "your-company"}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={save.isPending || slug.trim() === (cfg?.signupSlug ?? "")}
              >
                {save.isPending ? "Saving…" : "Save address"}
              </Button>
            </div>
            {/* Blank is a real answer, and for most tenants it is the right
                one. Since the lookup resolves portal_slug too, a business that
                has already set its portal address has a working link without
                touching this field, and having one address instead of two is
                less to explain to a customer. */}
            <p className="text-xs text-muted-foreground">
              Letters, numbers and hyphens only. Leave it empty to use your portal address
              {cfg?.portalSlug ? ` (${cfg.portalSlug})` : ""}. The form accepts either.
            </p>
          </form>

          {formQ.data ? (
            <>
              <FormCustomizer config={formQ.data.config} instantOn={instantOn} />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border bg-card p-4">
                  <div className="text-xs uppercase text-muted-foreground">
                    Submissions (all time)
                  </div>
                  <div className="mt-1 text-2xl font-semibold">{formQ.data.submissionsTotal}</div>
                </div>
                <div className="rounded-lg border bg-card p-4">
                  <div className="text-xs uppercase text-muted-foreground">Last 30 days</div>
                  <div className="mt-1 text-2xl font-semibold">{formQ.data.submissionsLast30}</div>
                </div>
              </div>
            </>
          ) : formQ.error ? (
            <p className="text-sm text-destructive">{(formQ.error as Error).message}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

const OPTIONAL_FIELDS: { key: keyof FormFields; label: string; pricedAlways?: boolean }[] = [
  { key: "phone", label: "Phone" },
  { key: "location", label: "ZIP and address", pricedAlways: true },
  { key: "dogCount", label: "Number of dogs", pricedAlways: true },
  { key: "message", label: "Notes (gate code, dog names)" },
];

function FormCustomizer({ config: raw, instantOn }: { config: unknown; instantOn: boolean }) {
  const qc = useQueryClient();
  const saveFn = useServerFn(setLeadFormConfig);
  const [headline, setHeadline] = useState("");
  const [intro, setIntro] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [fields, setFields] = useState<FormFields>({
    phone: true,
    location: true,
    dogCount: true,
    message: true,
  });

  // The fixture and a business that never saved the form both send null;
  // normalizeFormConfig is the one reading of it the public page uses too.
  useEffect(() => {
    const c = normalizeFormConfig(raw);
    setHeadline(c.headline);
    setIntro(c.intro);
    setConfirmation(c.confirmation);
    setBrandColor(c.brandColor ?? "");
    setLogoUrl(c.logoUrl ?? "");
    setFields(c.fields);
  }, [raw]);

  const defaults = instantOn ? FORM_DEFAULTS.instant : FORM_DEFAULTS.quoteOnly;

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          headline: headline.trim() || undefined,
          intro: intro.trim() || undefined,
          confirmation: confirmation.trim() || undefined,
          brandColor: brandColor.trim() || "",
          logoUrl: logoUrl.trim() || "",
          fields,
        },
      }),
    onSuccess: () => {
      toast.success("Form updated");
      qc.invalidateQueries({ queryKey: ["lead-form-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="space-y-4 rounded-lg border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="text-sm font-medium">Customize the form</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <Label htmlFor="form-brand-color" className="text-xs">
            Brand color
          </Label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick a brand color"
              value={brandColor || "#2563eb"}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-9 w-12 shrink-0 rounded border touch:h-11 touch:w-14"
            />
            <Input
              id="form-brand-color"
              className="min-w-0"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              placeholder="#2563eb"
            />
          </div>
        </div>
        <div className="min-w-0">
          <Label htmlFor="form-logo" className="text-xs">
            Logo URL
          </Label>
          <Input
            id="form-logo"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…/logo.png"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Leave these empty to use the logo and colour from Settings → Client portal.
      </p>

      <div>
        <Label htmlFor="form-headline" className="text-xs">
          Headline
        </Label>
        <Input
          id="form-headline"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder={defaults.headline}
        />
      </div>
      <div>
        <Label htmlFor="form-intro" className="text-xs">
          Intro text
        </Label>
        <Input
          id="form-intro"
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          placeholder={defaults.intro}
        />
      </div>
      <div>
        <Label htmlFor="form-confirmation" className="text-xs">
          Message after a quote request
        </Label>
        <Input
          id="form-confirmation"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={FORM_DEFAULTS.confirmation}
        />
      </div>

      <div>
        <div className="text-xs font-medium">Questions to ask</div>
        <p className="text-xs text-muted-foreground">
          Name and email are always asked.
          {instantOn
            ? " With online signup on, ZIP, address and dogs are always asked too, because the price is made of them."
            : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {OPTIONAL_FIELDS.map((f) => {
            const forced = instantOn && !!f.pricedAlways;
            return (
              <div key={f.key} className="flex min-h-9 items-center gap-2 touch:min-h-11">
                <Checkbox
                  id={`form-field-${f.key}`}
                  checked={forced || fields[f.key]}
                  disabled={forced}
                  onCheckedChange={(v) => setFields((prev) => ({ ...prev, [f.key]: v === true }))}
                />
                <Label htmlFor={`form-field-${f.key}`} className="text-sm font-normal">
                  {f.label}
                </Label>
              </div>
            );
          })}
        </div>
      </div>

      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save form"}
      </Button>
    </form>
  );
}
