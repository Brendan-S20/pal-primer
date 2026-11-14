// A directory listing says which services book online (#630; mypets v2 step
// 7: booking exposure).
//
// This file:
//   * pins 20261112100000: numbered after every migration on main and every
//     open PR's, additive only (drops no column, table, function or view,
//     and the view keeps every column it had, in place), the switch NOT NULL
//     DEFAULT false, the writer owner-only and not anon's, the hand-off lookup
//     service-role only;
//   * pins the CONTRACT: directory_public_listings' columns, the keys of a
//     listed service and of its package, the proof's expected keys, the e2e's
//     list and PUBLIC_LISTING_FIELDS / PUBLIC_SERVICE_FIELDS /
//     PUBLIC_PACKAGE_FIELDS are one list, and toDirectoryListings drops
//     anything else whatever the view returns;
//   * pins the EFFECTIVE MODE rules (directoryBookingMode), case by case, and
//     the view's CASE to the same pieces;
//   * pins the hand-off: /d/{slug}/book lands on /signup/{booking slug} with
//     ref, and with book=1 only when the listing says the service sells now;
//     a return URL is the directory app's own or nothing;
//   * pins the attribution: ref=DIRECTORY_REF, and only that, tags a lead
//     LEAD_SOURCE.directoryBooking, labelled "Directory booking";
//   * runs tests/sql/a-directory-listing-says-which-services-book-online.proof.sql
//     against a real database when one answers (skipped, loudly, when none
//     does). CI's database job runs the same proof through supabase/proofs/.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BOOKING_POLICY_MAX,
  PUBLIC_LISTING_FIELDS,
  PUBLIC_PACKAGE_FIELDS,
  PUBLIC_SERVICE_FIELDS,
  cleanBookingPolicy,
  directoryBookingHref,
  directoryBookingMode,
  directoryBookingSearch,
  type DirectoryBookingGates,
  type DirectoryBookingService,
  type DirectoryListedService,
  type DirectoryListing,
  type DirectoryPackage,
} from "@/lib/directory";
import { DIRECTORY_BRAND, DIRECTORY_REF } from "@/lib/directory-site";
import { directoryProfileSchema, toDirectoryListings } from "@/lib/directory.functions";
import { decideDirectoryBooking, directoryReturnUrl } from "@/lib/directory-booking.functions";
import { LEAD_SOURCE, leadBodyFromForm, leadOriginLabel } from "@/lib/new-customer-form";
import { signupCheckoutSchema } from "@/lib/signup.functions";
import { STAYS_IN_BROWSER, appLinkClaims } from "@/lib/android-app-links";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const STAMP = "20261112100000";
const NAME = "a-directory-listing-says-which-services-book-online";
const MIGRATION = join(ROOT, `supabase/migrations/${STAMP}_${NAME}.sql`);
const PROOF = join(
  ROOT,
  "tests/sql/a-directory-listing-says-which-services-book-online.proof.sql",
);
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const sql = () => codeOnly(readFileSync(MIGRATION, "utf8"));

// Exact both ways: a key added to a type without a decision in the
// allowlist fails to compile, and so does an allowlist entry the type lacks.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _listing: Exact<(typeof PUBLIC_LISTING_FIELDS)[number], keyof DirectoryListing> = true;
const _service: Exact<(typeof PUBLIC_SERVICE_FIELDS)[number], keyof DirectoryListedService> = true;
const _package: Exact<(typeof PUBLIC_PACKAGE_FIELDS)[number], keyof DirectoryPackage> = true;
void _listing;
void _service;
void _package;

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

const view = () =>
  sql().split("CREATE OR REPLACE VIEW public.directory_public_listings")[1].split(";")[0];

