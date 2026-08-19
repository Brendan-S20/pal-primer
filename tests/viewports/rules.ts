import { type Page } from "@playwright/test";

/**
 * The four measured rules, in one place.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * These bodies were written for `every-public-page-at-every-width.spec.ts`
 * and every word of reasoning in their comments was earned there. When the
 * sweep grew a second half — `every-signed-in-page-at-every-width.spec.ts` —
 * copying them would have created two definitions of "no horizontal page
 * scroll" that drift the first time one is fixed.
 *
 * So the MEASUREMENTS live here and the ASSERTIONS stay in the specs, where
 * the failure message can name the route and the width. Nothing about what
 * either rule checks changed in the move: the thresholds, the exclusions and
 * the wording of every finding are the ones the public sweep shipped with.
 *
 * Each function returns findings rather than asserting, because the signed-in
 * sweep runs all four rules against ONE page load and reports every fault it
 * finds. A dashboard that is measured four times is measured four times as
 * slowly, and a rule that stops at the first failure hides the other three.
 */

/** The four widths named in CLAUDE.md, measured rather than reasoned about.
 *
 *  360 is the one that matters: "320–360px is a real phone, not an edge case."
 *  768 and 1280 bracket the tablet band the working agreement calls out as the
 *  place layouts with only phone/desktop branches fail. 1920 catches the
 *  opposite fault — a max-width that was never set. */
export const WIDTHS = [
  { w: 360, h: 780, label: "360 · a real phone" },
  { w: 768, h: 1024, label: "768 · tablet portrait" },
  { w: 1280, h: 800, label: "1280 · small laptop" },
  { w: 1920, h: 1080, label: "1920 · wide monitor" },
] as const;

/**
 * THE rule, stated first in the working agreement: "No horizontal page
 * scroll, ever." Wide content scrolls inside its own container; the body
 * does not.
 *
 * Measured on documentElement AND body because either can be the scrolling
 * box depending on overflow styles. Callers allow a 1px tolerance for
 * sub-pixel rounding at fractional device ratios — not for anything a person
 * could see.
 */
export async function measurePageOverflow(page: Page): Promise<{ scrollW: number; innerW: number }> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const scrollW = Math.max(de.scrollWidth, document.body.scrollWidth);
    return { scrollW, innerW: window.innerWidth };
  });
}

/**
 * A control whose right edge is past the viewport is unreachable even when
 * the page itself does not scroll — the overflow rule above can be satisfied
 * by clipping. This is the fault that rule cannot see.
 */
export async function findControlsOffTheSide(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];

    /** Inside a horizontal scroller whose own edge is on the page.
     *
     *  The working agreement asks for exactly this — "Wide content — tables,
     *  calendars, code, diagrams, wide toolbars — scrolls inside its own
     *  `overflow-x: auto` container" — so a row action in column nine of a
     *  scrolling table is reachable, by the mechanism the rule prescribes.
     *
     *  This exemption did not exist while the sweep only visited six static
     *  public pages, because none of them has a table. The first signed-in run
     *  reported all fifty "open tenant" links in the platform directory, which
     *  is a table doing precisely what it was told to.
     *
     *  The scroller's OWN right edge still has to be on screen. A scrolling
     *  box that is itself past the edge does not make its contents reachable,
     *  and that case stays a finding. */
    const reachableByScrolling = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== "auto" && cs.overflowX !== "scroll") continue;
        if (p.scrollWidth - p.clientWidth <= 1) continue;
        return p.getBoundingClientRect().right <= window.innerWidth + 1;
      }
      return false;
    };

    for (const el of document.querySelectorAll("button, a, input, select, textarea")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (reachableByScrolling(el)) continue;
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        out.push(
          `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 32)}" at x=${Math.round(r.left)}..${Math.round(r.right)}`,
        );
      }
    }
    return out;
  });
}

