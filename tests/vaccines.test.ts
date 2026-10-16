import { describe, expect, it } from "vitest";
import { groomVaccineDecision, vaccineStatus, type VaccineRecord } from "@/lib/vaccines";
import { vaccineFields, vaccinePathMatches } from "@/lib/vaccines.schema";

const record = (expires_on: string, extra: Partial<VaccineRecord> = {}): VaccineRecord => ({ vaccine: "rabies", expires_on, source: "office", verified_at: null, ...extra });
const today = "2026-10-16";

describe("vaccine status", () => {
  it("uses only the latest expiry regardless of input order or verification", () => {
    const records = [record("2027-01-01", { source: "portal" }), record("2025-01-01", { verified_at: "2025-01-01T00:00:00Z" })];
    const status = vaccineStatus(records, ["rabies"], today);
    expect(status).toEqual({ overall: "ok", vaccines: [{ vaccine: "rabies", state: "ok", expiresOn: "2027-01-01", unverified: true }] });
    expect(vaccineStatus([...records].reverse(), ["rabies"], today)).toEqual(status);
    expect(records[0].expires_on).toBe("2027-01-01");
  });
  it.each([ ["2026-10-15", "expired"], [today, "expiring"], ["2026-11-15", "expiring"], ["2026-11-16", "ok"] ] as const)("%s is %s on October 16", (date, state) => {
    expect(vaccineStatus([record(date)], ["rabies"], today).overall).toBe(state);
  });
  it("uses calendar days through DST and leap years", () => {
    expect(vaccineStatus([record("2026-03-31")], ["rabies"], "2026-03-01").overall).toBe("expiring");
    expect(vaccineStatus([record("2024-03-01")], ["rabies"], "2024-01-31").overall).toBe("expiring");
  });
  it("reports every required vaccine and the worst state", () => {
    const out = vaccineStatus([record("2027-01-01"), record("2026-01-01", { vaccine: "dhpp" })], ["rabies", "dhpp", "bordetella"], today);
    expect(out.overall).toBe("missing");
    expect(out.vaccines.map((r) => r.state)).toEqual(["ok", "expired", "missing"]);
    expect(out.vaccines[2]).toEqual({ vaccine: "bordetella", state: "missing", expiresOn: null, unverified: false });
  });
  it("does not substitute another vaccine or an optional vaccine", () => {
    expect(vaccineStatus([record("2027-01-01", { vaccine: "other" })], ["rabies"], today).overall).toBe("missing");
    expect(vaccineStatus([record("2025-01-01")], [], today)).toEqual({ overall: "ok", vaccines: [] });
  });
  it("flags only unverified portal records and prefers a verified tie", () => {
    expect(vaccineStatus([record("2027-01-01")], ["rabies"], today).vaccines[0].unverified).toBe(false);
    expect(vaccineStatus([record("2027-01-01", { source: "portal", verified_at: "2026-01-01T12:00:00Z" })], ["rabies"], today).vaccines[0].unverified).toBe(false);
    expect(vaccineStatus([record("2027-01-01", { source: "portal" }), record("2027-01-01", { verified_at: "2026-01-01T12:00:00Z" })], ["rabies"], today).vaccines[0].unverified).toBe(false);
  });
});

describe("groom vaccine decisions", () => {
  it("expired rabies warns under warn and blocks under block", () => {
    const status = vaccineStatus([record("2026-10-15")], ["rabies"], today);
    expect(groomVaccineDecision("warn", status)).toBe("warn");
    expect(groomVaccineDecision("block", status)).toBe("block");
    expect(groomVaccineDecision("off", status)).toBe("allow");
  });
  it("treats missing as expired, and allows expiring vaccines", () => {
    const missing = vaccineStatus([], ["rabies"], today);
    expect(groomVaccineDecision("warn", missing)).toBe("warn");
    expect(groomVaccineDecision("block", missing)).toBe("block");
    for (const rule of ["off", "warn", "block"] as const) {
      expect(groomVaccineDecision(rule, vaccineStatus([record(today)], ["rabies"], today))).toBe("allow");
      expect(groomVaccineDecision(rule, vaccineStatus([], [], today))).toBe("allow");
    }
  });
});

describe("vaccine input validation", () => {
  const dogId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const orgId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fields = { dogId, vaccine: "rabies", expiresOn: "2027-01-01" };
  it("requires a real calendar date, an ordered date range and a note for other", () => {
    expect(vaccineFields.safeParse({ ...fields, expiresOn: "2026-02-30" }).success).toBe(false);
    expect(vaccineFields.safeParse({ ...fields, givenOn: "2028-01-01" }).success).toBe(false);
    expect(vaccineFields.safeParse({ ...fields, vaccine: "other", vaccineNote: "  " }).success).toBe(false);
    expect(vaccineFields.safeParse({ ...fields, vaccine: "other", vaccineNote: "Feline vaccine" }).success).toBe(true);
  });
  it("requires an exact tenant and pet path with one UUID filename", () => {
    expect(vaccinePathMatches(`${orgId}/${dogId}/${dogId}.pdf`, orgId, dogId)).toBe(true);
    for (const path of [`${dogId}/${dogId}/${dogId}.pdf`, `${orgId}/${orgId}/${dogId}.pdf`, `${orgId}/${dogId}/../${dogId}.pdf`, `${orgId}/${dogId}/${dogId}.svg`, `${orgId}/${dogId}/${dogId}.pdf/extra`]) {
      expect(vaccinePathMatches(path, orgId, dogId)).toBe(false);
    }
  });
});
