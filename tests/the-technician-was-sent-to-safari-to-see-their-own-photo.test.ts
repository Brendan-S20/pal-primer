/**
 * Tapping a visit photo left the app.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * My Day's PhotoThumb rendered every photo as
 *
 *     <a href={signedUrl} target="_blank" rel="noreferrer">
 *
 * where `signedUrl` is a Supabase storage REST endpoint. On the phone that is
 * not "open the photo" — it is "leave HoundStack". iOS hands `target="_blank"`
 * to the system browser, so a technician checking the completion photo they
 * just took landed in Safari, signed out, looking at a raw
 * `/storage/v1/object/sign/...` URL with a token in the query string, and had
 * to find their way back to a route they were part-way through. Anything
 * queued offline was still queued; they simply could not see it any more.
 *
 * The CUSTOMER has had an in-app viewer for this the whole time — the lightbox
 * in portal-ui.tsx. Only the technician was sent out of the product to look at
 * their own work.
 *
 * ── WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE ─────────────────────────
 *
 * `target="_blank"` is one attribute. It is the default thing to write next to
 * an href, it reads as harmless in a diff, and nothing about it fails at
 * desktop width, in a unit test, or in the browser sweep — which runs in
 * Chromium, where a new tab is a new tab and not an ejection from the app.
 * The only place it hurts is the native shell, which no automated check here
 * loads. So the rule is asserted against the source: the photo path opens
 * something in-app, and nothing on this screen hands a STORAGE url to a new
 * tab.
 *
 * `mapsUrl` is deliberately still `target="_blank"` and deliberately not
 * caught. Handing a destination to the maps app is the point of that button —
 * leaving for turn-by-turn is what the technician asked for. The rule below is
 * about storage URLs, which is the distinction that matters.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** TS with comments stripped, quote-aware so a `//` in a URL survives. */
export function codeOnly(ts: string): string {
  const noBlocks = ts.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

const myDay = () => codeOnly(read("src/routes/_authenticated/my-day.tsx"));

describe("the stripper this file rests on", () => {
  it("removes the prose that quotes the bug", () => {
    const raw = read("src/routes/_authenticated/my-day.tsx");
    // The rewritten PhotoThumb explains itself by naming the attribute it
    // replaced, so an un-stripped file contains the very string under test.
    expect(raw).toContain('target="_blank"');
    expect(myDay()).toContain("PhotoLightbox");
  });
});

describe("a technician looks at their own photo without leaving the app", () => {
  it("the photo thumbnail is a button, not a link to a signed URL", () => {
    const code = myDay();
    const thumb = code.slice(code.indexOf("function PhotoThumb"));
    const body = thumb.slice(0, thumb.indexOf("\nfunction "));

    expect(body, "PhotoThumb still links out").not.toMatch(/<a\s/);
    expect(body, "the thumbnail is not pressable").toMatch(/<button/);
    expect(body).toMatch(/onClick=\{onOpen\}/);
  });

  it("an in-app viewer is rendered for the card's photos", () => {
    const code = myDay();
    expect(code).toMatch(/<PhotoLightbox/);
    expect(code).toMatch(/openIndex=\{lightboxIndex\}/);
  });

  it("the viewer traps focus and closes on Escape, rather than being a bare div", () => {
    // A hand-rolled `<div onClick={close}>` — which is what the customer
    // portal still uses — leaves focus behind it, leaves the page readable to
    // a screen reader, and ignores Escape. Radix gives all three.
    const lb = codeOnly(read("src/components/PhotoLightbox.tsx"));
    expect(lb).toMatch(/DialogPrimitive\.Root/);
    expect(lb).toMatch(/DialogPrimitive\.Content/);
    expect(lb).toMatch(/DialogPrimitive\.Title/);
  });

  it("nothing on this screen opens a storage URL in a new tab", () => {
    // The shape of the original bug, stated as a rule: an anchor whose href is
    // a signed/storage url and which targets a new tab.
    const code = myDay();
    const offenders: string[] = [];
    for (const m of code.matchAll(/<a\b[^>]*>/g)) {
      const tag = m[0];
      if (!/target="_blank"/.test(tag)) continue;
      if (/href=\{(url|signedUrl|photoUrl)/.test(tag)) {
        offenders.push(tag.slice(0, 80));
      }
    }
    expect(offenders, `a storage URL is opened in a new tab:\n  ${offenders.join("\n  ")}`).toEqual(
      [],
    );
  });
});
