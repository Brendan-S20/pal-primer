// native-r2-06 and native-r2-11: with the on-screen keyboard up, the bottom
// bars covered the walk note on a small phone, and on an iPad in landscape a
// centred dialog's Add line / Create invoice sat behind the keyboard.
// src/lib/keyboard-chrome.ts is what tells the page the keyboard is up. Node
// has no DOM, so the window here is a fake with exactly the surface it uses.
//
// What it cannot check: where WebKit actually puts the keyboard. That is a
// device check (Duo cover display, iPad landscape), listed on the PR.
/* eslint-disable @typescript-eslint/no-explicit-any -- a hand-made window */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  KEYBOARD_MIN_PX,
  initKeyboardChrome,
  isTextEntry,
  viewportGaps,
} from "@/lib/keyboard-chrome";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

function el(tagName: string, extra: Record<string, unknown> = {}) {
  return {
    tagName,
    type: "",
    readOnly: false,
    isContentEditable: false,
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => ({ top: 0, bottom: 40 }),
    ...extra,
  } as any;
}

function fakeWindow({ coarse = true, innerHeight = 678 } = {}) {
  const docHandlers: Record<string, (e: any) => void> = {};
  const vvHandlers: Record<string, () => void> = {};
  const attrs = new Map<string, string>();
  const vars = new Map<string, string>();
  const vv = {
    height: innerHeight,
    offsetTop: 0,
    addEventListener: (n: string, f: () => void) => void (vvHandlers[n] = f),
    removeEventListener: (n: string) => void delete vvHandlers[n],
  };
  const win: any = {
    innerHeight,
    visualViewport: vv,
    matchMedia: () => ({ matches: coarse }),
    requestAnimationFrame: (f: () => void) => (f(), 1),
    scrollBy: vi.fn(),
    document: {
      activeElement: null,
      addEventListener: (n: string, f: (e: any) => void) => void (docHandlers[n] = f),
      removeEventListener: (n: string) => void delete docHandlers[n],
      documentElement: {
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
        removeAttribute: (k: string) => void attrs.delete(k),
        hasAttribute: (k: string) => attrs.has(k),
        style: { setProperty: (k: string, v: string) => void vars.set(k, v) },
      },
    },
  };
  return {
    win,
    vv,
    attrs,
    vars,
    focus: (target: any, relatedTarget: any = null) =>
      docHandlers.focusin({ target, relatedTarget }),
    blur: (target: any, relatedTarget: any = null) =>
      docHandlers.focusout({ target, relatedTarget }),
    resize: () => vvHandlers.resize?.(),
    scroll: () => vvHandlers.scroll?.(),
    handlers: { docHandlers, vvHandlers },
  };
}

