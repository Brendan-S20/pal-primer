import { describe, expect, it } from "vitest";
import { parseHoldRequest } from "@/lib/hold-request";

// QA round 3, C4/G4: portal vacation-hold requests land as free-text concerns
// formatted by portal_request_vacation_hold. The Concerns inbox parses them to
// prefill the shared hold drawer for a structured "Create hold from request".
describe("parseHoldRequest", () => {
  it("parses the portal's canonical message format (→ separator)", () => {
    expect(
      parseHoldRequest("Vacation hold requested 2026-07-23 → 2028-10-17. Out of town"),
    ).toEqual({ startsOn: "2026-07-23", endsOn: "2028-10-17", reason: "Out of town" });
  });

  it("parses when the reason is empty (trailing '. ')", () => {
    expect(parseHoldRequest("Vacation hold requested 2026-07-23 → 2026-08-02. ")).toEqual({
      startsOn: "2026-07-23",
      endsOn: "2026-08-02",
      reason: "",
    });
  });

  it("accepts alternate separators (-> and 'to')", () => {
    expect(parseHoldRequest("hold from 2026-01-01 -> 2026-01-10")).toEqual({
      startsOn: "2026-01-01",
      endsOn: "2026-01-10",
      reason: "",
    });
    expect(parseHoldRequest("Please hold 2026-01-01 to 2026-01-10 for vacation")).toEqual({
      startsOn: "2026-01-01",
      endsOn: "2026-01-10",
      reason: "for vacation",
    });
  });

  it("still parses an out-of-policy multi-year range (validation happens on submit)", () => {
    // Parsing surfaces the request; the drawer + server reject the 2-year span.
    expect(parseHoldRequest("Vacation hold requested 2026-07-23 → 2028-10-17.")).toMatchObject({
      startsOn: "2026-07-23",
      endsOn: "2028-10-17",
    });
  });

  it("returns null when the message never mentions a hold", () => {
    expect(parseHoldRequest("Missed my yard on 2026-07-16, please redo")).toBeNull();
  });

  it("returns null when there is no start/end date pair", () => {
    expect(parseHoldRequest("Requesting a vacation hold, dates TBD")).toBeNull();
  });

  it("returns null when the end date precedes the start date", () => {
    expect(parseHoldRequest("hold 2026-08-02 → 2026-07-23")).toBeNull();
  });

  it("returns null for empty/nullish input", () => {
    expect(parseHoldRequest(null)).toBeNull();
    expect(parseHoldRequest(undefined)).toBeNull();
    expect(parseHoldRequest("")).toBeNull();
  });
});
