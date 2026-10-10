// Every step of the guided setup has a target that exists, for every person
// the step is offered to, and a way past it.
//
// ── WHY ───────────────────────────────────────────────────────────────────
//
// The tour this replaced (OnboardingTour.tsx, removed) pinned each step to a
// `data-tour` anchor and a route, and "could not continue all the way" in the
// owner's words. Some of its failures were the anchor; the one that stranded
// people was the overlay itself (tests/the-tour-that-would-not-finish.test.ts).
// The guided setup at /setup has no anchors and no overlay, so what is left
// to go wrong is the LIST: a step with no panel draws nothing and offers
// nothing to do, a step whose link goes nowhere 404s on somebody's first
// minute, a step gated to a role that cannot open its page is a dead end for
// that role, and a step list that disagrees with the checklist is two flows
// again.
//
// Each of those is checked here against the source, file:line where it can
// be, so the failure says what to fix.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRelative } from "./support/repo-paths";
import { ROUTE_ROLES, canAccess, type AppRole } from "../src/hooks/useMyRole";
import { nextOpenStep, startingStep, stepsFor } from "../src/lib/setup-guide";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const STATUS = "src/lib/onboarding.functions.ts";
const PAGE = "src/routes/_authenticated/setup.tsx";
const BANNER = "src/components/SetupGuideBanner.tsx";
const FIXTURE = "tests/viewports/fixtures/stub-backend.ts";

/** Comments blanked, same length, so prose that names a step cannot stand in
 *  for code that handles it. */
function codeOnly(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

type Parsed = { id: string; to: string; gate: string; alt?: { to: string; gate: string } };

/** The step literals in getOnboardingStatus, in order. Brace-matched, because
 *  a step holds a nested `alt` object. */
function parsedSteps(): Parsed[] {
  const src = codeOnly(read(STATUS));
  const decl = "const steps: OnboardingStep[] = [";
  const start = src.indexOf(decl);
  if (start === -1) return [];
  const out: Parsed[] = [];
  let depth = 0;
  let from = -1;
  for (let i = start + decl.length; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") {
      if (depth === 0) from = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && from !== -1) {
        const lit = src.slice(from, i + 1);
        const field = (k: string, s = lit) => s.match(new RegExp(`\\b${k}:\\s*"([^"]+)"`))?.[1];
        const altLit = lit.match(/alt:\s*\{([^}]*)\}/)?.[1];
        const top = lit.replace(/alt:\s*\{[^}]*\}/, "");
        out.push({
          id: field("id", top)!,
          to: field("to", top)!,
          gate: field("gate", top)!,
          alt: altLit ? { to: field("to", altLit)!, gate: field("gate", altLit)! } : undefined,
        });
        from = -1;
      }
    } else if (c === "]" && depth === 0) break;
  }
  return out;
}

