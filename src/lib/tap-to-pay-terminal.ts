// Tap to Pay on the phone: the Stripe Terminal SDK, once per app launch.
//
// NATIVE ONLY. Nothing imports this statically: TapToPayButton,
// TapToPayAnnouncement and TapToPaySettingsCard reach it through lazy chunks
// that the web build drops (an inline VITE_NATIVE_BUNDLE check), and the
// _authenticated layout starts the warm-up the same way.
//
// What lives here, for Apple's Tap to Pay on iPhone review guide (v1.8):
//
//   * ensureTerminal: initialise the SDK once. Its connection-token listener
//     asks the server for a fresh token each time (a token is single use).
//   * reader setup progress (3.9.1, 5.7): the plugin's StartInstallingUpdate,
//     ReaderSoftwareUpdateProgress and FinishInstallingUpdate events, fanned
//     out to whichever screen is showing a meter.
//   * connectTapToPayReader: discover and connect the phone's own reader.
//     On an iPhone whose business has not accepted Apple's terms, connecting
//     is what presents Apple's terms sheet, so it is only allowed for a person
//     who may accept them (the owner, 3.8). Anyone else gets the
//     "ask your admin" message (3.8.1) and Apple's sheet is never raised.
//   * warm-up (1.5, 5.6): connect at launch and every time the app returns to
//     the foreground, so the first tap does not pay for the reader's setup.
//     Never on a phone whose terms are still open: a warm-up must not raise
//     Apple's sheet over whatever the person opened the app to do.
//   * the in-flight tap (5.12): while a tap waits for a card or approval, a
//     move to the background reports it, and the server pushes the merchant
//     if it was not approved. The record survives a closed app, and the next
//     launch says what happened.
import type { PluginListenerHandle } from "@capacitor/core";

type Plugin = typeof import("@capacitor-community/stripe-terminal");

export type ReaderSetupProgress =
  | { stage: "idle" }
  | { stage: "connecting" }
  | { stage: "updating"; percent: number }
  | { stage: "ready" };

type Listener = (p: ReaderSetupProgress) => void;
const progressListeners = new Set<Listener>();
let lastProgress: ReaderSetupProgress = { stage: "idle" };

function emit(p: ReaderSetupProgress) {
  lastProgress = p;
  for (const l of progressListeners) l(p);
}

/** Subscribe to reader setup progress. Returns the unsubscribe. */
export function onReaderSetupProgress(listener: Listener): () => void {
  progressListeners.add(listener);
  listener(lastProgress);
  return () => progressListeners.delete(listener);
}

export class TapToPayNeedsAdminError extends Error {
  constructor() {
    super("Tap to Pay terms not accepted; the account owner accepts them");
    this.name = "TapToPayNeedsAdminError";
  }
}

let terminalReady: Promise<Plugin> | null = null;
let initialisedAs: boolean | null = null;

/** Initialise the SDK once per launch. `simulated` comes from the server
 *  (prepareTapToPay.isTest): test keys, Stripe's simulated reader; live keys
 *  for a business on TAP_TO_PAY_LIVE_ORG_IDS, the real phone reader. */
