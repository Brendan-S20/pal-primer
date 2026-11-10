// Reviews in HoundStack's directory (#630): the pure half.
//
// Held for moderation (Brendan, 2026-11-09): a review is never public until a
// moderator approves it. Brendan is the only moderator for now, so the queue
// is a platform-admin page (/platform/directory-reviews). The database half is
// supabase/migrations/20261110120100_a-review-is-public-only-after-a-moderator-approves-it.sql.

/** The written rules a review may be rejected under, and nothing else. Never
 *  the rating: there is no reason for "too negative" (16 CFR 465.7(b)). */
export const REVIEW_REJECTION_REASONS = [
  "abusive_or_defamatory",
  "personal_info",
  "believed_fake",
  "unrelated",
] as const;
export type ReviewRejectionReason = (typeof REVIEW_REJECTION_REASONS)[number];

export const REVIEW_REJECTION_LABEL: Record<ReviewRejectionReason, string> = {
  abusive_or_defamatory: "Abusive or defamatory",
  personal_info: "Shares another person's personal information",
  believed_fake: "Believed to be fake",
  unrelated: "Not about this business",
};

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** An approved review as a visitor reads it. No reviewer identity at all. */
export type PublicDirectoryReview = { rating: number; body: string; reviewed_at: string };

/** A review in the moderator's queue. */
export type QueuedDirectoryReview = {
  id: string;
  business_name: string;
  profile_slug: string | null;
  rating: number;
  body: string;
  status: ReviewStatus;
  rejection_reason: ReviewRejectionReason | null;
  created_at: string;
  updated_at: string;
  moderated_at: string | null;
  /** Which platform admin decided it: the queue's audit trail, for when
   *  Brendan is no longer the only moderator. */
  moderated_by: string | null;
};

/** An average is shown only from this many approved reviews: fewer is not a
 *  rating, it is an anecdote (and the spec's threshold for any star summary). */
export const MIN_REVIEWS_FOR_AVERAGE = 3;

export function reviewSummary(
  reviews: ReadonlyArray<Pick<PublicDirectoryReview, "rating">>,
): { average: number; count: number } | null {
  if (reviews.length < MIN_REVIEWS_FOR_AVERAGE) return null;
  const sum = reviews.reduce((a, r) => a + r.rating, 0);
  return { average: Math.round((sum / reviews.length) * 10) / 10, count: reviews.length };
}

/** Rows from directory_public_reviews, narrowed to the public shape. */
export function toPublicReviews(rows: unknown): PublicDirectoryReview[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: { rating?: unknown; body?: unknown; reviewed_at?: unknown }) =>
    typeof r?.rating === "number" && typeof r.body === "string" && typeof r.reviewed_at === "string"
      ? [{ rating: r.rating, body: r.body, reviewed_at: r.reviewed_at }]
      : [],
  );
}
