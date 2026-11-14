// A directory photo is public only after a moderator approves it (#630;
// mypets v2 step 5b: photos and moderation).
//
// This file:
//   * pins 20261112110000: numbered after every migration on main and every
//     open PR's, file only, additive (drops no column, table, function or
//     view; the view keeps every column it had, in place, and adds photos
//     last), the bucket created IN the file and private, its storage policies
//     owner-only (and platform admin to read) with no anon and no overwrite,
//     the table shut to anon with two-step sign-in, a client able to UPDATE
//     only alt and position, the guard holding pending / attestation / the
//     eight, and the queue and moderator platform-admin only;
//   * pins the CONTRACT: the view's columns, the keys of a photo, the
//     proof's expected keys, the e2e's list and PUBLIC_LISTING_FIELDS /
//     PUBLIC_PHOTO_FIELDS are one list, and toDirectoryListings keeps
//     approved-photo fields only whatever the view returns;
//   * pins the MODERATION STATES (pending / approved / rejected): what an
//     owner reads, what counts toward the eight, what the queue offers;
//   * pins the UPLOAD: the attestation word for word, refused without it,
//     alt required and at most 140, the owner's own folder only;
//   * pins NO CREDIT LINE anywhere: Settings, /platform, the server
//     functions, the view;
//   * runs tests/sql/a-directory-photo-waits-for-a-moderator.proof.sql
//     against a real database when one answers (skipped, loudly, when none
//     does). CI's database job runs the same proof through supabase/proofs/.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_PHOTOS_MAX,
  DIRECTORY_PHOTO_ALT_MAX,
  DIRECTORY_PHOTO_ATTESTATION,
  DIRECTORY_PHOTO_BUCKET,
  DIRECTORY_PHOTO_MAX_BYTES,
  DIRECTORY_PHOTO_STATUSES,
  DIRECTORY_PHOTO_STATUS_LABEL,
  DIRECTORY_PHOTO_TYPES,
  PUBLIC_LISTING_FIELDS,
  PUBLIC_PHOTO_FIELDS,
  countsTowardPhotoLimit,
  directoryPhotoPath,
  isDirectoryPhotoKey,
  isDirectoryPhotoPath,
  isDirectoryPhotoUrl,
  photoAltProblem,
  photoFileProblem,
  type DirectoryListing,
  type DirectoryPhoto,
} from "@/lib/directory";
import { toDirectoryListings } from "@/lib/directory.functions";
import {
  addDirectoryPhotoSchema,
  servePublicDirectoryPhoto,
} from "@/lib/directory-photos.functions";
import { STAYS_IN_BROWSER } from "@/lib/android-app-links";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const STAMP = "20261112110000";
const NAME = "a-directory-photo-is-public-only-after-a-moderator-approves-it";
const MIGRATION = join(ROOT, `supabase/migrations/${STAMP}_${NAME}.sql`);
const PROOF = join(ROOT, "tests/sql/a-directory-photo-waits-for-a-moderator.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const sql = () => codeOnly(readFileSync(MIGRATION, "utf8"));

// Exact both ways, as the step 7 contract does.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _listing: Exact<(typeof PUBLIC_LISTING_FIELDS)[number], keyof DirectoryListing> = true;
const _photo: Exact<(typeof PUBLIC_PHOTO_FIELDS)[number], keyof DirectoryPhoto> = true;
void _listing;
void _photo;

/** Top-level SELECT items of a view, by alias or bare `p.column`. */
function viewColumns(view: string): string[] {
  const select = view
    .split(/\bAS\s+SELECT\b/)[1]
    .split(/\n\s+FROM public\.directory_profiles p\b/)[0];
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of select) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  return items.map((it) => {
    const t = it.trim();
    return /\bAS ([a-z_]+)$/.exec(t)?.[1] ?? /^[a-z]+\.([a-z_]+)$/.exec(t)?.[1] ?? `?${t}`;
  });
}

const viewOf = (s: string) =>
  s.split("CREATE OR REPLACE VIEW public.directory_public_listings")[1].split(";")[0];
const view = () => viewOf(sql());
const photosExpr = () => view().split("AS book_path,")[1].split("AS photos")[0];

