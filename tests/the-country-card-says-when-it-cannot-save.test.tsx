// The Country card says when it cannot save (#496, review of #512).
//
// The app can deploy before 20261018120000 adds organizations.country. The
// reader and the writer already survive that (org-country-column.ts, pinned by
// a-deploy-ahead-of-the-country-column-still-signs-in.test.ts), but the card
// toasted "Country saved" over a write that had quietly dropped the country.
// Now the read marks the row `country_column_missing`, the write answers
// `countryColumnMissing`, and the card turns itself off and says why.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/lib/org.functions", () => ({
  getOrgBranding: vi.fn(),
  updateOrgBranding: vi.fn(),
}));

import { CountryCard } from "@/components/settings/CountryCard";
import { COUNTRY_NOT_YET, countrySaveOutcome } from "@/lib/org-country-column";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function render(node: ReactNode, branding: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["org-branding"], branding);
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  return html.replace(/&#x27;/g, "'");
}

const selectTag = (html: string) => /<select[^>]*id="org-country"[^>]*>/.exec(html)?.[0] ?? "";

describe("the Country card before the column exists", () => {
  const before = { id: "o1", country: null, country_column_missing: true };

  it("turns the select off and says why", () => {
    const html = render(<CountryCard />, before);
    expect(selectTag(html)).toMatch(/\bdisabled=""/);
    expect(html).toContain(
      "Country can't be saved yet. It turns on with the next database update.",
    );
    expect(html).not.toContain("Country saved");
  });

  it("says nothing of the kind once the column is there, even with no country set", () => {
    for (const country of [null, "US"]) {
      const html = render(<CountryCard />, { id: "o1", country });
      expect(selectTag(html)).not.toMatch(/\bdisabled=""/);
      expect(html).not.toContain(COUNTRY_NOT_YET);
    }
  });
});

describe("what a save says", () => {
  it("says saved only when the server stored it", () => {
    expect(countrySaveOutcome({ countryColumnMissing: false })).toEqual({
      saved: true,
      message: "Country saved",
    });
    expect(countrySaveOutcome({ countryColumnMissing: true })).toEqual({
      saved: false,
      message: "Country can't be saved yet.",
    });
  });

  it("is what the card toasts, and nothing else toasts 'Country saved'", () => {
    const card = read("src/components/settings/CountryCard.tsx");
    expect(card).toMatch(/const \{ saved, message \} = countrySaveOutcome\(r\);/);
    expect(card).not.toContain('"Country saved"');
    expect(read("src/lib/org-country-column.ts").match(/"Country saved"/g)).toHaveLength(1);
    expect(read("src/routes/_authenticated/settings.business.tsx")).not.toContain("Country saved");
  });
});

describe("the copy is spelled for a US business", () => {
  it("reads kilometers, not kilometres", () => {
    const html = render(<CountryCard />, { id: "o1", country: "US" });
    expect(html).toContain("in miles for the United States and in kilometers everywhere else");
    expect(html).not.toMatch(/kilometre|metre/i);
  });
});
