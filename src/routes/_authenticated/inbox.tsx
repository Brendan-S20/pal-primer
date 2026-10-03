import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import {
  Bell,
  ChevronRight,
  ClipboardCheck,
  Inbox as InboxIcon,
  MessageCircleWarning,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";
import { canAccess, useMyRole } from "@/hooks/useMyRole";
import { listMessageThreads } from "@/lib/messages.functions";
import { listConcerns, CONCERN_CATEGORY_LABELS } from "@/lib/concerns.functions";
import { getReviewQueueCount } from "@/lib/review-queue.functions";
import { getDisputeQueue } from "@/lib/disputes.functions";
import { listMyNotifications } from "@/lib/notifications-center.functions";
import { formatDateTime } from "@/lib/format";
import { titleHead } from "@/lib/page-title";
import { threadsAwaitingReply } from "@/lib/inbox";

// ── ONE PLACE FOR EVERYTHING WAITING ON THE OFFICE ───────────────────────
//
// Texts from clients, concerns and re-clean requests, records the product
// refused to guess about, card disputes with a deadline, and alerts. They were
// five destinations in three sidebar groups (Operations, Insights, Billing)
// plus the bell, and an owner doing the evening round had to know to visit
// each one (launch pass, 2026-10, recommendation 12).
//
// This page does not replace any of them. Each section shows how many things
// are waiting and the first few, and every row and every heading goes to the
// page where the work is done. It reads the same server functions those pages
// do, under the same query keys, so a reply sent on Messages or a concern
// resolved on Concerns is reflected here without a second fetch, and nothing
// here can disagree with them.
//
// A section is drawn only for a role that can open its page (ROUTE_ROLES),
// which is also the role its server function answers, so no section is an
// error waiting to happen.

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => titleHead("Inbox"),
  component: InboxPage,
});

const PREVIEW = 4;

type Thread = {
  client_id: string;
  direction: string;
  body: string | null;
  created_at: string;
  clients?: { display_name?: string | null } | null;
};

