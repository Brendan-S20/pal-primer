import { describe, expect, it } from "vitest";
import { matchZone, type ZoneMatchFields } from "@/lib/zone-match";

// QA round 3, finding B3: 412 Congress Ave, Austin 78701 (commercial) was
// detected into "Central Austin" (residential, prefix 78704, huge radius)
// instead of "Downtown Commercial" (commercial, prefix 78701), because the
// old ranking put radius containment ABOVE ZIP/prefix matches. These tests
// encode the corrected ranking:
//   polygon > exact ZIP > postal prefix > radius/drive-time,
//   then priority, then type-appropriateness, then longest prefix, then id.

const zone = (over: Partial<ZoneMatchFields> & { id: string }): ZoneMatchFields => ({
  priority: 0,
  account_type: null,
  postal_prefix: null,
  zip_codes: [],
  geo_match_mode: "zip",
  boundary: null,
  center_latitude: null,
  center_longitude: null,
  radius_meters: null,
  drive_time_minutes: null,
  ...over,
});

// Real coordinates from the repro: downtown Austin.
const CONGRESS_AVE = { lat: 30.2655, lng: -97.7445 };

// The two live zones from the B3 repro (simplified).
const CENTRAL_AUSTIN = zone({
  id: "central",
  account_type: "residential",
  postal_prefix: "78704",
  geo_match_mode: "radius",
  center_latitude: 30.25,
  center_longitude: -97.75,
  radius_meters: 40000, // ~24.9 mi — swallows all of Austin
});
const DOWNTOWN_COMMERCIAL = zone({
  id: "downtown",
  account_type: "commercial",
  postal_prefix: "78701",
  geo_match_mode: "radius",
  center_latitude: 30.267,
  center_longitude: -97.743,
  radius_meters: 29500,
});

describe("matchZone ranking (finding B3)", () => {
  it("prefix match beats radius containment (the 412 Congress repro)", () => {
    const m = matchZone([CENTRAL_AUSTIN, DOWNTOWN_COMMERCIAL], {
      postalCode: "78701",
      point: CONGRESS_AVE,
      accountType: "commercial",
    });
    expect(m?.id).toBe("downtown");
  });

  it("exact ZIP beats radius containment", () => {
    const zipZone = zone({ id: "zip-zone", zip_codes: ["78701"] });
    const m = matchZone([CENTRAL_AUSTIN, zipZone], {
      postalCode: "78701",
      point: CONGRESS_AVE,
    });
    expect(m?.id).toBe("zip-zone");
  });

  it("exact ZIP beats a prefix match", () => {
    const exact = zone({ id: "exact", zip_codes: ["78704"] });
    const prefix = zone({ id: "prefix", postal_prefix: "787" });
    expect(matchZone([prefix, exact], { postalCode: "78704" })?.id).toBe("exact");
  });

  it("polygon containment beats an exact ZIP match", () => {
    const poly = zone({
      id: "poly",
      geo_match_mode: "polygon",
      boundary: {
        coordinates: [
          [
            [-97.75, 30.26],
            [-97.74, 30.26],
            [-97.74, 30.27],
            [-97.75, 30.27],
            [-97.75, 30.26],
          ],
        ],
      },
    });
    const exact = zone({ id: "exact", zip_codes: ["78701"] });
    const m = matchZone([exact, poly], { postalCode: "78701", point: CONGRESS_AVE });
    expect(m?.id).toBe("poly");
  });

  it("a radius zone that also lists the exact ZIP ranks at the exact-ZIP level", () => {
    // CENTRAL_AUSTIN with the ZIP listed should beat a prefix-only zone even
    // though its geometry alone would rank below the prefix.
    const central = { ...CENTRAL_AUSTIN, zip_codes: ["78701"] };
    const m = matchZone([central, DOWNTOWN_COMMERCIAL], {
      postalCode: "78701",
      point: CONGRESS_AVE,
    });
    expect(m?.id).toBe("central");
  });

  it("radius containment still matches when no ZIP-level zone applies", () => {
    const m = matchZone([CENTRAL_AUSTIN, DOWNTOWN_COMMERCIAL], {
      postalCode: "78741", // no prefix/zip match on either zone
      point: { lat: 30.23, lng: -97.72 }, // inside Central Austin's radius only? both radii cover Austin
    });
    // Both radii contain the point; equal priority and no type given, so the
    // tie falls through to id order — the point is: SOME radius zone matched.
    expect(m).not.toBeNull();
  });

  it("returns null when nothing matches (no geometry-less catch-alls)", () => {
    const bare = zone({ id: "bare" }); // no zips, no prefix, no geometry
    expect(matchZone([bare], { postalCode: "78701", point: CONGRESS_AVE })).toBeNull();
  });
});

