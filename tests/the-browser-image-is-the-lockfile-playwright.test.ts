/**
 * The browser jobs run inside Playwright's own image, and that image has to be
 * the Playwright the lockfile installs.
 *
 * ── WHY THEY RUN IN AN IMAGE AT ALL ───────────────────────────────────────
 *
 * On 2026-11-11 "Four real widths in a real browser" and "The one-off cases in
 * a real browser" failed on nine PRs and on main 3a028504 the same way: inside
 * `playwright install --with-deps chromium`, apt-get got "Temporary failure
 * resolving archive.ubuntu.com". No test had started. Every run of those jobs
 * on GitHub's Linux machine depended on Ubuntu's mirrors resolving, for a set
 * of libraries that never changes between runs.
 *
 * So on that machine both jobs now take `container:`
 * mcr.microsoft.com/playwright:vX.Y.Z-noble, which ships Chromium and every
 * library it needs, and scripts/install-playwright-browser.sh skips
 * `--with-deps` there. No apt.
 *
 * ── WHY THE TAG IS PINNED HERE ────────────────────────────────────────────
 *
 * The image's browsers belong to ONE Playwright release. If package-lock.json
 * moves on and the tag does not, `playwright install chromium` quietly
 * downloads a newer Chromium into an image whose system libraries were chosen
 * for the old one -- and the first symptom is a browser that will not launch,
 * or one that renders text a pixel differently, reported as a layout failure.
 * A dependency bump that moves one must move the other, and this says so by
 * name, in seconds, before either job starts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const workflow = readFileSync(join(root, ".github/workflows/sandboxes.yml"), "utf8");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string }>;
};

const BROWSER_JOBS = ["viewports", "viewport-cases"] as const;

/** The text of one top-level job, from its key to the next job's key. */
function jobBlock(id: string): string {
  const start = workflow.search(new RegExp(`^  ${id}:\\s*$`, "m"));
  expect(start, `sandboxes.yml has no job \`${id}\``).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe("the browser jobs' Playwright image", () => {
  const installed = lock.packages["node_modules/playwright"]?.version;

  it("the lockfile names a Playwright to compare against", () => {
    expect(installed).toMatch(/^\d+\.\d+\.\d+/);
  });

  for (const id of BROWSER_JOBS) {
    it(`${id}: runs in mcr.microsoft.com/playwright:v${installed}, the lockfile's version`, () => {
      const block = jobBlock(id);
      const container = /^ {4}container:.*$/m.exec(block)?.[0];
      expect(container, `${id} has no \`container:\` line -- it would install system deps with apt`).toBeTruthy();
      const tag = /mcr\.microsoft\.com\/playwright:v([\w.-]+?)-noble/.exec(container!)?.[1];
      expect(tag, `${id}'s container is not a Playwright image`).toBeTruthy();
      expect(tag, `${id} runs Playwright image v${tag}, but package-lock.json installs ${installed}`).toBe(installed);
    });

    it(`${id}: installs the browser through the script that skips apt in that image`, () => {
      const block = jobBlock(id);
      expect(block).toContain("run: bash scripts/install-playwright-browser.sh");
      expect(block).not.toMatch(/run: npx playwright install/);
    });
  }
});