// ── THE FAULT THE WORKING AGREEMENT CALLS UNENFORCEABLE ───────────────────
//
// CLAUDE.md, on what is NOT enforced:
//
//     "whether a value with no space in it — an address, a link, an id — has
//      somewhere to break. That last one is the same fault as the truncation
//      rule with a different trigger, and it cannot be checked mechanically:
//      telling a 40-character signup URL from an eight-character promo code
//      means knowing the value."
//
// That is true of PARSING and it is the reason the static tests stop here: the
// class list is identical either way, and the JSX only says `{org.signupUrl}`.
// It is not true of MEASURING. At render time the string has a width, the box
// has a width, and the browser knows both.
//
// The failure is specifically the SILENT one. A long value that pushes the page
// is already caught by the overflow rule above. A long value inside a container
// that clips is caught by nothing: no scrollbar, no ellipsis, no page scroll —
// the end of the address is simply not there, and the page looks fine.
//
// So the three exclusions matter more than the rule:
//
//   * `text-overflow: ellipsis` — that IS the intended treatment. `truncate`
//     lands here, and the static suite already exempts it for the same reason.
//   * a scrollable box (`overflow-x: auto|scroll`) — wide content scrolling
//     inside its own container is what the working agreement asks for.
//   * DECORATION. This is the one that decides whether the check is usable.
//
// ── ON MEASURING TEXT RATHER THAN THE BOX ─────────────────────────────────
//
// The first version of this asked whether a clipping box had `scrollWidth >
// clientWidth`, and it "found" something on three routes at all four widths —
// always exactly 154px, which is the tell. The box was the page wrapper:
//
//   <div class="relative flex min-h-screen … overflow-hidden">  sw=1382 cw=1280
//        <div class="pointer-events-none absolute inset-0">   x=0..1280, no text
//        <div class="relative w-full max-w-md">               x=416..864
//
// Both children fit. The overflow came from a decorative blur blob nested in
// the first one, and clipping it is precisely what that `overflow-hidden` is
// FOR. Nothing was cut off; the rule was measuring the wrong thing and would
// have been "fixed" by damaging a background.
//
// So the question is not whether the BOX overflows. It is whether any TEXT
// ends up outside it. A decorative element has no text and cannot trip this;
// an address with nowhere to break has nothing but text and cannot escape it.
export async function findSilentlyClippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const scrollable = (cs: CSSStyleDeclaration) =>
      cs.overflowX === "auto" || cs.overflowX === "scroll";

    for (const box of document.querySelectorAll("*")) {
      const cs = getComputedStyle(box);
      if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
      if (box.scrollWidth - box.clientWidth <= 1) continue;

      // A FOURTH exclusion, found the first time these rules met a signed-in
      // page: `sr-only`.
      //
      // Tailwind's screen-reader utility is `position:absolute; width:1px;
      // height:1px; overflow:hidden; clip:rect(0,0,0,0)`, and the app shell
      // uses it for the label on every icon button — "Toggle Sidebar",
      // "Actions", "Open menu". By this rule's arithmetic that is a clipping
      // box whose text overflows by ~100px with no ellipsis, which is exactly
      // what it looks like and precisely not what it is: the clipping is the
      // point, the text is FOR the screen reader, and a sighted reader is
      // missing nothing.
      //
      // Written as a measurement rather than a class-name match, so it holds
      // for `visually-hidden`, a hand-rolled equivalent, or whatever the next
      // component library calls it: nothing legible fits in a 1x1 box.
      if (box.clientWidth <= 1 && box.clientHeight <= 1) continue;

      const edge = box.getBoundingClientRect().right;
      const bcs = getComputedStyle(box);

      // CASE A — the clipping box holds the text ITSELF.
      //
      // `<div class="overflow-hidden whitespace-nowrap">{signupUrl}</div>`
      // is the shape CLAUDE.md describes, and it is invisible to the
      // descendant walk below: the text is a direct text node of the
      // clipper, so there is no child element whose rect can escape.
      // The first version of this check missed a deliberately injected
      // 78-character signup URL for exactly that reason.
      const boxOwnText = Array.from(box.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? "").trim())
        .join(" ")
        .trim();
      if (boxOwnText && bcs.textOverflow !== "ellipsis") {
        out.push(
          `<${box.tagName.toLowerCase()}> "${boxOwnText.slice(0, 40)}" is cut off by ${box.scrollWidth - box.clientWidth}px, with no ellipsis`,
        );
      }

      // CASE B — a descendant's text escapes the clip.

      // Walk what is inside and ask which TEXT-bearing elements fall off
      // the right edge. Deepest match only — reporting a paragraph and
      // every span inside it says the same thing five times.
      for (const el of box.querySelectorAll("*")) {
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? "").trim())
          .join(" ")
          .trim();
        if (!own) continue;

        const ecs = getComputedStyle(el);
        if (ecs.textOverflow === "ellipsis") continue;
        if (ecs.visibility === "hidden" || ecs.display === "none") continue;

        // Inside its own scroller, or inside something that gives the
        // reader a way to reach it — not this rule's business.
        let scroller = false;
        for (let p = el.parentElement; p && p !== box; p = p.parentElement) {
          if (scrollable(getComputedStyle(p))) {
            scroller = true;
            break;
          }
        }
        if (scroller) continue;

        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > edge + 1) {
          out.push(
            `<${el.tagName.toLowerCase()}> "${own.slice(0, 40)}" runs ${Math.round(r.right - edge)}px past the clip`,
          );
        }
      }
    }
    return out;
  });
}

/**
 * "Touch targets are at least 44px. Not the icon: the button."
 *
 * Scoped to actual controls. An inline link inside a paragraph of legal
 * prose is a word, not a button, and demanding 44px of it would only
 * teach people to add an exception — so anchors are included ONLY when
 * they are styled as buttons or stand alone as a block.
 *
 * Touch sizing is a phone-and-tablet rule: hover does not exist there and a
 * finger is not a cursor. Above the md breakpoint a 32px icon button is fine,
 * so callers only run this below 768px — asserting 44px at 1280 would be
 * inventing a rule the product does not have.
 */
export async function findControlsUnder44px(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const controls = document.querySelectorAll(
      "button, select, input:not([type=hidden]), [role=button], a[class*=button], a[data-slot=button]",
    );
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      // A checkbox or radio may be a small box with a larger hit area
      // provided by an ancestor label or an out-of-flow pseudo-element —
      // which is exactly the pattern ui/checkbox.tsx uses. Measure the
      // label when there is one.
      const type = (el as HTMLInputElement).type;
      let height = r.height;
      const tag = el.tagName.toLowerCase();
      if (
        type === "checkbox" ||
        type === "radio" ||
        // Same argument, one step wider, and it took a signed-in page to find
        // it: the Routes filter bar is a bare 16px `<select>` inside a padded
        // `<label>`, and clicking the label is what opens the menu. Label
        // activation is browser behaviour for form controls, so the label is
        // the target — for a `<button>` in a label it is not, which is why
        // this is scoped by tag. The larger of the two, never the smaller: a
        // label cannot make a control harder to hit.
        tag === "select" ||
        tag === "input" ||
        tag === "textarea"
      ) {
        const label = el.closest("label") ?? document.querySelector(`label[for="${el.id}"]`);
        if (label) height = Math.max(height, label.getBoundingClientRect().height);
      }
      if (height < 44 - 0.5) {
        out.push(
          `<${el.tagName.toLowerCase()}${type ? ` type=${type}` : ""}> "${(el.textContent ?? "").trim().slice(0, 32)}" is ${height.toFixed(1)}px tall`,
        );
      }
    }
    return out;
  });
}
