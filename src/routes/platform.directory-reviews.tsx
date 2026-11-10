import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import {
  listDirectoryReviewQueue,
  moderateDirectoryReview,
} from "@/lib/directory-reviews.functions";
import {
  REVIEW_REJECTION_LABEL,
  REVIEW_REJECTION_REASONS,
  REVIEW_STATUSES,
  type QueuedDirectoryReview,
  type ReviewRejectionReason,
  type ReviewStatus,
} from "@/lib/directory-reviews";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { titleHead } from "@/lib/page-title";
import { formatDateTime } from "@/lib/format";

// The directory's review moderation queue (#630). Brendan, 2026-11-09:
// "a review is never public until a moderator approves it", and Brendan is
// the only moderator for now, so this lives in the platform console, which
// only a platform admin reaches. The server function and the database both
// ask again (is_platform_admin) before showing or changing anything.
//
// A rejection must name one of the written rules applied to every review.
// None of them is about the rating.

export const Route = createFileRoute("/platform/directory-reviews")({
  head: () => titleHead("Directory reviews", "Platform admin"),
  component: DirectoryReviewsPage,
});

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
};

function DirectoryReviewsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listDirectoryReviewQueue);
  const moderateFn = useServerFn(moderateDirectoryReview);
  const [status, setStatus] = useState<ReviewStatus>("pending");

  const q = useQuery({
    queryKey: ["platform", "directory-reviews", status],
    queryFn: () => listFn({ data: { status } }),
  });

  const moderate = useMutation({
    mutationFn: (v: { id: string; approve: boolean; reason?: ReviewRejectionReason }) =>
      moderateFn({ data: { id: v.id, approve: v.approve, reason: v.reason ?? null } }),
    onSuccess: (_r, v) => {
      toast.success(v.approve ? "Approved: the review is public" : "Rejected: it will not show");
      qc.invalidateQueries({ queryKey: ["platform", "directory-reviews"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const rows = q.data?.reviews ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Directory reviews</h1>
          <p className="text-sm text-muted-foreground">
            No review is public until it is approved here. Reject only under a written rule, never
            because of the rating.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show reviews">
          {REVIEW_STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? "default" : "outline"}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
            >
              {STATUS_LABEL[s]}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{STATUS_LABEL[status]}</CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading reviews...</div>
          ) : q.isError ? (
            <div className="text-sm text-destructive">{(q.error as Error).message}</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">Nothing here.</div>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <ReviewRow
                  key={r.id}
                  review={r}
                  busy={moderate.isPending}
                  onApprove={() => moderate.mutate({ id: r.id, approve: true })}
                  onReject={(reason) => moderate.mutate({ id: r.id, approve: false, reason })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewRow({
  review: r,
  busy,
  onApprove,
  onReject,
}: {
  review: QueuedDirectoryReview;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: ReviewRejectionReason) => void;
}) {
  const [reason, setReason] = useState<ReviewRejectionReason | "">("");
  return (
    <li className="space-y-3 py-4 text-sm" data-directory-review>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-words">{r.business_name}</span>
        <Badge variant="outline">{r.rating} of 5</Badge>
        {r.rejection_reason ? (
          <Badge variant="destructive">{REVIEW_REJECTION_LABEL[r.rejection_reason]}</Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {formatDateTime(r.updated_at)}
          {r.created_at !== r.updated_at ? " (edited)" : ""}
          {r.moderated_at && r.moderated_by
            ? ` · decided ${formatDateTime(r.moderated_at)} by moderator ${r.moderated_by.slice(0, 8)}`
            : ""}
        </span>
      </div>
      <p className="max-w-3xl whitespace-pre-line break-words">{r.body}</p>
      <div className="flex flex-wrap items-center gap-2">
        {r.status !== "approved" ? (
          <Button size="sm" className="gap-1" disabled={busy} onClick={onApprove}>
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            Approve
          </Button>
        ) : null}
        {r.status !== "rejected" ? (
          <>
            <select
              aria-label="Rule this review breaks"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReviewRejectionReason | "")}
              className="h-9 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-sm touch:min-h-11"
            >
              <option value="">Reject under…</option>
              {REVIEW_REJECTION_REASONS.map((x) => (
                <option key={x} value={x}>
                  {REVIEW_REJECTION_LABEL[x]}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={busy || !reason}
              onClick={() => reason && onReject(reason)}
            >
              <X className="h-4 w-4 shrink-0" aria-hidden="true" />
              Reject
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
