// The vocabulary pass of the eleven-reviewer audit: four places where the
// product printed a word its reader does not use.
//
//   the add-on row      a raw addon_frequency enum, to a homeowner
//   the lifecycle SMS   "yard cleanup" for the thing the portal calls a visit
//   the role labels     four hand-written copies of one four-line map
//   the skip warning    a charge that is usually zero, on an action that
//                       never charges at all
//
// ── THREE CORRECTIONS TO THE REPORT ──────────────────────────────────────
//
// 1. The add-on enum's values are not `per_visit` / `one_time`. `addon_frequency`
//    is ('weekly','biweekly','monthly','quarterly','yearly') and has never been
//    altered since it was created. Only `monthly` of the three named values
//    exists. That matters for the fix: the worst of the real values is
//    `biweekly`, which is not ugly so much as ambiguous — twice a week, or every
//    other week? — and the rest of the portal has spelled it "Every 2 weeks"
//    since the frequency-label map was consolidated. So the right helper was the
//    portal's own `friendlyFrequency`, not humanizeEnum, which would have
//    printed "Biweekly" and kept the ambiguity with a capital letter.
//
// 2. "At least four other files carry their own inline role→label maps" was
//    right about the count and wrong about every filename. All six candidates
//    it named are logic, not labels: VisitDetailDrawer, OneOffVisitDialog,
//    AutoRoutingPanel, LaneStrip and VisitsTab match a role grep only through
//    `is_field_tech` filters and one `role === "dispatcher"` permission branch,
//    and useMyRole.ts is the route ACL. Those were left alone. The five real
//    copies were elsewhere: provision-location.ts, profile.tsx, and BOTH role
//    pickers on settings.users.tsx — where the same table cell renders
//    humanizeRole for a row you cannot edit and a private map for one you can —
//    plus platform.invites.tsx, which is the one that proves the point. Its
//    <option> list says "Tech". The invites table four lines below it calls
//    humanizeRole and says "Technician". One page, one role, two words.
//
// 3. The skip fee is not an organizations column. It is a percentage, per
//    reason code, in `skip_billing_rules`, and `customer_requested` — the code
//    the portal writes — has no default row at all: `portal_request_skip` ends
//    with `IF _pct IS NULL THEN _pct := 0`. Both halves of the report's claim
//    held: the warning fires on reschedule, which cannot bill, and it warns
//    about a charge that on an unconfigured org is zero.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { frequencyLabel, FREQUENCY_LABELS } from "@/lib/frequency-request";
import { humanizeRole } from "@/lib/humanize";

const ROOT = join(import.meta.dirname, "..");

/** Lazy on purpose. A readFileSync resolved in a describe body throws at
 *  collection time, and vitest reports a file that failed to import as "no
 *  tests" rather than as failures — which reads, in a terminal and in CI, as a
 *  pass. Every source below is a thunk so a bad path fails one assertion. */
const read = (p: string) => () => readFileSync(join(ROOT, p), "utf8");

const propertyRoute = read("src/routes/portal.$slug.$token.property.tsx");
const visitsRoute = read("src/routes/portal.$slug.$token.visits.tsx");
const portalUi = read("src/lib/portal-ui.tsx");
const portalFns = read("src/lib/portal.functions.ts");
const messages = read("src/lib/messages.functions.ts");
const profile = read("src/routes/_authenticated/profile.tsx");
const settingsUsers = read("src/routes/_authenticated/settings.users.tsx");

/** Source with comments removed, for every `not.toMatch`. Each fix here is
 *  documented in a comment that quotes the copy it replaced — asserting the old
 *  wording is gone would otherwise fail on the explanation of its removal.
 *  Braced JSX comment blocks go first: they span lines, so a line-prefix
 *  filter cannot see them, and every JSX fix here is documented in one. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

/* ───────────────── 1. a database enum shown to a homeowner ──────────────── */