describe("the migration", () => {
  it("is timestamped after every other migration and every open PR's, with a proof beside it", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(STAMP))).toEqual([`${STAMP}_${NAME}.sql`]);
    // Main's newest before it is 20261112090000 (step 5a); the open PRs
    // checked when this was written hold 20261112080000 (#912) and
    // 20261112030000 (#906).
    expect(STAMP > "20261112090000").toBe(true);
    expect(files.map((f) => f.slice(0, 14)).sort().at(-1)).toBe(STAMP);
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/PROPOSED MIGRATION\. File only/);
    expect(read(`supabase/proofs/${STAMP}-${NAME}.sql`)).toMatch(
      new RegExp(`\\\\ir \\.\\./\\.\\./tests/sql/${NAME}\\.proof\\.sql`),
    );
  });

  it("is additive: it drops no column, table, function or view, and changes no column", () => {
    const s = sql();
    expect(s).not.toMatch(/DROP\s+(TABLE|COLUMN|FUNCTION|VIEW)\b/i);
    expect(s).not.toMatch(/ALTER TABLE[^;]*DROP COLUMN/i);
    expect(s).not.toMatch(/ALTER COLUMN/i);
    // directory_search, directory_profiles_by_slug and directory_public_rows
    // keep their shape; the writers 5a made are untouched.
    expect(s).not.toMatch(
      /FUNCTION public\.(directory_search|directory_profiles_by_slug|directory_public_rows|set_directory_profile|set_directory_profile_areas)\b/,
    );
  });

  it("adds the switch OFF for every business, and a policy of at most 400 trimmed characters", () => {
    const s = sql();
    expect(s).toMatch(
      /ADD COLUMN IF NOT EXISTS directory_booking_enabled boolean NOT NULL DEFAULT false;/,
    );
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS booking_policy_text text;/);
    expect(s).toMatch(/char_length\(booking_policy_text\) BETWEEN 1 AND 400/);
    expect(s).toMatch(/booking_policy_text = btrim\(booking_policy_text\)/);
    expect(BOOKING_POLICY_MAX).toBe(400);
    // Nothing in the file turns it on for anyone.
    expect(s).not.toMatch(/directory_booking_enabled\s*=\s*true/i);
    const sets = [...s.matchAll(/SET directory_booking_enabled = ([^\n]+),\n/g)].map((m) => m[1]);
    expect(sets).toEqual(["COALESCE(_enabled, false)"]);
  });

  it("lets only an owner write the switch or the policy, through the one writer", () => {
    const s = sql();
    const body = s.split("FUNCTION public.set_directory_booking(")[1].split("$fn$;")[0];
    const check = body.indexOf("public.has_role(auth.uid(), _org, 'owner'::public.app_role)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf("UPDATE public.organizations"));
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_directory_booking\(uuid, boolean, text\) FROM PUBLIC, anon;/,
    );
    expect(s).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.set_directory_booking[^;]*anon/);
    // A settings manager can UPDATE organizations under RLS, so the columns
    // have their own guard.
    expect(s).toMatch(
      /BEFORE UPDATE OF directory_booking_enabled, booking_policy_text ON public\.organizations/,
    );
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.organizations_guard_directory_booking\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("keeps the hand-off lookup to the service role", () => {
    const s = sql();
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.directory_booking_handoff\(text, text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(s).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.directory_booking_handoff\(text, text\) TO service_role;/,
    );
    // It reads the view, so it cannot disagree with the listing.
    const body = s.split("FUNCTION public.directory_booking_handoff(")[1].split("$fn$;")[0];
    expect(body).toMatch(/FROM public\.directory_public_listings v/);
  });
});

