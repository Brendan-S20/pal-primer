// From the product review of 2026-09-27, the phone's More sheet.
//
// The nav had a group called "Operations" (Clients, Zones, Schedule) and,
// two groups further down, one called "Ops" (Inventory, Timesheets). The same
// word twice, once abbreviated, in the sidebar and in the More sheet — which
// is built from NAV_GROUPS, so it inherited the pair — and in the command
// palette, which keeps its own list and spelled them the same way. Nobody
// reading them could say what separated the two. They are one group now.

import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// AppSidebar pulls in the Supabase client at import time. NAV_GROUPS needs
// none of it, and a test of a list of labels should not open a client.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");

describe("the nav groups", () => {
  it("have no two labels that are the same word", async () => {
    const { NAV_GROUPS } = await import("@/components/AppSidebar");
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels).not.toContain("Ops");
    // Case-folded and cut to three letters: catches "Ops"/"Operations", and
    // any "Oper."/"Operations" pair that comes after it.
    const stems = labels.map((l) => l.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3));
    expect(new Set(stems).size, `labels: ${labels.join(", ")}`).toBe(stems.length);
  });

  it("keep Inventory and Timesheets, under Operations", async () => {
    const { NAV_GROUPS } = await import("@/components/AppSidebar");
    const ops = NAV_GROUPS.find((g) => g.label === "Operations");
    // Clients and Schedule moved up into the first group and Zones down into
    // Setup on 2026-10-15 (QA row 36, tests/the-five-an-owner-opens-first
    // .test.ts). Inventory and Timesheets, the pair this test is about, stay.
    expect(ops?.items.map((i) => i.url)).toEqual(
      expect.arrayContaining(["/inventory", "/timesheets"]),
    );
    // Moved, not dropped: each URL is in exactly one group.
    const urls = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.url));
    expect(urls.filter((u) => u === "/inventory")).toHaveLength(1);
    expect(urls.filter((u) => u === "/timesheets")).toHaveLength(1);
  });

  it("are what the More sheet is built from, so it cannot keep the old pair", () => {
    const sheet = read("src/components/MobileTabBar.tsx");
    expect(sheet).toMatch(/const moreGroups = NAV_GROUPS\.map/);
    expect(sheet).not.toMatch(/label: "Ops"/);
  });
});

describe("the command palette", () => {
  it("files the same two destinations under the same group name", () => {
    const palette = read("src/components/CommandPalette.tsx");
    expect(palette).not.toMatch(/group: "Ops"/);
    expect(palette).toMatch(/\{ label: "Inventory", to: "\/inventory", group: "Operations" \}/);
    expect(palette).toMatch(/\{ label: "Timesheets", to: "\/timesheets", group: "Operations" \}/);
  });
});
