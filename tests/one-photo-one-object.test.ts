import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// A visit photo could end up in storage several times over, with only the last
// copy referenced by anything.
//
// The upload is not the last step — `recordVisitPhoto` follows it — and both
// paths put `Date.now()` in the object key:
//
//   useOfflineVisitActions.uploadPhoto  online: upload, then record
//   sync.runOne (kind "photo")          replay: upload, then record, then drop
//                                       the local blob
//
// So any failure AFTER the bytes land goes somewhere new next time:
//
//   * Online, `runOrQueue` treats a transport failure at the record step by
//     QUEUEING the action — so the bytes are uploaded once online and again on
//     replay, to two different keys.
//   * On replay, the loop retries up to MAX_ATTEMPTS, so one stubborn photo
//     could leave five copies behind before dead-lettering, which then deletes
//     the only reference.
//
// Orphans are referenced by nothing, collected by nothing, and billed to the
// organization for ever.

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are not code — both files now explain the defect in prose. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const SYNC = code(read("src/lib/offline/sync.ts"));
const HOOK = code(read("src/lib/offline/useOfflineVisitActions.ts"));

describe("a photo's storage key", () => {
  it("is not the clock, on either path", () => {
    for (const [name, src] of [
      ["sync.ts", SYNC],
      ["useOfflineVisitActions.ts", HOOK],
    ] as const) {
      const uploadPath = /const path = `\$\{[^`]*`/.exec(src)?.[0] ?? "";
      expect(uploadPath, `${name}: no upload path found`).not.toBe("");
      expect(uploadPath, `${name} still keys the object on Date.now()`).not.toContain("Date.now()");
    }
  });

  it("is minted once and shared by the online attempt and the replay", () => {
    // The sharper half: online upload lands, record fails, action is queued,
    // replay uploads the SAME bytes. Without one key that is two objects.
    expect(HOOK).toMatch(/const uploadKey =/);
    expect(HOOK).toMatch(/\$\{vRow\.organization_id\}\/\$\{visitId\}\/\$\{uploadKey\}/);
    expect(HOOK).toMatch(/uploadKey,/); // carried onto the queued action
    expect(SYNC).toMatch(/action\.uploadKey \?\? action\.id/);
  });

  it("falls back to the action id for rows queued before the key existed", () => {
    // Optional field, no schema bump: an older row has no uploadKey and its own
    // action id is stable across its retries, which is what it needs.
    expect(SYNC).toMatch(/action\.uploadKey \?\? action\.id/);
  });
});

describe("the upload overwrites rather than refusing", () => {
  for (const [name, src] of [
    ["sync.ts", SYNC],
    ["useOfflineVisitActions.ts", HOOK],
  ] as const) {
    it(`${name} uploads with upsert`, () => {
      // Now that the key is stable, `upsert: false` would make a retry after a
      // successful upload fail on "already exists" — turning a recoverable
      // record-step failure into a permanent one, which is worse than the
      // orphan it replaced.
      expect(src).not.toMatch(/upsert:\s*false/);
      expect(src).toMatch(/upsert:\s*true/);
    });
  }
});

describe("the local blob still outlives the upload", () => {
  it("is deleted only after the record lands", () => {
    // Pre-existing and load-bearing: until recordVisitPhoto returns, the blob in
    // IndexedDB is the only copy that exists. Deleting earlier is how a photo
    // was once lost while being reported as synced.
    // Scoped to runOne's photo branch: `recordVisitPhoto` also names a field on
    // the SyncCallers interface at the top of the file, so a whole-file
    // indexOf finds the declaration, not the call, and the ordering it reports
    // is meaningless.
    const branch = /case "photo": \{[\s\S]*?\n    \}/.exec(SYNC)?.[0] ?? "";
    expect(branch, "photo branch not found").not.toBe("");
    const upload = branch.indexOf("visit-photos");
    const record = branch.indexOf("callers.recordVisitPhoto");
    const drop = branch.indexOf("deletePhoto(action.photoId)");
    expect(upload).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(upload);
    expect(drop).toBeGreaterThan(record);
  });
});

// ── Two claims the schema and the settings screen were making ──────────────

describe("the portal skip rule is reachable", () => {
  const src = readFileSync(join(ROOT, "src/lib/skip-rules.functions.ts"), "utf8");

  it("lists the code the portal actually writes", () => {
    // `portal_skip_visit` sets skip_reason_code='customer_requested' and reads
    // skip_billing_rules for that code, ending `IF _pct IS NULL THEN _pct := 0`.
    // The code was missing from SKIP_REASON_CODES, so it never appeared in
    // Settings and upsertSkipRule's z.enum rejected it — the override could
    // never exist, and a client cancelling through the portal was ALWAYS billed
    // $0, whatever the business's late-cancellation policy said.
    expect(src).toMatch(/"customer_requested"/);
    expect(src).toMatch(/customer_requested: "Customer skipped via portal"/);
  });

  it("defaults it to 0, matching the SQL rather than improving on it", () => {
    // Making it configurable must not also, silently, start charging people.
    expect(src).toMatch(/customer_requested: 0,/);
  });

  it("keeps it out of the tech's picker", () => {
    // A tech choosing it would record the customer's decision as though the
    // customer had made it — on the one code whose billing that decision drives.
    expect(src).toMatch(/export const TECH_SKIP_REASON_CODES/);
    expect(src).toMatch(/c !== "customer_requested"/);
    const myDay = readFileSync(join(ROOT, "src/routes/_authenticated/my-day.tsx"), "utf8");
    expect(myDay).toMatch(/TECH_SKIP_REASON_CODES\.map/);
    expect(myDay).not.toMatch(/\{SKIP_REASON_CODES\.map/);
  });
});

describe("billed_through_parent is gone", () => {
  it("is not referenced anywhere in src", () => {
    // Its comment promised HoundStack invoices the PARENT for a location and
    // that the location "must not be dunned or suspended". Nothing implemented
    // any of it: no reader, no writer, every row false. Meanwhile
    // provision_franchise_location gives each location its own plan and bills it
    // in its own right — the OPPOSITE of the claim, sitting in the schema for
    // the next person to design franchise billing to read and believe.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${e}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (
          /\.(ts|tsx)$/.test(e) &&
          readFileSync(join(ROOT, rel), "utf8").includes("billed_through_parent")
        ) {
          hits.push(rel);
        }
      }
    };
    walk("src");
    expect(hits, `still referenced in:\n${hits.join("\n")}`).toEqual([]);
  });

  it("is out of the platform-columns trigger", () => {
    // A trigger naming a dropped column fails EVERY organizations UPDATE.
    const mig = readFileSync(
      join(
        ROOT,
        "supabase/migrations/20260804070000_a-column-that-promised-consolidated-franchise-billing.sql",
      ),
      "utf8",
    );
    const fn =
      /CREATE OR REPLACE FUNCTION public\.tg_orgs_protect_platform_columns[\s\S]*$/.exec(
        mig,
      )?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).not.toContain("billed_through_parent");
    // The sibling that IS wired stays protected.
    expect(fn).toContain("payments_collected_by_parent");
  });
});
