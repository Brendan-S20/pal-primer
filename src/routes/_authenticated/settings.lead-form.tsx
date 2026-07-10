import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLeadFormConfig } from "@/lib/leads.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/lead-form")({
  component: LeadFormSettings,
});

const APP_ORIGIN = "https://www.app.houndstack.com";

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
        <h1 className="text-xl font-semibold">Lead capture form</h1>
        <p className="text-sm text-muted-foreground">
          Put a "Request a quote" form on your own website. Submissions land in Leads.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !slug ? (
        <div className="rounded-lg border bg-card p-4 text-sm">
          Set your portal address first (Settings → Client portal branding) — the lead form uses the
          same short web address.
        </div>
      ) : (
        <>
          {!cfg.publicSignupEnabled && (
            <div className="rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900">
              Public intake is currently off, so the hosted form won't accept submissions. Turn on
              public signup/intake for <strong>{cfg.orgName}</strong> to start collecting leads.
            </div>
          )}

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">Hosted form link</h2>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-xs">{hostedUrl}</code>
              <button className="text-xs text-primary underline" onClick={() => copy(hostedUrl!, "Link")}>Copy link</button>
              <a className="text-xs text-primary underline" href={hostedUrl!} target="_blank" rel="noreferrer">Preview</a>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Share this link directly, or embed the form below.</p>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">Embed on your website</h2>
            <pre className="overflow-x-auto rounded bg-muted p-3 text-xs"><code>{embed}</code></pre>
            <button className="mt-2 text-xs text-primary underline" onClick={() => copy(embed, "Embed code")}>Copy embed code</button>
          </div>

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