describe("the public contract", () => {
  it("is the view's columns, in order, and nothing else", () => {
    expect(viewColumns(view())).toEqual([...PUBLIC_LISTING_FIELDS]);
    expect(sql()).toMatch(
      /IF _cols IS DISTINCT FROM ARRAY\['slug', 'display_name', 'logo_url', 'bio', 'service_lines',\s+'coverage_zips', 'coverage_cities', 'services', 'published_at',\s+'tagline', 'highlights', 'areas',\s+'books_online', 'booking_policy_text', 'book_path'\]/,
    );
  });

  it("drops no existing column: the view it replaces is a prefix of this one", () => {
    const before = codeOnly(
      read(
        "supabase/migrations/20261112090000_a-directory-profile-says-what-a-business-is-and-where.sql",
      ),
    )
      .split("CREATE OR REPLACE VIEW public.directory_public_listings")[1]
      .split(";")[0];
    const first = viewColumns(before);
    expect(first).toHaveLength(12);
    expect(viewColumns(view()).slice(0, first.length)).toEqual(first);
    expect(viewColumns(view()).slice(first.length)).toEqual([
      "books_online",
      "booking_policy_text",
      "book_path",
    ]);
  });

  it("names exactly the allowlisted keys for a listed service and its package", () => {
    const v = view();
    const svc = v.split("LEFT JOIN LATERAL (")[1].split("ORDER BY b.position")[0];
    expect([...svc.matchAll(/'([a-z_]+)', (?:b\.|CASE)/g)].map((m) => m[1])).toEqual([
      ...PUBLIC_SERVICE_FIELDS,
    ]);
    const pack = v.split("AS booking_mode,")[1].split("AS pack")[0];
    expect([...pack.matchAll(/'([a-z_]+)', pk\./g)].map((m) => m[1])).toEqual([
      ...PUBLIC_PACKAGE_FIELDS,
    ]);
    // The package's id is never built into it.
    expect(pack).not.toMatch(/pk\.id\b(?! IS NOT NULL)/);
  });

  it("returns no organization, service or package id, contact detail, address or booking slug", () => {
    const v = view();
    const returned = v
      .replace(/WHERE ds\.organization_id = p\.organization_id/, "")
      .replace(/WHERE a\.organization_id = p\.organization_id/, "")
      .replace(/JOIN public\.organizations o ON o\.id = p\.organization_id/, "")
      .replace(/ON sv\.id = ds\.service_id AND sv\.organization_id = ds\.organization_id/, "")
      .replace(
        /ON pk\.id = sv\.public_package_id\s+AND pk\.organization_id = sv\.organization_id\s+AND pk\.service_id = sv\.id/,
        "",
      )
      .replace("CASE WHEN p.show_logo THEN o.logo_url END AS logo_url", "")
      .replace(/left\(md5\('directory-service:' \|\| ds\.service_id::text\), 12\) AS booking_key/, "")
      .replace(/WHEN sv\.id IS NULL/, "")
      .replace(/pk\.id IS NOT NULL/g, "");
    for (const forbidden of [
      "organization_id",
      "service_id",
      "public_package_id",
      "sv.id",
      "pk.id",
      "confirmed_by",
      "client_id",
      "phone",
      "email",
      "street",
      "address",
      "contact_",
      "portal_slug",
      "o.slug",
      "stripe_connect_account",
      "stripe_customer",
    ]) {
      expect(returned, forbidden).not.toMatch(new RegExp(`\\b${forbidden.replace(".", "\\.")}`));
    }
    expect(v).toMatch(/WHERE p\.published\s+AND o\.deleted_at IS NULL/);
    // book_path names the DIRECTORY slug.
    expect(v).toMatch(/'\/d\/' \|\| p\.slug \|\| '\/book'/);
  });

  it("works the effective mode out from the same pieces as directoryBookingMode", () => {
    const v = view();
    for (const piece of [
      /NOT \(o\.directory_booking_enabled\s+AND o\.public_signup_enabled\s+AND o\.stripe_connect_charges_enabled\) THEN 'request_only'/,
      /OR NOT sv\.active/,
      /l\.service_line = sv\.service_line AND l\.bookable/,
      /NOT \(sv\.service_line = 'pet_waste' OR sv\.base_price_cents IS NOT NULL\)/,
      /WHEN sv\.public_booking_mode IN \('one_time', 'recurring'\) THEN sv\.public_booking_mode/,
      /sv\.public_booking_mode = 'package'\s+AND sv\.service_line <> 'mobile_grooming'\s+AND pk\.id IS NOT NULL THEN 'package'/,
      /AND pk\.active\s+AND pk\.sessions_count > 0\s+AND pk\.price_cents > 0/,
      /ELSE 'request_only'/,
      /bool_or\(b\.booking_mode <> 'request_only'\) AS books_online/,
    ]) {
      expect(v).toMatch(piece);
    }
  });

  it("is the list the proof expects, key for key", () => {
    const proof = readFileSync(PROOF, "utf8");
    const keys = /_keys IS DISTINCT FROM ARRAY\[([^\]]+)\]/.exec(proof)![1];
    expect([...keys.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_LISTING_FIELDS].sort(),
    );
    const svc = /_svc IS DISTINCT FROM ARRAY\[([^\]]+)\]/.exec(proof)![1];
    expect([...svc.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_SERVICE_FIELDS].sort(),
    );
    const pkg = /_pkg IS DISTINCT FROM ARRAY\[([^\]]+)\]/.exec(proof)![1];
    expect([...pkg.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_PACKAGE_FIELDS].sort(),
    );
  });

  it("is what the e2e contract against a real stack expects", () => {
    const e2e = read("tests/e2e/a-quote-from-mypets-lands-in-the-test-org.spec.ts");
    const list = /const PUBLIC_FIELDS = \[([^\]]+)\]/.exec(e2e)![1];
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_LISTING_FIELDS].sort(),
    );
  });

  it("toDirectoryListings keeps the allowlist and drops everything else, at every level", () => {
    const base = {
      slug: "acme-walks",
      display_name: "Acme",
      logo_url: null,
      bio: null,
      service_lines: ["dog_walking", "training"],
      coverage_zips: ["48201"],
      coverage_cities: [],
      published_at: null,
      tagline: null,
      highlights: [],
      areas: [],
      organization_id: "leak",
      contact_email: "owner@acme.test",
    };
    const [l] = toDirectoryListings([
      {
        ...base,
        services: [
          {
            label: "Walk",
            service_line: "dog_walking",
            price_from_cents: 2200,
            price_unit: "visit",
            booking_mode: "recurring",
            booking_key: "0123456789ab",
            package: null,
            service_id: "leak",
          },
          {
            label: "Lessons",
            service_line: "training",
            price_from_cents: null,
            price_unit: "visit",
            booking_mode: "package",
            booking_key: "ba9876543210",
            package: { name: "Five lessons", sessions_count: 5, price_cents: 27500, id: "leak" },
          },
          {
            label: "Sit",
            service_line: "pet_sitting",
            price_from_cents: null,
            price_unit: "night",
            booking_mode: "sell_everything",
            booking_key: "aaaaaaaaaaaa",
            package: { name: "Not shown", sessions_count: 1, price_cents: 1 },
          },
        ],
        books_online: true,
        booking_policy_text: "Cancel 24 hours ahead for a full refund.",
        book_path: "/d/acme-walks/book",
        stripe_connect_account_id: "leak",
      },
    ]);
    expect(Object.keys(l).sort()).toEqual([...PUBLIC_LISTING_FIELDS].sort());
    for (const s of l.services) {
      expect(Object.keys(s).sort()).toEqual([...PUBLIC_SERVICE_FIELDS].sort());
    }
    expect(l.services.map((s) => s.booking_mode)).toEqual(["recurring", "package", "request_only"]);
    expect(l.services[1].package).toEqual({ name: "Five lessons", sessions_count: 5, price_cents: 27500 });
    expect(Object.keys(l.services[1].package!).sort()).toEqual([...PUBLIC_PACKAGE_FIELDS].sort());
    // A package is shown only for a package-mode service.
    expect(l.services[0].package).toBeNull();
    expect(l.services[2].package).toBeNull();
    expect(l.books_online).toBe(true);
    expect(l.book_path).toBe("/d/acme-walks/book");
    expect(l.booking_policy_text).toBe("Cancel 24 hours ahead for a full refund.");
    expect(JSON.stringify(l)).not.toMatch(/leak|acme\.test/);
  });

  it("toDirectoryListings reads a row from before step 7 as request only, with no book path", () => {
    const [l] = toDirectoryListings([
      {
        slug: "old-row",
        display_name: "Old",
        services: [{ label: "Walk", service_line: "dog_walking", price_from_cents: 1, price_unit: "visit" }],
        service_lines: [],
        coverage_zips: [],
        coverage_cities: [],
        // A row that claims books_online with nothing sellable is not believed.
        books_online: true,
        book_path: "/d/old-row/book",
      },
    ]);
    expect(l.services[0]).toMatchObject({ booking_mode: "request_only", booking_key: "", package: null });
    expect(l.books_online).toBe(false);
    expect(l.book_path).toBeNull();
    expect(l.booking_policy_text).toBeNull();
  });
});