function InboxPage() {
  const { role } = useMyRole();
  const can = (path: string) => canAccess(role, path);

  const threadsFn = useServerFn(listMessageThreads);
  const concernsFn = useServerFn(listConcerns);
  const reviewFn = useServerFn(getReviewQueueCount);
  const disputesFn = useServerFn(getDisputeQueue);
  const alertsFn = useServerFn(listMyNotifications);

  const threads = useQuery({
    queryKey: ["message-threads"],
    queryFn: () => threadsFn(),
    enabled: can("/messages"),
  });
  const concerns = useQuery({
    queryKey: ["concerns", "all"],
    queryFn: () => concernsFn({ data: { status: "all" } }),
    enabled: can("/concerns"),
  });
  const review = useQuery({
    queryKey: ["review-queue", "count"],
    queryFn: () => reviewFn(),
    enabled: can("/review"),
    retry: false,
  });
  const disputes = useQuery({
    queryKey: ["disputes"],
    queryFn: () => disputesFn(),
    enabled: can("/disputes"),
    retry: false,
  });
  const alerts = useQuery({ queryKey: ["notifications"], queryFn: () => alertsFn() });

  const waitingThreads = threadsAwaitingReply(
    ((threads.data as { threads?: Thread[] } | null | undefined)?.threads ?? []) as Thread[],
  );
  const openConcerns = (
    (concerns.data as { concerns?: Array<Record<string, any>> } | null | undefined)?.concerns ?? []
  ).filter((c) => c.status !== "resolved");
  const reviewCount = (review.data as { openCount?: number } | null | undefined)?.openCount ?? 0;
  const disputeTotals = (
    disputes.data as { totals?: { inquiryCount?: number; openCount?: number } } | null | undefined
  )?.totals;
  const disputeCount = (disputeTotals?.inquiryCount ?? 0) + (disputeTotals?.openCount ?? 0);
  const alertData = alerts.data as
    { notifications?: Array<Record<string, any>>; unread?: number } | null | undefined;
  const unreadAlerts = (alertData?.notifications ?? []).filter((n) => !n.read_at);

  const total =
    (can("/messages") ? waitingThreads.length : 0) +
    (can("/concerns") ? openConcerns.length : 0) +
    (can("/review") ? reviewCount : 0) +
    (can("/disputes") ? disputeCount : 0) +
    unreadAlerts.length;

  return (
    <>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <InboxIcon className="h-6 w-6 shrink-0" /> Inbox
        </h1>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "Nothing is waiting on you right now."
            : `${total} thing${total === 1 ? "" : "s"} waiting on you, from every part of the app.`}
        </p>
      </div>

      {can("/messages") && (
        <Section
          icon={<MessageSquare className="h-4 w-4 shrink-0" />}
          title="Texts waiting for a reply"
          count={waitingThreads.length}
          to="/messages"
          empty="Every conversation has had a reply."
        >
          {waitingThreads.slice(0, PREVIEW).map((t) => (
            <Row
              key={t.client_id}
              link={
                <Link
                  to="/messages/$clientId"
                  params={{ clientId: t.client_id }}
                  className="block min-w-0"
                />
              }
              title={t.clients?.display_name ?? "Unknown client"}
              detail={t.body ?? ""}
              when={t.created_at}
            />
          ))}
        </Section>
      )}

      {can("/concerns") && (
        <Section
          icon={<MessageCircleWarning className="h-4 w-4 shrink-0" />}
          title="Concerns and requests"
          count={openConcerns.length}
          to="/concerns"
          empty="No open concerns or re-clean requests."
        >
          {openConcerns.slice(0, PREVIEW).map((c) => (
            <Row
              key={String(c.id)}
              link={<Link to="/concerns" className="block min-w-0" />}
              title={`${c.clients?.display_name ?? "Unknown client"} · ${
                CONCERN_CATEGORY_LABELS[c.category as string] ?? "Concern"
              }`}
              detail={String(c.message ?? "")}
              when={String(c.created_at)}
            />
          ))}
        </Section>
      )}

      {can("/review") && (
        <Section
          icon={<ClipboardCheck className="h-4 w-4 shrink-0" />}
          title="Needs review"
          count={reviewCount}
          to="/review"
          empty="Nothing the app needs you to check."
          summary={
            reviewCount > 0
              ? `${reviewCount} record${reviewCount === 1 ? "" : "s"} the app would not guess about.`
              : undefined
          }
        />
      )}

      {can("/disputes") && (
        <Section
          icon={<ShieldAlert className="h-4 w-4 shrink-0" />}
          title="Card disputes"
          count={disputeCount}
          to="/disputes"
          empty="No disputes waiting for an answer."
          summary={
            disputeCount > 0
              ? `${disputeCount} dispute${disputeCount === 1 ? "" : "s"} with a bank waiting for your evidence.`
              : undefined
          }
        />
      )}

      <Section
        icon={<Bell className="h-4 w-4 shrink-0" />}
        title="Unread alerts"
        count={unreadAlerts.length}
        to="/notifications"
        empty="You're caught up on alerts."
      >
        {unreadAlerts.slice(0, PREVIEW).map((n) => (
          <Row
            key={String(n.id)}
            link={<Link to="/notifications" className="block min-w-0" />}
            title={String(n.title ?? "")}
            detail={String(n.body ?? "")}
            when={String(n.created_at)}
          />
        ))}
      </Section>
    </>
  );
}

function Section({
  icon,
  title,
  count,
  to,
  empty,
  summary,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  to: string;
  empty: string;
  summary?: string;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card" data-inbox-section={to}>
      <Link
        to={to}
        className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2 hover:bg-muted/40"
      >
        <span className="flex min-w-0 items-center gap-2 font-medium">
          {icon}
          <span className="truncate">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-sm">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
              count > 0 ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
            }`}
            data-inbox-count
          >
            {count}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </span>
      </Link>
      {count === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : summary ? (
        <p className="px-4 py-3 text-sm">{summary}</p>
      ) : (
        <ul className="divide-y">{children}</ul>
      )}
    </section>
  );
}

function Row({
  link,
  title,
  detail,
  when,
}: {
  /** The row's destination, as an empty <Link>; the row's text goes inside. */
  link: ReactElement<{ children?: ReactNode }>;
  title: string;
  detail: string;
  when: string;
}) {
  const body = (
    <span className="flex min-h-11 flex-col justify-center px-4 py-2">
      <span className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(when)}</span>
      </span>
      {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
  return <li className="min-w-0 hover:bg-muted/40">{cloneElement(link, undefined, body)}</li>;
}
