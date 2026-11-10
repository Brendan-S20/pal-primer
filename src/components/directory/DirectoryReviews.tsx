import { reviewSummary, type PublicDirectoryReview } from "@/lib/directory-reviews";

/**
 * Approved reviews on a directory profile (#630). Only reviews a HoundStack
 * moderator approved ever reach this component: the database returns nothing
 * else (directory_public_reviews). No reviewer name, no stars graphic and no
 * structured data: an average is written out only from three approved
 * reviews, and JSON-LD waits for a decision on the domain.
 */
export function DirectoryReviews({ reviews }: { reviews: PublicDirectoryReview[] }) {
  const summary = reviewSummary(reviews);
  return (
    <section className="space-y-3" data-directory-reviews>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Reviews</h2>
        {summary ? (
          <p className="text-sm text-muted-foreground">
            {summary.average} out of 5 from {summary.count} reviews
          </p>
        ) : null}
      </div>
      {reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews yet.</p>
      ) : (
        <ul className="space-y-3">
          {reviews.map((r, i) => (
            <li key={`${r.reviewed_at}-${i}`} className="rounded-lg border p-3">
              <p className="text-sm font-medium">{r.rating} out of 5</p>
              <p className="mt-1 whitespace-pre-line break-words">
                <bdi>{r.body}</bdi>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {new Date(r.reviewed_at).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Reviews come from the business's clients and are checked by HoundStack before they are
        shown. The business cannot remove or edit them.
      </p>
    </section>
  );
}
