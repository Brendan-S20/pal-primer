import { test, expect, type Page } from "@playwright/test";

// The four widths named in CLAUDE.md, measured rather than reasoned about.
//
// 360 is the one that matters: "320–360px is a real phone, not an edge case."
// 768 and 1280 bracket the tablet band the working agreement calls out as the
// place layouts with only phone/desktop branches fail. 1920 catches the
// opposite fault — a max-width that was never set.
const WIDTHS = [
  { w: 360, h: 780, label: "360 · a real phone" },
  { w: 768, h: 1024, label: "768 · tablet portrait" },
  { w: 1280, h: 800, label: "1280 · small laptop" },
  { w: 1920, h: 1080, label: "1920 · wide monitor" },
] as const;

// Public routes only. Everything behind /_authenticated needs a session, which
// needs a seeded org in a local Supabase stack — that is the next stage of this
// sweep, not a reason to leave the reachable half unmeasured. Listed explicitly
// rather than crawled so that a route going missing is a failure here.
const ROUTES = [
  "/auth",
  "/get-started",
  "/no-workspace",
  "/legal/privacy",
  "/legal/terms",
  "/legal/sms",
] as const;

/**
 * Wait for fonts and entry animation, then REFUSE TO MEASURE A PAGE THAT DID
 * NOT RENDER.
 *
 * ── WHY THIS GUARD EARNS ITS PLACE ────────────────────────────────────────
 *
 * Every assertion in this file is of the form "nothing is wrong". On a blank
 * page they are all true. So a route that fails to render does not fail the
 * sweep — it passes it, in full, silently, which is the single worst thing a
 * check like this can do.
 *
 * That is not hypothetical. While developing the clipping rule below, a
 * mutation was injected as a second JSX root, which is a syntax error; the dev
 * server served an error page, and the sweep went green against it for several
 * runs. It also made an EARLIER mutation look successful for the wrong reason:
 * the overflow it "caught" was the error page's layout, not the injected block.
 * The check was measuring the absence of the app.
 *
 * Healthy renders of these six routes, measured at 360px: 71–116 elements and
 * 316–3923 characters. The error page had 116 characters and almost no
 * structure. The thresholds below sit well clear of both, and the explicit
 * overlay check catches the dev-server case by name rather than by size.
 */
async function settle(page: Page, route: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(150);

  const health = await page.evaluate(() => ({
    els: document.querySelectorAll("*").length,
    text: document.body.innerText.trim().length,
    overlay: Boolean(document.querySelector("vite-error-overlay")),
  }));
  expect(health.overlay, `${route} rendered a Vite error overlay`).toBe(false);
  expect(
    health.els,
    `${route} rendered only ${health.els} elements — the page did not render, so every assertion about it would pass vacuously`,
  ).toBeGreaterThan(40);
  expect(
    health.text,
    `${route} rendered only ${health.text} characters of text — the page did not render`,
  ).toBeGreaterThan(200);
}

for (const { w, h, label } of WIDTHS) {
  test.describe(label, () => {
    for (const route of ROUTES) {
      test(`${route} does not scroll the page sideways`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(route);
        await settle(page, route);

        // THE rule, stated first in the working agreement: "No horizontal page
        // scroll, ever." Wide content scrolls inside its own container; the
        // body does not.
        //
        // Measured on documentElement AND body because either can be the
        // scrolling box depending on overflow styles, and a 1px tolerance is
        // allowed for sub-pixel rounding at fractional device ratios — not for
        // anything a person could see.
        const overflow = await page.evaluate(() => {
          const de = document.documentElement;
          const scrollW = Math.max(de.scrollWidth, document.body.scrollWidth);
          return { scrollW, innerW: window.innerWidth };
        });
        expect(
          overflow.scrollW,
          `${route} at ${w}px scrolls sideways: content is ${overflow.scrollW}px in a ${overflow.innerW}px viewport`,
        ).toBeLessThanOrEqual(overflow.innerW + 1);
      });

      test(`${route} keeps every control on the page`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(route);
        await settle(page, route);

        // A control whose right edge is past the viewport is unreachable even
        // when the page itself does not scroll — the overflow rule above can be
        // satisfied by clipping. This is the fault that rule cannot see.
        const escaped = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll("button, a, input, select, textarea")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (getComputedStyle(el).visibility === "hidden") continue;
            if (r.right > window.innerWidth + 1 || r.left < -1) {
              out.push(
                `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 32)}" at x=${Math.round(r.left)}..${Math.round(r.right)}`,
              );
            }
          }
          return out;
        });
        expect(escaped, `${route} at ${w}px has controls off the side of the screen`).toEqual([]);
      });
    }
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
test.describe("nothing is cut off with no way to read it", () => {
  for (const { w, h, label } of WIDTHS) {
    test(`${label} clips nothing silently`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      const found: string[] = [];
      for (const route of ROUTES) {
        await page.goto(route);
        await settle(page, route);
        const clipped = await page.evaluate(() => {
          const out: string[] = [];
          const scrollable = (cs: CSSStyleDeclaration) =>
            cs.overflowX === "auto" || cs.overflowX === "scroll";

          for (const box of document.querySelectorAll("*")) {
            const cs = getComputedStyle(box);
            if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
            if (box.scrollWidth - box.clientWidth <= 1) continue;

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
        for (const c of clipped) found.push(`${route}  ${c}`);
      }
      expect(found, `text is cut off with no ellipsis and no scrollbar`).toEqual([]);
    });
  }
});

// Touch sizing is a phone-and-tablet rule: hover does not exist there and a
// finger is not a cursor. Above the md breakpoint a 32px icon button is fine,
// so asserting 44px at 1280 would be inventing a rule the product does not have.
test.describe("touch targets below the md breakpoint", () => {
  for (const route of ROUTES) {
    test(`${route} has no control under 44px`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 780 });
      await page.goto(route);
      await settle(page, route);

      // "Touch targets are at least 44px. Not the icon: the button."
      //
      // Scoped to actual controls. An inline link inside a paragraph of legal
      // prose is a word, not a button, and demanding 44px of it would only
      // teach people to add an exception — so anchors are included ONLY when
      // they are styled as buttons or stand alone as a block.
      const small = await page.evaluate(() => {
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
          let box = r;
          if (type === "checkbox" || type === "radio") {
            const label = el.closest("label") ?? document.querySelector(`label[for="${el.id}"]`);
            if (label) box = label.getBoundingClientRect();
          }
          if (box.height < 44 - 0.5) {
            out.push(
              `<${el.tagName.toLowerCase()}${type ? ` type=${type}` : ""}> "${(el.textContent ?? "").trim().slice(0, 32)}" is ${box.height.toFixed(1)}px tall`,
            );
          }
        }
        return out;
      });
      expect(small, `${route} at 360px has controls below the 44px floor`).toEqual([]);
    });
  }
});