describe("the portal's active add-ons say their cadence in words", () => {
  /** The enum as the database declares it, read rather than remembered — the
   *  report named values this type does not have, and a label map that covers
   *  the wrong five values would pass every test below while shipping the bug. */
  const declaredFrequencies = (): string[] => {
    const dir = join(ROOT, "supabase/migrations");
    const values: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".sql")) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      const created = /CREATE TYPE public\.addon_frequency AS ENUM \(([^)]+)\)/i.exec(sql);
      if (created) values.push(...[...created[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
      // An ALTER that adds a value later would make the create statement a
      // half-truth. There is none today; this is what notices if one lands.
      for (const m of sql.matchAll(
        /ALTER TYPE public\.addon_frequency ADD VALUE[^;]*'([a-z_]+)'/gi,
      )) {
        values.push(m[1]);
      }
    }
    return [...new Set(values)];
  };

  it("has a label for every value the enum can hold", () => {
    const declared = declaredFrequencies();
    expect(
      declared.length,
      "found no addon_frequency declaration to check against",
    ).toBeGreaterThan(0);
    for (const v of declared) {
      expect(FREQUENCY_LABELS, `addon_frequency '${v}' has no label`).toHaveProperty(v);
    }
  });

  it("spells the ambiguous cadence out instead of capitalising it", () => {
    // The whole reason this uses the portal's map and not humanizeEnum. A
    // homeowner reading "Biweekly" still does not know which fortnight they are
    // paying for; the plan row three screens away has said "Every 2 weeks" for
    // months.
    expect(frequencyLabel("biweekly")).toBe("Every 2 weeks");
    expect(frequencyLabel("quarterly")).toBe("Quarterly");
    expect(frequencyLabel("yearly")).toBe("Yearly");
  });

  it("renders the add-on row through the label helper, not the raw column", () => {
    const src = codeOnly(propertyRoute());
    expect(src).toMatch(/friendlyFrequency\(a\.frequency\)/);
    expect(src, "raw addon_frequency enum still interpolated into the row").not.toMatch(
      /·\s*\{a\.frequency\}/,
    );
  });
});

/* ─────────────────────── 2. two names for one thing ─────────────────────── */

describe("the lifecycle texts call it the same thing the portal does", () => {
  /** The reminder and completed texts in sendVisitStatusSms, and the "on my
   *  way" text, which moved to on-my-way.ts when it learned the tech's name
   *  and an arrival window. */
  const templates = (): string[] => [
    ...[...codeOnly(messages()).matchAll(/`Hi \$\{name\}[^`]*`/g)].map((m) => m[0]),
    ...[
      ...codeOnly(read("src/lib/on-my-way.ts")()).matchAll(/`Hi \$\{p\.customerName\}[^`]*`/g),
    ].map((m) => m[0]),
  ];

  it("finds the four visit texts and the walk text", () => {
    // Two in one ternary, the scoop on-my-way text, the on-my-way text for a
    // visit that is not a yard (#560), and the walk text. Fewer would mean
    // this suite is checking a subset of the copy.
    expect(templates()).toHaveLength(5);
  });

  it("says visit on a scoop and walk on a walk", () => {
    const walks = templates().filter((t) => t.includes("today's walk"));
    const visits = templates().filter((t) => !t.includes("today's walk"));
    expect(walks).toHaveLength(1);
    expect(visits).toHaveLength(4);
    for (const t of visits) expect(t, t).toMatch(/\bvisit\b/);
    expect(walks[0]).toMatch(/\bwalk\b/);
    expect(walks[0]).not.toMatch(/Reply ENT|Reply DNE/);
  });

  it("has no yard cleanup left in the customer-facing copy", () => {
    // "visit" won on weight of evidence, not preference: the portal's
    // "Upcoming visits" heading and Skip/Reschedule rows, the visit-completed
    // and weather-reschedule emails, and legal.sms.tsx, which promises the
    // customer "visit-completed confirmations" in those words. "Yard cleanup"
    // appeared in exactly one switch statement.
    expect(codeOnly(messages())).not.toMatch(/yard clean-?up/i);
  });
});

/* ────────────────────── 3. one map for the role labels ──────────────────── */

