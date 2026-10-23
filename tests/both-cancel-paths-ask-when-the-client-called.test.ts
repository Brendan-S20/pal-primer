/**
 * The office cancels a training lesson from the client's Visits tab and from
 * the board drawer. Both ask when the client called, through the same field,
 * and send it to cancelVisitFromOffice, which passes it to office_skip_visit
 * as _client_cancelled_at.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientCalledAtIso } from "@/components/training/ClientCalledAtField";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("both office cancel paths ask when the client called", () => {
  for (const file of [
    "src/components/client-detail/VisitsTab.tsx",
    "src/components/VisitDetailDrawer.tsx",
  ]) {
    it(`${file} renders the field on a package lesson and sends it`, () => {
      const src = read(file);
      expect(src).toMatch(/client_package_id && \(\s*<ClientCalledAtField/);
      expect(src).toMatch(
        /clientCancelledAt: [^\n]*client_package_id \? clientCalledAtIso\(calledAt\) : null/,
      );
    });
  }

  it("the drawer's cancel is behind the office permission", () => {
    const drawer = read("src/components/VisitDetailDrawer.tsx");
    const gate = drawer.indexOf("{!canActFromOffice ? (");
    const field = drawer.indexOf("<ClientCalledAtField");
    expect(gate).toBeGreaterThan(-1);
    expect(field).toBeGreaterThan(gate);
  });

  it("an empty field sends no time, and a set one sends ISO", () => {
    expect(clientCalledAtIso("")).toBeNull();
    expect(clientCalledAtIso("not a date")).toBeNull();
    expect(clientCalledAtIso("2026-10-16T09:30")).toBe(new Date("2026-10-16T09:30").toISOString());
  });
});