describe("the effective booking mode", () => {
  const on: DirectoryBookingGates = {
    directoryBookingEnabled: true,
    publicSignupEnabled: true,
    chargesEnabled: true,
  };
  const walk = (over: Partial<DirectoryBookingService> = {}): DirectoryBookingService => ({
    active: true,
    service_line: "dog_walking",
    base_price_cents: 2500,
    public_booking_mode: "recurring",
    lineBookable: true,
    pack: null,
    ...over,
  });
  const pack = { active: true, sessions_count: 5, price_cents: 27500 };
  const lesson = (over: Partial<DirectoryBookingService> = {}) =>
    walk({ service_line: "training", public_booking_mode: "package", pack, ...over });

  it("is request only while the directory switch is off: nobody is opted in by default", () => {
    expect(directoryBookingMode({ ...on, directoryBookingEnabled: false }, walk())).toBe(
      "request_only",
    );
  });
  it("is request only while public signup is off", () => {
    expect(directoryBookingMode({ ...on, publicSignupEnabled: false }, walk())).toBe("request_only");
  });
  it("is request only while Stripe charges are off", () => {
    expect(directoryBookingMode({ ...on, chargesEnabled: false }, walk())).toBe("request_only");
  });
  it("keeps a request-only service request only, with every gate on", () => {
    expect(directoryBookingMode(on, walk({ public_booking_mode: "request_only" }))).toBe(
      "request_only",
    );
    expect(directoryBookingMode(on, walk({ public_booking_mode: null }))).toBe("request_only");
    expect(directoryBookingMode(on, walk({ public_booking_mode: "weekly" }))).toBe("request_only");
  });
  it("sells recurring, one visit and a package with a package on sale", () => {
    expect(directoryBookingMode(on, walk())).toBe("recurring");
    expect(directoryBookingMode(on, walk({ public_booking_mode: "one_time" }))).toBe("one_time");
    expect(directoryBookingMode(on, lesson())).toBe("package");
  });
  it("is request only for a package mode with no package that can be sold", () => {
    expect(directoryBookingMode(on, lesson({ pack: null }))).toBe("request_only");
    expect(directoryBookingMode(on, lesson({ pack: { ...pack, active: false } }))).toBe("request_only");
    expect(directoryBookingMode(on, lesson({ pack: { ...pack, price_cents: 0 } }))).toBe("request_only");
    expect(directoryBookingMode(on, lesson({ pack: { ...pack, sessions_count: 0 } }))).toBe(
      "request_only",
    );
    // A groom is a day and a time on a van, never a package.
    expect(directoryBookingMode(on, lesson({ service_line: "mobile_grooming" }))).toBe("request_only");
  });
  it("is request only for a service the booking link would not list", () => {
    expect(directoryBookingMode(on, walk({ active: false }))).toBe("request_only");
    expect(directoryBookingMode(on, walk({ lineBookable: false }))).toBe("request_only");
    expect(directoryBookingMode(on, walk({ base_price_cents: null }))).toBe("request_only");
    // Zone-priced pet waste has no base price and still sells.
    expect(
      directoryBookingMode(on, walk({ service_line: "pet_waste", base_price_cents: null })),
    ).toBe("recurring");
  });
});