describe("matchZone priority tie-break (I13 #7)", () => {
  it("higher priority wins between two exact-ZIP zones", () => {
    const a = zone({ id: "a", zip_codes: ["78701"], priority: 0 });
    const b = zone({ id: "b", zip_codes: ["78701"], priority: 5 });
    expect(matchZone([a, b], { postalCode: "78701" })?.id).toBe("b");
  });

  it("priority never lets a prefix match beat an exact ZIP match", () => {
    const exact = zone({ id: "exact", zip_codes: ["78701"], priority: 0 });
    const prefix = zone({ id: "prefix", postal_prefix: "78", priority: 99 });
    expect(matchZone([prefix, exact], { postalCode: "78701" })?.id).toBe("exact");
  });

  it("priority never lets a radius zone beat a ZIP-level match", () => {
    const central = { ...CENTRAL_AUSTIN, priority: 99 };
    const m = matchZone([central, DOWNTOWN_COMMERCIAL], {
      postalCode: "78701",
      point: CONGRESS_AVE,
    });
    expect(m?.id).toBe("downtown");
  });

  it("equal-priority prefix overlap resolves to the longest prefix", () => {
    const broad = zone({ id: "broad", postal_prefix: "78" });
    const tight = zone({ id: "tight", postal_prefix: "78704" });
    expect(matchZone([broad, tight], { postalCode: "78704" })?.id).toBe("tight");
  });

  it("is deterministic on full ties regardless of input order", () => {
    const a = zone({ id: "a", zip_codes: ["78701"] });
    const b = zone({ id: "b", zip_codes: ["78701"] });
    expect(matchZone([a, b], { postalCode: "78701" })?.id).toBe("a");
    expect(matchZone([b, a], { postalCode: "78701" })?.id).toBe("a");
  });
});

describe("matchZone type-appropriateness (B3/I4)", () => {
  const resZone = zone({ id: "res", zip_codes: ["78701"], account_type: "residential" });
  const commZone = zone({ id: "comm", zip_codes: ["78701"], account_type: "commercial" });
  const bothZone = zone({ id: "both", zip_codes: ["78701"], account_type: null });

  it("a commercial property prefers the commercial zone on a same-level tie", () => {
    const m = matchZone([resZone, commZone], { postalCode: "78701", accountType: "commercial" });
    expect(m?.id).toBe("comm");
  });

  it("a residential property prefers the residential zone on a same-level tie", () => {
    const m = matchZone([commZone, resZone], { postalCode: "78701", accountType: "residential" });
    expect(m?.id).toBe("res");
  });

  it("a typed match beats an untyped zone; untyped beats a mismatched type", () => {
    expect(
      matchZone([bothZone, commZone], { postalCode: "78701", accountType: "commercial" })?.id,
    ).toBe("comm");
    expect(
      matchZone([commZone, bothZone], { postalCode: "78701", accountType: "residential" })?.id,
    ).toBe("both");
  });

  it("priority outranks type-appropriateness (I4 ordering)", () => {
    const boostedRes = { ...resZone, priority: 5 };
    const m = matchZone([boostedRes, commZone], {
      postalCode: "78701",
      accountType: "commercial",
    });
    expect(m?.id).toBe("res");
  });

  it("a mismatched-type zone still matches when it is the only candidate", () => {
    const m = matchZone([resZone], { postalCode: "78701", accountType: "commercial" });
    expect(m?.id).toBe("res");
  });

  it("type is neutral when the property's account type is unknown", () => {
    const m = matchZone([commZone, resZone], { postalCode: "78701" });
    expect(m?.id).toBe("comm"); // falls through to deterministic id order
  });
});

describe("matchZone proximity level: radius and drive_time (finding 5)", () => {
  // A drive-time zone centered downtown, ~15 min ≈ 12 km at the matcher's
  // 800 m/min, so it contains Congress Ave.
  const driveZone = zone({
    id: "drive",
    geo_match_mode: "drive_time",
    center_latitude: 30.267,
    center_longitude: -97.743,
    drive_time_minutes: 15,
  });
  const radiusZone = zone({
    id: "radius",
    geo_match_mode: "radius",
    center_latitude: 30.267,
    center_longitude: -97.743,
    radius_meters: 12000,
  });

  it("a drive_time zone matches when the point is within reach", () => {
    expect(matchZone([driveZone], { point: CONGRESS_AVE })?.id).toBe("drive");
  });

  it("drive_time and radius rank at the SAME (proximity) level", () => {
    // Equal level → the tie falls to priority; give radius the edge and it
    // must win over drive_time despite drive_time being listed first.
    const boostedRadius = { ...radiusZone, priority: 3 };
    const m = matchZone([driveZone, boostedRadius], { point: CONGRESS_AVE });
    expect(m?.id).toBe("radius");
  });

  it("a prefix match still outranks both drive_time and radius", () => {
    const prefix = zone({ id: "prefix", postal_prefix: "78701", priority: -5 });
    const m = matchZone([driveZone, radiusZone, prefix], {
      postalCode: "78701",
      point: CONGRESS_AVE,
    });
    expect(m?.id).toBe("prefix");
  });

  it("radius-vs-radius tie is resolved by priority (pinned winner)", () => {
    const a = { ...radiusZone, id: "ra", priority: 1 };
    const b = { ...radiusZone, id: "rb", priority: 7 };
    expect(matchZone([a, b], { point: CONGRESS_AVE })?.id).toBe("rb");
    expect(matchZone([b, a], { point: CONGRESS_AVE })?.id).toBe("rb");
  });

  it("radius-vs-radius equal priority is resolved by type-appropriateness", () => {
    const res = { ...radiusZone, id: "rr", account_type: "residential" as const };
    const comm = { ...radiusZone, id: "rc", account_type: "commercial" as const };
    expect(matchZone([res, comm], { point: CONGRESS_AVE, accountType: "commercial" })?.id).toBe(
      "rc",
    );
  });
});
