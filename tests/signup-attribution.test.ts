import { describe, expect, it } from "vitest";
import {
  UTM_KEYS,
  groupByUtm,
  hasAnyAttribution,
  orgHasConverted,
  type AttributedOrg,
} from "@/lib/signup-attribution.report";

// The failure mode here is not a crash — it is a plausible-looking table that
// sends real marketing spend the wrong way. Every case below is one where a
// wrong answer still reads as a reasonable number.

const org = (utm: Record<string, unknown> | null, converted = false): AttributedOrg => ({
  signup_utm: utm,
  converted,
});

describe("what counts as converted", () => {
  it("counts an organization that churned", () => {
    // A campaign that produced a customer who later left still produced a
    // customer. Scoring it as a failure pushes spend toward whichever channel
    // happens to have the freshest cohort.
    expect(orgHasConverted("canceled")).toBe(true);
    expect(orgHasConverted("past_due")).toBe(true);
    expect(orgHasConverted("grace")).toBe(true);
    expect(orgHasConverted("active")).toBe(true);
  });

  it("does not count a trial or a free account as a paying customer", () => {
    for (const s of ["trialing", "free", "", null, undefined]) {
      expect(orgHasConverted(s), String(s)).toBe(false);
    }
  });
});

describe("grouping", () => {
  it("ranks by paying customers, not by signups", () => {
    // The whole point. Forty signups and no conversions must sort BELOW two
    // signups that both pay, or the table recommends the wrong campaign.
    const orgs = [
      ...Array.from({ length: 40 }, () => org({ utm_source: "loud" })),
      org({ utm_source: "quiet" }, true),
      org({ utm_source: "quiet" }, true),
    ];
    const rows = groupByUtm(orgs, "utm_source");
    expect(rows[0].value).toBe("quiet");
    expect(rows[0].converted).toBe(2);
    expect(rows[1].value).toBe("loud");
    expect(rows[1].signups).toBe(40);
    expect(rows[1].conversionPercent).toBe(0);
  });

  it("keeps untagged signups visible, and last", () => {
    // Dropping them would make every campaign look more significant than it
    // is; leading with them would bury the thing the page exists for.
    const rows = groupByUtm(
      [org(null), org(null), org({ utm_source: "newsletter" }, true)],
      "utm_source",
    );
    expect(rows.at(-1)!.value).toBeNull();
    expect(rows.at(-1)!.signups).toBe(2);
  });

  it("sinks untagged even when it is the largest group", () => {
    const orgs = [
      ...Array.from({ length: 100 }, () => org(null, true)),
      org({ utm_source: "ads" }),
    ];
    expect(groupByUtm(orgs, "utm_source")[0].value).toBe("ads");
  });

  it("treats an empty parameter as untagged rather than a channel", () => {
    // `?utm_source=` is a phantom channel nothing can ever be attributed to.
    const rows = groupByUtm([org({ utm_source: "" }), org({ utm_source: "   " })], "utm_source");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeNull();
    expect(rows[0].signups).toBe(2);
  });

  it("ignores a non-string value rather than rendering it", () => {
    expect(groupByUtm([org({ utm_source: { nested: true } })], "utm_source")[0].value).toBeNull();
  });

  it("computes the rate against that group's own signups", () => {
    const rows = groupByUtm(
      [org({ utm_medium: "cpc" }, true), org({ utm_medium: "cpc" }), org({ utm_medium: "cpc" })],
      "utm_medium",
    );
    expect(rows[0].conversionPercent).toBe(33);
  });

  it("groups every captured key, not just source", () => {
    const orgs = [org({ utm_campaign: "spring", utm_term: "scooper" }, true)];
    for (const k of UTM_KEYS) expect(groupByUtm(orgs, k), k).toHaveLength(1);
    expect(groupByUtm(orgs, "utm_campaign")[0].value).toBe("spring");
    expect(groupByUtm(orgs, "utm_content")[0].value).toBeNull();
  });
});

describe("the empty state has to tell the truth", () => {
  it("knows when nothing has ever been tagged", () => {
    // Today's real state: seven organizations, zero UTM payloads. "No data" and
    // "nobody has published a tagged link yet" call for different actions.
    expect(hasAnyAttribution([org(null), org(null)])).toBe(false);
    expect(hasAnyAttribution([org({}), org({ utm_source: "" })])).toBe(false);
  });

  it("knows when something has", () => {
    expect(hasAnyAttribution([org(null), org({ utm_content: "hero-button" })])).toBe(true);
  });
});
