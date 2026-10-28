// Review replies from templates, chosen by star rating.
//
// `draftReviewReply` used to send each review to a model. What an owner
// actually needs from it is short and predictable: thank a happy customer by
// name, and give an unhappy one an apology and a way to reach the office. That
// is a choice between a few well-written replies, keyed on the rating, and a
// template does it the same way every time, for nothing, on any plan. It also
// cannot do the thing a model reply occasionally did, which is promise a
// refund or argue with the customer in public under the owner's name.
//
// Two wordings per rating, picked by the review text, so a business replying
// to a run of five-star reviews does not post the identical sentence under
// each one. The pick is a hash rather than a random number: the same review
// always gets the same draft, which is what makes it testable.

export interface ReviewReplyInput {
  rating: number;
  reviewText: string;
  reviewerName?: string | null;
  businessName?: string | null;
}

export interface ReviewReplyDraft {
  /** The public reply. */
  reply: string;
  /** Internal follow-up, or "none". */
  notes: string;
}

/** The first word of the name the reviewer posted under, or null. "Jane D."
 *  becomes "Jane"; an empty or missing name becomes null, and the reply is
 *  written without one rather than with a placeholder. */
export function reviewerFirstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.length ? first : null;
}

function pick<T>(options: readonly T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return options[h % options.length];
}

type Template = (name: string | null, business: string) => string;

const hi = (name: string | null) => (name ? `, ${name}` : "");

const FIVE: readonly Template[] = [
  (n, b) =>
    `Thank you${hi(n)}! We're so glad you're happy with the service, and we really appreciate you taking the time to say so. See you on the next visit.\n\n${b}`,
  (n, b) =>
    `Thanks so much for the kind words${hi(n)}. Reviews like this mean a lot to a small team, and we look forward to the next visit.\n\n${b}`,
];

const FOUR: readonly Template[] = [
  (n, b) =>
    `Thank you for the review${hi(n)}. We're glad things are going well, and if there is anything that would make it a five-star visit, please let us know.\n\n${b}`,
  (n, b) =>
    `Thanks for taking the time to leave a review${hi(n)}. We're always looking to improve, so if anything could be better, our office would love to hear it.\n\n${b}`,
];

const THREE: readonly Template[] = [
  (n, b) =>
    `Thank you for your feedback${hi(n)}. We'd like to hear more about how we can do better. Please get in touch with our office so we can follow up with you directly.\n\n${b}`,
  (n, b) =>
    `Thanks for the honest review${hi(n)}. It sounds like we fell short of what you expected, and we'd like to fix that. Please contact our office and we'll follow up.\n\n${b}`,
];

const LOW: readonly Template[] = [
  (n, b) =>
    `${n ? `${n}, we're` : "We're"} sorry your experience fell short. This isn't the standard we hold ourselves to, and we'd like to make it right. Please contact our office so we can look into it with you directly.\n\n${b}`,
  (n, b) =>
    `We apologize${n ? `, ${n}` : ""}. Thank you for letting us know, and we'd like the chance to put this right. Please reach out to our office so we can talk it through.\n\n${b}`,
];

export function draftReviewReplyFromTemplate(input: ReviewReplyInput): ReviewReplyDraft {
  const rating = Math.max(1, Math.min(5, Math.round(input.rating || 0)));
  const name = reviewerFirstName(input.reviewerName);
  const business = (input.businessName ?? "").trim() || "The team";
  const seed = input.reviewText ?? "";

  if (rating === 5) return { reply: pick(FIVE, seed)(name, business), notes: "none" };
  if (rating === 4) return { reply: pick(FOUR, seed)(name, business), notes: "none" };
  if (rating === 3) {
    return {
      reply: pick(THREE, seed)(name, business),
      notes: "Mixed review: worth a call to find out what would have made it better.",
    };
  }
  return {
    reply: pick(LOW, seed)(name, business),
    notes:
      "Low rating: call this client and check their recent visits before posting, so the office knows what happened when they get in touch.",
  };
}
