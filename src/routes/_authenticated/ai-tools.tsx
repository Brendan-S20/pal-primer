import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  MarketingPanel,
  ReviewPanel,
  ChurnPanel,
  DigestPanel,
  DispatchPanel,
  PricingPanel,
} from "@/components/ai/AiPanels";

// Punch list #11: AI tools now live inside their workflows (Reviews settings,
// Clients, Routes, Zones, Dashboard) instead of a standalone destination —
// this route stays for bookmarks and the command palette, and as the one
// place to see every tool together.
export const Route = createFileRoute("/_authenticated/ai-tools")({
  component: AiToolsPage,
  head: () => ({
    meta: [{ title: "AI tools" }],
  }),
});

type Tab = "marketing" | "reviews" | "churn" | "digest" | "dispatch" | "pricing";

function AiToolsPage() {
  const [tab, setTab] = useState<Tab>("marketing");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">AI tools</h1>
        <p className="text-sm text-muted-foreground">
          These tools also live where the work happens — review replies in Settings → Reviews, churn on
          Clients, dispatch on Routes, zone pricing on Zones, and the digest on your Dashboard. Configure
          API keys in <Link to="/settings/ai" className="underline">Settings → AI</Link>.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 border-b text-sm">
        {(
          [
            ["marketing", "Marketing content"],
            ["reviews", "Review replies"],
            ["churn", "Churn risk"],
            ["digest", "Weekly digest"],
            ["dispatch", "AI dispatch"],
            ["pricing", "Zone pricing"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 ${
              tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "marketing" && <MarketingPanel />}
      {tab === "reviews" && <ReviewPanel />}
      {tab === "churn" && <ChurnPanel />}
      {tab === "digest" && <DigestPanel />}
      {tab === "dispatch" && <DispatchPanel />}
      {tab === "pricing" && <PricingPanel />}
    </div>
  );
}
