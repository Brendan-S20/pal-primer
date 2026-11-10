// A zone's ZIP chips accepted anything alphanumeric, and a zone with a chip
// that cannot match is a zone that covers nothing without ever saying so.
//
// Owner QA, 2026-08-19, verbatim:
//
//   "When entering a zip code for zones, it should automatically assume it's
//    a United States zip code."
//
// ── WHAT WAS ACTUALLY BROKEN ──────────────────────────────────────────────
//
// `ZipChips.commit()` in src/components/ZoneDrawer.tsx did:
//
//   raw.split(/[\s,]+/).map((p) => p.trim().replace(/[^0-9A-Za-z-]/g, ""))
//
// and the server's `normalizeZips` did the same thing to whatever was posted.
// So "787", "ABC", "M5V 3A8" and "78701-1234" all became chips, all rendered
// identically to a real one, and all were written to `zones.zip_codes`.
//
// That matters because a zone matches a property by EXACT STRING EQUALITY on
// its postal code — `z.zip_codes.includes(pc)` in src/lib/zone-match.ts, and
// `_zip = ANY(z.zip_codes)` in the public_quote RPC. Neither side is
// normalized at match time. So none of those chips can ever equal a property's
// postal_code: the zone silently covers nothing, and the dispatcher looking at
// twelve ZIP badges has no way to see which of them are furniture.
//
// The worst of the four is "78701-1234", because the person typing it meant a
// real, specific, servable area and got a zone that serves none of it.
//
// ── WHAT THE FIX ASSUMES, AND WHAT IT REFUSES ─────────────────────────────
//
// Kept: a ZIP+4 keeps its 5-digit base (the +4 is a delivery segment, no
// property row holds one), and four digits are padded with one leading zero,
// because that is what a spreadsheet does to 01810 and a 4-digit token is
// never a valid US ZIP anyway.
//
// Refused, by name: anything else. Not accepted — that is the bug — and not
// silently dropped either, which is worse, because dropping two bad entries
// out of a pasted twenty leaves the owner reading eighteen chips as twenty.
//
// The reasoning for each decision is written where the rules are, at the top
// of the US ZIP block in src/lib/zones.functions.ts.
//
// ── WHAT THESE TESTS PIN, AND WHY IN THIS ORDER ───────────────────────────
//
// The first group is about MATCHING, not about strings: it runs the
// normalized values through the real matcher, because "78701" being the right
// answer is only true insofar as it is the thing zone-match compares against.
// The rest pin the individual rules, including the ones a plausible wrong fix
// gets wrong — scavenging the digits out of "ABC12345", padding on the wrong
// end, or reading any 8 digits as a ZIP+4.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchZone, type ZoneMatchFields } from "@/lib/zone-match";
import {
  normalizeUsZip,
  parseUsZips,
  rejectedZipMessage,
  splitZipInput,
  zipCodesSchema,
} from "@/lib/zones.functions";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments stripped, so prose describing the old behaviour cannot satisfy
 *  or defeat an assertion about the code. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("{/*")
      );
    })
    .join("\n");

const zoneWith = (zips: string[]): ZoneMatchFields => ({
  id: "zone-1",
  zip_codes: zips,
  geo_match_mode: "zip",
});

describe("a chip is only worth having if the matcher can match it", () => {
  it("a ZIP+4 typed into a zone now covers the ZIP it was pointing at", () => {
    const { zips } = parseUsZips(splitZipInput("78701-1234"));
    // The property carries the 5-digit code; before the fix the zone carried
    // "78701-1234" and this returned null.
    expect(matchZone([zoneWith(zips)], { postalCode: "78701" })?.id).toBe("zone-1");
  });

  it("and the raw ZIP+4 string it used to store matched nothing at all", () => {
    expect(matchZone([zoneWith(["78701-1234"])], { postalCode: "78701" })).toBeNull();
  });

  it("a zero-eaten ZIP pasted from a spreadsheet covers the town it names", () => {
    const { zips } = parseUsZips(splitZipInput("1810"));
    expect(zips).toEqual(["01810"]);
    expect(matchZone([zoneWith(zips)], { postalCode: "01810" })?.id).toBe("zone-1");
  });
});

