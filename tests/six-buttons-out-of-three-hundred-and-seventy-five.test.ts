// The touch floor was a policy applied to whichever screens someone opened on
// a phone.
//
// `ui/button.tsx` shipped `h-8` for `size="sm"` and `h-9 w-9` for
// `size="icon"` — 32px and 36px against a stated minimum of 44 — and the fix
// so far had been a hand-written `touch:min-h-11` on six individual buttons.
// There are roughly 375 call sites. Six of them is not a rule, it is a record
// of where somebody happened to look.
//
// ── WHY IT SAT THERE ──────────────────────────────────────────────────────
//
// Raising the heights outright relayouts every dense office table on a
// desktop, which is a design decision rather than a bug fix, and that is what
// kept it parked. Scoping the floor to `max-md:` settles it: the pointer
// layout is unchanged to the pixel and a thumb gets 44px. `ui/tabs.tsx`
// already makes exactly this split.
//
// `ui/dialog.tsx` and `ui/sheet.tsx` deliberately do the opposite and set
// `h-11` at every width. That is right for them and wrong here — a close
// button is a 16px glyph inside a box, so the box can grow without moving
// anything, whereas a button's height is the density of the row it sits in.
//
// ── min-h, NOT h ──────────────────────────────────────────────────────────
//
// `min-height` beats `height` in the used-value calculation regardless of the
// order the two utilities land in the stylesheet, so `h-8 touch:min-h-11`
// resolves to 44px without depending on how Tailwind sorts its variants. That
// is a correctness point rather than a style preference, and it is why the
// assertions below insist on the `min-` form.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");
const button = () => read("src/components/ui/button.tsx");

/** The `size` variant block, which is the only part this is about. */
function sizeVariants(src: string): string {
  const start = src.indexOf("size: {");
  expect(start, "no size variant block in ui/button.tsx").toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("},", start));
}

describe("every button clears 44px on touch", () => {
  const sizes = () => sizeVariants(button());

  it("covers all four sizes, not just the small one", () => {
    // `sm` is the obvious offender at 32px, and fixing only `sm` leaves
    // `icon` at 36 and `default` at 36 — both still under the floor.
    const block = sizes();
    for (const name of ["default:", "sm:", "lg:", "icon:"]) {
      const line = block.split("\n").find((l) => l.trim().startsWith(name));
      expect(line, `no ${name} size defined`).toBeTruthy();
      expect(line!, `${name} has no touch floor`).toMatch(/touch:min-h-11/);
    }
  });

  it("gives the icon size a width floor too, since it is square", () => {
    // A 44px-tall, 36px-wide icon button is still a miss horizontally.
    const icon = sizes()
      .split("\n")
      .find((l) => l.trim().startsWith("icon:"));
    expect(icon!).toMatch(/touch:min-w-11/);
  });

  it("uses min-h rather than h, so the base height cannot win", () => {
    // `h-8 touch:h-11` depends on stylesheet order; `h-8 touch:min-h-11`
    // does not. The whole variant block must use the min- form.
    const block = sizes();
    expect(block).not.toMatch(/max-md:h-\d/);
    expect(block).not.toMatch(/max-md:w-\d/);
  });

  it("leaves the pointer layout exactly as it was", () => {
    // The reason this was safe to do at all. If these base heights change,
    // it stopped being a touch fix and became a redesign of every dense
    // table in the office app.
    const block = sizes();
    expect(block).toMatch(/default:\s*"h-9 px-4 py-2/);
    expect(block).toMatch(/sm:\s*"h-8 rounded-md px-3 text-xs/);
    expect(block).toMatch(/lg:\s*"h-10 rounded-md px-8/);
    expect(block).toMatch(/icon:\s*"h-9 w-9/);
  });

  it("scopes the floor to touch and not to every width", () => {
    // An unscoped h-11/min-h-11 here is the change that was deliberately not
    // made. It would pass the assertions above and silently relayout desktop.
    const block = sizes();
    for (const m of block.matchAll(/(?:^|[\s"])(min-[hw]-11)/g)) {
      const at = block.indexOf(m[0]);
      const prefix = block.slice(Math.max(0, at - 8), at + m[0].length);
      expect(prefix, `unscoped ${m[1]} in the size variants`).toMatch(/max-md:/);
    }
  });
});

describe("the two house patterns stay distinct", () => {
  it("keeps dialog and sheet closes at 44px on every width", () => {
    // These are the prior art the working agreement cites by name. If they
    // drift to max-md: someone has mistaken this change for a general rule.
    for (const p of ["src/components/ui/dialog.tsx", "src/components/ui/sheet.tsx"]) {
      expect(read(p), `${p} lost its unconditional 44px close`).toMatch(/h-11 w-11/);
    }
  });

  it("keeps the tabs floor touch-scoped, which is the pattern button follows", () => {
    expect(read("src/components/ui/tabs.tsx")).toMatch(/touch:min-h-11/);
  });
});