describe("which fields raise the keyboard", () => {
  it("text inputs, textareas and contenteditable do; pickers and buttons do not", () => {
    expect(isTextEntry(el("TEXTAREA"))).toBe(true);
    expect(isTextEntry(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTextEntry(el("INPUT", { type: "email" }))).toBe(true);
    expect(isTextEntry(el("INPUT", { type: "number" }))).toBe(true);
    expect(isTextEntry(el("DIV", { isContentEditable: true }))).toBe(true);
    for (const type of ["date", "checkbox", "radio", "submit", "file", "time"]) {
      expect(isTextEntry(el("INPUT", { type })), type).toBe(false);
    }
    expect(isTextEntry(el("SELECT"))).toBe(false);
    expect(isTextEntry(el("BUTTON"))).toBe(false);
    expect(isTextEntry(el("TEXTAREA", { readOnly: true }))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("how much the keyboard covers", () => {
  it("is what the visual viewport leaves out below, once it is keyboard-sized", () => {
    // iPad landscape: 820 tall, ~400 keyboard.
    expect(viewportGaps(820, { height: 420, offsetTop: 0 })).toEqual({ top: 0, bottom: 400 });
    // WebKit also scrolled the layout viewport 37pt.
    expect(viewportGaps(820, { height: 420, offsetTop: 37 })).toEqual({ top: 37, bottom: 363 });
  });

  it("is nothing for a URL bar, a pinch, or no visualViewport at all", () => {
    expect(viewportGaps(820, { height: 820 - (KEYBOARD_MIN_PX - 1), offsetTop: 0 })).toEqual({
      top: 0,
      bottom: 0,
    });
    expect(viewportGaps(820, null)).toEqual({ top: 0, bottom: 0 });
  });
});

describe("the page while a field has the keyboard", () => {
  it("marks <html> while a text field has focus, and clears it on blur", () => {
    const f = fakeWindow();
    initKeyboardChrome(f.win);
    const note = el("TEXTAREA");
    f.focus(note);
    expect(f.attrs.get("data-keyboard")).toBe("open");
    f.blur(note);
    expect(f.attrs.has("data-keyboard")).toBe(false);
  });

  it("does not flicker moving from one field to the next", () => {
    const f = fakeWindow();
    initKeyboardChrome(f.win);
    const a = el("INPUT", { type: "text" });
    const b = el("TEXTAREA");
    f.focus(a);
    f.blur(a, b);
    expect(f.attrs.get("data-keyboard")).toBe("open");
  });

  it("is not set by a mouse, a date picker or a button", () => {
    const mouse = fakeWindow({ coarse: false });
    initKeyboardChrome(mouse.win);
    mouse.focus(el("TEXTAREA"));
    expect(mouse.attrs.has("data-keyboard")).toBe(false);

    const f = fakeWindow();
    initKeyboardChrome(f.win);
    f.focus(el("INPUT", { type: "date" }));
    expect(f.attrs.has("data-keyboard")).toBe(false);
  });

  it("publishes the keyboard's size for dialogs, and zero once it is down", () => {
    const f = fakeWindow({ innerHeight: 820 });
    initKeyboardChrome(f.win);
    const field = el("INPUT", { type: "text" });
    f.focus(field);
    f.vv.height = 420;
    f.resize();
    expect(f.vars.get("--hs-kb-bottom")).toBe("400px");
    expect(f.vars.get("--hs-vv-top")).toBe("0px");
    f.blur(field);
    expect(f.vars.get("--hs-kb-bottom")).toBe("0px");
  });

  it("brings the focused field back above the keyboard after a resize (rotation)", () => {
    const f = fakeWindow({ innerHeight: 820 });
    initKeyboardChrome(f.win);
    // A note whose top is at 500, behind a keyboard whose top is at 420.
    const note = el("TEXTAREA", { getBoundingClientRect: () => ({ top: 500, bottom: 620 }) });
    f.focus(note);
    f.vv.height = 420;
    f.resize();
    expect(note.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    // Three lines (72px) of it, 16px clear of the keyboard: 572 - 404.
    expect(f.win.scrollBy).toHaveBeenCalledWith(0, 168);
  });

  it("does not pull the page back while the person scrolls", () => {
    const f = fakeWindow({ innerHeight: 820 });
    initKeyboardChrome(f.win);
    const note = el("TEXTAREA", { getBoundingClientRect: () => ({ top: 700, bottom: 760 }) });
    f.focus(note);
    f.vv.height = 420;
    f.scroll();
    expect(f.win.scrollBy).not.toHaveBeenCalled();
    expect(note.scrollIntoView).not.toHaveBeenCalled();
  });

  it("removes every listener it added", () => {
    const f = fakeWindow();
    const stop = initKeyboardChrome(f.win);
    stop();
    expect(Object.keys(f.handlers.docHandlers)).toEqual([]);
    expect(Object.keys(f.handlers.vvHandlers)).toEqual([]);
  });
});

describe("what reads it", () => {
  it("styles.css hides the bottom bars on small screens only, with no transition", () => {
    const css = read("src/styles.css");
    const at = css.indexOf(':root[data-keyboard="open"] [data-bottom-chrome]');
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(css.lastIndexOf("@media", at), css.indexOf("}", at) + 1);
    expect(block).toMatch(/@media \(max-width: 767px\), \(max-height: 500px\)/);
    expect(block).toMatch(/display: none/);
    expect(block).not.toMatch(/transition/);
  });

  it("the tab bar and My Day's Next up / Resume bar are the bars it hides", () => {
    expect(read("src/components/MobileTabBar.tsx")).toMatch(/data-bottom-chrome=""/);
    expect(read("src/routes/_authenticated/my-day.tsx")).toMatch(/data-bottom-chrome=""/);
  });

  it("the dialog is capped to and centred in what the keyboard leaves", () => {
    const src = read("src/components/ui/dialog.tsx");
    const frame = src.slice(src.indexOf("const DIALOG_SAFE_FRAME"));
    const top = frame.match(/top-\[([^\]]+)\]/)?.[1] ?? "";
    const maxH = frame.match(/max-h-\[([^\]]+)\]/)?.[1] ?? "";
    expect(top).toContain("var(--hs-kb-bottom,0px)");
    expect(top).toContain("var(--hs-vv-top,0px)");
    expect(maxH).toContain("var(--hs-kb-bottom,0px)");
    expect(maxH).toContain("var(--hs-vv-top,0px)");
    expect(frame).toMatch(/overflow-y-auto/);
  });

  it("it runs in the app only, from the root", () => {
    const root = read("src/routes/__root.tsx");
    const effect = root.slice(root.indexOf('import("../lib/keyboard-chrome")') - 300);
    expect(effect).toMatch(/if \(!IS_NATIVE_BUNDLE\) return;/);
  });
});