export function ensureTerminal(simulated: boolean): Promise<Plugin> {
  if (terminalReady && initialisedAs !== null && initialisedAs !== simulated) {
    // The SDK cannot change mode after initialize; a mismatch means the keys
    // changed under a running app. Say so rather than tap on the wrong reader.
    return Promise.reject(new Error("Tap to Pay changed mode. Close and reopen the app."));
  }
  if (!terminalReady) {
    initialisedAs = simulated;
    terminalReady = (async () => {
      const mod = await import("@capacitor-community/stripe-terminal");
      const { createTapToPayConnectionToken } = await import("@/lib/tap-to-pay.functions");
      const { readerSetupPercent } = await import("@/lib/tap-to-pay");
      const E = mod.TerminalEventsEnum;
      await mod.StripeTerminal.addListener(E.RequestedConnectionToken, async () => {
        try {
          const { secret } = await createTapToPayConnectionToken();
          await mod.StripeTerminal.setConnectionToken({ token: secret });
        } catch (e) {
          // The SDK call that asked for the token fails with its own error,
          // which describeTapToPayError turns into a sentence.
          console.warn("Tap to Pay: connection token failed", e);
        }
      });
      await mod.StripeTerminal.addListener(E.StartInstallingUpdate, () =>
        emit({ stage: "updating", percent: 0 }),
      );
      await mod.StripeTerminal.addListener(E.ReaderSoftwareUpdateProgress, ({ progress }) =>
        emit({ stage: "updating", percent: readerSetupPercent(progress) }),
      );
      await mod.StripeTerminal.addListener(E.FinishInstallingUpdate, () =>
        emit({ stage: "updating", percent: 100 }),
      );
      await mod.StripeTerminal.initialize({ isTest: simulated });
      return mod;
    })().catch((e) => {
      terminalReady = null;
      initialisedAs = null;
      throw e;
    });
  }
  return terminalReady;
}

export type Prepared = {
  locationId: string;
  merchantDisplayName: string;
  isTest: boolean;
};

/** Whether Apple's terms are accepted for this business, asked of Apple every
 *  time (1.6), never cached. null off iOS, or where iOS cannot answer. */
export async function tapToPayTermsAccepted(plugin: Plugin, platform: string) {
  if (platform !== "ios") return null;
  try {
    return (await plugin.StripeTerminal.isTapToPayAccountLinked()).isLinked;
  } catch {
    return null; // older iOS: connectReader still presents the terms
  }
}

let connecting: Promise<void> | null = null;

/**
 * Connect the phone's own reader, showing progress. `allowTerms` is true only
 * for a person who may accept Apple's terms; without it, an iPhone whose
 * business has not accepted them throws TapToPayNeedsAdminError before
 * Apple's sheet could appear. `warmUp` never raises the sheet at all.
 */
export async function connectTapToPayReader(
  prep: Prepared,
  opts: { platform: string; allowTerms: boolean; warmUp?: boolean },
): Promise<{ termsLinked: boolean | null }> {
  const plugin = await ensureTerminal(prep.isTest);
  const { StripeTerminal, TerminalConnectTypes } = plugin;
  const termsLinked = await tapToPayTermsAccepted(plugin, opts.platform);
  const { reader } = await StripeTerminal.getConnectedReader();
  if (reader) {
    emit({ stage: "ready" });
    return { termsLinked };
  }
  if (termsLinked === false && (opts.warmUp || !opts.allowTerms)) {
    if (opts.warmUp) return { termsLinked };
    throw new TapToPayNeedsAdminError();
  }
  if (!connecting) {
    connecting = (async () => {
      emit({ stage: "connecting" });
      const { readers } = await StripeTerminal.discoverReaders({
        type: TerminalConnectTypes.TapToPay,
        locationId: prep.locationId,
      });
      if (!readers.length) throw new Error("unsupported device");
      // On an iPhone whose business has not accepted Apple's terms, this is
      // where Apple shows them; a refusal comes back as an error.
      await StripeTerminal.connectReader({
        reader: readers[0],
        merchantDisplayName: prep.merchantDisplayName,
        autoReconnectOnUnexpectedDisconnect: true,
      });
      emit({ stage: "ready" });
    })().finally(() => {
      connecting = null;
    });
  }
  try {
    await connecting;
  } catch (e) {
    emit({ stage: "idle" });
    throw e;
  }
  return { termsLinked: termsLinked === false ? true : termsLinked };
}

// ── Warm-up at launch and on foreground (Apple 1.5, 5.6) ─────────────────

export type WarmUpDeps = {
  platform: string;
  userAgent: string;
  getStatus: () => Promise<{ available: boolean; canTap: boolean; canAcceptTerms: boolean }>;
  prepare: () => Promise<Prepared>;
  connect: typeof connectTapToPayReader;
  deviceCanTapToPay: (platform: string, userAgent: string) => boolean;
};

