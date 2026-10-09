import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getLeadFormConfig, setLeadFormConfig } from "@/lib/leads.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { appOrigin } from "@/lib/app-origin";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/settings/lead-form")({
  head: () => titleHead("Lead form", "Settings"),
  component: LeadFormSettings,
});

const APP_ORIGIN = appOrigin();

function LeadFormSettings() {
  const cfgFn = useServerFn(getLeadFormConfig);
  const q = useQuery({ queryKey: ["lead-form-config"], queryFn: () => cfgFn() });
  const cfg = q.data as any;

  const slug = cfg?.slug;
  const hostedUrl = slug ? `${APP_ORIGIN}/lead/${slug}` : null;
  const embed = slug
    ? `<iframe src="${hostedUrl}" title="Request a quote" width="100%" height="620" style="border:0;max-width:480px"></iframe>`
    : "";

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Couldn't copy"),
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Lead capture form</h2>
        <p className="text-sm text-muted-foreground">
          Put a "Request a quote" form on your own website. Submissions land in Leads.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !slug ? (
        <div className="rounded-lg border bg-card p-4 text-sm">
          Set your portal address first (Settings → Client portal). The lead form uses the same
          short web address.
        </div>
      ) : (
        <>
          {/* This used to be an amber warning saying the hosted form "won't
              accept submissions" while public signup was off, and that has been
              untrue since 20260711120000. Lead capture was DELIBERATELY
              decoupled from the signup gate in that migration —
              `public_get_org_for_lead_form` does not look at
              public_signup_enabled at all, and `/api/public/leads` resolves the
              org through it — precisely because collecting a name is not the
              same decision as taking a card.

              The cost of leaving it was not cosmetic. It told owners their
              working lead form was broken and pointed them at a switch that
              would not have fixed it, so the rational response was to stop
              using the form, or to turn on public signup for a reason that was
              never real. What replaces it says the true thing and offers the
              upsell the old warning was clumsily reaching for. */}
          {!cfg.publicSignupEnabled && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              This form collects leads whether or not you take signups online. The two are
              independent. If you'd also like homeowners to price their yard and pay without
              calling, turn on{" "}
              <Link to="/settings/online-signup" className="text-primary underline">
                online signup
              </Link>
              .
            </div>
          )}

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">Hosted form link</h2>
            <div className="flex flex-wrap items-center gap-2">
              {/* A URL has no space to wrap at, so its min-content width is the
                  whole address, and a flex item is never laid out narrower than
                  that. With a slug like sunset-ridge-property-care this line is
                  wider than a phone and takes the card and the page with it.
                  `break-all` is what the referral link and the platform invite
                  link already do with theirs. */}
              <code className="break-all rounded bg-muted px-2 py-1 text-xs">{hostedUrl}</code>
              {/* 16px tall until 2026-09-28, and never measured: with no
                  fixture for the lead-form config the sweep saw this card
                  without a link in it. */}
              <button type="button" className="inline-flex items-center text-xs text-primary underline touch:min-h-11" onClick={() => copy(hostedUrl!, "Link")}>Copy link</button>
              <a className="inline-flex items-center text-xs text-primary underline touch:min-h-11" href={hostedUrl!} target="_blank" rel="noreferrer">Preview</a>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Share this link directly, or embed the form below.</p>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">Embed on your website</h2>
            <pre className="overflow-x-auto rounded bg-muted p-3 text-xs"><code>{embed}</code></pre>
            <button type="button" className="mt-2 inline-flex items-center text-xs text-primary underline touch:min-h-11" onClick={() => copy(embed, "Embed code")}>Copy embed code</button>
          </div>

          <LeadFormCustomizer config={cfg.config} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">Submissions (all time)</div>
              <div className="mt-1 text-2xl font-semibold">{cfg.submissionsTotal}</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">Last 30 days</div>
              <div className="mt-1 text-2xl font-semibold">{cfg.submissionsLast30}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const OPTIONAL_FIELDS = [
  { key: "phone", label: "Phone" },
  { key: "location", label: "Service address / ZIP" },
  { key: "dogCount", label: "Number of dogs" },
  { key: "message", label: "Message / notes" },
] as const;

function LeadFormCustomizer({ config }: { config: any }) {
  const qc = useQueryClient();
  const saveFn = useServerFn(setLeadFormConfig);
  const [headline, setHeadline] = useState("");
  const [intro, setIntro] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [fields, setFields] = useState({ phone: true, location: true, dogCount: true, message: true });

  useEffect(() => {
    if (!config) return;
    setHeadline(config.headline ?? "");
    setIntro(config.intro ?? "");
    setConfirmation(config.confirmation ?? "");
    setBrandColor(config.brandColor ?? "");
    setLogoUrl(config.logoUrl ?? "");
    setFields({
      phone: config.fields?.phone !== false,
      location: config.fields?.location !== false,
      dogCount: config.fields?.dogCount !== false,
      message: config.fields?.message !== false,
    });
  }, [config]);

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
    onSuccess: () => { toast.success("Lead form updated"); qc.invalidateQueries({ queryKey: ["lead-form-config"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="space-y-4 rounded-lg border bg-card p-4"
      onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
    >
      <h2 className="text-sm font-medium">Customize the form</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="text-xs">Brand color</Label>
          <div className="mt-1 flex items-center gap-2">
            <input type="color" value={brandColor || "#2563eb"} onChange={(e) => setBrandColor(e.target.value)} className="h-9 w-12 rounded border touch:h-11 touch:w-14" />
            <Input value={brandColor} onChange={(e) => setBrandColor(e.target.value)} placeholder="#2563eb" />
          </div>
        </div>
        <div>
          <Label className="text-xs">Logo URL</Label>
          <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.png" />
        </div>
      </div>

      <div>
        <Label className="text-xs">Headline</Label>
        <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Request a quote" />
      </div>
      <div>
        <Label className="text-xs">Intro text</Label>
        <Input value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="Tell us about your property and pets and we'll get you a quote." />
      </div>
      <div>
        <Label className="text-xs">Confirmation message</Label>
        <Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="Thanks, we got your request!" />
      </div>

      <div>
        <Label className="text-xs">Fields to collect</Label>
        <p className="text-xs text-muted-foreground">Name and email are always required.</p>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          {OPTIONAL_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={(fields as any)[f.key]}
                onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.checked }))}
              />
              {f.label}
            </label>
          ))}
        </div>
      </div>

      <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save form"}</Button>
    </form>
  );
}
