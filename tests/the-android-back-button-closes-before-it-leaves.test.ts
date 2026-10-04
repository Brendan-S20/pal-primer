// The Android back button, without a device.
//
// What it must do, in order (src/lib/native.ts, handleBackButton):
//   1. close the open dialog / sheet / popover, and do nothing else;
//   2. else go back one history entry, unless this is a start screen;
//   3. else send the app to the background.
//
// The handler this replaced did only 2 and 3, and treated "is there history"
// as the whole test of a start screen. Two faults followed, and these are the
// cases below that would fail against it:
//   * back with a sheet open navigated the page UNDER the sheet, leaving the
//     sheet up over a different screen;
//   * back on the dashboard after signing in went to /auth, which saw the
//     session and sent the user straight back: a button that appeared dead.
//
// `npm test` runs in Node with no DOM library, so the document here is a
// small fake with the four things the handler touches. The plugin is mocked
// for the wiring tests at the bottom.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── a document just big enough ───────────────────────────────────────────

class FakeKeyboardEvent extends Event {
  key: string;
  constructor(type: string, init: KeyboardEventInit) {
    super(type, init);
    this.key = init.key ?? "";
  }
}

class FakeLayer extends EventTarget {
  attrs: Record<string, string>;
  isConnected = true;
  constructor(attrs: Record<string, string>) {
    super();
    this.attrs = attrs;
  }
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
}

function fakeDocument(layers: FakeLayer[]) {
  const body = new EventTarget();
  const doc = {
    body,
    activeElement: null as EventTarget | null,
    defaultView: { KeyboardEvent: FakeKeyboardEvent },
    querySelectorAll: () =>
      layers.filter((l) => l.isConnected && l.getAttribute("data-state") !== "closed"),
  };
  return { doc: doc as unknown as Document, body, layers };
}

/** A Radix layer: Escape dismisses it (and Radix calls preventDefault when it
 *  does), unless `refuse` stands in for an onEscapeKeyDown that says no. */
function radixDialog(target: EventTarget, layer: FakeLayer, opts: { refuse?: boolean } = {}) {
  target.addEventListener("keydown", (e) => {
    if ((e as FakeKeyboardEvent).key !== "Escape") return;
    e.preventDefault();
    if (!opts.refuse) layer.attrs["data-state"] = "closed";
  });
}

async function press(canGoBack: boolean, doc: Document, pathname: string) {
  const { handleBackButton } = await import("@/lib/native");
  const historyBack = vi.fn();
  const background = vi.fn();
  const outcome = await handleBackButton(canGoBack, {
    document: doc,
    pathname: () => pathname,
    historyBack,
    background,
    settle: async () => {},
  });
  return { outcome, historyBack, background };
}

describe("an open layer closes first, and that is all one press does", () => {
  it("closes a sheet and does not also navigate under it", async () => {
    const sheet = new FakeLayer({ role: "dialog", "data-state": "open" });
    const { doc, body } = fakeDocument([sheet]);
    radixDialog(body, sheet);

    const r = await press(true, doc, "/clients/abc");
    expect(r.outcome).toBe("closed-layer");
    expect(sheet.attrs["data-state"]).toBe("closed");
    expect(r.historyBack).not.toHaveBeenCalled();
    expect(r.background).not.toHaveBeenCalled();
  });

  it("sends Escape to the focused element, as a real key would", async () => {
    const dialog = new FakeLayer({ role: "dialog", "data-state": "open" });
    const { doc } = fakeDocument([dialog]);
    const input = new EventTarget();
    (doc as unknown as { activeElement: EventTarget }).activeElement = input;
    radixDialog(input, dialog);

    const r = await press(true, doc, "/invoices");
    expect(r.outcome).toBe("closed-layer");
  });

  it("leaves a dialog that refuses to close where it is, and stays on the page", async () => {
    // An unsaved-changes guard: Radix's onEscapeKeyDown calls preventDefault.
    const dialog = new FakeLayer({ role: "alertdialog", "data-state": "open" });
    const { doc, body } = fakeDocument([dialog]);
    radixDialog(body, dialog, { refuse: true });

    const r = await press(true, doc, "/quotes/new");
    expect(r.outcome).toBe("layer-refused");
    expect(r.historyBack).not.toHaveBeenCalled();
    expect(r.background).not.toHaveBeenCalled();
  });

  it("does not trap the user behind a layer that ignores Escape", async () => {
    // The guided tour is role=dialog with no Escape handler. Back must still
    // do something, or the only way out is a button the user may not find.
    const tour = new FakeLayer({ role: "dialog" });
    const { doc } = fakeDocument([tour]);

    const r = await press(true, doc, "/clients");
    expect(r.outcome).toBe("history-back");
  });

  it("ignores a layer that is mid-exit or mounted shut", async () => {
    const closing = new FakeLayer({ role: "dialog", "data-state": "closed" });
    const { doc } = fakeDocument([closing]);
    const r = await press(true, doc, "/clients");
    expect(r.outcome).toBe("history-back");
  });
});

