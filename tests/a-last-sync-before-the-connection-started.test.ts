// QuickBooks read "since Oct 12 · last sync Oct 3" after a reconnect (QA row
// 41, #433): `connected_at` is rewritten on every reconnect and
// `last_sync_at` is not, so the label claimed a sync before the connection
// existed. The wording now follows the order of the two dates.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { qboConnectionParts } from "../src/lib/qbo-connection-label";

const fmt = (iso: string) => iso.slice(0, 10);

describe("qboConnectionParts", () => {
  it("a sync after connecting reads as the last sync", () => {
    expect(qboConnectionParts("2026-10-01T10:00:00Z", "2026-10-05T10:00:00Z", fmt)).toEqual({
      connected: "Connected 2026-10-01",
      sync: "Last sync 2026-10-05",
    });
  });

  it("a sync from before a reconnect never reads as later than the connection", () => {
    const parts = qboConnectionParts("2026-10-12T10:00:00Z", "2026-10-03T10:00:00Z", fmt);
    expect(parts.connected).toBe("Connected 2026-10-12");
    expect(parts.sync).toBe("Not synced since reconnecting (last sync 2026-10-03)");
  });

  it("no sync yet says so", () => {
    expect(qboConnectionParts("2026-10-12T10:00:00Z", null, fmt)).toEqual({
      connected: "Connected 2026-10-12",
      sync: "Not synced yet",
    });
  });

  it("nothing known shows nothing", () => {
    expect(qboConnectionParts(null, null, fmt)).toEqual({ connected: null, sync: null });
  });

  it("compares instants when connection and sync use different time zones", () => {
    expect(qboConnectionParts("2026-10-12T09:00:00-05:00", "2026-10-12T13:00:00Z", fmt).sync)
      .toBe("Not synced since reconnecting (last sync 2026-10-12)");
    expect(qboConnectionParts("2026-10-12T09:00:00-05:00", "2026-10-12T14:00:00Z", fmt).sync)
      .toBe("Last sync 2026-10-12");
  });

  it("the settings page uses it instead of the two raw labels", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "src/routes/_authenticated/settings.accounting.tsx"),
      "utf8",
    );
    expect(src).toContain("qboConnectionParts(");
    expect(src).not.toMatch(/· since \$\{/);
  });
});
