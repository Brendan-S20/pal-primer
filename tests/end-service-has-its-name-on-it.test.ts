// R2-46 (waste-r2-11): End service was reachable only through an unlabeled
// "…" on the service card. It is now a button with its name on it, beside
// Pause; the "…" keeps only Delete, shown before the service has started.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tab = readFileSync(
  join(process.cwd(), "src/components/client-detail/ServicesTab.tsx"),
  "utf8",
);

describe("the service card", () => {
  it("shows End service as a labeled button", () => {
    expect(tab).toMatch(
      /\{canManagePricing && showEnd && \(\s*<Button size="sm" variant="outline" onClick=\{\(\) => setEndingSub\(s\)\}>[\s\S]{0,120}End service…\s*<\/Button>/,
    );
  });
  it("no longer hides End service in the menu", () => {
    expect(tab).not.toMatch(/<DropdownMenuItem onSelect=\{\(\) => setEndingSub\(s\)\}>/);
    expect(tab).toMatch(/\{canManagePricing && showDelete && \(\s*<DropdownMenu>/);
  });
  it("Delete's refusal points at where End now is", () => {
    const fns = readFileSync(join(process.cwd(), "src/lib/subscriptions.functions.ts"), "utf8");
    expect(fns).toMatch(/Use End service… on the service instead\./);
    expect(fns).not.toMatch(/in its menu instead/);
  });
});
