import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getMyReferralProgram } from "@/lib/referrals.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Check, Copy, Gift, Share2 } from "lucide-react";
import { toast } from "sonner";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/_authenticated/settings/referrals")({
  component: ReferBusinessPage,
});

function money(cents: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

// Mirrors the client portal's "Refer a neighbor" pattern (short code + Share +
// Copy), lifted to the tenant level: refer another pet-service business to
// HoundStack, earn a % of their first payment once they're a paying customer.
function ReferBusinessPage() {
  const fn = useServerFn(getMyReferralProgram);
  const { data, isLoading, error } = useQuery({
    queryKey: ["my-referral-program"],
    queryFn: () => fn(),
  });
  const [copied, setCopied] = useState(false);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return null;

  const link = `${window.location.origin}/sign-up?ref=${data.code}`;

  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    toast.success("Referral link copied");
    setTimeout(() => setCopied(false), 2000);
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Try ${APP_NAME}`,
          text: `We run our pet-waste business on ${APP_NAME}. Sign up with my link:`,
          url: link,
        });
      } catch {
        // user cancelled the share sheet
      }
    } else {
      copy();
    }
  };

  const statusBadge = (r: MyReferralRow) => {
    if (r.status === "paid")
      return <Badge className="bg-emerald-600 text-white">Reward paid</Badge>;
    if (r.status === "rejected") return <Badge variant="outline">Not eligible</Badge>;
    if (r.status === "converted") {
      const eligible = r.eligible_at && new Date(r.eligible_at) <= new Date();
      return eligible ? (
        <Badge className="bg-blue-600 text-white">Reward on its way</Badge>
      ) : (
        <Badge className="bg-blue-600/80 text-white">Subscribed, reward pending</Badge>
      );
    }
    return <Badge variant="secondary">Signed up</Badge>;
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Refer a business</h2>
        <p className="text-sm text-muted-foreground">
          Know another pet-service business that could use {APP_NAME}? Share your link. When they
          become a paying customer, you earn{" "}
          <strong>{data.rewardPercent}% of their first payment</strong>, paid out to you in cash
          after they've been active {data.holdingDays} days.
        </p>
      </div>

      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Gift className="h-4 w-4 text-primary" /> Your referral link
        </div>
        <div className="rounded-md border bg-muted/40 p-3 font-mono text-sm break-all">{link}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={copy}>
            {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button size="sm" variant="outline" onClick={share}>
            <Share2 className="mr-1 h-4 w-4" /> Share
          </Button>
          <span className="text-xs text-muted-foreground">
            Code: <span className="font-mono font-medium">{data.code}</span>
          </span>
        </div>
      </Card>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Your referrals</h3>
        {!data.referrals.length ? (
          <div className="rounded-lg border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
            No referrals yet. Share your link to get started.
          </div>
        ) : (
          <div className="relative overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Business</th>
                  <th className="px-4 py-2 font-medium">Signed up</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Reward</th>
                </tr>
              </thead>
              <tbody>
                {data.referrals.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-4 py-2">{r.referred_org_name}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {new Date(r.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">{statusBadge(r)}</td>
                    <td className="px-4 py-2">
                      {r.status === "converted" || r.status === "paid"
                        ? money(r.reward_cents)
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Rewards are confirmed after the referred business stays active and paid for{" "}
        {data.holdingDays} days, then paid out directly by the {APP_NAME} team. Self-referrals don't
        qualify.
      </p>
    </div>
  );
}

type MyReferralRow = {
  id: string;
  referred_org_name: string;
  status: string;
  flagged: boolean;
  reward_cents: number | null;
  eligible_at: string | null;
  paid_at: string | null;
  created_at: string;
};
