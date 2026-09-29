import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";
import { CampaignEditor } from "@/components/campaigns/CampaignEditor";
import { listCampaigns } from "@/lib/campaigns.functions";

export const Route = createFileRoute("/_authenticated/campaigns/new")({
  head: () => ({ meta: [{ title: "New campaign · HoundStack" }] }),
  component: NewCampaignPage,
});

function NewCampaignPage() {
  // The list carries the business address, which decides whether Send can
  // work; it is usually already cached from the page this was opened from.
  const list = useServerFn(listCampaigns);
  const q = useQuery({ queryKey: ["campaigns"], queryFn: () => list() });
  return (
    <div className="space-y-5">
      <div className="min-w-0 space-y-1">
        <Link
          to="/campaigns"
          className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" /> Campaigns
        </Link>
        <h1 className="text-2xl font-semibold">New campaign</h1>
      </div>
      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      ) : (
        <CampaignEditor campaign={null} contactAddress={q.data?.contactAddress ?? null} />
      )}
    </div>
  );
}