/** One warm-up. Quiet: a phone or a person that cannot tap is not an error. */
export async function warmUpTapToPay(deps: WarmUpDeps): Promise<"warmed" | "skipped"> {
  if (!deps.deviceCanTapToPay(deps.platform, deps.userAgent)) return "skipped";
  const status = await deps.getStatus();
  if (!status.available || !status.canTap) return "skipped";
  const prep = await deps.prepare();
  await deps.connect(prep, { platform: deps.platform, allowTerms: false, warmUp: true });
  return "warmed";
}

type AppLike = {
  addListener: (
    event: "appStateChange",
    cb: (s: { isActive: boolean }) => void,
  ) => Promise<PluginListenerHandle>;
};

/**
 * Warm up now and on every return to the foreground; report an in-flight tap
 * when the app leaves it. Returns the cleanup. `warm` and `onBackground` are
 * injected so the trigger wiring can be tested without a phone.
 */
export function startTapToPayLifecycle(
  app: AppLike,
  warm: () => Promise<unknown>,
  onBackground: () => Promise<unknown> = async () => {},
): () => void {
  let running: Promise<unknown> | null = null;
  const run = () => {
    if (running) return;
    running = warm()
      .catch((e) => console.warn("Tap to Pay warm-up skipped", e))
      .finally(() => {
        running = null;
      });
  };
  run();
  let handle: PluginListenerHandle | null = null;
  let stopped = false;
  void app
    .addListener("appStateChange", ({ isActive }) => {
      if (isActive) run();
      else void onBackground().catch(() => {});
    })
    .then((h) => {
      if (stopped) void h.remove();
      else handle = h;
    });
  return () => {
    stopped = true;
    void handle?.remove();
  };
}

// ── The tap in flight (Apple 5.12) ───────────────────────────────────────

const IN_FLIGHT_KEY = "hs.tap-to-pay.in-flight";

export type InFlightTap = { invoiceId: string; amountLabel: string; at: number };

export function markTapInFlight(t: InFlightTap) {
  try {
    localStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(t));
  } catch {
    /* private mode: the push still covers it */
  }
}

export function clearTapInFlight() {
  try {
    localStorage.removeItem(IN_FLIGHT_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function readTapInFlight(): InFlightTap | null {
  try {
    const raw = localStorage.getItem(IN_FLIGHT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as InFlightTap;
    return typeof v?.invoiceId === "string" && typeof v?.amountLabel === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Everything the launch path needs, wired to the real plugin and server. */
export async function startTapToPayOnLaunch(): Promise<() => void> {
  const [{ App }, { Capacitor }, fns, lib, { toast }] = await Promise.all([
    import("@capacitor/app"),
    import("@capacitor/core"),
    import("@/lib/tap-to-pay.functions"),
    import("@/lib/tap-to-pay"),
    import("sonner"),
  ]);
  const platform = Capacitor.getPlatform();
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;

  // A tap left in flight by a closed app: say what happened to it.
  const left = readTapInFlight();
  if (left) {
    clearTapInFlight();
    void fns
      .reportTapToPayInterrupted({ data: { ...left, push: false } })
      .then((r) => {
        if (!r.approved) toast.error(lib.tapToPayNotApprovedPush(left.amountLabel).body);
      })
      .catch(() => {});
  }

  return startTapToPayLifecycle(
    App,
    () =>
      warmUpTapToPay({
        platform,
        userAgent,
        getStatus: () => fns.getTapToPayStatus(),
        prepare: () => fns.prepareTapToPay({ data: {} }),
        connect: connectTapToPayReader,
        deviceCanTapToPay: lib.deviceCanTapToPay,
      }),
    async () => {
      const t = readTapInFlight();
      if (!t) return;
      await fns.reportTapToPayInterrupted({ data: { ...t, push: true } });
    },
  );
}
