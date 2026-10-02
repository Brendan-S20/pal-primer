import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import {
  getAiUsage,
  getOrgAiSettings,
  setAiHardCapMultiplier,
  testOrgAiKey,
} from "@/lib/ai-settings.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AI_FEATURES } from "@/lib/ai-usage";

// IMP-9: this page used to ask the customer for an Anthropic or OpenAI API key
// and tell them "You're billed by them directly." BYOK is retired — AI runs on
// HoundStack's key and the tenant buys an allowance with overages (Q-7) — so the
// page no longer asks for something we don't want and never used. No org had
// ever entered a key.
//
// BUILD-2 added the usage meter this page used to say it did not have. The
// numbers come from `ai_usage_state` — the SAME function the request path
// enforces against — because a settings page that computes "you have allowance
// left" its own way will eventually say so while the product refuses the next
// call.

export const Route = createFileRoute("/_authenticated/settings/ai")({
  component: AiSettings,
});

function AiSettings() {
  const getFn = useServerFn(getOrgAiSettings);
  const testFn = useServerFn(testOrgAiKey);

  const q = useQuery({ queryKey: ["org-ai-settings"], queryFn: () => getFn() });

  const testMut = useMutation({
    mutationFn: () => testFn(),
    onSuccess: (r) => {
      if (r?.ok) toast.success(`AI is responding · ${r.model}`);
      else toast.error(r?.error ?? "AI check failed");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">AI usage</h2>
        <p className="text-sm text-muted-foreground">
          The AI features (marketing content, review replies, churn scoring, AI dispatch, and zone
          pricing) run on HoundStack&apos;s own models. There is no key to set up and no separate
          provider bill; your plan includes an AI allowance, and any usage beyond it appears on your
          HoundStack invoice.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4 text-sm">
            {q.data && !q.data.planAllowsAi ? (
              // BUILD-7: checked FIRST. This page used to read availability
              // from environment variables alone, so an organization whose plan
              // does not include AI was told "AI is enabled for this
              // organization" — and, if they pressed the check, that it was a
              // HoundStack configuration issue and to contact support. Support
              // cannot change someone's plan for them, and nothing on the page
              // hinted that the plan was the point.
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <div className="font-medium">AI isn&apos;t included on your plan</div>
                  <div className="text-xs text-muted-foreground">
                    {q.data.planReason ?? "AI features need a paid plan."}
                  </div>
                </div>
              </div>
            ) : q.data?.toolsAvailable && q.data?.assistantAvailable ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <div className="font-medium">AI is enabled for this organization</div>
                    <div className="text-xs text-muted-foreground">Model: {q.data.model}</div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => testMut.mutate()}
                  disabled={testMut.isPending}
                >
                  {testMut.isPending ? "Checking…" : "Run a check"}
                </Button>
              </div>
            ) : (
              // An operator problem, worded as one. Telling a tenant to fix this
              // would send them looking for a setting that no longer exists.
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">
                    {q.data?.toolsAvailable || q.data?.assistantAvailable
                      ? "Some AI features are unavailable"
                      : "AI is temporarily unavailable"}
                  </div>
                  <div className="text-xs">
                    {/* Named specifically. "AI is down" when only half of it is
                        down sends someone looking in the wrong place. */}
                    {!q.data?.toolsAvailable && !q.data?.assistantAvailable
                      ? "No AI features will run until this is resolved."
                      : !q.data?.toolsAvailable
                        ? "Marketing content, review replies, churn scoring, AI dispatch, and zone pricing are unavailable. The receptionist and business advisor are unaffected."
                        : "The AI receptionist and the business advisor are unavailable. The AI tools are unaffected."}{" "}
                    This is a HoundStack configuration issue, not something in your account. Please
                    contact support.
                  </div>
                </div>
              </div>
            )}
          </div>

          <AiUsageMeter />
        </>
      )}
    </div>
  );
}

/** Human labels for the feature slugs stored on every usage row. A raw
 *  `dispatch_suggestion` on a billing screen is the kind of detail that makes
 *  an owner call support to ask what it is. */
