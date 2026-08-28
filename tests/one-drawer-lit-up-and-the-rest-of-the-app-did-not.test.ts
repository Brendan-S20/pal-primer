// Address autocomplete was built, complete, and reachable from one drawer.
//
// `src/lib/address/` has a pluggable provider interface, a Google Places
// implementation, a registry, a server proxy with a bias cache and per-user
// rate limiting, and a keyboard-accessible React control. All of it worked.
// Exactly one form imported it: PropertyDrawer.tsx. Every other place a person
// types a street address — the new-client wizard, both staff route-endpoint
// editors, the canvassing door form, the disposal-facility form, the business
// address — went on being a bare <Input>.
//
// That is not a half-finished feature, it is a feature that would half-arrive.
// The day somebody sets GOOGLE_PLACES_API_KEY, one drawer would start matching
// addresses and the wizard beside it would not, and the difference would read
// as a bug in the new feature rather than as five forms nobody wired.
//
// check-dead-machinery.mjs exists for exactly this class of defect — built,
// granted, and called by nothing — but it deliberately only walks the seams
// between SYSTEMS (SQL→app, cron→endpoint, writer→reader). "A React component
// only one of its six call sites uses" is invisible to it and to the compiler,
// because a component with one caller is perfectly well-typed.
//
// Two rules here, and the second is the one that will still be doing work in a
// year:
//
//   1. a named list of the surfaces, each with what it is, so a deletion has
//      to be deliberate;
//   2. a derived rule with no list in it — any file that client-side geocodes
//      a string the user just typed is by definition a file where the user
//      just typed an address, and must offer to match it. That rule found
//      StaffRoutingDialog.tsx, which is the SECOND editor for the same two
//      staff fields and was not in the task's list of places to look.
//
// And the negative half, which matters just as much: the public routes must
// NOT use it. See the comment in signup.$slug.tsx.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every surface in the staff app where somebody types a street address. */
const WIRED: Array<[string, string]> = [
  ["src/components/client-detail/PropertyDrawer.tsx", "add/edit a property — the reference wiring"],
  ["src/routes/_authenticated/clients.new.tsx", "new-client wizard, step 1: the service address"],
  ["src/routes/_authenticated/settings.users.tsx", "staff route start and end"],
  ["src/components/routes/StaffRoutingDialog.tsx", "the same two fields, opened from the board"],
  ["src/routes/_authenticated/neighbors.tsx", "canvassing: add a door manually"],
  ["src/routes/_authenticated/waste-log.tsx", "disposal facility address"],
  [
    // Moved 2026-08-28 out of Preferences and into the Client portal page.
    "src/components/settings/ClientPortalCards.tsx",
    "the business address, geocoded for routing",
  ],
];

/** Public routes. An anonymous caller has no Supabase session, and all three
 *  address server functions are behind requireSupabaseAuth — so the control
 *  could only fail there. Dropping the middleware to fix that would put an
 *  unauthenticated proxy to a metered Google API on a page that exists to be
 *  linked from adverts, with a rate limit keyed on a userId that does not
 *  exist. */
const PUBLIC: Array<[string, string]> = [
  ["src/routes/signup.$slug.tsx", "public tenant signup"],
  ["src/routes/lead.$slug.tsx", "public lead capture"],
];

describe("every staff form that takes an address offers to match it", () => {
  for (const [file, what] of WIRED) {
    it(`${file} — ${what}`, () => {
      const src = read(file);
      expect(src, "imports AddressAutocomplete").toMatch(
        /from "@\/components\/AddressAutocomplete"/,
      );
      expect(src, "renders it").toMatch(/<AddressAutocomplete\b/);
    });
  }

  it("hands every one of them a value and a way to type into it", () => {
    // The control degrades to plain manual entry, which only works if the call
    // site actually stores what is typed. A usage that passes `onResolved`
    // alone is a field that appears to work until the provider is off.
    const offenders: string[] = [];
    for (const [file] of WIRED) {
      const src = read(file);
      for (const m of src.matchAll(/<AddressAutocomplete\b([\s\S]*?)\/>/g)) {
        const props = m[1];
        const line = src.slice(0, m.index).split("\n").length;
        if (!/\bvalue=/.test(props)) offenders.push(`${file}:${line} has no value prop`);
        if (!/\bonChangeText=/.test(props)) offenders.push(`${file}:${line} has no onChangeText`);
        if (/onChangeText=\{\s*\(\s*\)\s*=>\s*\{?\s*\}?\s*\}/.test(props))
          offenders.push(`${file}:${line} onChangeText does nothing`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("the rule with no list in it", () => {
  it("every file that geocodes a typed string also offers to match it", () => {
    // A client-side Nominatim lookup of a value straight out of a text box is
    // the fingerprint of an address-entry surface. This is what catches the
    // seventh one that nobody remembered to add above.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx$/.test(name)) files.push(rel);
      }
    };
    walk("src");

    const offenders: string[] = [];
    for (const rel of files) {
      const src = read(rel);
      if (!src.includes("nominatim.openstreetmap.org")) continue;
      if (!src.includes("AddressAutocomplete"))
        offenders.push(`${rel} geocodes a typed address but offers no address matching`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("no public route proxies the paid API", () => {
  for (const [file, what] of PUBLIC) {
    it(`${file} — ${what}`, () => {
      const src = read(file);
      expect(src, "must not render AddressAutocomplete").not.toMatch(/<AddressAutocomplete\b/);
    });
  }

  it("the address server functions all still require a staff session", () => {
    // The tempting way to make the public forms work, and the reason the two
    // assertions above are not enough on their own.
    const src = read("src/lib/address.functions.ts");
    const fns = src.match(
      /export const \w+ = createServerFn\([\s\S]*?\)\n\s*\.middleware\(\[[^\]]*\]\)/g,
    );
    expect(fns, "found the exported server functions").toHaveLength(3);
    for (const fn of fns!) {
      expect(fn, fn.split("\n")[0]).toMatch(/requireSupabaseAuth/);
    }
  });
});
