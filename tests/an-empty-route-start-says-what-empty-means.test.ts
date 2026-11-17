// #943: an owner read the empty Route start box's grey hint ("123 Main St,
// Austin, TX 78701") as a saved address that came back after clearing. The
// hint now says what an empty start does, and cannot be read as an address.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_START_BLANK_HINT } from "@/lib/route-endpoints";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Both places a person edits a route start. */
const EDITORS = [
  "src/routes/_authenticated/settings.users.tsx",
  "src/components/routes/StaffRoutingDialog.tsx",
];

describe("an empty route start says what empty means", () => {
  it("the hint names the fallback", () => {
    expect(ROUTE_START_BLANK_HINT).toBe("Leave blank for business address");
  });

  it("the hint cannot be read as an address", () => {
    // No house number or ZIP, no street suffix, no "City, ST".
    expect(ROUTE_START_BLANK_HINT).not.toMatch(/\d/);
    expect(ROUTE_START_BLANK_HINT).not.toMatch(/\b(St|Ave|Rd|Blvd|Dr|Ln|Street|Avenue|Road)\b/);
    expect(ROUTE_START_BLANK_HINT).not.toMatch(/,\s*[A-Z]{2}\b/);
  });

  it.each(EDITORS)("%s uses it for the Route start box", (file) => {
    const src = read(file);
    expect(src).toContain("placeholder={ROUTE_START_BLANK_HINT}");
    for (const old of ["123 Main St", "Street, city, state and ZIP", "Home, shop, or depot"]) {
      expect(src, `${file} still hints "${old}"`).not.toContain(old);
    }
  });
});
