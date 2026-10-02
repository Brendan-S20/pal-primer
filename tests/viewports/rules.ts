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
 * The sizes Apple actually ships, in CSS pixels.
 *
 * ── WHY THESE AND NOT THE FOUR ABOVE ──────────────────────────────────────
 *
 * The four canonical widths are a good contract and a poor census. They test
 * one phone width and one tablet width, and every real fault found on the
 * device during the 2026-08 iOS pass was at a size not in that list: the app
 * ships to a 402pt phone, and the iPad band the working agreement warns about
 * ("usually fails between 640 and 1024") is represented there by a single
 * point at 768.
 *
 * So this is the device list, chosen to bracket rather than to enumerate —
 * each entry is a size where a layout can newly break, not merely a model
 * Apple sells:
 *
 *   * 320 — the narrowest screen still running current iOS. CLAUDE.md calls
 *     320-360 "a real phone, not an edge case"; only the top of that range
 *     was ever measured.
 *   * 390 / 402 — the two commonest modern iPhones. 402 is the simulator the
 *     device tests run on, so a failure here is reproducible by hand.
 *   * 430 — the largest phone. Catches the opposite fault from 320: a phone
 *     layout that assumed it was cramped and looks empty when it is not.
 *   * 744 / 820 — iPad mini and Air in PORTRAIT. Both land in the 640-1024
 *     band, on either side of the `md` breakpoint at 768, which is exactly
 *     where a layout with only phone and desktop branches comes apart.
 *   * 1024 — iPad Pro portrait and iPad Air landscape. The `lg` boundary.
 *   * 1366 — iPad Pro landscape: desktop-width, touch-input. Anything
 *     hover-only is wrong here and nothing about the width says so.
 *
 * Heights are the real ones, because a short landscape viewport is its own
 * failure mode — a bottom sheet sized for an 874pt portrait phone runs off a
 * 430pt landscape one.
 */