describe("the hand-off", () => {
  const row = {
    signup_slug: "acme-portal",
    service_id: "57370000-0000-4000-8000-0000000000a1",
    booking_mode: "recurring",
    books_online: true,
  };
  const parse = (href: string) => new URL(href, "https://app.test");

  it("goes to the business's own booking link with the service, the ZIP and ref, and book=1 when it sells", () => {
    const u = parse(directoryBookingHref(row, "48201"));
    expect(u.pathname).toBe("/signup/acme-portal");
    expect(u.searchParams.get("service")).toBe(row.service_id);
    expect(u.searchParams.get("zip")).toBe("48201");
    expect(u.searchParams.get("ref")).toBe(DIRECTORY_REF);
    expect(u.searchParams.get("book")).toBe("1");
  });

  it("drops book=1 for anything short of a service that sells now: the quote path", () => {
    for (const r of [
      { ...row, booking_mode: "request_only" },
      { ...row, books_online: false },
      { ...row, service_id: null },
    ]) {
      const u = parse(directoryBookingHref(r, null));
      expect(u.pathname).toBe("/signup/acme-portal");
      expect(u.searchParams.get("ref")).toBe(DIRECTORY_REF);
      expect(u.searchParams.has("book")).toBe(false);
      expect(u.searchParams.has("zip")).toBe(false);
    }
  });

  it("answers an unpublished or unknown listing with a page, and a failed lookup with the quote form", () => {
    expect(decideDirectoryBooking([], { slug: "gone" })).toEqual({ kind: "unavailable", back: null });
    expect(decideDirectoryBooking(null, { slug: "acme" })).toEqual({
      kind: "go",
      href: "/pros/acme/quote",
    });
    const go = decideDirectoryBooking([row], { slug: "acme", zip: 48201 });
    expect(go.kind).toBe("go");
    expect(go.kind === "go" && parse(go.href).searchParams.get("zip")).toBe("48201");
    // A ZIP that is not five digits is left out, not passed on.
    const bad = decideDirectoryBooking([row], { slug: "acme", zip: "4820%" });
    expect(bad.kind === "go" && parse(bad.href).searchParams.has("zip")).toBe(false);
  });

  it("takes a return URL only from the directory app's own origins", () => {
    expect(directoryReturnUrl(`https://${DIRECTORY_BRAND}/acme`)).toBe(`https://${DIRECTORY_BRAND}/acme`);
    expect(directoryReturnUrl(`https://www.${DIRECTORY_BRAND}/`)).toBe(`https://www.${DIRECTORY_BRAND}/`);
    expect(directoryReturnUrl(`http://${DIRECTORY_BRAND}/`)).toBeNull();
    expect(directoryReturnUrl(`https://${DIRECTORY_BRAND}.evil.example/`)).toBeNull();
    expect(directoryReturnUrl("https://evil.example/")).toBeNull();
    expect(directoryReturnUrl("javascript:alert(1)")).toBeNull();
    expect(directoryReturnUrl(42)).toBeNull();
    expect(decideDirectoryBooking([], { slug: "gone", returnTo: "https://evil.example/" })).toEqual({
      kind: "unavailable",
      back: null,
    });
  });

  it("is read back by the booking link: quote only unless book=1, and only for the directory's ref", () => {
    expect(directoryBookingSearch({ ref: DIRECTORY_REF })).toMatchObject({
      fromDirectory: true,
      quoteOnly: true,
    });
    expect(directoryBookingSearch({ ref: DIRECTORY_REF, book: "1" })).toMatchObject({
      fromDirectory: true,
      quoteOnly: false,
    });
    expect(directoryBookingSearch({ ref: DIRECTORY_REF, book: 1 }).quoteOnly).toBe(false);
    expect(directoryBookingSearch({ ref: DIRECTORY_REF, book: "yes" }).quoteOnly).toBe(true);
    // An ordinary visit, or someone else's ref, is the page it always was.
    expect(directoryBookingSearch({})).toMatchObject({ fromDirectory: false, quoteOnly: false });
    expect(directoryBookingSearch({ ref: "newsletter" })).toMatchObject({
      fromDirectory: false,
      quoteOnly: false,
    });
    expect(directoryBookingSearch({ service: "not-a-uuid", zip: "abc" })).toMatchObject({
      serviceId: null,
      zip: null,
    });
    expect(directoryBookingSearch({ zip: 8001 }).zip).toBe("08001");
  });

  it("is a public route that stays in the browser and redirects on the server", () => {
    const route = read("src/routes/d.$slug.book.tsx");
    expect(route).toMatch(/createFileRoute\("\/d\/\$slug\/book"\)/);
    expect(route).toMatch(/throw redirect\(\{ href: answer\.href, statusCode: 302 \}\)/);
    expect(route).toMatch(/directoryHead\(/);
    expect(STAYS_IN_BROWSER["/d"]).toBeTruthy();
    expect(appLinkClaims("/d/acme/book")).toBe(false);
    // It makes no charge: nothing in the hand-off talks to Stripe.
    const noComments = (t: string) => t.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const f of ["src/routes/d.$slug.book.tsx", "src/lib/directory-booking.functions.ts"]) {
      expect(noComments(read(f)), f).not.toMatch(/stripe|paymentIntent|createSignupPaymentIntent/i);
    }
  });

  it("uses the directory app's origin list, and no new environment variable", () => {
    const fn = read("src/lib/directory-booking.functions.ts");
    expect(fn).toMatch(/import \{ isDirectoryAppOrigin \} from "@\/lib\/directory-quote-cors"/);
    expect(fn).not.toMatch(/process\.env/);
  });
});

