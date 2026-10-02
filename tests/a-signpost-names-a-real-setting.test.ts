import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EVERY "Settings → X" THE PRODUCT SAYS HAS TO NAME A SETTINGS PAGE THAT EXISTS.
 *
 * Found in the launch pass, 2026-10. The product tells people where things are
 * in about forty places — error messages, empty states, help articles, emails
 * — and by then a quarter of those directions pointed at a label that was not
 * on the settings rail:
 *
 *   - the weekly digest email said "turn this off in Settings → Notifications".
 *     There is no such page; the digest is configured on Analytics.
 *   - three AI messages said "Settings → AI Tools" and one said "check your API
 *     key in Settings → AI", a field deleted when BYOK went.
 *   - onboarding and the plan picker said "Settings → Plan & billing" while the
 *     rail said "Billing", and three other places said "Billing".
 *   - the schedule said "Settings → Team" and the lead form "Settings → Client
 *     portal branding"; Online signup sent people to Preferences for a portal
 *     address that moved to Client portal on 2026-08-28.
 *
 * None of that is visible to a type checker or a layout sweep: each string is
 * well-formed, and each page it names is one rename away from being right.
 * So this reads the labels from TAB_GROUPS in settings.tsx (as text, because
 * a route file should only export its Route) and holds every signpost in
 * src/ to one of them.
 *
 * Comments are skipped: they record history, including old names on purpose.
 * Directions inside OTHER products' settings (Supabase, Sweep&Go, QuickBooks)
 * are allowed by name below, each with the reason.
 */

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

function settingsLabels(): string[] {
  const src = readFileSync(join(SRC, "routes", "_authenticated", "settings.tsx"), "utf8");
  const block = src.slice(src.indexOf("const TAB_GROUPS"), src.indexOf("function SettingsLayout"));
  return [...block.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Lines that give directions inside somebody else's product. */
const OTHER_PRODUCTS: Array<[RegExp, string]> = [
  [/Project Settings →/, "the Supabase dashboard, for whoever deploys this"],
  [/Sweep&Go → Settings →/, "Sweep&Go's own export menu, in the import instructions"],
  [/Settings → Import data → Invoices/, "QuickBooks Online's own import menu"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".gen.ts")) out.push(full);
  }
  return out;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*");
}

describe("a signpost names a real setting", () => {
  const labels = settingsLabels();

  it("reads the labels it checks against", () => {
    // A parse that silently found nothing would pass every signpost below.
    expect(labels.length).toBeGreaterThan(15);
    expect(labels).toContain("Preferences");
    expect(labels).toContain("Plan & billing");
  });

  it("every Settings → X in the product's copy is a label on the settings rail", () => {
    const wrong: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        for (const m of line.matchAll(/Settings\s*(?:→|->|&rarr;)\s*/g)) {
          if (OTHER_PRODUCTS.some(([re]) => re.test(line))) continue;
          const rest = line.slice(m.index! + m[0].length).replace(/&amp;/g, "&");
          // A JSX link often puts the label on the next line.
          const target = rest.trim() === "" ? (lines[i + 1] ?? "").trim() : rest;
          if (!labels.some((l) => target.startsWith(l))) {
            wrong.push(`${relative(ROOT, file)}:${i + 1}  "Settings → ${target.slice(0, 40)}"`);
          }
        }
      });
    }
    expect(
      wrong,
      `these point at a settings page that is not on the rail. Labels: ${labels.join(", ")}`,
    ).toEqual([]);
  });
});