// ── The migration ────────────────────────────────────────────────────────────
describe("the migration", () => {
  it("is timestamped after every other migration and every open PR's, with a proof beside it", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(STAMP))).toEqual([`${STAMP}_${NAME}.sql`]);
    // Main's newest before it is 20261112100000 (step 7, #928); the open PRs
    // checked when this was written hold 20261112080000 (#912) and lower.
    expect(STAMP > "20261112100000").toBe(true);
    expect(
      files
        .map((f) => f.slice(0, 14))
        .sort()
        .at(-1),
    ).toBe(STAMP);
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/PROPOSED MIGRATION\. File only/);
    expect(read(`supabase/proofs/${STAMP}-${NAME}.sql`)).toMatch(
      /\\ir \.\.\/\.\.\/tests\/sql\/a-directory-photo-waits-for-a-moderator\.proof\.sql/,
    );
  });

  it("is additive: it drops no column, table, function or view, and changes no column", () => {
    const s = sql();
    expect(s).not.toMatch(/DROP\s+(TABLE|COLUMN|FUNCTION|VIEW|SCHEMA|INDEX)\b/i);
    expect(s).not.toMatch(/ALTER TABLE[^;]*DROP/i);
    expect(s).not.toMatch(/ALTER COLUMN/i);
    // The only DROPs are IF EXISTS of this file's own policies and trigger,
    // so it replays twice.
    for (const m of s.matchAll(/DROP (POLICY|TRIGGER) IF EXISTS ([^;]+);/g)) {
      expect(m[2], m[0]).toMatch(
        /^("directory photos [a-z ]+"|directory_profile_photos_guard) ON /,
      );
    }
    // Nothing else of the directory's is redefined.
    expect(s).not.toMatch(
      /FUNCTION public\.(directory_search|directory_profiles_by_slug|directory_public_rows|directory_booking_handoff|set_directory_profile|set_directory_profile_areas|set_directory_booking)\b/,
    );
    // No operations state: it reads and writes no tenant row.
    expect(s).not.toMatch(/INSERT INTO public\./);
    expect(s).not.toMatch(/UPDATE public\.organizations/);
  });

  it("creates the bucket in this file, private, 5 MB, JPEG / PNG / WebP", () => {
    const s = sql();
    expect(s).toMatch(
      /INSERT INTO storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+VALUES \('directory-photos', 'directory-photos', false, 5242880,\s+ARRAY\['image\/jpeg', 'image\/png', 'image\/webp'\]\)\s+ON CONFLICT \(id\) DO UPDATE SET public = false,/,
    );
    expect(s).not.toMatch(/public = true/i);
    expect(DIRECTORY_PHOTO_BUCKET).toBe("directory-photos");
    expect(DIRECTORY_PHOTO_MAX_BYTES).toBe(5242880);
    expect(Object.keys(DIRECTORY_PHOTO_TYPES)).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it("gives the bucket owner-only read, upload and delete, a moderator read, and nothing to anon or to overwrite", () => {
    const s = sql();
    const policies = [
      ...s.matchAll(/CREATE POLICY "([^"]+)" ON storage\.objects FOR (\w+) TO (\w+)/g),
    ];
    expect(policies.map((m) => [m[1], m[2], m[3]])).toEqual([
      ["directory photos read", "SELECT", "authenticated"],
      ["directory photos upload", "INSERT", "authenticated"],
      ["directory photos delete", "DELETE", "authenticated"],
    ]);
    const check = s.split("FUNCTION public.can_use_directory_photo(")[1].split("$fn$;")[0];
    expect(check).toMatch(
      /IF public\.has_role\(auth\.uid\(\), _org, 'owner'::public\.app_role\) THEN RETURN true;/,
    );
    expect(check).toMatch(/RETURN NOT write AND public\.is_platform_admin\(auth\.uid\(\)\);/);
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.can_use_directory_photo\(text, boolean\) FROM PUBLIC, anon;/,
    );
  });

  it("makes the table: alt required and at most 140, new photos pending, shut to anon, two-step sign-in", () => {
    const s = sql();
    const table = s
      .split("CREATE TABLE IF NOT EXISTS public.directory_profile_photos (")[1]
      .split(");")[0];
    for (const col of [
      "id uuid PRIMARY KEY",
      "organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE",
      "path text NOT NULL",
      "alt text NOT NULL",
      "position integer NOT NULL",
      "rights_attested_at timestamptz NOT NULL",
      "status text NOT NULL DEFAULT 'pending'",
      "moderated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL",
      "moderated_at timestamptz",
    ]) {
      expect(table).toContain(col);
    }
    expect(table).toMatch(/char_length\(alt\) BETWEEN 1 AND 140/);
    expect(DIRECTORY_PHOTO_ALT_MAX).toBe(140);
    expect(table).toMatch(/status IN \('pending', 'approved', 'rejected'\)/);
    expect(table).toMatch(/split_part\(path, '\/', 1\) = organization_id::text/);
    // No credit, source, photographer or licence column.
    expect(table).not.toMatch(/credit|source|photographer|licen[cs]e|pexels/i);
    expect(s).toMatch(/ALTER TABLE public\.directory_profile_photos ENABLE ROW LEVEL SECURITY;/);
    expect(s).toMatch(/SELECT public\.require_mfa_policy\('public\.directory_profile_photos'\);/);
    expect(s).toMatch(
      /REVOKE ALL ON public\.directory_profile_photos FROM PUBLIC, anon, authenticated;/,
    );
    expect(s).toMatch(
      /GRANT UPDATE \(alt, position\) ON public\.directory_profile_photos TO authenticated;/,
    );
    expect(s).not.toMatch(/GRANT[^;]*directory_profile_photos[^;]*TO[^;]*anon/);
    // Four owner policies, nobody else's.
    const own = [
      ...s.matchAll(
        /CREATE POLICY "directory photos owner (\w+)" ON public\.directory_profile_photos\s+FOR (\w+) TO authenticated/g,
      ),
    ];
    expect(own.map((m) => m[2])).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  it("holds every photo to the rules in a trigger: pending, attested, its own file, no self-approval, eight at most", () => {
    const g = sql().split("FUNCTION public.directory_profile_photos_guard()")[1].split("$fn$;")[0];
    expect(g).toMatch(
      /IF NEW\.rights_attested_at IS NULL THEN\s+RAISE EXCEPTION 'Confirm you took these photos/,
    );
    expect(g).toMatch(/NEW\.rights_attested_at := now\(\);/);
    expect(g).toMatch(
      /NEW\.status := 'pending';\s+NEW\.moderated_by := NULL;\s+NEW\.moderated_at := NULL;/,
    );
    expect(g).toMatch(/NEW\.path IS DISTINCT FROM OLD\.path/);
    expect(g).toMatch(
      /AND NOT _moderator THEN\s+RAISE EXCEPTION 'Only a HoundStack moderator can approve or reject a photo'/,
    );
    // New words go back for review.
    expect(g).toMatch(
      /IF NEW\.alt IS DISTINCT FROM OLD\.alt AND NOT _moderator THEN\s+NEW\.status := 'pending';/,
    );
    // The eight: pending and approved count, rejected do not, under a lock.
    expect(g).toMatch(
      /pg_advisory_xact_lock\(hashtext\('directory_profile_photos:' \|\| NEW\.organization_id::text\)\)/,
    );
    expect(g).toMatch(/AND status <> 'rejected'/);
    expect(g).toMatch(/IF _n >= 8 THEN/);
    expect(DIRECTORY_PHOTOS_MAX).toBe(8);
    // The moderator flag is set in exactly one place: the moderator's function.
    const sets = [...sql().matchAll(/set_config\('app\.directory_photo_moderator', '1', true\)/g)];
    expect(sets).toHaveLength(1);
    const mod = sql().split("FUNCTION public.moderate_directory_photo(")[1].split("$fn$;")[0];
    expect(mod.indexOf("public.is_platform_admin(auth.uid())")).toBeLessThan(
      mod.indexOf("set_config('app.directory_photo_moderator', '1', true)"),
    );
    expect(sql()).toMatch(
      /REVOKE ALL ON FUNCTION public\.directory_profile_photos_guard\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("keeps the queue and the decision to platform admins, as the review queue does", () => {
    const s = sql();
    for (const fn of ["directory_photo_queue(", "moderate_directory_photo("]) {
      const body = s.split(`FUNCTION public.${fn}`)[1].split("$fn$;")[0];
      expect(body).toMatch(
        /IF auth\.uid\(\) IS NULL OR NOT public\.is_platform_admin\(auth\.uid\(\)\) THEN/,
      );
    }
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.directory_photo_queue\(text\) FROM PUBLIC, anon;/,
    );
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.moderate_directory_photo\(uuid, boolean\) FROM PUBLIC, anon;/,
    );
    const mod = s.split("FUNCTION public.moderate_directory_photo(")[1].split("$fn$;")[0];
    expect(mod).toMatch(/moderated_by = auth\.uid\(\),\s+moderated_at = now\(\)/);
  });

  it("keeps the photo lookup to the service role, read through the view", () => {
    const s = sql();
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.directory_photo_object\(text, text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(s).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.directory_photo_object\(text, text\) TO service_role;/,
    );
    const body = s.split("FUNCTION public.directory_photo_object(")[1].split("$fn$;")[0];
    expect(body).toMatch(/FROM public\.directory_public_listings v/);
    expect(body).toMatch(/AND ph\.status = 'approved'/);
  });
});

// ── The public contract ──────────────────────────────────────────────────────
describe("the public contract", () => {
  it("is the view's columns, in order, and nothing else", () => {
    expect(viewColumns(view())).toEqual([...PUBLIC_LISTING_FIELDS]);
    expect(sql()).toMatch(
      /IF _cols IS DISTINCT FROM ARRAY\['slug', 'display_name', 'logo_url', 'bio', 'service_lines',\s+'coverage_zips', 'coverage_cities', 'services', 'published_at',\s+'tagline', 'highlights', 'areas',\s+'books_online', 'booking_policy_text', 'book_path',\s+'photos'\]/,
    );
  });

  it("drops no existing column: step 7's view is a prefix of this one, expression for expression", () => {
    const before = viewOf(
      codeOnly(
        read(
          "supabase/migrations/20261112100000_a-directory-listing-says-which-services-book-online.sql",
        ),
      ),
    );
    const first = viewColumns(before);
    expect(first).toHaveLength(15);
    expect(viewColumns(view()).slice(0, 15)).toEqual(first);
    expect(viewColumns(view()).slice(15)).toEqual(["photos"]);
    // The fifteen are the same SQL, byte for byte, once photos is taken out.
    const without = view().replace(
      /,\n\s+COALESCE\(\(\n\s+SELECT jsonb_agg\(jsonb_build_object\(\n\s+'url'[\s\S]*?AS photos/,
      "",
    );
    expect(without.replace(/\s+/g, " ")).toBe(before.replace(/\s+/g, " "));
  });

  it("names exactly the allowlisted keys for a photo, approved only, as a HoundStack path", () => {
    const e = photosExpr();
    expect([...e.matchAll(/'([a-z_]+)', /g)].map((m) => m[1])).toEqual([...PUBLIC_PHOTO_FIELDS]);
    expect(e).toMatch(/AND ph\.status = 'approved'/);
    expect(e).toMatch(
      /'url', '\/d\/' \|\| p\.slug \|\| '\/photos\/' \|\| left\(md5\('directory-photo:' \|\| ph\.id::text\), 16\)/,
    );
    expect(e).toMatch(/ORDER BY ph\.position, ph\.created_at/);
    // Never the path, the bucket, an id or a credit.
    expect(e).not.toMatch(
      /ph\.path|directory-photos|storage|organization_id'|'id'|credit|pexels|photo by/i,
    );
    expect(view()).toMatch(/WHERE p\.published\s+AND o\.deleted_at IS NULL/);
  });

  it("is the list the proof expects, key for key", () => {
    const proof = readFileSync(PROOF, "utf8");
    const keys = /_keys IS DISTINCT FROM ARRAY\[([^\]]+)\]/.exec(proof)![1];
    expect([...keys.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_LISTING_FIELDS].sort(),
    );
    const ph = /_ph IS DISTINCT FROM ARRAY\[([^\]]+)\]/.exec(proof)![1];
    expect([...ph.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_PHOTO_FIELDS].sort(),
    );
  });

  it("is what the e2e contract against a real stack expects", () => {
    const e2e = read("tests/e2e/a-quote-from-mypets-lands-in-the-test-org.spec.ts");
    const list = /const PUBLIC_FIELDS = \[([^\]]+)\]/.exec(e2e)![1];
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_LISTING_FIELDS].sort(),
    );
  });

  // AC2.1, on this side: a TEST profile with three approved photos and one
  // pending one comes out of the reader as exactly the three, with alt.
  it("toDirectoryListings keeps url, alt and position of each photo the view could have made, and drops the rest", () => {
    const slug = "qa-test-882";
    const key = (n: number) => `/d/${slug}/photos/${String(n).repeat(16)}`;
    const [l] = toDirectoryListings([
      {
        slug,
        display_name: "QA TEST 882",
        logo_url: null,
        bio: null,
        service_lines: ["dog_walking"],
        coverage_zips: ["48201"],
        coverage_cities: [],
        services: [],
        published_at: null,
        tagline: null,
        highlights: [],
        areas: [],
        books_online: false,
        booking_policy_text: null,
        book_path: null,
        photos: [
          { url: key(2), alt: "Clean back lawn", position: 1, id: "leak", path: "org/leak.jpg" },
          {
            url: key(1),
            alt: "Gate latched after a visit",
            position: 0,
            credit: "Photo by Someone on Pexels",
          },
          { url: key(3), alt: "Our van at the curb", position: 2, status: "approved" },
          // Not something the view makes for this listing:
          { url: "https://example.test/x.jpg", alt: "Elsewhere", position: 3 },
          { url: `/d/qa-test-882b/photos/${"4".repeat(16)}`, alt: "Another listing", position: 4 },
          { url: key(5), alt: "", position: 5 },
          { url: key(6), alt: "No position" },
          "junk",
        ],
        organization_id: "leak",
      },
    ]);
    expect(Object.keys(l).sort()).toEqual([...PUBLIC_LISTING_FIELDS].sort());
    expect(l.photos.map((p) => p.alt)).toEqual([
      "Gate latched after a visit",
      "Clean back lawn",
      "Our van at the curb",
    ]);
    for (const p of l.photos) {
      expect(Object.keys(p).sort()).toEqual([...PUBLIC_PHOTO_FIELDS].sort());
      expect(isDirectoryPhotoUrl(p.url, slug)).toBe(true);
    }
    expect(JSON.stringify(l)).not.toMatch(/leak|Photo by|Pexels|credit|status/i);
  });

  it("toDirectoryListings reads a row from before step 5b as no photos", () => {
    const [l] = toDirectoryListings([
      {
        slug: "old-row",
        display_name: "Old",
        services: [],
        service_lines: [],
        coverage_zips: [],
        coverage_cities: [],
      },
    ]);
    expect(l.photos).toEqual([]);
  });
});