describe("the attribution", () => {
  it("adds one lead source, worded plainly", () => {
    expect(LEAD_SOURCE.directoryBooking).toBe("directory_booking");
    expect(leadOriginLabel("directory_booking", null)).toBe("Directory booking, asked for a quote");
    expect(leadOriginLabel("directory_booking", { status: "pending", refunded_at: null })).toBe(
      "Directory booking, didn't pay",
    );
    expect(leadOriginLabel("directory_booking", { status: "provisioned", refunded_at: null })).toBe(
      "Directory booking, started service",
    );
    for (const s of [null, { status: "failed", refunded_at: null }, { status: "provisioned", refunded_at: "x" }]) {
      expect(leadOriginLabel("directory_booking", s)).toMatch(/^Directory booking/);
      expect(leadOriginLabel("directory_booking", s)).not.toMatch(/—|–/);
    }
  });

  it("leaves an ordinary signup and quote request as they were", () => {
    expect(leadOriginLabel("online_signup", null)).toBe("Started signup online, didn't pay");
    expect(leadOriginLabel("website", null)).toBe("Quote request");
    const f = {
      name: "A",
      email: "a@example.test",
      phone: "",
      street: "",
      city: "",
      region: "",
      postal_code: "48201",
      dog_count: "1",
      frequency: "",
      message: "",
    };
    expect(leadBodyFromForm("acme", f).source).toBe("website");
  });

  it("is written only when the directory's ref came through", () => {
    const signup = read("src/lib/signup.functions.ts");
    expect(signup).toMatch(
      /data\.channel === "door"\s+\? LEAD_SOURCE\.doorSignup\s+: data\.ref === DIRECTORY_REF\s+\? LEAD_SOURCE\.directoryBooking\s+: LEAD_SOURCE\.onlineSignup/,
    );
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/\.\.\.\(fromDirectory \? \{ ref: DIRECTORY_REF \} : \{\}\)/);
    expect(flow).toMatch(
      /\.\.\.\(fromDirectory \? \{ source: LEAD_SOURCE\.directoryBooking \} : \{\}\)/,
    );
    const page = read("src/routes/signup.$slug.tsx");
    expect(page).toMatch(/fromDirectory=\{fromDirectory\.fromDirectory\}/);
    expect(page).toMatch(/quoteOnly=\{fromDirectory\.quoteOnly\}/);
    // The checkout accepts the directory's ref and nothing else in its place.
    const base = {
      slug: "acme",
      postal_code: "48201",
      dog_count: 1,
      frequency: "weekly",
      name: "A",
      email: "a@example.test",
      street: "1 Test St",
    };
    expect(signupCheckoutSchema.safeParse({ ...base, ref: DIRECTORY_REF }).success).toBe(true);
    expect(signupCheckoutSchema.safeParse({ ...base, ref: "somewhere-else" }).success).toBe(false);
    expect(signupCheckoutSchema.safeParse(base).success).toBe(true);
  });

  it("takes no card for a directory booking the owner has not switched on", () => {
    const signup = read("src/lib/signup.functions.ts");
    const guard = signup.indexOf("if (data.ref === DIRECTORY_REF) {");
    expect(guard).toBeGreaterThan(-1);
    expect(signup.slice(guard, guard + 700)).toMatch(
      /dirOrg\?\.directory_booking_enabled !== true\) \{[\s\S]*throw new Error\(DIRECTORY_BOOKING_OFF\)/,
    );
    // Before the PaymentIntent is made.
    expect(guard).toBeLessThan(signup.indexOf("paymentIntents.create"));
  });
});

