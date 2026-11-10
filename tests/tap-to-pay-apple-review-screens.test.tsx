// @vitest-environment happy-dom
//
// Tap to Pay on iPhone: the screens and the phone-side runtime, for Apple's
// review guide (v1.8) gaps on #757. The rules and the server are in
// tap-to-pay-apple-review-gaps.test.ts. The Stripe Terminal plugin is a
// fixture: nothing here reaches Stripe or a phone.
/* eslint-disable @typescript-eslint/no-explicit-any -- plugin fixtures */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const listeners = new Map<string, (arg: any) => void>();
  return {
    role: "owner" as string,
    platform: "ios",
    listeners,
    linked: true as boolean,
    connected: null as any,
    confirm: async () => ({}),
    collect: async () => ({}),
    connectReader: vi.fn(async () => ({})),
    discoverReaders: vi.fn(async () => ({ readers: [{ serialNumber: "phone" }] })),
    initialize: vi.fn(async () => {}),
    reconcile: vi.fn(async () => ({})),
    share: vi.fn(async () => ({})),
    createIntent: vi.fn(async () => ({
      clientSecret: "pi_secret",
      amountCents: 100,
      currency: "usd",
    })),
    prepare: vi.fn(async () => ({
      locationId: "tml_demo",
      stripeAccount: "acct_demo",
      merchantDisplayName: "Recording Demo Co",
      readerMode: "live",
      isTest: false,
    })),
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => h.platform, isNativePlatform: () => true },
  registerPlugin: () => ({}),
}));
vi.mock("@capacitor/share", () => ({ Share: { share: h.share } }));
vi.mock("@capacitor-community/stripe-terminal", () => ({
  TerminalConnectTypes: { TapToPay: "tap-to-pay" },
  TerminalEventsEnum: {
    RequestedConnectionToken: "terminalRequestedConnectionToken",
    StartInstallingUpdate: "terminalStartInstallingUpdate",
    ReaderSoftwareUpdateProgress: "terminalReaderSoftwareUpdateProgress",
    FinishInstallingUpdate: "terminalFinishInstallingUpdate",
  },
  StripeTerminal: {
    addListener: async (event: string, fn: (a: any) => void) => {
      h.listeners.set(event, fn);
      return { remove: async () => {} };
    },
    initialize: h.initialize,
    setConnectionToken: async () => {},
    isTapToPayAccountLinked: async () => ({ isLinked: h.linked }),
    getConnectedReader: async () => ({ reader: h.connected }),
    discoverReaders: h.discoverReaders,
    connectReader: async (o: unknown) => {
      await h.connectReader(o);
      h.connected = { serialNumber: "phone" };
    },
    collectPaymentMethod: () => h.collect(),
    confirmPaymentIntent: () => h.confirm(),
    cancelCollectPaymentMethod: async () => {},
  },
}));
vi.mock("@/lib/native-build", () => ({ IS_NATIVE_BUNDLE: true }));
vi.mock("@/hooks/useMyRole", () => ({ usePermissions: () => ({ role: h.role }) }));
vi.mock("@/components/client-detail/primitives", () => ({
  SectionLabel: ({ children }: { children: unknown }) => createElement("h3", null, children as any),
}));
vi.mock("@/lib/tap-to-pay.functions", () => ({
  prepareTapToPay: h.prepare,
  createTapToPayPaymentIntent: h.createIntent,
  createTapToPayConnectionToken: async () => ({ secret: "pst" }),
  getTapToPayStatus: async () => ({
    available: true,
    readerMode: "live",
    canTap: true,
    canAcceptTerms: true,
  }),
  reportTapToPayInterrupted: async () => ({ approved: false, notified: true }),
}));
vi.mock("@/lib/invoices.functions", () => ({ reconcileInvoiceNow: h.reconcile }));
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { success: () => {}, error: () => {}, warning: () => {} }),
}));

import { TapToPayButton } from "@/components/TapToPayButton";
import { educationPages } from "@/components/tap-to-pay/TapToPayEducation";
import { shouldAnnounce } from "@/components/tap-to-pay/TapToPayAnnouncement";
import {
  connectTapToPayReader,
  ensureTerminal,
  onReaderSetupProgress,
  startTapToPayLifecycle,
  TapToPayNeedsAdminError,
  warmUpTapToPay,
  type ReaderSetupProgress,
} from "@/lib/tap-to-pay-terminal";
import { TAP_TO_PAY_MESSAGES } from "@/lib/tap-to-pay";

