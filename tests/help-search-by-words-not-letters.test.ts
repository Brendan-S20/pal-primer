import { describe, expect, it } from "vitest";
import { HELP_ARTICLES } from "@/lib/help-content";
import { helpMatchScore, helpWords } from "@/lib/help-search";

// The Knowledge Center matched a query as one substring. On 2026-09-27 the
// first-time-owner review typed "get paid" and was told "Nothing matches that
// search" directly above an article called "Getting paid"; "first visit" and
// "business hours" found nothing either. These run the real articles.

const search = (q: string) =>
  HELP_ARTICLES.map((a) => ({ slug: a.slug, score: helpMatchScore(a, q) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.slug);

describe("the queries a new owner actually typed", () => {
  it('"get paid" leads with Getting paid', () => {
    expect(search("get paid")[0]).toBe("getting-paid");
  });
  it('"how do I get paid" is the same question', () => {
    expect(search("how do I get paid")[0]).toBe("getting-paid");
  });
  it('"first visit" and "business hours" find something', () => {
    expect(search("first visit").length).toBeGreaterThan(0);
    expect(search("business hours").length).toBeGreaterThan(0);
  });
});

describe("matching", () => {
  it("folds endings so a person's phrasing meets the article's", () => {
    expect(helpWords("Getting invoices sent")).toEqual(["get", "invoice", "sent"]);
  });
  it("matches a word being typed", () => {
    expect(search("invo").length).toBeGreaterThan(0);
  });
  it("still says no when nothing is about it", () => {
    expect(search("xylophone")).toEqual([]);
  });
  it("an empty query lists everything", () => {
    expect(search("   ").length).toBe(HELP_ARTICLES.length);
  });
});