describe("a role has one label in the whole product", () => {
  const ROLES = ["owner", "office_manager", "dispatcher", "tech"] as const;

  it("labels every role the app can assign", () => {
    expect(ROLES.map(humanizeRole)).toEqual([
      "Owner",
      "Office manager",
      "Dispatcher",
      "Technician",
    ]);
  });

  it("falls back readably rather than printing the enum", () => {
    // What the deleted local maps did on an unknown role was print the raw
    // value, or nothing. This is the fallback that made deleting them safe.
    expect(humanizeRole("route_planner")).toBe("Route planner");
    expect(humanizeRole(null)).toBe("-");
  });

  /** Every .ts/.tsx under src/ that still writes a role label by hand, in any
   *  of the three shapes the duplicates used: an object entry, a
   *  `{ value, label }` option, or a hard-coded <option>. */
  const handWrittenLabelMaps = (): string[] => {
    const offenders: string[] = [];
    const shapes = [
      /^\s*(owner|office_manager|dispatcher|tech)\s*:\s*["'][A-Z]/m,
      /label:\s*["'](Owner|Office manager|Dispatcher|Technician)["']/,
      /<option value="(owner|office_manager|dispatcher|tech)"\s*>/,
    ];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, childRel);
          continue;
        }
        if (!/\.tsx?$/.test(e.name)) continue;
        // The one definition, and the generated database types.
        if (childRel === "lib/humanize.ts") continue;
        if (childRel === "integrations/supabase/types.ts") continue;
        if (!statSync(join(ROOT, full)).isFile()) continue;
        const src = codeOnly(readFileSync(join(ROOT, full), "utf8"));
        if (shapes.some((re) => re.test(src))) offenders.push(childRel);
      }
    };
    walk("src", "");
    return offenders.sort();
  };

  it("keeps that label in exactly one file", () => {
    // Four copies is how two screens end up disagreeing about what a `tech` is
    // called. This is the guard, not the fix — the fix was deleting three maps
    // and one hard-coded <option> list. If this fails on a new file, route it
    // through humanizeRole; if humanizeRole gives a worse word than the local
    // map wanted, change humanizeRole.
    expect(handWrittenLabelMaps()).toEqual([]);
  });

  it("routes the two pages that had their own copies through the shared one", () => {
    expect(codeOnly(profile())).toMatch(/humanizeRole\(staff\.role\)/);
    expect(codeOnly(settingsUsers())).toMatch(/humanizeRole\(r\)/);
  });
});

/* ───────────── 4. a warning about a charge that is usually zero ─────────── */

describe("the skip notice only mentions money when there is money", () => {
  const migrations = (): string => {
    const dir = join(ROOT, "supabase/migrations");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  };

  it("confirms a portal skip is free unless the org configured otherwise", () => {
    // The claim the copy rests on, checked against the function that does the
    // billing rather than against the settings screen that describes it.
    const fn = /CREATE OR REPLACE FUNCTION public\.portal_request_skip[\s\S]*?END; \$\$;/.exec(
      migrations(),
    );
    expect(fn, "portal_request_skip not found").not.toBeNull();
    expect(fn![0]).toMatch(/IF _pct IS NULL THEN _pct := 0/);
    expect(fn![0]).toMatch(/reason_code\s*=\s*'customer_requested'/);
  });

  it("confirms rescheduling cannot bill at all", () => {
    // Why the money sentence is gated on skipOpen and not on the pair. If a
    // later migration teaches reschedule to charge, this fails and the copy
    // needs revisiting rather than quietly becoming wrong again.
    const fn = /CREATE OR REPLACE FUNCTION public\.portal_reschedule_visit[\s\S]*?END; \$\$;/.exec(
      migrations(),
    );
    expect(fn, "portal_reschedule_visit not found").not.toBeNull();
    expect(fn![0]).not.toMatch(/skip_charge_cents|skip_billable/);
  });

  it("carries the org's percentage to the portal, defaulting to no charge", () => {
    expect(codeOnly(portalFns())).toMatch(/skip_billable_pct:\s*rule\?\.billable_pct \?\? 0/);
    expect(codeOnly(visitsRoute())).toMatch(
      /skipBillablePct=\{Number\(c\?\.skip_billable_pct \?\? 0\)\}/,
    );
  });

  it("drops the hedge that was shown on both actions", () => {
    expect(codeOnly(portalUi())).not.toMatch(/may still be billable/);
  });

  it("shows the charge only when skipping, and only when there is one", () => {
    const src = codeOnly(portalUi());
    // The condition, verbatim: reschedule never reaches the money sentence, and
    // a zero percentage never reaches it either.
    expect(src).toMatch(/skipOpen && skipBillablePct > 0/);
    expect(src).toMatch(
      /Skipping this visit is still billed at \$\{skipBillablePct\}% of the visit price/,
    );
    expect(src).toMatch(/Skipping this visit is still billed at the full visit price/);
  });
});