export const APPLE_SIZES = [
  { w: 320, h: 568, label: "320×568 · iPhone SE (1st gen)" },
  { w: 375, h: 667, label: "375×667 · iPhone SE (2nd/3rd)" },
  { w: 390, h: 844, label: "390×844 · iPhone 13/14/15" },
  { w: 402, h: 874, label: "402×874 · iPhone 16 Pro" },
  { w: 430, h: 932, label: "430×932 · iPhone Pro Max" },
  { w: 744, h: 1133, label: "744×1133 · iPad mini portrait" },
  { w: 820, h: 1180, label: "820×1180 · iPad Air portrait" },
  { w: 1024, h: 1366, label: "1024×1366 · iPad Pro portrait" },
  { w: 1180, h: 820, label: "1180×820 · iPad Air landscape" },
  { w: 1366, h: 1024, label: "1366×1024 · iPad Pro landscape" },
  { w: 844, h: 390, label: "844×390 · iPhone landscape" },
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
 *
 * ── WHY `innerW` IS NOT `window.innerWidth` ───────────────────────────────
 *
 * It was, until 2026-09-28, and under `isMobile: true` that made this rule a
 * tautology. A mobile browser that finds a page wider than the device does
 * not leave it hanging off the edge: it zooms out until the whole layout
 * fits, and `window.innerWidth` — the VISUAL viewport, in CSS pixels — grows
 * with it. On a 360px phone, /leads measured `scrollWidth` 495 and
 * `innerWidth` 495, and /reports 786 and 786. The comparison below can never
 * fail when both sides are the same number, and every spec that sets
 * `isMobile` (the unlisted-route sweep, the role sweep, the client tabs, the
 * customer portal) was running it that way.
 *
 * So the page is compared against the width the TEST ASKED FOR — the
 * viewport it set, which is the phone — falling back to the initial
 * containing block (`documentElement.clientWidth`, which does not grow when
 * the browser zooms out) if there is no viewport to ask. The name stays
 * `innerW` because a dozen specs read it; what it means is "the screen".
 */
export async function measurePageOverflow(page: Page): Promise<{ scrollW: number; innerW: number }> {
  const asked = page.viewportSize()?.width ?? null;
  return page.evaluate((asked) => {
    const de = document.documentElement;
    const scrollW = Math.max(de.scrollWidth, document.body.scrollWidth);
    return { scrollW, innerW: asked ?? de.clientWidth };
  }, asked);
}

/**
 * A control whose right edge is past the viewport is unreachable even when
 * the page itself does not scroll — the overflow rule above can be satisfied
 * by clipping. This is the fault that rule cannot see.
 *
 * The edge is the screen the test asked for, for the reason given above
 * `measurePageOverflow`: under `isMobile` a zoomed-out page reports an
 * `innerWidth` as wide as its own overflow, and nothing is ever past that.
 */
export async function findControlsOffTheSide(page: Page): Promise<string[]> {
  const asked = page.viewportSize()?.width ?? null;
  return page.evaluate((asked) => {
    const edge = asked ?? document.documentElement.clientWidth;
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
        return p.getBoundingClientRect().right <= edge + 1;
      }
      return false;
    };

    for (const el of document.querySelectorAll("button, a, input, select, textarea")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (reachableByScrolling(el)) continue;
      if (r.right > edge + 1 || r.left < -1) {
        out.push(
          `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 32)}" at x=${Math.round(r.left)}..${Math.round(r.right)}`,
        );
      }
    }
    return out;
  }, asked);
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

      // ── ONE EXEMPTION, STATED RATHER THAN SILENT ────────────────────────
      //
      // Map markers. A route map draws one pin per stop, numbered, and on a
      // dense day that is thirty pins inside a few hundred pixels. Growing
      // each to 44px does not make them easier to hit — it makes them overlap,
      // so the pin you land on is the wrong one and the map stops showing the
      // shape of the route, which is the only reason it is on the dashboard.
      // Apple's own MapKit annotations are ~30px for exactly this reason.
      //
      // Scoped to Leaflet's marker pane, so it exempts pins and nothing else:
      // the zoom controls, the attribution links and every control drawn over
      // the map are still measured. They are the ones a finger is actually
      // aimed at, and one of them — Leaflet's own +/- at 30px — was a real
      // finding this sweep caught and would have kept catching.
      //
      // Recorded here instead of quietly dropped, because a rule with an
      // undocumented hole is a rule nobody can trust. If pins ever become the
      // primary way to open a stop, this exemption is the thing to revisit.
      // `.hs-map-marker` is the same pin drawn by the Google renderer
      // (src/lib/maps/google-renderer.ts), so the exemption follows the pins
      // to whichever provider draws them and to nothing else.
      if (el.closest(".leaflet-marker-pane, .leaflet-overlay-pane, .hs-map-marker")) continue;

      // ── AND ONE CONDITION: A MODAL IS OPEN ───────────────────────────────
      //
      // A Radix modal (Dialog, AlertDialog) sets `pointer-events: none` on
      // <body> and gives it back only to its own content. Every control
      // behind it is untappable for as long as it is open, and -- the part
      // that produced a finding -- a checkbox's `::before` hit area INHERITS
      // that `none`, so the pseudo-element credit above stops applying and a
      // 16px checkbox that is 44px on the page itself reads as 16px. Found
      // on 2026-09-29 when "/concerns · extra cleanup" opened its booking
      // dialog over the inbox's row checkboxes: the same page measured
      // closed, by the "/concerns" surface, passes.
      //
      // So while a modal holds the page, only what is inside the modal is
      // measured. Keyed on the body's pointer-events rather than on a
      // role="dialog" existing, because a Radix Popover is also a dialog and
      // leaves the page behind it live -- those controls are still measured.
      if (
        getComputedStyle(document.body).pointerEvents === "none" &&
        getComputedStyle(el).pointerEvents === "none"
      ) {
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      // A checkbox or radio may be a small box with a larger hit area
      // provided by an ancestor label or an out-of-flow pseudo-element —
      // which is exactly the pattern ui/checkbox.tsx uses. Measure the
      // label when there is one.
      const type = (el as HTMLInputElement).type;
      let height = r.height;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");

      // ── THE PSEUDO-ELEMENT HIT AREA THIS FILE ALREADY PROMISED ──────────
      //
      // The comment above has named "an out-of-flow pseudo-element — which is
      // exactly the pattern ui/checkbox.tsx uses" since this rule was written,
      // and nothing here ever measured one. So the sweep reported the
      // auto-routing panel's reassign checkbox at 16.0px, and the fix that had
      // ALREADY been made for it — a `::before` extending the target to 44x44
      // below `md`, out of flow so nothing moves — was invisible to the check
      // that was supposed to credit it. It came within one commit of being
      // replaced by something worse.
      //
      // Measured in Chromium before this was written, and not from the style
      // alone: the pseudo-element computes to 44x44, `position: absolute`,
      // `pointer-events: auto` — and a synthetic click FOURTEEN PIXELS ABOVE
      // the visible square toggles the control. The hit area is real.
      //
      // `pointer-events` is the load-bearing condition. A decorative overlay —
      // a focus ring, a gradient — is commonly a large absolute pseudo-element
      // with `pointer-events: none`, and crediting one of those would turn
      // this rule into a rubber stamp. So: out of flow, has content, and
      // actually takes the tap.
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (!ps || ps.content === "none" || ps.pointerEvents === "none") continue;
        if (ps.position !== "absolute" && ps.position !== "fixed") continue;
        const ph = Number.parseFloat(ps.height);
        if (Number.isFinite(ph)) height = Math.max(height, ph);
      }

      if (
        type === "checkbox" ||
        type === "radio" ||
        // Radix renders a checkbox or radio as a `<button role="checkbox">`,
        // with no `type` at all — so the two conditions above, written for
        // native inputs, never matched the components this app actually uses.
        role === "checkbox" ||
        role === "radio" ||
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
        // A CLASS FINGERPRINT, because the label is not enough to find it.
        //
        // The first pass of this audit printed tag + text, and half the
        // findings could not be located: a chip labelled "Mon 17 · 8 visits"
        // is composed at runtime, so grepping the source for the text the
        // sweep printed returns nothing. Two of the fixes that followed went
        // into the wrong component for exactly this reason and changed
        // nothing while looking correct.
        //
        // Tailwind class lists ARE greppable, and the distinctive ones — the
        // padding and type-size utilities that made the control small — are
        // what a fix has to change anyway. Trimmed to the first few so the
        // finding stays one readable line.
        const cls = (el.getAttribute("class") ?? "")
          .split(/\s+/)
          .filter((c) => /^(p|px|py|h|min-h|text|gap|rounded)-/.test(c))
          .slice(0, 6)
          .join(" ");
        out.push(
          `<${el.tagName.toLowerCase()}${type ? ` type=${type}` : ""}> "${(el.textContent ?? "").trim().slice(0, 32)}" is ${height.toFixed(1)}px tall${cls ? ` [${cls}]` : ""}`,
        );
      }
    }
    return out;
  });
}
