// C4/G4 deferred item: portal frequency-change requests arrive as structured,
// parseable concerns; the office Concerns page derives a one-click apply from
// the canonical message written by portal_change_frequency.
import { describe, expect, it } from "vitest";
import { frequencyLabel, parseFrequencyRequest } from "@/lib/frequency-request";

const SUB = "2c9e9f3a-8a31-4b7e-9f43-0d6f2f6f2b11";

describe("parseFrequencyRequest", () => {
  it("parses the canonical RPC format", () => {
    expect(
      parseFrequencyRequest(`Frequency change requested: weekly → monthly (subscription ${SUB}).`),
    ).toEqual({ subscriptionId: SUB, fromFrequency: "weekly", toFrequency: "monthly" });
  });

  it("accepts the ASCII arrow variant", () => {
    expect(
      parseFrequencyRequest(`Frequency change requested: biweekly -> weekly (subscription ${SUB}).`),
    ).toEqual({ subscriptionId: SUB, fromFrequency: "biweekly", toFrequency: "weekly" });
  });

  it("parses a request whose current frequency is not portal-selectable", () => {
    expect(
      parseFrequencyRequest(
        `Frequency change requested: every_n_days → weekly (subscription ${SUB}).`,
      ),
    ).toEqual({ subscriptionId: SUB, fromFrequency: "every_n_days", toFrequency: "weekly" });
  });

  it("rejects a target frequency the portal cannot request", () => {
    expect(
      parseFrequencyRequest(`Frequency change requested: weekly → one_time (subscription ${SUB}).`),
    ).toBeNull();
  });

  it("rejects a no-op request", () => {
    expect(
      parseFrequencyRequest(`Frequency change requested: weekly → weekly (subscription ${SUB}).`),
    ).toBeNull();
  });

  it("returns null for ordinary concern text and malformed ids", () => {
    expect(parseFrequencyRequest("The gate was left open again")).toBeNull();
    expect(parseFrequencyRequest("Frequency change requested: weekly → monthly")).toBeNull();
    expect(
      parseFrequencyRequest("Frequency change requested: weekly → monthly (subscription nope)"),
    ).toBeNull();
    expect(parseFrequencyRequest(null)).toBeNull();
    expect(parseFrequencyRequest("")).toBeNull();
  });
});

describe("frequencyLabel", () => {
  it("labels known frequencies and humanizes unknown ones", () => {
    expect(frequencyLabel("twice_weekly")).toBe("Twice a week");
    expect(frequencyLabel("biweekly")).toBe("Every 2 weeks");
    expect(frequencyLabel("some_new_mode")).toBe("some new mode");
  });
});
