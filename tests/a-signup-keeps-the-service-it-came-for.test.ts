import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preselectedServiceLines, requestedServiceLine } from "@/lib/signup-service";
import { readSignupAttribution, stashSignupAttribution } from "@/lib/signup-attribution";
import type { ServiceLineAvailability } from "@/lib/service-lines";

// site-r2-03 / F-06. A trainer who clicked "Start free trial" on
// /services/dog-training was set up as a scooping business, because no CTA
// carried the service and pet waste is the column default. The site now links
// to /sign-up?service=<line>&utm_source=site&utm_content=<page>; these pin the
// app half: the parameter is validated, it survives the walkthrough beside the
// UTM, it reaches bootstrap_organization's caller, and setup step 1 ticks it.

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const allBookable: ServiceLineAvailability = {
  bookable: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"],
  customerRequestable: [],
};

describe("?service= is validated against the offered service lines", () => {
  it("accepts every offered id", () => {
    for (const id of ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"]) {
      expect(requestedServiceLine(id)).toBe(id);
    }
  });

  it("reads a slug-shaped or differently cased link as the same request", () => {
    expect(requestedServiceLine("dog-walking")).toBe("dog_walking");
    expect(requestedServiceLine(" Training ")).toBe("training");
  });

  it("ignores anything else, including the database-only `other`", () => {
    for (const v of [
      "other",
      "dog-training",
      "",
      "training;drop",
      undefined,
      null,
      3,
      ["training"],
    ]) {
      expect(requestedServiceLine(v), String(v)).toBeUndefined();
    }
  });
});

describe("setup step 1 preselects the requested line", () => {
  it("replaces the bare pet-waste default with the line asked for", () => {
    expect(preselectedServiceLines(["pet_waste"], "training", allBookable)).toEqual(["training"]);
  });

  it("leaves the default alone when nothing was asked (RC3 owns that default)", () => {
    expect(preselectedServiceLines(["pet_waste"], undefined, allBookable)).toEqual(["pet_waste"]);
  });

  it("never overrides an answer somebody already chose", () => {
    expect(preselectedServiceLines(["dog_walking"], "training", allBookable)).toEqual([
      "dog_walking",
    ]);
    expect(preselectedServiceLines(["pet_waste", "dog_walking"], "training", allBookable)).toEqual([
      "pet_waste",
      "dog_walking",
    ]);
  });

  it("does not preselect a Coming soon line, or anything before availability is known", () => {
    const wasteOnly: ServiceLineAvailability = { bookable: ["pet_waste"], customerRequestable: [] };
    expect(preselectedServiceLines(["pet_waste"], "training", wasteOnly)).toEqual(["pet_waste"]);
    expect(preselectedServiceLines(["pet_waste"], "training", null)).toEqual(["pet_waste"]);
  });

  it("the setup page reads ?service= and starts from the preselection, only before step 1 is done", () => {
    const page = read("src/routes/_authenticated/setup.tsx");
    expect(page).toMatch(/service: requestedServiceLine\(s\.service\)/);
    expect(page).toMatch(/const mayPreselect = linesKnown && !alreadyDone/);
    expect(page).toMatch(/preselectedServiceLines\(savedLines, requestedLine, availability\)/);
    expect(page).toMatch(/const linesVal = lines \?\? startingLines/);
  });
});

describe("the service and the UTM survive the walkthrough to org creation", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stashes the service beside the UTM from a site CTA", () => {
    stashSignupAttribution({
      service: "training",
      utm_source: "site",
      utm_content: "services-dog-training",
    });
    const a = readSignupAttribution();
    expect(a.service).toBe("training");
    expect(a.utm).toEqual({ utm_source: "site", utm_content: "services-dog-training" });
  });

  it("stashes a service on its own, and drops an unknown one", () => {
    stashSignupAttribution({ service: "mobile-grooming" });
    expect(readSignupAttribution().service).toBe("mobile_grooming");
    store.clear();
    stashSignupAttribution({ service: "astrology" });
    expect(readSignupAttribution()).toEqual({});
  });

  it("a later visit without ?service= keeps the one already stashed", () => {
    stashSignupAttribution({ service: "training", utm_source: "site" });
    stashSignupAttribution({ utm_campaign: "fall" });
    expect(readSignupAttribution().service).toBe("training");
  });

  it("/sign-up and /get-started accept ?service=, and /sign-up hands it off rather than in the URL", () => {
    for (const f of ["src/routes/sign-up.tsx", "src/routes/get-started.tsx"]) {
      expect(read(f), f).toMatch(
        /service: typeof s\.service === "string" \? s\.service : undefined/,
      );
    }
    expect(read("src/routes/sign-up.tsx")).toMatch(/service: undefined,\n\s*\},\n\s*replace: true/);
  });

  it("both org-creation paths pass the stashed service and UTM to bootstrapOrganization", () => {
    // get-started.tsx's sequence is src/lib/finish-signup.ts since 2026-11-09.
    for (const f of ["src/lib/finish-signup.ts", "src/lib/ensure-workspace.ts"]) {
      const src = read(f);
      expect(src, f).toMatch(/utm: attribution\.utm,\s*serviceLine: attribution\.service,/);
    }
  });
});

describe("bootstrapOrganization stores the requested line on a brand-new org", () => {
  const org = read("src/lib/org.functions.ts");
  const features = read("src/lib/org-features.functions.ts");
  const helper = features.slice(
    features.indexOf("export const startNewOrgOnRequestedLine"),
    features.indexOf("export const setServiceLines"),
  );

  it("validates the line server-side too, and only for a caller with no business yet", () => {
    expect(org).toMatch(
      /serviceLine: z\s*\.string\(\)\s*\.optional\(\)\s*\.transform\(\(v\) => requestedServiceLine\(v\)\)/,
    );
    expect(org).toMatch(/if \(orgId && data\.serviceLine && !member\?\.length\)/);
    // Signup is never blocked by it.
    expect(org).toMatch(/requested service line not applied \(continuing without it\)/);
  });

  it("writes only over the bare default, only a bookable line, through the owner's own write path", () => {
    expect(helper).toMatch(/current\.length === 1 && current\[0\] === "pet_waste"/);
    expect(helper).toMatch(
      /serviceLinesAdditionProblem\(\["pet_waste"\], \[line\], await loadServiceLineAvailability\(\)\)/,
    );
    expect(helper).toMatch(/updateOwnOrg\(supabase, orgId, \{ service_lines: lines \}\)/);
    expect(helper).toMatch(/ensureDefaultServicesForLines\(supabase, orgId, lines\)/);
    expect(helper.indexOf("serviceLinesAdditionProblem(")).toBeLessThan(
      helper.indexOf("updateOwnOrg("),
    );
  });

  it("signup_utm needed no migration: bootstrap_organization already stores _utm", () => {
    expect(org).toMatch(
      /_utm: data\.utm && Object\.keys\(data\.utm\)\.length \? data\.utm : undefined/,
    );
  });
});
