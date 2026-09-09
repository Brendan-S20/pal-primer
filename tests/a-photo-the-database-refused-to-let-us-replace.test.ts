// The retry path for a half-uploaded photo could never have worked.
//
// src/lib/offline/sync.ts uploads a queued photo to a path keyed on the ACTION
// rather than the clock, and explains at length that this is why `upsert` has
// to be true: "With `upsert: false` a retry after a successful upload fails on
// 'already exists', turning a recoverable record-step failure into a permanent
// one."
//
// The reasoning is right in every particular and the database never agreed to
// it. `storage.objects` had SELECT, INSERT and DELETE policies for
// `visit-photos` and no UPDATE, and Supabase implements upsert as an insert
// that falls back to an update — so the overwrite was refused by RLS, which is
// neither a transport failure nor being offline, so it counted as an attempt.
// Five of those and the action was dead-lettered, at which point sync.ts
// deletes the local blob: the only copy of a photograph of somebody's yard,
// taken on a day that is over.
//
// Verified against production before it was changed: pg_policies on
// storage.objects returned exactly three rows for this bucket, cmd SELECT,
// INSERT and DELETE.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const SQL = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(root, "supabase/migrations", f), "utf8"))
  .join("\n");

describe("the client may overwrite the object it is retrying", () => {
  it("grants UPDATE on visit-photos, which nothing ever did", () => {
    expect(SQL).toMatch(
      /CREATE POLICY "assigned tech overwrites visit photo files"\s*\n\s*ON storage\.objects FOR UPDATE TO authenticated/,
    );
  });

  it("gates the overwrite exactly as the upload is gated", () => {
    // A looser UPDATE policy than the INSERT one would let a tech overwrite
    // another tech's photo, which is a worse bug than the one being fixed.
    const at = SQL.indexOf('CREATE POLICY "assigned tech overwrites visit photo files"');
    const policy = SQL.slice(at, SQL.indexOf(";", at));
    for (const half of ["USING", "WITH CHECK"]) {
      const from = policy.indexOf(half);
      expect(from, `${half} missing`).toBeGreaterThan(-1);
      const clause = policy.slice(from, from + 400);
      expect(clause).toMatch(/bucket_id = 'visit-photos'/);
      expect(clause).toMatch(
        /is_org_member\(\(select auth\.uid\(\)\), \(\(storage\.foldername\(name\)\)\[1\]\)::uuid\)/,
      );
      expect(clause).toMatch(
        /is_visit_tech\(\(select auth\.uid\(\)\), \(\(storage\.foldername\(name\)\)\[2\]\)::uuid\)/,
      );
    }
  });

  it("still uploads with upsert, which is the whole point", () => {
    // If someone "fixes" this by turning upsert off instead, the retry goes
    // back to writing a fresh orphaned object per attempt — the fault the
    // uploadKey comment describes.
    const sync = strip(read("src/lib/offline/sync.ts"));
    expect(sync).toMatch(/upsert: true/);
    expect(sync).toMatch(/action\.uploadKey \?\? action\.id/);
  });
});

describe("recording the photo twice records one photo", () => {
  it("makes (visit_id, storage_path) unique", () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS visit_photos_visit_path_uniq/);
  });

  it("collapses existing duplicates first, or the index cannot be built", () => {
    const at = SQL.indexOf("DELETE FROM public.visit_photos vp");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(
      SQL.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS visit_photos_visit_path_uniq"),
    );
  });

  it("stops the second insert rather than erroring on it", () => {
    // The other half-failure: both steps landed and the RESPONSE was lost, so
    // the replay re-records a path already recorded and the customer sees the
    // same photograph twice.
    const fns = strip(read("src/lib/my-day.functions.ts"));
    expect(fns).toMatch(/onConflict: "visit_id,storage_path", ignoreDuplicates: true/);
  });
});

describe("the message that sends a tech back to a house names the house", () => {
  it("carries the affected visits out of the sync", () => {
    const sync = strip(read("src/lib/offline/sync.ts"));
    expect(sync).toMatch(/deadLetteredVisitIds: string\[\]/);
    expect(sync).toMatch(/droppedVisitIds: string\[\]/);
    // Sets, not guarded pushes: the dead-letter branch has to stay three flat
    // statements or the source-reading extraction in offline-dead-letter.test.ts
    // stops at the nested closing brace and no longer sees the `continue`.
    expect(sync).toMatch(/deadLetteredVisits\.add\(action\.visitId\)/);
    expect(sync).toMatch(/droppedVisits\.add\(action\.visitId\)/);
    expect(sync).toMatch(/result\.deadLetteredVisitIds = \[\.\.\.deadLetteredVisits\]/);
    expect(sync).toMatch(/result\.droppedVisitIds = \[\.\.\.droppedVisits\]/);
  });

  it("puts a client name on both toasts", () => {
    const page = strip(read("src/routes/_authenticated/my-day.tsx"));
    expect(page).toMatch(/description: namesFor\(res\.deadLetteredVisitIds\)/);
    expect(page).toMatch(/description: namesFor\(res\.droppedVisitIds\)/);
  });

  it("says nothing rather than counting visits it cannot name", () => {
    // A queued action outlives the day it belongs to, so an id with no row
    // today is expected. "and 2 others" with no names is worse than silence.
    const page = strip(read("src/routes/_authenticated/my-day.tsx"));
    expect(page).toMatch(/if \(named\.length === 0\) return undefined;/);
  });
});
