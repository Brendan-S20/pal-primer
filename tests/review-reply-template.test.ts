import { describe, expect, it } from "vitest";
import {
  draftReviewReplyFromTemplate,
  reviewerFirstName,
} from "@/lib/review-reply-template";

// Review replies stopped being a model call on 2026-10-03: a template chosen by
// star rating (src/lib/review-reply-template.ts). These are posted publicly
// under the owner's business name, so the tests read the words.

const draft = (rating: number, o: { name?: string; text?: string; biz?: string } = {}) =>
  draftReviewReplyFromTemplate({
    rating,
    reviewText: o.text ?? "Great service, the yard is spotless.",
    reviewerName: o.name,
    businessName: o.biz ?? "Scoop Troop",
  });

describe("draftReviewReplyFromTemplate", () => {
  it("thanks a five-star reviewer by first name and signs with the business", () => {
    const r = draft(5, { name: "Jane Doe" });
    expect(r.reply).toMatch(/Jane/);
    expect(r.reply).not.toMatch(/Doe/);
    expect(r.reply.endsWith("Scoop Troop")).toBe(true);
    expect(r.reply).toMatch(/[Tt]hank/);
    expect(r.notes).toBe("none");
  });

  it("thanks a four-star reviewer and asks what would make it five", () => {
    for (const text of ["a", "b", "c", "d"]) {
      const r = draft(4, { name: "Sam", text });
      expect(r.reply).toMatch(/[Tt]hank/);
      expect(r.notes).toBe("none");
    }
  });

  it("answers three stars neutrally and points to the office", () => {
    for (const text of ["a", "b", "c", "d"]) {
      const r = draft(3, { text });
      expect(r.reply).toMatch(/office/);
      expect(r.notes).not.toBe("none");
    }
  });

  it("apologises for one and two stars and invites contact with the office", () => {
    for (const rating of [1, 2]) {
      for (const text of ["a", "b", "c", "d"]) {
        const r = draft(rating, { name: "Lee", text });
        expect(r.reply).toMatch(/sorry|apologize/i);
        expect(r.reply).toMatch(/office/);
        expect(r.reply).toMatch(/Lee/);
        expect(r.notes).toMatch(/Low rating/);
      }
    }
  });

  it("writes without a name rather than with a placeholder", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      for (const text of ["a", "b", "c", "d"]) {
        const r = draft(rating, { text });
        expect(r.reply).not.toMatch(/undefined|null|\{|\}/);
        expect(r.reply).not.toMatch(/^,|\s,/);
      }
    }
  });

  it("is the same draft for the same review, and not always the same draft", () => {
    expect(draft(5, { text: "Lovely" })).toEqual(draft(5, { text: "Lovely" }));
    const replies = new Set(["a", "b", "c", "d", "e", "f"].map((t) => draft(5, { text: t }).reply));
    expect(replies.size).toBeGreaterThan(1);
  });

  it("never posts an em dash under the owner's name", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      for (const text of ["a", "b", "c", "d"]) {
        expect(draft(rating, { name: "Ana", text }).reply).not.toMatch(/—/);
      }
    }
  });

  it("signs off generically when the business has no name on file", () => {
    const r = draftReviewReplyFromTemplate({ rating: 5, reviewText: "x", businessName: "  " });
    expect(r.reply.endsWith("The team")).toBe(true);
  });
});

describe("reviewerFirstName", () => {
  it("takes the first word and drops an empty name", () => {
    expect(reviewerFirstName("  Jane   D. ")).toBe("Jane");
    expect(reviewerFirstName("")).toBeNull();
    expect(reviewerFirstName(undefined)).toBeNull();
  });
});