describe("with nothing open, back goes back until a start screen, then leaves", () => {
  it("goes back from a page with history", async () => {
    const { doc } = fakeDocument([]);
    const r = await press(true, doc, "/clients/abc");
    expect(r.outcome).toBe("history-back");
    expect(r.historyBack).toHaveBeenCalledOnce();
  });

  it("backgrounds from a page with no history", async () => {
    const { doc } = fakeDocument([]);
    const r = await press(false, doc, "/clients/abc");
    expect(r.outcome).toBe("background");
    expect(r.background).toHaveBeenCalledOnce();
  });

  it.each(["/dashboard", "/my-day", "/routes", "/platform", "/auth", "/", "/dashboard/"])(
    "backgrounds from the start screen %s even with history behind it",
    async (path) => {
      // History behind the dashboard after a sign-in is /auth, which bounces
      // a signed-in user straight back. Going "back" there looks dead.
      const { doc } = fakeDocument([]);
      const r = await press(true, doc, path);
      expect(r.outcome).toBe("background");
      expect(r.historyBack).not.toHaveBeenCalled();
    },
  );

  it("treats a customer portal's home as a start screen, and its pages as not", async () => {
    const { isBackRoot } = await import("@/lib/native");
    expect(isBackRoot("/portal/acme/tok123")).toBe(true);
    expect(isBackRoot("/portal/acme/tok123/")).toBe(true);
    expect(isBackRoot("/portal/acme/tok123/visits")).toBe(false);
    expect(isBackRoot("/settings")).toBe(false);
  });
});

// ── the wiring, with the plugin mocked ───────────────────────────────────

const listeners: Record<string, (e: any) => void> = {};
const minimizeApp = vi.fn(async () => {});
const exitApp = vi.fn(async () => {});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (name: string, fn: (e: any) => void) => {
      listeners[name] = fn;
      return { remove: vi.fn(async () => delete listeners[name]) };
    }),
    minimizeApp,
    exitApp,
  },
}));

describe("initBackButton registers one listener and never exits the app", () => {
  const g = globalThis as Record<string, unknown>;
  let saved: { document: unknown; window: unknown };

  beforeEach(() => {
    saved = { document: g.document, window: g.window };
    for (const k of Object.keys(listeners)) delete listeners[k];
    minimizeApp.mockClear();
    exitApp.mockClear();
  });
  afterEach(() => {
    g.document = saved.document;
    g.window = saved.window;
  });

  it("backgrounds at a start screen via minimizeApp, not exitApp", async () => {
    const { doc } = fakeDocument([]);
    const back = vi.fn();
    g.document = doc;
    g.window = { location: { pathname: "/my-day" }, history: { back } };

    const { initBackButton } = await import("@/lib/native");
    const remove = await initBackButton();
    expect(listeners.backButton).toBeTypeOf("function");

    listeners.backButton({ canGoBack: true });
    await vi.waitFor(() => expect(minimizeApp).toHaveBeenCalledOnce());
    expect(exitApp).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();

    remove();
    await vi.waitFor(() => expect(listeners.backButton).toBeUndefined());
  });

  it("pops browser history on an inner page", async () => {
    const { doc } = fakeDocument([]);
    const back = vi.fn();
    g.document = doc;
    g.window = { location: { pathname: "/clients/abc" }, history: { back } };

    const { initBackButton } = await import("@/lib/native");
    await initBackButton();
    listeners.backButton({ canGoBack: true });
    await vi.waitFor(() => expect(back).toHaveBeenCalledOnce());
    expect(minimizeApp).not.toHaveBeenCalled();
  });
});

describe("initAppLinks routes our https links and nothing else", () => {
  it("navigates to the path of a staff link, and ignores the OAuth hand-back", async () => {
    const { initAppLinks } = await import("@/lib/native");
    const go = vi.fn();
    await initAppLinks(go);
    expect(listeners.appUrlOpen).toBeTypeOf("function");

    listeners.appUrlOpen({ url: "https://app.houndstack.com/my-day?date=2026-10-03" });
    expect(go).toHaveBeenLastCalledWith("/my-day?date=2026-10-03");

    go.mockClear();
    listeners.appUrlOpen({ url: "consulting.thenorth.houndstack://auth-callback#access_token=x" });
    listeners.appUrlOpen({ url: "https://app.houndstack.com/pay/i/tok" });
    listeners.appUrlOpen({ url: "https://evil.example/my-day" });
    expect(go).not.toHaveBeenCalled();
  });
});