/** Route files TanStack would serve a pathname from. */
function routeFilesFor(pathname: string): string[] {
  const flat = pathname.replace(/^\//, "").replace(/\//g, ".");
  return [`${flat}.tsx`, `${flat}.index.tsx`]
    .map((f) => resolve(ROOT, "src/routes/_authenticated", f))
    .filter((f) => existsSync(f));
}

const steps = parsedSteps();
const ROLES: AppRole[] = ["owner", "office_manager", "dispatcher", "tech"];

describe("the guided setup's steps", () => {
  it("parses the step list at all", () => {
    // Every assertion below is vacuously true on an empty list.
    expect(steps.length, `${STATUS}: no steps parsed`).toBeGreaterThanOrEqual(5);
    for (const s of steps) {
      expect(s.id && s.to && s.gate, `${STATUS}: a step is missing id, to or gate`).toBeTruthy();
    }
  });

  it("is short: six steps at most", () => {
    // The brief that replaced the tour: "Keep it short (aim <= 6 steps)".
    // A seventh step is a decision, and this is where it gets made.
    expect(steps.map((s) => s.id).length).toBeLessThanOrEqual(6);
  });

  it("is ONE list: the ids the guide walks are the ids the checklist draws", () => {
    const src = codeOnly(read(STATUS));
    const declared = src
      .match(/ONBOARDING_STEP_IDS[^=]*=\s*\[([^\]]*)\]/)?.[1]
      .match(/"([a-z_]+)"/g)
      ?.map((s) => s.slice(1, -1));
    expect(declared, `${STATUS}: ONBOARDING_STEP_IDS not found`).toBeTruthy();
    expect(declared).toEqual(steps.map((s) => s.id));
  });

  it.each(steps.map((s) => s.id))("%s has a panel on /setup", (id) => {
    // A step with no case in StepPanel renders an empty card: a title, a
    // description, and nothing to do.
    const src = codeOnly(read(PAGE));
    expect(
      new RegExp(`case\\s+"${id}"\\s*:\\s*\\n?\\s*return\\s*<\\w+`).test(src),
      `${PAGE} has no \`case "${id}": return <…Panel />\` in StepPanel`,
    ).toBe(true);
  });

  it.each(steps.flatMap((s) => [s.to, ...(s.alt ? [s.alt.to] : [])]))(
    "%s is a real page that does not redirect",
    (to) => {
      const files = routeFilesFor(to);
      expect(files, `no route file for "${to}": a first session would 404`).not.toHaveLength(0);
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        const head = src.slice(0, src.indexOf("component:") + 1 || src.length);
        expect(
          /throw\s+redirect\s*\(/.test(head),
          `${repoRelative(file, ROOT)} redirects away on load; point the step at the destination`,
        ).toBe(false);
      }
    },
  );

  it.each(steps.map((s) => [s.id, s] as const))(
    "%s: everyone it is offered to can open the page it sends them to",
    (_id, s) => {
      // The gate decides who is offered the step. If someone it admits is
      // then refused by the route the step links to, that is a dead end
      // built into the list.
      expect(
        Object.keys(ROUTE_ROLES).some((k) => s.gate === k || s.gate.startsWith(k + "/")),
        `gate "${s.gate}" matches no ROUTE_ROLES entry, so it admits everyone`,
      ).toBe(true);
      for (const role of ROLES) {
        if (!canAccess(role, s.gate) || !canAccess(role, "/setup")) continue;
        expect(canAccess(role, s.to), `${role} is offered "${s.id}" but refused ${s.to}`).toBe(true);
        if (s.alt && canAccess(role, s.alt.gate)) {
          expect(canAccess(role, s.alt.to)).toBe(true);
        }
      }
    },
  );

  it("offers the owner every step, so an owner can always reach Done", () => {
    expect(stepsFor(steps, "owner").map((s) => s.id)).toEqual(steps.map((s) => s.id));
  });

  it("offers it to nobody who cannot set a business up", () => {
    expect(canAccess("tech", "/setup")).toBe(false);
    expect(canAccess("dispatcher", "/setup")).toBe(false);
  });

  it("matches the fixture the browser walk uses", () => {
    // A fixture of the wrong shape measures the fallback (CLAUDE.md).
    const fx = read(FIXTURE);
    const block = fx.slice(fx.indexOf("getOnboardingStatus: {"), fx.indexOf("],", fx.indexOf("getOnboardingStatus: {")));
    const ids = [...block.matchAll(/id:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(steps.map((s) => s.id));
  });
});

describe("there is always a way past a step", () => {
  it("draws a forward control on every step, done or not", () => {
    // Both branches of the footer carry one: Next or Done when the step is
    // done, Skip for now or Skip and finish when it is not. A step whose
    // forward button depended on finishing it is the dead end the owner hit.
    const src = codeOnly(read(PAGE));
    const footer = src.slice(src.indexOf("current.done ? ("), src.indexOf("</section>"));
    expect(footer).toMatch(/data-setup-action=\{isLast \? "done" : "next"\}/);
    expect(footer).toMatch(/data-setup-action=\{isLast \? "done" : "skip"\}/);
  });

  it("floats nothing over the app", () => {
    // The tour's controls were taken away by whatever opened underneath its
    // fixed, full-screen layer. The guide has no layer to take.
    for (const f of [PAGE, BANNER]) {
      const src = codeOnly(read(f));
      expect(src, `${f} draws a fixed overlay`).not.toMatch(/\bfixed\b[^"]*\binset-0\b/);
      expect(src, `${f} reaches for a z-index`).not.toMatch(/\bz-\[?\d/);
    }
  });

  it("resumes where they were, or at the first open step", () => {
    const list = [
      { id: "business", done: true },
      { id: "zones", done: false },
      { id: "clients", done: false },
    ] as const;
    expect(startingStep(list, "clients")).toBe("clients");
    expect(startingStep(list, null)).toBe("zones");
    expect(startingStep(list, "a-step-that-no-longer-exists")).toBe("zones");
    expect(startingStep([], null)).toBeNull();
    expect(nextOpenStep(list, "zones")).toBe("clients");
    expect(nextOpenStep(list, "clients")).toBe("zones");
    expect(nextOpenStep([{ id: "business", done: true }], "business")).toBeNull();
  });
});