// ── Moderation states ────────────────────────────────────────────────────────
describe("the moderation states", () => {
  it("are pending, approved and rejected, the database's three", () => {
    expect([...DIRECTORY_PHOTO_STATUSES]).toEqual(["pending", "approved", "rejected"]);
    expect(sql()).toMatch(/status IN \('pending', 'approved', 'rejected'\)/);
  });

  it("count toward the eight when pending or approved, never when rejected", () => {
    expect(countsTowardPhotoLimit("pending")).toBe(true);
    expect(countsTowardPhotoLimit("approved")).toBe(true);
    expect(countsTowardPhotoLimit("rejected")).toBe(false);
  });

  it("tell the owner in plain words which ones show", () => {
    expect(DIRECTORY_PHOTO_STATUS_LABEL).toEqual({
      pending: "Waiting for review",
      approved: "Approved, shown on your listing",
      rejected: "Not approved, not shown",
    });
  });

  it("are all three offered in the queue, which only a moderator can read or change", () => {
    const page = read("src/routes/platform.directory-photos.tsx");
    expect(page).toMatch(/createFileRoute\("\/platform\/directory-photos"\)/);
    expect(page).toMatch(/DIRECTORY_PHOTO_STATUSES\.map/);
    expect(page).toMatch(/pending: "Waiting",\s+approved: "Approved",\s+rejected: "Rejected",/);
    expect(read("src/routes/platform.tsx")).toMatch(/to: "\/platform\/directory-photos"/);
    const fns = read("src/lib/directory-photos.functions.ts");
    for (const name of ["listDirectoryPhotoQueue", "moderateDirectoryPhoto"]) {
      const body = fns.split(`export const ${name}`)[1].split("export const")[0];
      expect(body.indexOf("assertModerator(context.supabase, context.userId)")).toBeGreaterThan(-1);
      expect(body.indexOf("assertModerator(")).toBeLessThan(body.indexOf(".rpc("));
      expect(body).not.toMatch(/supabaseAdmin/);
    }
    // The page never receives a storage path.
    const queue = fns.split("export const listDirectoryPhotoQueue")[1].split("export const")[0];
    expect(queue).toMatch(/list\.map\(\(\{ path, \.\.\.r \}\)/);
  });
});

// ── The upload ───────────────────────────────────────────────────────────────
describe("the upload", () => {
  const ORG = "08820000-0000-4000-8000-0000000000aa";
  const FILE = "a8820000-0000-4000-8000-000000000001";

  it("asks for the attestation word for word, and shows it in Settings", () => {
    expect(DIRECTORY_PHOTO_ATTESTATION).toBe(
      "I took these or have the rights to use them, and they are not AI-generated",
    );
    const ui = read("src/components/directory/DirectoryPhotosSettings.tsx");
    expect(ui).toMatch(/\{DIRECTORY_PHOTO_ATTESTATION\}/);
    expect(ui).toMatch(
      /const ready = !!file && !fileProblem && !photoAltProblem\(alt\) && attested && !!folder;/,
    );
    expect(read("src/routes/_authenticated/settings.directory.tsx")).toMatch(
      /<DirectoryPhotosSettings disabled=\{!canEdit\} \/>/,
    );
  });

  it("is refused without the attestation, without alt, or with more than 140 characters of it", () => {
    const ok = {
      path: directoryPhotoPath(ORG, FILE, "image/jpeg"),
      alt: "  A latched gate  ",
      position: 0,
      attested: true,
    };
    expect(addDirectoryPhotoSchema.parse(ok).alt).toBe("A latched gate");
    expect(addDirectoryPhotoSchema.safeParse({ ...ok, attested: false }).success).toBe(false);
    expect(addDirectoryPhotoSchema.safeParse({ ...ok, attested: undefined }).success).toBe(false);
    expect(addDirectoryPhotoSchema.safeParse({ ...ok, alt: "   " }).success).toBe(false);
    expect(addDirectoryPhotoSchema.safeParse({ ...ok, alt: "x".repeat(141) }).success).toBe(false);
    expect(addDirectoryPhotoSchema.safeParse({ ...ok, alt: "x".repeat(140) }).success).toBe(true);
    expect(photoAltProblem("")).toMatch(/Describe the photo/);
    expect(photoAltProblem("x".repeat(141))).toMatch(/140 characters/);
    expect(photoAltProblem("A latched gate")).toBeNull();
  });

  it("goes only into the business's own folder, as JPEG, PNG or WebP under 5 MB", () => {
    expect(directoryPhotoPath(ORG, FILE, "image/png")).toBe(`${ORG}/${FILE}.png`);
    expect(isDirectoryPhotoPath(`${ORG}/${FILE}.jpg`, ORG)).toBe(true);
    expect(isDirectoryPhotoPath(`${ORG}/${FILE}.jpg`, "08820000-0000-4000-8000-0000000000bb")).toBe(
      false,
    );
    expect(isDirectoryPhotoPath(`${ORG}/../${FILE}.jpg`, ORG)).toBe(false);
    expect(isDirectoryPhotoPath(`${ORG}/${FILE}.gif`, ORG)).toBe(false);
    expect(photoFileProblem({ type: "image/heic", size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(photoFileProblem({ type: "image/jpeg", size: 5 * 1024 * 1024 + 1 })).toMatch(
      /under 5 MB/,
    );
    expect(photoFileProblem({ type: "image/webp", size: 1000 })).toBeNull();
    const fns = read("src/lib/directory-photos.functions.ts");
    const add = fns.split("export const addMyDirectoryPhoto")[1].split("export const")[0];
    expect(add.indexOf('if (role !== "owner")')).toBeLessThan(
      add.indexOf("isDirectoryPhotoPath(data.path, orgId)"),
    );
    expect(add).not.toMatch(/supabaseAdmin|status:|moderated/);
  });

  it("lets an owner write photos on their own client only, never the service role", () => {
    const fns = read("src/lib/directory-photos.functions.ts");
    for (const name of [
      "getMyDirectoryPhotos",
      "addMyDirectoryPhoto",
      "updateMyDirectoryPhoto",
      "removeMyDirectoryPhoto",
    ]) {
      const body = fns.split(`export const ${name}`)[1].split("export const")[0];
      expect(body, name).toMatch(/role !== "owner"/);
      expect(body, name).not.toMatch(/supabaseAdmin/);
    }
  });
});

// ── What a visitor fetches ───────────────────────────────────────────────────
describe("the photo URL", () => {
  it("is a public route that stays in the browser", () => {
    const route = read("src/routes/d.$slug.photos.$key.ts");
    expect(route).toMatch(/createFileRoute\("\/d\/\$slug\/photos\/\$key"\)/);
    expect(route).toMatch(/servePublicDirectoryPhoto\(params\.slug, params\.key\)/);
    expect(STAYS_IN_BROWSER["/d"]).toBeTruthy();
  });

  it("answers 404, without asking the database, for a slug or key the view could not have made", async () => {
    for (const [slug, key] of [
      ["Not A Slug!", "0".repeat(16)],
      ["qa-test-882", "short"],
      ["qa-test-882", "../../etc/passwd"],
      ["qa-test-882", "Z".repeat(16)],
    ]) {
      const r = await servePublicDirectoryPhoto(slug, key);
      expect(r.status).toBe(404);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(isDirectoryPhotoKey("0123456789abcdef")).toBe(true);
  });

  it("serves the bytes of an approved photo only, never a redirect or signed URL that would carry the path", () => {
    const fns = read("src/lib/directory-photos.functions.ts");
    const serve = fns.split("export async function servePublicDirectoryPhoto")[1];
    expect(serve).toMatch(/rpc\("directory_photo_object"/);
    expect(serve).toMatch(/\.download\(path\)/);
    expect(serve).not.toMatch(/createSignedUrl|status: 30[12]|Location/);
    expect(serve).toMatch(/"Cache-Control": `public, max-age=\$\{PUBLIC_PHOTO_MAX_AGE\}`/);
  });
});

// ── No credit line, no em dash ───────────────────────────────────────────────
describe("the words", () => {
  const FILES = [
    "src/components/directory/DirectoryPhotosSettings.tsx",
    "src/routes/platform.directory-photos.tsx",
    "src/lib/directory-photos.functions.ts",
    "src/routes/d.$slug.photos.$key.ts",
  ];

  it("render no credit line anywhere: Settings, /platform, the server or the view", () => {
    for (const f of FILES) {
      const code = read(f)
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(code, f).not.toMatch(/photo by|pexels|unsplash|credit|photographer|licen[cs]e/i);
    }
    expect(view()).not.toMatch(/photo by|pexels|credit|photographer|licen[cs]e/i);
  });

  it("use no em or en dash in the step 5b copy", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/[–—]/);
  });
});

// ── The proof, in a real database ───────────────────────────────────────────
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the ${NAME} proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a directory photo waits for a moderator, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("attestation, pending, no self-approval, the queue, three approved of four, AC2.4, the bucket, the lookup, rejected, the eight, and both mutations reproduce", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect(out).toMatch(/ALL DIRECTORY PHOTO PROOFS PASSED/);
  });
});
