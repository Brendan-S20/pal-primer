// A control that appears on `group-hover` is a control a phone cannot reach.
//
// This is one of the rules in CLAUDE.md, and it is here rather than only there
// because it is the one rule in that file a machine can check exactly. Hover
// reveals are easy to write, they look right on the machine they are written
// on, and they fail in a way that produces no error and no visual clue — the
// control is simply not there, and the person holding the phone concludes the
// feature does not exist.
//
// The live instance that prompted this: `/notifications` rendered its per-row
// Delete inside `hidden gap-1 group-hover:flex`. On a phone, notifications
// could be read and could not be dismissed, forever. `NotificationBell` had
// the same markup and had already been given a `max-md:block` escape, so the
// two copies of one control disagreed about whether phones exist.
//
// ── WHAT COUNTS AS A VIOLATION ────────────────────────────────────────────
//
// Only reveals. `group-hover:scale-105` on a portal thumbnail is decoration —
// nothing is hidden, the image is there either way, and requiring an escape
// hatch for it would train people to add meaningless ones. What this looks for
// is a `group-hover:` that turns something ON: display, visibility, or opacity.
//
// ── WHY `max-md:` AND NOT A MEDIA QUERY FOR TOUCH ─────────────────────────
//
// `hover: none` would be the precise test and is the wrong one to build on.
// A touchscreen laptop reports coarse pointer support while being driven with
// a trackpad, and a phone in a desktop-mode browser reports whatever it likes.
// Width is a worse proxy for input in theory and a better one in practice: at
// phone widths, show the control. Anyone at that width who does have a mouse
// loses nothing but a little tidiness.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** A `group-hover:` utility that makes something appear, as opposed to one
 *  that animates or tints something already on screen. */
const REVEAL =
  /group-hover:(block|flex|inline|inline-flex|inline-block|grid|table|visible|opacity-100)\b/;

/** The counterpart that has to be in the same class list: something that puts
 *  it back on screen at phone widths. */
const TOUCH_ESCAPE =
  /max-md:(block|flex|inline|inline-flex|inline-block|grid|table|visible|opacity-\d+)\b/;

type Reveal = { file: string; line: number; classes: string };

/** Lazy — resolving this in a `describe` body throws at import time if a file
 *  is missing, and vitest then reports "no tests" rather than a failure. */
const reveals = (): Reveal[] => {
  const found: Reveal[] = [];
  for (const file of tsxFiles(join(root, "src"))) {
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // Comments explain these fixes by quoting the markup they replaced, so
      // reading them as code would flag the account of the fix as the defect.
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      for (const m of line.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const classes = m[1] ?? m[2] ?? "";
        if (REVEAL.test(classes)) {
          found.push({ file: file.slice(root.length + 1), line: i + 1, classes });
        }
      }
    });
  }
  return found;
};

describe("nothing important is hover-only", () => {
  it("finds the hover reveals, so a green run means checked and not skipped", () => {
    // If this drops to zero the rule below is vacuously true and would stay
    // green through any amount of new hover-only markup written in a form the
    // scanner does not recognise.
    expect(reveals().length).toBeGreaterThan(0);
  });

  it("gives every one of them a way through on a phone", () => {
    const stranded = reveals()
      .filter((r) => !TOUCH_ESCAPE.test(r.classes))
      .map((r) => `${r.file}:${r.line}\n    ${r.classes}`);
    // Named rather than counted: the failure message has to say which control
    // is unreachable, because "1 violation" sends the reader hunting.
    expect(stranded).toEqual([]);
  });

  it("leaves decoration alone", () => {
    // `group-hover:scale-105` and friends hide nothing. They must not be
    // caught, or the fix for a failure becomes "add a meaningless max-md:".
    expect(REVEAL.test("h-full w-full object-cover transition group-hover:scale-105")).toBe(false);
    expect(REVEAL.test("transition group-hover:text-foreground")).toBe(false);
    expect(REVEAL.test("hidden gap-1 group-hover:flex")).toBe(true);
    expect(REVEAL.test("opacity-0 group-hover:opacity-100")).toBe(true);
  });
});

describe("the two copies of the notification row agree that phones exist", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  /** The attributes of the button carrying `aria-label`, up to its icon. Both
   *  files spell the button the same way, and anchoring on the label rather
   *  than on a character offset is what stops this from re-breaking every time
   *  a comment above it grows a line. */
  const buttonAttrs = (src: string, label: string) => {
    const at = src.indexOf(`aria-label="${label}"`);
    expect(at).toBeGreaterThan(0);
    return src.slice(at, src.indexOf("<X ", at));
  };

  it("shows Delete at phone widths in the bell and on the page", () => {
    // The same control, rendered twice, in two files, by two edits months
    // apart. One had the escape and one did not; asserting on both is how the
    // next divergence gets caught rather than the next report.
    for (const f of [
      "src/components/NotificationBell.tsx",
      "src/routes/_authenticated/notifications.tsx",
    ]) {
      expect(buttonAttrs(read(f), "Delete notification")).toMatch(TOUCH_ESCAPE);
    }
  });

  it("does not put a duplicate Mark read on top of the title", () => {
    // Tapping the row already marks it read. On a phone the reveal container
    // is always visible, so leaving the button in would overlay the
    // notification with a second control doing what tapping it already does.
    const src = read("src/routes/_authenticated/notifications.tsx");
    // Anchored inside the reveal container, because the prose above it also
    // says the words "Mark read" and `indexOf` found the explanation first.
    const container = src.slice(src.indexOf('className="absolute right-3 top-3'));
    expect(container.slice(0, container.indexOf("Mark read"))).toMatch(/max-md:hidden/);
  });
});