const FEATURE_LABELS: Record<(typeof AI_FEATURES)[number], string> = {
  marketing_content: "Marketing content",
  review_reply: "Review replies",
  churn_scoring: "Churn scoring",
  weekly_digest: "Weekly digest (dashboard)",
  weekly_digest_email: "Weekly digest email",
  business_advisor: "Business advisor",
  dispatch_suggestion: "AI dispatch",
  zone_pricing: "Zone pricing",
  ai_receptionist: "AI receptionist",
  connection_test: "Connection tests (not charged)",
};

function AiUsageMeter() {
  const qc = useQueryClient();
  const usageFn = useServerFn(getAiUsage);
  const capFn = useServerFn(setAiHardCapMultiplier);
  const [draft, setDraft] = useState<string>("");

  const u = useQuery({ queryKey: ["ai-usage"], queryFn: () => usageFn() });

  const capMut = useMutation({
    mutationFn: (multiplier: number) => capFn({ data: { multiplier } }),
    onSuccess: () => {
      toast.success("Ceiling updated.");
      setDraft("");
      qc.invalidateQueries({ queryKey: ["ai-usage"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (u.isLoading) return <p className="text-xs text-muted-foreground">Loading usage…</p>;
  if (!u.data?.available) {
    // Honest about the gap rather than rendering a zero, which is the rule this
    // page followed before the meter existed and still follows.
    return (
      <p className="text-xs text-muted-foreground">
        Usage for this organization could not be read just now.
      </p>
    );
  }

  const d = u.data;
  const unlimited = d.actionsIncluded == null;
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((d.actionsUsed / (d.actionsIncluded || 1)) * 100));
  const rate = d.overageCentsPerAction;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">AI usage this month</h2>
        <span className="text-xs text-muted-foreground">{d.periodMonth.slice(0, 7)}</span>
      </div>

      <div>
        <div className="flex items-baseline justify-between text-sm">
          <span>
            <span className="font-medium">{d.actionsUsed.toLocaleString()}</span>
            {unlimited ? " actions" : ` of ${d.actionsIncluded?.toLocaleString()} included`}
          </span>
          {d.overageCents > 0 && (
            <span className="text-amber-700 dark:text-amber-500">
              ${(d.overageCents / 100).toFixed(2)} overage so far
            </span>
          )}
        </div>
        {!unlimited && (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={
                d.overHardCap
                  ? "h-full bg-red-600"
                  : d.overAllowance
                    ? "h-full bg-amber-500"
                    : "h-full bg-primary"
              }
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>

      {d.overHardCap && (
        <div className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs dark:border-red-500/40 dark:bg-red-950/30">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div>
            <span className="font-medium">AI is paused for the rest of this month.</span> You have
            used {d.actionsUsed.toLocaleString()} actions against a ceiling of{" "}
            {d.hardCapActions?.toLocaleString()}. Raise the ceiling below, or it resets at the start
            of next month.
          </div>
        </div>
      )}

      {!unlimited && rate != null && (
        <p className="text-xs text-muted-foreground">
          Actions past {d.actionsIncluded?.toLocaleString()} are ${(rate / 100).toFixed(2)} each and
          appear on your next invoice as a single line for the month. One action is one AI request:
          a receptionist conversation counts once however many replies it takes.
        </p>
      )}

      {d.breakdown.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">What used it</p>
          {d.breakdown.map((b) => (
            <div key={b.feature} className="flex justify-between text-xs text-muted-foreground">
              <span>{FEATURE_LABELS[b.feature as (typeof AI_FEATURES)[number]] ?? b.feature}</span>
              <span>{b.actions.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {!unlimited && (
        <div className="space-y-1 border-t pt-3">
          <label className="text-xs font-medium" htmlFor="ai-cap">
            Stop AI at
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="ai-cap"
              type="number"
              min={1}
              max={100}
              step={0.5}
              className="w-24"
              value={draft || String(d.hardCapMultiplier)}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              × your allowance ({d.hardCapActions?.toLocaleString()} actions)
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={capMut.isPending || !draft || Number(draft) === d.hardCapMultiplier}
              onClick={() => capMut.mutate(Number(draft))}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A safety stop, not a budget. Below the ceiling nothing is blocked, and usage past your
            allowance is simply billed. Cannot be set below 1×, which would pause AI you have
            already paid for.
          </p>
        </div>
      )}
    </div>
  );
}