describe("US assumptions applied to what is entered", () => {
  it("keeps a plain 5-digit ZIP as it is", () => {
    expect(normalizeUsZip("78701")).toBe("78701");
    expect(normalizeUsZip("  78701  ")).toBe("78701");
  });

  it("drops the +4, in both spellings", () => {
    expect(normalizeUsZip("78701-1234")).toBe("78701");
    expect(normalizeUsZip("787011234")).toBe("78701");
  });

  it("pads four digits on the LEFT, which is the end a spreadsheet ate", () => {
    expect(normalizeUsZip("1810")).toBe("01810");
    // Padding the other end would also produce five digits, and a wrong town.
    expect(normalizeUsZip("1810")).not.toBe("18100");
  });

  it("pads the base of a zero-eaten ZIP+4 too", () => {
    expect(normalizeUsZip("1810-2345")).toBe("01810");
  });

  it("strips the punctuation a CSV wraps a value in, but not letters", () => {
    expect(normalizeUsZip('"78701"')).toBe("78701");
    expect(normalizeUsZip("(78701)")).toBe("78701");
    expect(normalizeUsZip("ABC12345")).toBeNull();
    expect(normalizeUsZip("12345ABC")).toBeNull();
  });

  it("does not read every run of digits as a ZIP+4", () => {
    expect(normalizeUsZip("12341234")).toBeNull();
    expect(normalizeUsZip("787011")).toBeNull();
    expect(normalizeUsZip("1234567890")).toBeNull();
  });

  it("refuses what is not a US ZIP at all", () => {
    for (const bad of ["787", "ABC", "M5V", "3A8", "12", "-", "0"]) {
      expect(normalizeUsZip(bad)).toBeNull();
    }
  });
});

describe("a bad entry is named, never dropped and never kept", () => {
  it("keeps the good ones and reports the bad ones from the same paste", () => {
    const { zips, rejected } = parseUsZips(splitZipInput("78701, ABC, 78702, 787"));
    expect(zips).toEqual(["78701", "78702"]);
    // The whole point: silence here is the failure. Both bad ones, by name.
    expect(rejected).toEqual(["ABC", "787"]);
  });

  it("reports a Canadian postal code as the thing the person typed", () => {
    // It splits on the space, so both halves are reported — but neither is
    // scavenged for digits, and neither becomes a chip.
    const { zips, rejected } = parseUsZips(splitZipInput("M5V 3A8"));
    expect(zips).toEqual([]);
    expect(rejected).toEqual(["M5V", "3A8"]);
  });

  it("says which values were refused, not how many", () => {
    const msg = rejectedZipMessage(["ABC", "787"]);
    expect(msg).toContain('"ABC"');
    expect(msg).toContain('"787"');
  });

  it("collapses duplicates and keeps entry order, so the first ZIP is stable", () => {
    // handleZips() centres the coverage map on next[0]; reordering would move
    // the map to a different town.
    const { zips } = parseUsZips(splitZipInput("78702 78701 78702"));
    expect(zips).toEqual(["78702", "78701"]);
  });

  it("splits on commas, spaces, semicolons and newlines", () => {
    expect(splitZipInput("78701, 78702;78703\n78704")).toEqual([
      "78701",
      "78702",
      "78703",
      "78704",
    ]);
    expect(splitZipInput("   ")).toEqual([]);
  });
});

describe("the server refuses the same list the drawer refuses", () => {
  // A server function is an HTTP endpoint; the drawer's validation is an
  // affordance. These go through the real validator the zone writes use.
  it("accepts a list of US ZIPs", () => {
    expect(zipCodesSchema.safeParse(["78701", "78702"]).success).toBe(true);
    expect(zipCodesSchema.safeParse(undefined).success).toBe(true);
    expect(zipCodesSchema.safeParse([]).success).toBe(true);
  });

  it("rejects a posted list containing anything that is not one", () => {
    const r = zipCodesSchema.safeParse(["78701", "ABC"]);
    expect(r.success).toBe(false);
    // Rejecting, not quietly writing ["78701"]: the zone that gets saved has
    // to be the zone that was asked for.
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("ABC");
  });

  it("is wired into the zone write schema, so create and update both use it", () => {
    const src = codeOnly(read("src/lib/zones.functions.ts"));
    expect(src).toMatch(/zipCodes:\s*zipCodesSchema/);
    // The old rule, which turned any alphanumeric soup into a stored chip.
    expect(src).not.toMatch(/\[\^0-9A-Za-z-\]/);
  });
});

