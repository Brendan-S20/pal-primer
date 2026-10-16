// Dog walking can be booked (#410).
//
// #467 listed walking as Coming soon until its path worked end to end. The
// path is booking (with a time window), the walker's day, the portal's walk
// reports and access, the client's emails, the reports and the invoices, and
// with all of it in, walking is back in BOOKABLE_SERVICE_LINES. Sitting is bookable with #411.
// Mobile grooming (#412) and training (#413) still wait for theirs,
// so they are still Coming soon. And nothing in src/ may still tell an owner
// that walking is not available.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceLinesChoices } from "@/components/ServiceLinesChoices";
import { BOOKABLE_SERVICE_LINES, OFFERED_SERVICE_LINES } from "@/lib/service-lines";
import { serviceLineChoices } from "@/lib/services";
import { repoRelative } from "./support/repo-paths";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Each <li> of the rendered choices, keyed by the label it carries. */
function rowsOf(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const li of html.split("<li").slice(1)) {
    const label = /<span[^>]*font-medium[^>]*>([^<]+)<\/span>/.exec(li)?.[1] ?? "";
    out.set(label, li);
  }
  return out;
}

describe("which lines can be booked", () => {
  it("walking and sitting are bookable; grooming and training wait", () => {
    expect(BOOKABLE_SERVICE_LINES).toContain("dog_walking");
    expect(BOOKABLE_SERVICE_LINES).toContain("pet_waste");
    expect(BOOKABLE_SERVICE_LINES).toContain("pet_sitting");
    for (const line of ["mobile_grooming", "training"] as const) {
      expect(OFFERED_SERVICE_LINES).toContain(line);
      expect(BOOKABLE_SERVICE_LINES).not.toContain(line);
    }
  });

  it("a scooper can put a service on the walking line without ticking anything first", () => {
    expect(serviceLineChoices(["pet_waste"])).toContain("dog_walking");
    expect(serviceLineChoices(["pet_waste"])).toContain("pet_sitting");
  });
});

describe("the picker an owner sees", () => {
  const html = renderToStaticMarkup(
    <ServiceLinesChoices lines={["pet_waste"]} onChange={() => {}} />,
  );
  const rows = rowsOf(html);

  it("draws Dog walking with no Coming soon badge, and it can be ticked", () => {
    const walking = rows.get("Dog walking");
    expect(walking, html).toBeDefined();
    expect(walking).not.toContain("Coming soon");
    expect(walking).not.toMatch(/disabled=""/);
  });

  it("still marks the lines that are not ready", () => {
    for (const label of ["Mobile grooming", "Dog training"]) {
      const row = rows.get(label);
      expect(row, label).toBeDefined();
      expect(row, label).toContain("Coming soon");
    }
  });

  it("says what it said before #467 under a single ticked line", () => {
    expect(html).toContain("You need at least one. Add or remove lines as your business changes.");
    expect(html).not.toContain("cannot be added yet");
  });
});

// ── Nothing still says walking is unavailable ──────────────────────────────

function* walk(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(f)) yield p;
  }
}

describe("copy about walking", () => {
  const UNAVAILABLE = [
    /dog walking[^.\n]{0,80}(coming soon|not (yet )?(available|bookable)|when booking arrives)/i,
    /(coming soon|when booking arrives)[^.\n]{0,40}dog walking/i,
    /only pet waste removal is bookable/i,
  ];

  it("no file in src/ describes dog walking as Coming soon or not bookable", () => {
    const hits: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // The one sentence that names walking as bookable beside the lines
        // that are not.
        if (/dog walking are bookable/i.test(line)) return;
        if (UNAVAILABLE.some((re) => re.test(line))) hits.push(`${repoRelative(file, ROOT)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("Settings > Services says walking can be booked", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/Pet waste removal and dog walking are bookable/);
    expect(page).not.toMatch(/Only pet waste\s+removal is bookable/);
  });
});
