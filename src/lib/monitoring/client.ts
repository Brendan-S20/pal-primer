// Browser and native-shell error monitoring: the half of it that is always in
// the bundle, which is deliberately almost nothing.
//
// The Sentry SDK itself lives in ./sentry-browser.ts and is only ever reached
// through the dynamic import below, so it is a separate chunk fetched once,
// after the page has started, and never on the critical path. Anything
// reported before it arrives waits for it.
//
// Whether anything is sent at all is decided by ./config.ts: a production
// build reports to the HoundStack project by default; the dev server, the
// Playwright sweeps and vitest send nothing. When it is off, every function
// here returns before importing or fetching anything.

import { resolveDsn } from "./config";
import type { MonitoringIdentity } from "./policy";

type SentryBrowserModule = typeof import("./sentry-browser");

/** The DSN this bundle reports to, or "" when monitoring is off. Spelled out
 *  in full (no `?.`) because the build replaces exactly this text. */
export function browserDsn(): string {
  return resolveDsn({
    explicit: import.meta.env.VITE_SENTRY_DSN,
    prod: import.meta.env.PROD === true,
    mode: import.meta.env.MODE,
  });
}

let loading: Promise<SentryBrowserModule | null> | null = null;
let pendingIdentity: MonitoringIdentity | null | undefined;

function load(): Promise<SentryBrowserModule | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const dsn = browserDsn();
  if (!dsn) return Promise.resolve(null);
  if (!loading) {
    loading = import("./sentry-browser")
      .then((m) => {
        m.start(dsn);
        if (pendingIdentity !== undefined) m.identify(pendingIdentity);
        return m;
      })
      .catch(() => {
        // The chunk did not load (offline, a deploy replaced it). Monitoring
        // is best-effort and must never become the error; try again next time
        // something is reported.
        loading = null;
        return null;
      });
  }
  return loading;
}

/** Start monitoring for this page. Safe to call more than once and on the
 *  server, where it does nothing. */
export function initClientMonitoring(): void {
  void load();
}

/** Report an error a React error boundary caught. The boundary still renders
 *  its fallback; this only tells Sentry it happened. */
export function reportBoundaryError(error: unknown, boundary: string): void {
  if (!browserDsn()) return;
  void load().then((m) => m?.captureBoundary(error, boundary));
}

/** Tags for one report: short, fixed vocabulary, never a value somebody typed
 *  or a record's contents. They are scrubbed like everything else (policy.ts),
 *  but a tag is indexed and searchable in Sentry, so it should be something a
 *  developer filters BY ("area", "step", "push_permission"), not a payload. */
export type ClientReportTags = Record<string, string>;

/** Report a fault that was caught on purpose, somewhere a throw is never the
 *  product working: a native start-up step, a token the server would not save.
 *  The original error rides along as the cause; see sentry-browser.ts on why
 *  it is wrapped. Nothing is sent in dev or tests, like everything here. */
export function reportClientError(error: unknown, tags: ClientReportTags): void {
  if (!browserDsn()) return;
  void load().then((m) => m?.captureClientError(error, tags));
}

/** Report something that is not an exception but that a developer needs to
 *  know happened on a real device: APNs refusing to issue a token, or a person
 *  who never ended up with notifications on. `level` is "warning" or "info"
 *  for a state, "error" only for a fault, so a state that is a person's
 *  choice does not page anybody. Same scrub, same identity, same off-switch. */
export function reportClientIssue(
  message: string,
  tags: ClientReportTags,
  level: "error" | "warning" | "info" = "warning",
): void {
  if (!browserDsn()) return;
  void load().then((m) => m?.captureClientIssue(message, tags, level));
}

/** Attach who is signed in to later events: ids only. Pass null on sign-out.
 *  Takes the identity type rather than a profile so that nothing else can be
 *  handed over by accident; policy.identityUser enforces it again. */
export function setMonitoringIdentity(identity: MonitoringIdentity | null): void {
  if (!browserDsn()) return;
  pendingIdentity = identity;
  void load().then((m) => m?.identify(identity));
}

/** For the platform admin's "send a test error" button. Resolves to whether
 *  an event was handed to Sentry, so the button can say when it is off. */
export async function sendClientTestError(): Promise<boolean> {
  const m = await load();
  if (!m) return false;
  m.captureTest();
  return true;
}
