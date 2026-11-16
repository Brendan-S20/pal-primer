import { createFileRoute } from "@tanstack/react-router";
import { TextingNotLiveText, TextingStateBadge } from "@/components/TextingNotLive";
import { AiSection, ReviewPanel } from "@/components/ai/AiPanels";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  getReviewSettings,
  updateReviewSettings,
  getReferralStats,
} from "@/lib/reviews.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { titleHead } from "@/lib/page-title";
import { useClientTexting } from "@/hooks/useClientTexting";

export const Route = createFileRoute("/_authenticated/settings/reviews")({
  head: () => titleHead("Reviews & referrals", "Settings"),
  component: ReviewsSettings,
});

const DEFAULT_TEMPLATE =
  "Hi {name}, thanks for choosing us! If we did a great job, a quick review would mean the world: {link} Reply STOP to opt out.";

function ReviewsSettings() {
  const qc = useQueryClient();
  const settingsFn = useServerFn(getReviewSettings);
  const statsFn = useServerFn(getReferralStats);
  const saveFn = useServerFn(updateReviewSettings);
  // The ask goes by text when the business can text the client, by email
  // otherwise. The template is a draft until then, kept for when it can.
  const texting = useClientTexting();

  const { data, isLoading } = useQuery({
    queryKey: ["review-settings"],
    queryFn: () => settingsFn({}),
  });
  const { data: stats } = useQuery({
    queryKey: ["referral-stats"],
    queryFn: () => statsFn({}),
  });

  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [reward, setReward] = useState("20.00");
  const [template, setTemplate] = useState("");

  useEffect(() => {
    if (!data) return;
    setUrl(data.google_review_url ?? "");
    setEnabled(!!data.review_ask_enabled);
    setReward(((data.referral_reward_cents ?? 0) / 100).toFixed(2));
    setTemplate(data.review_ask_template ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          organizationId: data!.id,
          googleReviewUrl: url.trim() || null,
          reviewAskEnabled: enabled,
          referralRewardCents: Math.round(parseFloat(reward || "0") * 100),
          reviewAskTemplate: template.trim() || null,
        },
      }),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["review-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (!data) return <p>Set up your organization first.</p>;

  const preview = (template.trim() || DEFAULT_TEMPLATE)
    .replace(/\{name\}/g, "Alex")
    .replace(/\{link\}/g, url.trim() || "https://g.page/r/…/review");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Reviews & referrals</h2>
        <p className="text-sm text-muted-foreground">
          Ask happy clients for a Google review and reward those who refer new business.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Auto-ask for reviews</div>
            <div className="text-xs text-muted-foreground">
              {texting
                ? "Send the text below after a completed visit (once per client per 90 days). Clients who can't be texted get it by email."
                : // #930: says where it goes now, and nothing about setup: the
                  // template below carries the state (Under review, Setup
                  // needed...) and where to fix it, in the shared words.
                  "Send a review request after a completed visit (once per client per 90 days). It goes by email until texting is on for your business."}
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Google review URL</label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://g.page/r/…/review"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Find this in your Google Business profile → "Ask for reviews".
          </p>
        </div>

        <div>
          <label className="mb-1 flex flex-wrap items-center gap-2 text-sm font-medium">
            Text message template
            {!texting && <TextingStateBadge />}
          </label>
          {!texting && (
            <p className="mb-1 text-xs text-muted-foreground">
              <TextingNotLiveText tail="You can write the message now, ready for it." />
            </p>
          )}
          <Textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={DEFAULT_TEMPLATE}
            rows={4}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Use <code>{"{name}"}</code> and <code>{"{link}"}</code>. Leave blank for the default.
          </p>
          <div className="mt-2 rounded bg-muted p-2 text-xs">
            <span className="font-semibold">Preview:</span> {preview}
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="font-medium">Referral reward</h2>
        <p className="text-xs text-muted-foreground">
          When a new client redeems an existing client's referral code, both accounts receive this
          credit.
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm">$</span>
          <Input
            className="w-32"
            type="number"
            min="0"
            step="0.01"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">per successful referral</span>
        </div>
      </div>

      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        Save changes
      </Button>

      {/* Review-reply drafting lives with review settings (punch list #11). */}
      <AiSection title="Draft a review reply" description="Paste a public review, get a reply to start from.">
        <ReviewPanel />
      </AiSection>

      {stats && stats.top.length > 0 && (
        <div className="space-y-2 rounded-lg border bg-card p-4">
          <h2 className="font-medium">Top referrers</h2>
          <ul className="divide-y">
            {stats.top.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <span>{r.display_name}</span>
                <span className="font-mono text-muted-foreground">{r.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