describe("Settings → Directory listing", () => {
  const page = () => read("src/routes/_authenticated/settings.directory.tsx");

  it("has the switch in the owner's words, off until they turn it on", () => {
    const p = page();
    expect(p).toMatch(/Show Book online on \{DIRECTORY_BRAND\}/);
    expect(p).toMatch(/<Switch\s+id="dir-book-online"\s+checked=\{enabled\}/);
    expect(p).toMatch(/setBookOnline\(!!data\.booking\?\.enabled\)/);
    expect(p).toMatch(/Otherwise visitors still see Request a quote\./);
  });

  it("has the policy field, at most 400 characters, never written for the owner", () => {
    const p = page();
    expect(p).toMatch(/Cancellation and refund policy/);
    expect(p).toMatch(/we\s+never write a policy for you/);
    expect(cleanBookingPolicy("   ")).toBeNull();
    expect(cleanBookingPolicy("  Cancel a day ahead.  ")).toBe("Cancel a day ahead.");
  });

  it("uses no em or en dash in the step-7 copy", () => {
    const p = page();
    const section = p.split("function BookOnline(")[1].split("function Problems(")[0];
    expect(section).not.toMatch(/—|–/);
    const route = read("src/routes/d.$slug.book.tsx");
    expect(codeOnly(route).replace(/\/\/.*$/gm, "")).not.toMatch(/—|–/);
  });

  it("saves through the owner-only schema, with off and empty as the defaults", () => {
    const base = {
      slug: "acme-scoop",
      displayName: "Acme",
      bio: null,
      showLogo: false,
      coverageZips: ["48201"],
      coverageCities: [],
      services: [],
      published: false,
      tagline: null,
      highlights: [],
      areas: [],
    };
    const parsed = directoryProfileSchema.parse(base);
    expect(parsed.bookOnline).toBe(false);
    expect(parsed.bookingPolicyText).toBeNull();
    expect(
      directoryProfileSchema.parse({ ...base, bookOnline: true, bookingPolicyText: "  x  " })
        .bookingPolicyText,
    ).toBe("x");
    expect(() =>
      directoryProfileSchema.parse({ ...base, bookingPolicyText: "p".repeat(401) }),
    ).toThrow(/400/);
    const fn = read("src/lib/directory.functions.ts");
    const save = fn.split("export const saveMyDirectoryProfile")[1];
    expect(save.indexOf('if (role !== "owner")')).toBeLessThan(save.indexOf('rpc("set_directory_booking"'));
  });
});

// ── The proof, in a real database ─────────────────────────────────────────
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

describe.skipIf(!reachable)("a directory listing says which services book online, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("off by default, owner-only writes, the effective mode on every gate, anon through the view only, the hand-off agrees, and both mutations reproduce", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect(out).toMatch(/ALL DIRECTORY BOOKING PROOFS PASSED/);
  });
});
