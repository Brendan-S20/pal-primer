// One campaign. A draft opens in the editor; one that has gone is a record:
// what was sent, to whom, and what happened to it.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";
import { CampaignEditor } from "@/components/campaigns/CampaignEditor";
import { CampaignStatsGrid, CampaignStatusBadge } from "@/components/campaigns/CampaignParts";
import { getCampaign, previewCampaignEmail } from "@/lib/campaigns.functions";
import { SKIP_REASON_TEXT } from "@/lib/campaigns";
import { formatDateTime } from "@/lib/format";
import { pageTitle, useDocumentTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/campaigns/$campaignId")({
  head: () => ({ meta: [{ title: pageTitle("Campaign") }] }),
  component: CampaignPage,
});

function CampaignPage() {
  const { campaignId } = Route.useParams();
  const getFn = useServerFn(getCampaign);
  const q = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => getFn({ data: { id: campaignId } }),
    refetchInterval: (query) => (query.state.data?.campaign.status === "sending" ? 30_000 : false),
  });
  const c = q.data?.campaign;
  useDocumentTitle(c ? pageTitle(c.subject || "Untitled campaign", "Campaigns") : null);

  return (
    <>
      <div className="min-w-0 space-y-1">
        <Link
          to="/campaigns"
          className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" /> Campaigns
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 break-words text-2xl font-semibold">
            {c ? c.subject || "Untitled campaign" : "Campaign"}
          </h1>
          {c && <CampaignStatusBadge status={c.status} />}
        </div>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      ) : !c ? null : c.status === "draft" ? (
        <CampaignEditor key={c.id} campaign={c} contactAddress={q.data?.contactAddress ?? null} />
      ) : (
        <SentCampaign data={q.data!} />
      )}
    </>
  );
}

function SentCampaign({ data }: { data: NonNullable<Awaited<ReturnType<typeof getCampaign>>> }) {
  const c = data.campaign;
  const tz = data.timezone ?? undefined;
  const previewFn = useServerFn(previewCampaignEmail);
  const preview = useQuery({
    queryKey: ["campaign-preview", c.id],
    queryFn: () =>
      previewFn({
        data: {
          content: {
            subject: c.subject,
            heading: c.heading,
            body: c.body,
            buttonLabel: c.buttonLabel,
            buttonUrl: c.buttonUrl,
          },
        },
      }),
    staleTime: Infinity,
  });
  const reasons = Object.entries(data.skipReasons).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        To {c.audienceLabel.toLowerCase()}. Sent {formatDateTime(c.sentAt, tz)}
        {c.completedAt ? `, all of it on its way by ${formatDateTime(c.completedAt, tz)}` : ""}.
      </p>

      {c.stats ? (
        <CampaignStatsGrid stats={c.stats} />
      ) : (
        <p className="text-sm text-muted-foreground">No delivery information yet.</p>
      )}

      {c.status === "sending" && (
        <p className="text-sm text-muted-foreground">
          Still going out. Campaigns send a batch a minute, after invoices and reminders, so they
          never hold those up. This page refreshes itself.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        "Sent" means your mail provider accepted the email. Whether it then reached the inbox is not
        tracked; bounces and spam reports are, and show under Bounced.
      </p>

      {reasons.length > 0 && (
        <section
          aria-labelledby="campaign-not-sent"
          className="space-y-2 rounded-lg border bg-card p-4"
        >
          <h2 id="campaign-not-sent" className="font-semibold">
            Why some were not sent
          </h2>
          <ul className="space-y-1 text-sm">
            {reasons.map(([reason, n]) => (
              <li key={reason} className="flex justify-between gap-3">
                <span className="min-w-0">{SKIP_REASON_TEXT[reason] ?? reason}</span>
                <span className="shrink-0 tabular-nums">{n}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Each client is checked again when their email's turn comes, so anyone who unsubscribed
            after you pressed Send was not sent it.
          </p>
        </section>
      )}

      <section
        aria-labelledby="campaign-sent-email"
        className="space-y-3 rounded-lg border bg-card p-4"
      >
        <h2 id="campaign-sent-email" className="font-semibold">
          The email
        </h2>
        {preview.data ? (
          <iframe
            title="The email that was sent"
            sandbox=""
            srcDoc={preview.data.html}
            className="h-[560px] w-full rounded-md border bg-white"
          />
        ) : preview.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {(preview.error as Error).message}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </section>
    </div>
  );
}
