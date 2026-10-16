// A walk reads as a walk (#410): the pure rules behind the walker's card, the
// office's access fields and the walk report email.

import { describe, expect, it } from "vitest";
import {
  cleanReportNote,
  dogNamesPhrase,
  walkClock,
  walkDurationMinutes,
  walkerFirstName,
  walkReportEmail,
  walkReportSubject,
  yesNoLine,
} from "@/lib/walk-report";
import { groupWalkMates, isWalkVisit, minutesOut, walkLengthMin } from "@/lib/walk-day";
import {
  ACCESS_METHODS,
  cleanKeyTag,
  hasWalkAccess,
  isAccessMethod,
  showsWalkAccess,
} from "@/lib/walk-access";
import { readFileSync } from "node:fs";

describe("walk duration", () => {
  it("is whole minutes from start to end, rounded", () => {
    expect(walkDurationMinutes("2026-10-19T14:05:00Z", "2026-10-19T14:37:00Z")).toBe(32);
    expect(walkDurationMinutes("2026-10-19T14:05:00Z", "2026-10-19T14:35:31Z")).toBe(31);
    // Under a minute is still a walk of a minute, not zero.
    expect(walkDurationMinutes("2026-10-19T14:05:00Z", "2026-10-19T14:05:20Z")).toBe(1);
  });

  it("is left out when the start is missing or the times make no sense", () => {
    expect(walkDurationMinutes(null, "2026-10-19T14:37:00Z")).toBeNull();
    expect(walkDurationMinutes("2026-10-19T14:05:00Z", null)).toBeNull();
    expect(walkDurationMinutes("not a time", "2026-10-19T14:37:00Z")).toBeNull();
    expect(walkDurationMinutes("2026-10-19T14:37:00Z", "2026-10-19T14:05:00Z")).toBeNull();
    expect(walkDurationMinutes("2026-10-19T14:05:00Z", "2026-10-19T14:05:00Z")).toBeNull();
  });
});

describe("pee and poo", () => {
  it("say yes or no, and nothing when not recorded", () => {
    expect(yesNoLine("Pee", true)).toBe("Pee: yes");
    expect(yesNoLine("Poo", false)).toBe("Poo: no");
    expect(yesNoLine("Pee", null)).toBeNull();
    expect(yesNoLine("Poo", undefined)).toBeNull();
  });
});

describe("names", () => {
  it("lists the dogs as a sentence, or says 'your dog'", () => {
    expect(dogNamesPhrase([])).toBe("your dog");
    expect(dogNamesPhrase([null, "  "])).toBe("your dog");
    expect(dogNamesPhrase(["Bella"])).toBe("Bella");
    expect(dogNamesPhrase(["Bella", "Max"])).toBe("Bella and Max");
    expect(dogNamesPhrase(["Bella", "Max", "Rex"])).toBe("Bella, Max and Rex");
  });

  it("uses the walker's first name only", () => {
    expect(walkerFirstName("Alejandra Villanueva")).toBe("Alejandra");
    expect(walkerFirstName("  Sam ")).toBe("Sam");
    expect(walkerFirstName("")).toBeNull();
    expect(walkerFirstName(null)).toBeNull();
  });

  it("puts the business and the dogs in the subject", () => {
    expect(walkReportSubject("Happy Paws", "Bella")).toBe("Happy Paws walked Bella today");
    expect(walkReportSubject(null, "your dog")).toBe("Your walker walked your dog today");
  });
});

describe("times on the business's clock", () => {
  it("formats in the org's timezone, not the server's", () => {
    // One instant, two businesses.
    expect(walkClock("2026-10-19T14:05:00Z", "America/Chicago")).toMatch(/^9:05\sAM$/);
    expect(walkClock("2026-10-19T14:05:00Z", "America/Los_Angeles")).toMatch(/^7:05\sAM$/);
    expect(walkClock("2026-10-19T14:05:00Z", "Europe/London")).toMatch(/^3:05\sPM$/);
    expect(walkClock(null, "America/Chicago")).toBe("");
    expect(walkClock("garbage", "America/Chicago")).toBe("");
  });

  it("builds the report the template draws", () => {
    const r = walkReportEmail({
      startedAt: "2026-10-19T14:05:00Z",
      completedAt: "2026-10-19T14:37:00Z",
      timezone: "America/Chicago",
      pee: true,
      poo: null,
      reportNote: "  Good walk.  ",
      dogNames: ["Bella"],
      walkerName: "Sam Ortiz",
    });
    expect(r.dogs).toBe("Bella");
    expect(r.walkerFirstName).toBe("Sam");
    expect(r.startTime).toMatch(/^9:05\sAM$/);
    expect(r.endTime).toMatch(/^9:37\sAM$/);
    expect(r.durationMin).toBe(32);
    expect(r.peeLine).toBe("Pee: yes");
    expect(r).not.toHaveProperty("pooLine");
    expect(r.reportNote).toBe("Good walk.");
  });

  it("drops the start and the duration when the walk was never started", () => {
    const r = walkReportEmail({
      startedAt: null,
      completedAt: "2026-10-19T14:37:00Z",
      timezone: "America/Chicago",
      pee: null,
      poo: null,
      reportNote: null,
      dogNames: [],
      walkerName: null,
    });
    expect(r).not.toHaveProperty("startTime");
    expect(r).not.toHaveProperty("durationMin");
    expect(r).not.toHaveProperty("walkerFirstName");
    expect(r.endTime).toMatch(/^9:37\sAM$/);
  });

  it("trims the note and cuts it at 500", () => {
    expect(cleanReportNote("   ")).toBeNull();
    expect(cleanReportNote(null)).toBeNull();
    expect(cleanReportNote(" hi ")).toBe("hi");
    expect(cleanReportNote("x".repeat(600))).toHaveLength(500);
  });
});

