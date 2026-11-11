// Small pieces the campaign list and the campaign page both draw.
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { CampaignStats, CampaignStatus } from "@/lib/campaigns.functions";
import { SEND_BLOCKER_TEXT } from "@/lib/campaigns";
import { useMyRole } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import { DismissButton } from "@/components/DismissButton";

const STATUS_STYLES: Record<CampaignStatus, string> = {
  draft: "border-transparent bg-muted text-muted-foreground hover:bg-muted",
  sending:
    "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400 hover:bg-blue-500/15",
  sent: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15",
};

const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  sending: "Sending",
  sent: "Sent",
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <Badge variant="secondary" className={STATUS_STYLES[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

/** Shown wherever Send is, while the business has no postal address. Send is
 *  refused without one (the server and the database both check), so this is
 *  the page saying why before anybody presses it.
 *
 *  `dismissible` on the campaign LIST only (2026-10-03). An owner who does not
 *  run campaigns met this every time he opened the list, with no way to move
 *  it. In the editor it stays put, because that is where Send is and where the
 *  refusal would otherwise be a surprise. Once put away it stays away for 30
 *  days; adding the address removes it everywhere anyway. One version: the
 *  only state it reports is "no address". Rule in src/lib/dismissible.ts. */
export function NoAddressWarning({ dismissible = false }: { dismissible?: boolean }) {
  const { orgId } = useMyRole();
  const { dismissed, dismiss } = useDismissed(
    "campaigns-no-address",
    dismissible ? "no-address" : null,
    { orgId, snoozeDays: 30 },
  );
  if (dismissed) return null;
  return (
    <div
      role="alert"
      className={`flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200 ${
        dismissible ? "pe-1" : ""
      }`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">Campaigns can't be sent yet</p>
        <p>{SEND_BLOCKER_TEXT.no_address}</p>
        <Link
          to="/settings/client-portal"
          className="inline-block font-medium underline underline-offset-4"
        >
          Add your business address
        </Link>
      </div>
      {dismissible ? (
        <DismissButton
          onClick={dismiss}
          label="Hide the campaign address warning"
          className="-my-3 ms-auto"
        />
      ) : null}
    </div>
  );
}

/** One line of counts for the list. */
export function statsLine(s: CampaignStats | null): string {
  if (!s) return "";
  const f = (n: number) => n.toLocaleString();
  const parts = [`${f(s.sent)} sent`];
  const waiting = s.waiting + s.inQueue;
  if (waiting > 0) parts.push(`${f(waiting)} waiting`);
  if (s.failed > 0) parts.push(`${f(s.failed)} failed`);
  if (s.bounced > 0) parts.push(`${f(s.bounced)} bounced`);
  if (s.skipped > 0) parts.push(`${f(s.skipped)} not sent`);
  return parts.join(" · ");
}

/** The tiles on a sent campaign. Two across on a phone, three on a tablet,
 *  six on a desktop: a reflow, not a shrink. */
export function CampaignStatsGrid({ stats }: { stats: CampaignStats }) {
  const tiles: { label: string; value: number; hint: string }[] = [
    { label: "Recipients", value: stats.recipients, hint: "Clients this campaign was going to." },
    { label: "Sent", value: stats.sent, hint: "Accepted by the mail provider." },
    {
      label: "Waiting",
      value: stats.waiting + stats.inQueue,
      hint: "Not sent yet. Campaigns go out a batch a minute, after invoices and reminders.",
    },
    { label: "Failed", value: stats.failed, hint: "Tried and given up on." },
    { label: "Bounced", value: stats.bounced, hint: "Sent, then returned or marked as spam." },
    { label: "Not sent", value: stats.skipped, hint: "Left out when its turn came. See below." },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="min-w-0 rounded-lg border bg-card p-3">
          <dt className="text-xs font-medium text-muted-foreground">{t.label}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{t.value.toLocaleString()}</dd>
          {/* A <dd>, not a <p>: a <dl> group may hold only dt and dd, and a
              <p> in it made screen readers drop the hint (axe
              definition-list). Two dd's for one dt is valid. */}
          <dd className="text-xs text-muted-foreground">{t.hint}</dd>
        </div>
      ))}
    </dl>
  );
}