describe("the drawer shows the refusal instead of swallowing it", () => {
  const drawer = read("src/components/ZoneDrawer.tsx");
  const code = codeOnly(drawer);

  it("parses entry with the shared rules rather than its own regex", () => {
    expect(code).toMatch(/parseUsZips\(splitZipInput\(raw\)\)/);
    expect(code).not.toMatch(/\[\^0-9A-Za-z-\]/);
  });

  it("renders the refused values and puts them back in the box to be fixed", () => {
    expect(code).toMatch(/rejectedZipMessage\(rejected\)/);
    expect(code).toMatch(/text-destructive/);
    // setBuf(bad.join(" ")) — a fix that cleared the input would drop them.
    expect(code).toMatch(/setBuf\(bad\.join\(/);
  });

  it("will not save a zone still carrying a chip that cannot match", () => {
    expect(code).toMatch(/const zipsOk = zips\.every\(\(z\) => normalizeUsZip\(z\) === z\)/);
    expect(code).toMatch(/canSave = nameOk && coverageOk && zipsOk/);
  });

  it("does not trap the keyboard on a value it just refused", () => {
    // Tab used to preventDefault too. With a commit that can refuse, that is
    // a field a keyboard user cannot leave until they type something valid.
    expect(code).not.toMatch(/e\.key === "Tab"/);
    expect(code).toMatch(/onBlur=\{\(\) => buf\.trim\(\) && commit\(buf\)\}/);
  });

  it("says the constraint before it bites", () => {
    expect(drawer).toMatch(/US 5-digit ZIPs only/);
    expect(drawer).toMatch(/ZIP codes served \(US\)/);
  });

  it("keeps the entry box on the 44px touch floor", () => {
    // A 42px box was under it, and this field is used in a driveway.
    expect(code).toMatch(/min-h-\[44px\][^"]*min-w-\[100px\]/);
    expect(code).not.toMatch(/min-h-\[42px\]/);
  });

  it("does not grow a country selector", () => {
    // The owner asked for the opposite of international support.
    expect(code).not.toMatch(/country/i);
  });
});

describe("and the list you never open still tells you", () => {
  // ── VERIFIED AGAINST THE LIVE DATABASE, 2026-08-19 ────────────────────────
  //
  // Eight zones; one of them — "Southgate" — has zip_codes = {"Michigan"} and
  // matches zero properties. Somebody typed a state name into the ZIP field
  // and the old input made it a chip that looks exactly like a working one.
  // That is this whole file's fault, sitting in production.
  //
  // The drawer refuses it on save now. But a zone nobody edits is a zone that
  // never gets asked, and /zones is where you go to see what a zone covers —
  // so the card has to distinguish a chip that matches from one that cannot.
  const zones = () => codeOnly(read("src/routes/_authenticated/settings.zones.tsx"));

  it("renders an unmatched ZIP as broken rather than as an ordinary chip", () => {
    // The variant is the assertion: `secondary` for every chip is precisely
    // the state where "Michigan" and "78701" are indistinguishable.
    expect(zones()).toMatch(/variant=\{normalizeUsZip\(z\) === z \? "secondary" : "destructive"\}/);
  });

  it("names the offending value instead of counting it", () => {
    // "1 invalid ZIP" sends you hunting through twelve chips for the one that
    // is wrong, which defeats the colour above.
    const src = zones();
    expect(src).toMatch(/const deadZips = zipList\.slice\(0, 12\)\.filter\(/);
    expect(src).toMatch(/is not a US 5-digit ZIP and matches no address\./);
    expect(src).toMatch(/are not US 5-digit ZIPs and match no addresses\./);
  });

  it("only claims about chips it actually rendered", () => {
    // The card caps the chips at 12. Naming a value behind "+N more" would
    // send somebody looking for something that is not on screen — so the
    // filter runs over the same slice the map does, not over zipList.
    const src = zones();
    expect(src).not.toMatch(/const deadZips = zipList\.filter\(/);
    const slices = src.match(/zipList\.slice\(0, 12\)/g) ?? [];
    expect(slices.length, "the chip cap and the warning must read the same slice").toBe(2);
  });

  it("uses the shared rule rather than a second regex that can drift", () => {
    // Two definitions of "a valid ZIP" is how a chip ends up red on one screen
    // and blue on another. zones.tsx imports the one the server enforces.
    const src = zones();
    expect(src).toMatch(/import \{[^}]*\bnormalizeUsZip\b[^}]*\} from "@\/lib\/zones\.functions"/);
    expect(src).not.toMatch(/\/\^\\d\{5\}\$\//);
  });
});