describe("the walker's card", () => {
  const walk = { services: { service_line: "dog_walking", default_duration_min: 30 } };
  it("is a walk only for a dog-walking service", () => {
    expect(isWalkVisit(walk)).toBe(true);
    expect(isWalkVisit({ services: [{ service_line: "dog_walking" }] })).toBe(true);
    expect(isWalkVisit({ services: { service_line: "pet_waste" } })).toBe(false);
    expect(isWalkVisit({ services: null })).toBe(false);
    expect(isWalkVisit({})).toBe(false);
  });

  it("reads the walk length from the service", () => {
    expect(walkLengthMin(walk)).toBe(30);
    expect(walkLengthMin({ services: { service_line: "dog_walking", default_duration_min: null } })).toBeNull();
  });

  it("counts whole minutes out", () => {
    const start = "2026-10-19T14:05:00Z";
    expect(minutesOut(start, Date.parse("2026-10-19T14:05:59Z"))).toBe(0);
    expect(minutesOut(start, Date.parse("2026-10-19T14:27:10Z"))).toBe(22);
    expect(minutesOut(start, Date.parse("2026-10-19T14:00:00Z"))).toBe(0);
    expect(minutesOut("nope", Date.now())).toBeNull();
  });

  it("lists a group walk in pickup order, from the day's own list", () => {
    const day = [
      { id: "a", sequence: 3, walk_group_id: "g", properties: { street: "3 Elm", dogs: [{ name: "Rex" }] } },
      { id: "b", sequence: 1, walk_group_id: "g", properties: { street: "1 Oak", dogs: [{ name: "Bella" }, { name: "Max" }] } },
      { id: "c", sequence: 2, walk_group_id: "other", properties: { street: "2 Fir", dogs: [] } },
      { id: "d", sequence: null, walk_group_id: "g", clients: { display_name: "The Parks" }, properties: { street: "9 Ash", dogs: [] } },
      { id: "e", sequence: 2, walk_group_id: "g", status: "skipped", properties: { street: "5 Yew", dogs: [{ name: "Gone" }] } },
    ];
    const mates = groupWalkMates(day[0], day);
    expect(mates.map((m) => [m.order, m.id, m.label, m.isThis])).toEqual([
      [1, "b", "Bella, Max", false],
      [2, "a", "Rex", true],
      [3, "d", "The Parks", false],
    ]);
    expect(groupWalkMates(day[2], day)).toHaveLength(1);
    expect(groupWalkMates({ id: "x", walk_group_id: null }, day)).toEqual([]);
  });
});

describe("the office's access fields", () => {
  it("accept exactly the database's values", () => {
    const mig = readFileSync(
      "supabase/migrations/20261015210000_a-walk-report-says-how-the-walk-went.sql",
      "utf8",
    );
    const inList = mig.match(/access_method IN \(([^)]*)\)/)![1];
    const sqlValues = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(sqlValues).toEqual([...ACCESS_METHODS]);
    expect(isAccessMethod("lockbox")).toBe(true);
    expect(isAccessMethod("window")).toBe(false);
  });

  it("show for a dog-walking business, or where a value is already saved", () => {
    expect(showsWalkAccess(["dog_walking"], null)).toBe(true);
    expect(showsWalkAccess(["pet_waste", "dog_walking"], {})).toBe(true);
    // A pet-waste-only business sees the drawer as before...
    expect(showsWalkAccess(["pet_waste"], null)).toBe(false);
    expect(showsWalkAccess(["pet_waste"], { access_method: null, key_held: false, key_tag: null })).toBe(false);
    // ...unless the property already says something, which is never hidden.
    expect(showsWalkAccess(["pet_waste"], { access_method: "garage" })).toBe(true);
    expect(showsWalkAccess(["pet_waste"], { key_held: true })).toBe(true);
    expect(hasWalkAccess({ key_tag: " K-12 " })).toBe(true);
  });

  it("trims the key tag and keeps it inside 40 characters", () => {
    expect(cleanKeyTag("  K-12 ")).toBe("K-12");
    expect(cleanKeyTag("")).toBeNull();
    expect(cleanKeyTag("x".repeat(50))).toHaveLength(40);
  });

  it("are written only when the drawer sent them, so a pet-waste save leaves them alone", () => {
    const fn = readFileSync("src/lib/properties.functions.ts", "utf8");
    expect(fn).toMatch(/if \(data\.accessMethod !== undefined\) patch\.access_method/);
    expect(fn).toMatch(/if \(data\.keyHeld !== undefined\) patch\.key_held/);
    expect(fn).toMatch(/if \(data\.keyTag !== undefined\) patch\.key_tag/);
    const drawer = readFileSync("src/components/client-detail/PropertyDrawer.tsx", "utf8");
    expect(drawer).toMatch(/\.\.\.\(walkAccess\s*\?\s*\{\s*accessMethod:/);
    expect(drawer).toMatch(/const walkAccess = linesKnown && showsWalkAccess\(serviceLines, property\)/);
  });
});
