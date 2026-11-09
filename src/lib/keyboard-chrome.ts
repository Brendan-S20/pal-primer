// ── WHAT THE ON-SCREEN KEYBOARD COVERS, AND WHAT GETS OUT OF ITS WAY ──────
//
// Two faults from the native round-2 audit, one cause: nothing in the page
// knew the keyboard was up.
//
// native-r2-06 (iPhone Duo cover display, 466x678 pt; also any 390-wide
// phone): with a walk note focused, My Day's sticky "IN PROGRESS / Resume"
// bar and the tab bar rode up above the keyboard and left two lines of the
// textarea visible between them. A tech typed the client's note blind.
//
// native-r2-11 (iPad landscape): a centred dialog stayed centred in the full
// 820-pt layout viewport while a ~400-pt keyboard covered its bottom half, so
// New invoice's Add line and Create invoice could not be reached without
// dismissing the keyboard, and after a rotation the focused field itself sat
// behind it.
//
// So, while a text field has focus on a touch screen:
//   - <html data-keyboard="open">. styles.css hides `[data-bottom-chrome]`
//     (the tab bar, My Day's Next up / Resume bar) on small screens only;
//     an iPad's tab bar has room to stay.
//   - --hs-vv-top / --hs-kb-bottom on <html>: how much of the layout viewport
//     is above and below the visual one. ui/dialog.tsx sizes and centres its
//     panel into what is left, and the panel already scrolls.
//   - after the visual viewport changes (keyboard up, rotation), the focused
//     field is brought back into view: in its own scroll container first,
//     then by scrolling the page if it is still under the keyboard. Instant,
//     never smooth: motion never makes a thumb wait.
//
// Listeners are focusin/focusout on the document and resize/scroll on
// visualViewport, all passive. Nothing here listens to touches.

/** Inputs that raise the on-screen keyboard. A date, a checkbox or a select
 *  opens a picker instead, and the bars can stay. */
const NO_KEYBOARD_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "image",
  "month",
  "radio",
  "range",
  "reset",
  "submit",
  "time",
  "week",
]);

export function isTextEntry(el: Element | null | undefined): el is HTMLElement {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return !(el as HTMLTextAreaElement).readOnly;
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    return !input.readOnly && !NO_KEYBOARD_INPUT_TYPES.has((input.type || "text").toLowerCase());
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** A gap smaller than this is browser chrome (a URL bar, an accessory row),
 *  not a keyboard, and does not move a dialog. */
export const KEYBOARD_MIN_PX = 120;

/** How much of the layout viewport the visual one leaves out, above and below.
 *  Both 0 unless what is below looks like a keyboard. */
export function viewportGaps(
  layoutHeight: number,
  vv: { height: number; offsetTop: number } | null | undefined,
): { top: number; bottom: number } {
  if (!vv) return { top: 0, bottom: 0 };
  const top = Math.max(0, Math.round(vv.offsetTop));
  const bottom = Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));
  if (bottom < KEYBOARD_MIN_PX) return { top: 0, bottom: 0 };
  return { top, bottom };
}

/** Space kept between the focused field and the keyboard's top edge. */
const CLEARANCE_PX = 16;

function bringIntoView(win: Window, el: HTMLElement) {
  try {
    // Its own scroll container first: a dialog body, a sheet.
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    /* old engines without the options form */
  }
  const vv = win.visualViewport;
  if (!vv) return;
  const r = el.getBoundingClientRect();
  // getBoundingClientRect is in layout-viewport coordinates.
  const visibleBottom = vv.offsetTop + vv.height - CLEARANCE_PX;
  // A tall textarea: its first three lines are what has to show.
  const needBottom = Math.min(r.bottom, r.top + 72);
  if (needBottom > visibleBottom) win.scrollBy(0, needBottom - visibleBottom);
}

export function initKeyboardChrome(win: Window = window): () => void {
  const doc = win.document;
  const root = doc.documentElement;
  const coarse = () => win.matchMedia?.("(pointer: coarse)").matches ?? false;
  let focused: HTMLElement | null = null;

  const apply = () => {
    const open = !!focused && coarse();
    if (open) root.setAttribute("data-keyboard", "open");
    else root.removeAttribute("data-keyboard");
    const gaps = open ? viewportGaps(win.innerHeight, win.visualViewport) : { top: 0, bottom: 0 };
    root.style.setProperty("--hs-vv-top", `${gaps.top}px`);
    root.style.setProperty("--hs-kb-bottom", `${gaps.bottom}px`);
  };

  const onFocusIn = (e: FocusEvent) => {
    focused = isTextEntry(e.target as Element) ? (e.target as HTMLElement) : null;
    apply();
  };
  const onFocusOut = (e: FocusEvent) => {
    // Moving from one field to the next is not the keyboard going down.
    if (isTextEntry(e.relatedTarget as Element | null)) return;
    focused = null;
    apply();
  };
  // A scroll only moves the variables. Pulling the field back on a scroll
  // would fight the person scrolling past it.
  const onViewportScroll = () => apply();
  // A resize is the keyboard arriving, changing height, or a rotation.
  const onViewport = () => {
    apply();
    if (focused && root.hasAttribute("data-keyboard")) {
      const el = focused;
      // After the dialog has re-laid itself out with the new variables.
      win.requestAnimationFrame(() => {
        if (focused === el) bringIntoView(win, el);
      });
    }
  };

  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  const vv = win.visualViewport;
  vv?.addEventListener("resize", onViewport, { passive: true });
  vv?.addEventListener("scroll", onViewportScroll, { passive: true });
  if (isTextEntry(doc.activeElement)) {
    focused = doc.activeElement;
    apply();
  }

  return () => {
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
    vv?.removeEventListener("resize", onViewport);
    vv?.removeEventListener("scroll", onViewportScroll);
    focused = null;
    apply();
  };
}
