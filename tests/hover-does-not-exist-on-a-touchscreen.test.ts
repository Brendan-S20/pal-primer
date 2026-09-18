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
import { repoRelative } from "./support/repo-paths";

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
 *  it back on screen where there is no hover.
 *
 * ── THIS USED TO ACCEPT `max-md:` ALONE, AND THAT WAS WRONG ───────────────
 *
 * `max-md:` keys on WIDTH. The thing that is missing on a touch device is not
 * width, it is HOVER — and Tailwind 4 compiles every `hover:` and
 * `group-hover:` rule inside `@media (hover:hover)` (verified in the built
 * stylesheet, not assumed). So the reveal never fires on any touch device at
 * any size.
 *
 * Below 768px the width escape happened to cover that, which is why this rule
 * looked correct for as long as the only touch device anyone measured was a
 * phone. On an iPad — 744 to 1366px, touch, both orientations — there is no
 * hover AND no `max-md`, so the control was invisible and unreachable. Found
 * on 2026-08-21 by sweeping the real Apple sizes rather than the four
 * canonical widths; the delete button on /notifications was unreachable on
 * every iPad the product ships to.
 *
 * `touch:` is the honest condition — a coarse pointer OR a narrow viewport,
 * defined once in src/styles.css. It is a SUPERSET of the old `max-md:`, so
 * accepting only it costs nothing below 768px and stops excluding iPads.
 */
const TOUCH_ESCAPE =
  /touch:(block|flex|inline|inline-flex|inline-block|grid|table|visible|opacity-\d+)\b/;

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
          found.push({ file: repoRelative(file, root), line: i + 1, classes });
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

  it("gives every one of them a way through on ANY touch device, not just a narrow one", () => {
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

describe("there is now ONE notification row, and it agrees that phones exist", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  /** The attributes of the button carrying `aria-label`, up to its icon.
   *  Anchoring on the label rather than on a character offset is what stops
   *  this from re-breaking every time a comment above it grows a line. */
  const buttonAttrs = (src: string, label: string) => {
    const at = src.indexOf(`aria-label="${label}"`);
    expect(at).toBeGreaterThan(0);
    return src.slice(at, src.indexOf("<X ", at));
  };

  it("shows Delete at phone widths on the notifications page", () => {
    // This used to loop over TWO files. The header bell rendered its own copy
    // of the list — same rows, same mark-read, same delete — and the two were
    // written months apart, so one had the touch escape and one did not.
    //
    // The bell is a link to /notifications now, so there is one copy and this
    // is it. The duplication is guarded separately below, because deleting a
    // divergence is worth nothing if the next change puts it back.
    expect(buttonAttrs(read("src/routes/_authenticated/notifications.tsx"), "Delete notification"))
      .toMatch(TOUCH_ESCAPE);
  });

  it("does not put a duplicate Mark read on top of the title", () => {
    // Tapping the row already marks it read. On a phone the reveal container
    // is always visible, so leaving the button in would overlay the
    // notification with a second control doing what tapping it already does.
    const src = read("src/routes/_authenticated/notifications.tsx");
    // Anchored inside the reveal container, because the prose above it also
    // says the words "Mark read" and `indexOf` found the explanation first.
    const container = src.slice(src.indexOf('className="absolute right-3 top-3'));
    expect(container.slice(0, container.indexOf("Mark read"))).toMatch(/touch:hidden/);
  });

  it("keeps the header bell a link rather than a second copy of the list", () => {
    // The bell's job is to say whether anything is waiting and to take you to
    // it. The moment it grows a list again it grows a second delete button, a
    // second mark-read, and a second set of touch rules to keep in step — the
    // exact drift the first test in this block was written to catch.
    const bell = read("src/components/NotificationBell.tsx");
    expect(bell).toMatch(/to="\/notifications"/);
    for (const forbidden of ["Delete notification", "Mark all read", "markNotificationRead"]) {
      expect(
        bell.includes(forbidden),
        `NotificationBell has grown "${forbidden}" — it is turning back into a ` +
          `second copy of /notifications. The page owns the list; the bell owns ` +
          `the badge and the link.`,
      ).toBe(false);
    }
  });

  it("kept notification settings reachable after the dropdown went away", () => {
    // The gear icon lived in the bell's dropdown and was its ONLY entry point.
    // Removing the dropdown without moving it would have deleted a settings
    // screen with nothing failing — no test asserts that a screen is reachable.
    expect(read("src/routes/_authenticated/notifications.tsx")).toMatch(/NotificationPrefs/);
  });
});
