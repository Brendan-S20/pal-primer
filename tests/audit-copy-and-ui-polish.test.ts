import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("Oct 11 audit copy and UI fixes", () => {
  // site-r2-05: Managed texting is on sale, so "coming soon" became the
  // business's own state (Under review, Setup needed, ...), read by
  // TextingNotLiveText. Compose is still offered only once texting is live.
  it("keeps Messages from offering compose until texting is live", () => {
    const page = read("src/routes/_authenticated/messages.tsx");
    const index = read("src/routes/_authenticated/messages.index.tsx");
    expect(page).toMatch(/\{texting && \(\s*<Button[\s\S]{0,500}New message/);
    expect(page).toMatch(/Once your texting is live/);
    expect(index).toMatch(/texting\s*\?/);
    expect(index).toMatch(/<TextingNotLiveText \/>/);
    expect(index).not.toMatch(/coming soon/i);
  });

  it("shows no visits before geocoding help on an empty route day", () => {
    const routes = read("src/routes/_authenticated/routes.tsx");
    const noVisits = routes.indexOf("No visits to show.");
    const geocode = routes.indexOf("No coordinates yet. Geocode your properties");
    expect(noVisits).toBeGreaterThan(-1);
    expect(geocode).toBeGreaterThan(-1);
    expect(noVisits).toBeLessThan(geocode);
  });

  it("hides raw add-on codes and names add-on cadence for people", () => {
    const addons = read("src/routes/_authenticated/settings.addons.tsx");
    expect(addons).toMatch(/FREQUENCY_LABELS/);
    expect(addons).toMatch(/One-time/);
    expect(addons).not.toMatch(/\(\{s\.code\}\)/);
  });

  it("spells out week lane away markers and gives truncated names a title", () => {
    const lanes = read("src/components/routes/LaneStrip.tsx");
    expect(lanes).toMatch(/title=\{s\.display_name\}/);
    expect(lanes).toMatch(/Off 3/);
    expect(lanes).not.toMatch(/!3/);
  });

  it("keeps demo invites and local seed cleanup on fake demo data", () => {
    const users = read("src/lib/users.functions.ts");
    const seed = read("tests/e2e/seed.mjs");
    expect(users).toMatch(/requireDemoInviteAddress/);
    expect(users).toMatch(/@demo\.test/);
    expect(seed).toMatch(/tidySeedRows/);
    expect(seed).toMatch(/Internal test client/);
    expect(seed).toMatch(/Demo Dog/);
  });
});