const IPHONE = (v: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`;

function setUA(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

let root: Root;
let host: HTMLElement;
function mount(props: Partial<Parameters<typeof TapToPayButton>[0]> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TapToPayButton, {
          invoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          invoiceStatus: "open",
          dueCents: 100,
          currencyLabel: "$1.00",
          cardPaymentsReady: true,
          onPaid: () => {},
          ...props,
        }),
      ),
    );
  });
}
async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const buttons = () => [...host.querySelectorAll("button")];
const byText = (t: string) => buttons().find((b) => b.textContent?.trim() === t);

beforeEach(() => {
  h.role = "owner";
  h.platform = "ios";
  h.linked = true;
  h.connected = null;
  h.confirm = async () => ({});
  h.collect = async () => ({});
  h.connectReader.mockClear();
  h.share.mockClear();
  setUA(IPHONE("18_1"));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("the button (Apple 5.4, 5.5)", () => {
  it('reads "Tap to Pay on iPhone" with the wave symbol and no amount', () => {
    mount();
    const b = byText("Tap to Pay on iPhone");
    expect(b, host.innerHTML).toBeTruthy();
    expect(b!.textContent).not.toMatch(/\$/);
    expect(b!.querySelector('svg[data-sf-symbol="wave.3.right.circle"]')).toBeTruthy();
    expect(host.querySelector("h3")!.textContent).toBe("Tap to Pay on iPhone");
  });
});

describe("a person who cannot take the payment (Apple 3.8.1)", () => {
  it("is told to ask, and is given no button that starts a tap", () => {
    h.role = "tech";
    mount();
    expect(host.textContent).toContain(TAP_TO_PAY_MESSAGES.askAdminToPay);
    expect(byText("Tap to Pay on iPhone")).toBeUndefined();
  });

  it("an office manager on a business whose terms are open is told to ask the owner; Apple's sheet never opens", async () => {
    h.role = "office_manager";
    h.linked = false;
    mount();
    await act(async () => byText("Tap to Pay on iPhone")!.click());
    await settle();
    expect(host.textContent).toContain(TAP_TO_PAY_MESSAGES.askAdmin);
    expect(h.connectReader).not.toHaveBeenCalled();
  });
});

describe("an iPhone that needs a newer iOS (Apple 1.4)", () => {
  it("below 16.4: the update prompt in place of the button", () => {
    setUA(IPHONE("16_2"));
    mount();
    expect(host.textContent).toContain(TAP_TO_PAY_MESSAGES.updateIosRequired);
    expect(byText("Tap to Pay on iPhone")).toBeUndefined();
  });
  it("17.5: can tap, and is told to update", () => {
    setUA(IPHONE("17_5"));
    mount();
    expect(byText("Tap to Pay on iPhone")).toBeTruthy();
    expect(host.textContent).toContain(TAP_TO_PAY_MESSAGES.updateIosRecommended);
  });
});

describe("processing, and a receipt after both outcomes (Apple 5.8, 5.10)", () => {
  it("approved: a processing state, then the receipt", async () => {
    let release!: () => void;
    h.confirm = () => new Promise((r) => (release = () => r({})));
    mount();
    await act(async () => byText("Tap to Pay on iPhone")!.click());
    await settle();
    expect(host.querySelector('[data-testid="tap-to-pay-processing"]')?.textContent).toMatch(
      /Processing payment/,
    );
    await act(async () => release());
    await settle();
    const result = host.querySelector('[data-testid="tap-to-pay-result"]');
    expect(result?.textContent).toMatch(/Payment approved: \$1\.00/);
    await act(async () => byText("Send receipt")!.click());
    await settle();
    expect(h.share).toHaveBeenCalledTimes(1);
    expect((h.share.mock.calls[0] as any)[0].text).toMatch(/Payment approved: \$1\.00/);
    expect((h.share.mock.calls[0] as any)[0].text).toMatch(/Recording Demo Co/);
  });

  it("declined: a receipt too, and a way to try another card", async () => {
    h.confirm = async () => {
      throw new Error("Card declined by issuer");
    };
    mount();
    await act(async () => byText("Tap to Pay on iPhone")!.click());
    await settle();
    const result = host.querySelector('[data-testid="tap-to-pay-result"]');
    expect(result?.textContent).toMatch(/Payment declined: \$1\.00/);
    expect(byText("Try another card")).toBeTruthy();
    await act(async () => byText("Send receipt")!.click());
    await settle();
    expect((h.share.mock.calls[0] as any)[0].text).toMatch(/not charged/);
  });
});

describe("reader setup progress (Apple 3.9.1, 5.7)", () => {
  it("the plugin's ReaderSoftwareUpdateProgress reaches every screen showing a meter", async () => {
    await ensureTerminal(false);
    const seen: ReaderSetupProgress[] = [];
    const stop = onReaderSetupProgress((p) => seen.push(p));
    h.listeners.get("terminalStartInstallingUpdate")!({});
    h.listeners.get("terminalReaderSoftwareUpdateProgress")!({ progress: 0.42 });
    h.listeners.get("terminalFinishInstallingUpdate")!({});
    stop();
    expect(seen.slice(1)).toEqual([
      { stage: "updating", percent: 0 },
      { stage: "updating", percent: 42 },
      { stage: "updating", percent: 100 },
    ]);
  });

  it("the button draws the meter while the phone is being set up", async () => {
    let finish!: () => void;
    h.discoverReaders.mockImplementationOnce(
      () => new Promise((r) => (finish = () => r({ readers: [{ serialNumber: "phone" }] }))),
    );
    mount();
    await act(async () => byText("Tap to Pay on iPhone")!.click());
    await settle();
    await act(async () =>
      h.listeners.get("terminalReaderSoftwareUpdateProgress")!({ progress: 0.6 }),
    );
    const meter = host.querySelector('[data-testid="tap-to-pay-progress"]');
    expect(meter?.textContent).toMatch(/Configuring this phone: 60%/);
    expect(meter?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("60");
    await act(async () => finish());
    await settle();
  });
});

describe("warm-up at launch and on foreground (Apple 1.5, 5.6)", () => {
  it("runs at start, again on every return to the foreground, and reports a background", async () => {
    let onChange!: (s: { isActive: boolean }) => void;
    const app = {
      addListener: vi.fn(async (_e: "appStateChange", cb: (s: { isActive: boolean }) => void) => {
        onChange = cb;
        return { remove: async () => {} };
      }),
    };
    const warm = vi.fn(async () => {});
    const bg = vi.fn(async () => {});
    const stop = startTapToPayLifecycle(app, warm, bg);
    await settle();
    expect(warm).toHaveBeenCalledTimes(1);
    onChange({ isActive: true });
    await settle();
    expect(warm).toHaveBeenCalledTimes(2);
    onChange({ isActive: false });
    await settle();
    expect(bg).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledTimes(2);
    stop();
  });

  it("connects the reader for someone who can tap, and skips everyone else", async () => {
    const connect = vi.fn(async () => ({ termsLinked: true }));
    const base = {
      platform: "ios",
      userAgent: IPHONE("18_1"),
      prepare: async () => ({ locationId: "tml", merchantDisplayName: "x", isTest: false }),
      connect: connect as any,
      deviceCanTapToPay: () => true,
    };
    const ok = { available: true, canTap: true, canAcceptTerms: false };
    expect(await warmUpTapToPay({ ...base, getStatus: async () => ok })).toBe("warmed");
    expect(connect).toHaveBeenCalledWith(expect.anything(), {
      platform: "ios",
      allowTerms: false,
      warmUp: true,
    });
    expect(
      await warmUpTapToPay({ ...base, getStatus: async () => ({ ...ok, canTap: false }) }),
    ).toBe("skipped");
    expect(
      await warmUpTapToPay({ ...base, getStatus: async () => ({ ...ok, available: false }) }),
    ).toBe("skipped");
    expect(
      await warmUpTapToPay({ ...base, deviceCanTapToPay: () => false, getStatus: async () => ok }),
    ).toBe("skipped");
  });

  it("a warm-up never raises Apple's terms sheet over the app", async () => {
    h.linked = false;
    const prep = { locationId: "tml", merchantDisplayName: "x", isTest: false };
    await connectTapToPayReader(prep, { platform: "ios", allowTerms: true, warmUp: true });
    expect(h.connectReader).not.toHaveBeenCalled();
    await expect(
      connectTapToPayReader(prep, { platform: "ios", allowTerms: false }),
    ).rejects.toBeInstanceOf(TapToPayNeedsAdminError);
    expect(h.connectReader).not.toHaveBeenCalled();
    // The owner's Enable action is what presents it (Apple 3.5).
    await connectTapToPayReader(prep, { platform: "ios", allowTerms: true });
    expect(h.connectReader).toHaveBeenCalledTimes(1);
  });
});

describe("education and the announcement (Apple 3.1, 4.x)", () => {
  it("education covers how to tap, cards and wallets, PIN entry and trouble", () => {
    const pages = educationPages("ios");
    expect(pages.map((p) => p.id)).toEqual(["how", "cards", "pin", "trouble"]);
    expect(pages[2].body.join(" ")).toMatch(/PIN/);
    expect(pages[0].title).toMatch(/Tap to Pay on iPhone/);
  });

  it("the announcement opens once, for an eligible iPhone merchant whose business has it", () => {
    const status = { available: true, canTap: true };
    expect(
      shouldAnnounce({ platform: "ios", deviceCanTap: true, status, alreadySeen: false }),
    ).toBe(true);
    expect(shouldAnnounce({ platform: "ios", deviceCanTap: true, status, alreadySeen: true })).toBe(
      false,
    );
    expect(
      shouldAnnounce({
        platform: "ios",
        deviceCanTap: true,
        status: { ...status, available: false },
        alreadySeen: false,
      }),
    ).toBe(false);
    expect(
      shouldAnnounce({
        platform: "ios",
        deviceCanTap: true,
        status: { ...status, canTap: false },
        alreadySeen: false,
      }),
    ).toBe(false);
    expect(
      shouldAnnounce({ platform: "android", deviceCanTap: true, status, alreadySeen: false }),
    ).toBe(false);
  });
});
