// Where error reports go, and when they go nowhere.
//
// ── THE DSN IS IN THE CODE ON PURPOSE ─────────────────────────────────────
//
// A Sentry DSN is not a secret. It is an address plus a public key that only
// permits SENDING events to this one project; it cannot read anything, and it
// ships inside every browser bundle that uses Sentry by design. Sentry's own
// docs say as much. The worst anyone can do with it is send us junk events,
// which rate limits and inbound filters in the Sentry project handle.
//
// So it is the default here rather than a variable somebody has to set. That
// matters because there are three builds and three places a variable would
// have to be remembered: Lovable's hosted build, the Worker's runtime secrets,
// and Xcode Cloud's native build. A default means all three report from the
// first deploy with nothing to configure, and nothing to forget the next time
// a build environment is recreated.
//
// ── AND WHEN IT IS OFF ────────────────────────────────────────────────────
//
// Only a PRODUCTION build sends by default. The dev server, the Playwright
// sweeps (which run against the dev server) and vitest send nothing: a
// developer's stack traces and a test's deliberate failures are not the
// owner's errors, and a test must never reach the network.
//
//   VITE_SENTRY_DSN / SENTRY_DSN unset   production: the default DSN; else off
//   = "off" (or 0, false, none, disabled) off everywhere, production included
//   = another DSN                        that DSN, in production and in dev
//                                        (how to try it from `npm run dev`)
//
// Under vitest (MODE "test") it is off whatever the variables say, so a DSN
// left in somebody's shell cannot make the suite phone home. The tests that
// exercise the sending path stub MODE and fetch to get past this.
//
// VITE_SENTRY_DSN is read by the browser and native bundle at BUILD time;
// SENTRY_DSN by the Worker at RUNTIME. Same rules for both.

/** The HoundStack project's DSN (Sentry org o4512195773792256). Public. */
export const DEFAULT_SENTRY_DSN =
  "https://54378a292b0aba3048501701331842f7@o4512195773792256.ingest.us.sentry.io/4512195827007488";

const OFF = new Set(["off", "0", "false", "none", "disabled", "no"]);

export type DsnInputs = {
  /** VITE_SENTRY_DSN or SENTRY_DSN, as set (or not). */
  explicit: unknown;
  /** import.meta.env.PROD of the build doing the reporting. */
  prod: boolean;
  /** import.meta.env.MODE. "test" under vitest. */
  mode: string | undefined;
};

/** The DSN to report to, or "" for "send nothing". */
export function resolveDsn({ explicit, prod, mode }: DsnInputs): string {
  const value = typeof explicit === "string" ? explicit.trim() : "";
  if (OFF.has(value.toLowerCase())) return "";
  if (mode === "test") return "";
  if (value) return value;
  return prod ? DEFAULT_SENTRY_DSN : "";
}
