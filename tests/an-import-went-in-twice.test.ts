import { describe, expect, it } from "vitest";
import {
  alreadyInDatabase,
  clientDuplicateIndex,
  commitRefusal,
  importContentHash,
  IMPORT_PREVIEW_TTL_MS,
  type ExistingClient,
  type ExistingRecords,
} from "@/lib/import-commit-guard";

const now = Date.parse("2026-10-15T14:00:00Z");
const preview = { status: "previewing", created_at: new Date(now - 1000).toISOString() };

describe("commit refusal", () => {
  it("accepts a fresh preview and refuses a second commit or an in-flight claim", () => {
    expect(commitRefusal(preview, now)).toBeNull();
    expect(commitRefusal({ ...preview, status: "committed" }, now)).toBe("committed");
    expect(commitRefusal({ ...preview, commit_started_at: preview.created_at }, now)).toBe(
      "committing",
    );
  });
  it("refuses superseded and cancelled previews", () => {
    expect(commitRefusal({ ...preview, status: "cancelled", superseded_by: "winner" }, now)).toBe(
      "superseded",
    );
    expect(commitRefusal({ ...preview, status: "cancelled" }, now)).toBe("closed");
  });
  it("expires at 24 hours and fails closed on an invalid timestamp", () => {
    expect(
      commitRefusal(
        { ...preview, created_at: new Date(now - IMPORT_PREVIEW_TTL_MS - 1).toISOString() },
        now,
      ),
    ).toBe("stale");
    expect(commitRefusal({ ...preview, created_at: "invalid" }, now)).toBe("stale");
  });
});

it("fingerprints file contents independently of JSON key order", async () => {
  const hash = await importContentHash("clients", [
    { name: "Sample", email: "sample@example.test" },
  ]);
  expect(
    await importContentHash("clients", [{ email: "sample@example.test", name: "Sample" }]),
  ).toBe(hash);
  expect(await importContentHash("clients", [{ name: "Another" }])).not.toBe(hash);
  expect(
    await importContentHash("dogs", [{ name: "Sample", email: "sample@example.test" }]),
  ).not.toBe(hash);
});

const client: ExistingClient = {
  id: "existing",
  display_name: "Sample Client",
  primary_email: "sample@example.test",
  primary_phone: "+1 (248) 555-1234",
  import_source: "jobber",
  import_external_id: "J-1",
  streets: [{ street: "100 Example Ave", postal_code: "48073" }],
};
const existing: ExistingRecords = {
  clients: clientDuplicateIndex([client], "jobber"),
  propertyKeys: new Set(),
  dogKeys: new Set(),
  clientsWithActivePlan: new Set(),
  clientsWithOpeningBalance: new Set(),
};

it.each([
  { primary_email: " SAMPLE@example.test " },
  { primary_phone: "2485551234" },
  { display_name: "Sample Client", street: "100 Example Ave", postal_code: "48073" },
  { external_id: "J-1" },
])("skips a client matching the records reloaded at commit: %j", (row) => {
  expect(alreadyInDatabase("clients", row, null, existing)).toBe("existing");
});

it("does not skip a new client, a name alone, or a short phone", () => {
  for (const row of [
    { primary_email: "new@example.test" },
    { display_name: "Sample Client" },
    { primary_phone: "5551234" },
  ]) {
    expect(alreadyInDatabase("clients", row, null, existing)).toBeNull();
  }
});
