// Campaigns: one email to many clients, written by the owner. What a campaign
// is and who it may reach is src/lib/campaigns.ts; how it goes out is
// src/lib/campaigns.server.ts.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Megaphone, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CampaignStatusBadge,
  NoAddressWarning,
  statsLine,
} from "@/components/campaigns/CampaignParts";
import { listCampaigns } from "@/lib/campaigns.functions";
import { formatDateTime } from "@/lib/format";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/campaigns/")({
  head: () => ({ meta: [{ title: pageTitle("Campaigns") }] }),
  component: CampaignsPage,
});

function CampaignsPage() {
  const list = useServerFn(listCampaigns);
  const q = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => list(),
    // A campaign that is sending changes every minute; nothing else does.
    refetchInterval: (query) =>
      query.state.data?.campaigns.some((c) => c.status === "sending") ? 30_000 : false,
  });
  const campaigns = q.data?.campaigns ?? [];
  const tz = q.data?.timezone ?? undefined;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Campaigns</h1>
          <p className="text-sm text-muted-foreground">
            One email to many clients: a seasonal offer, a new service area, a holiday schedule.
          </p>
        </div>
        <Button asChild>
          <Link to="/campaigns/new">
            <Plus className="mr-1 h-4 w-4 shrink-0" /> New campaign
          </Link>
        </Button>
      </div>

      {q.data && !q.data.contactAddress && <NoAddressWarning dismissible />}

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          <Megaphone className="mx-auto mb-2 h-6 w-6 shrink-0" />
          No campaigns yet. Write one to tell your clients about a spring clean-up, a new area or a
          change to your schedule.
        </div>
      ) : (
        <ul className="space-y-2">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link
                to="/campaigns/$campaignId"
                params={{ campaignId: c.id }}
                className="flex flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CampaignStatusBadge status={c.status} />
                    <span className="text-xs text-muted-foreground">{c.audienceLabel}</span>
                  </div>
                  <p className="break-words font-medium">{c.subject || "(no subject yet)"}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.sentAt
                      ? `Sent ${formatDateTime(c.sentAt, tz)}`
                      : `Edited ${formatDateTime(c.updatedAt, tz)}`}
                  </p>
                </div>
                {c.status !== "draft" && c.stats && (
                  <p className="text-sm tabular-nums text-muted-foreground sm:max-w-[45%] sm:text-right">
                    {statsLine(c.stats)}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
