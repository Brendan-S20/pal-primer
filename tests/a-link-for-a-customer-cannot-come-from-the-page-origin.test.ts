// `capacitor://localhost/portal/…` is not a link anybody can open.
//
// Inside the iOS binary the page is served from `capacitor://localhost`, so
// `window.location.origin` is that — not app.houndstack.com. Any address built
// from it and then shown to staff to READ ALOUD, texted to a customer, emailed
// as an invite, or handed to Stripe as a return_url is unusable the moment it
// leaves the phone.
//
// Reported from a real device on 2026-08-25: the client detail page showed the
// portal sign-in address as `capacitor://localhost/portal/…`.
//
// The repo already knew. InvoiceRow.tsx and InvoiceDrawer.tsx both carry the
// note "appUrl(), not window.location.origin — this link goes to a CUSTOMER".
// Five other call sites did not get the message: the portal address on the
// client header, the two portal-link panels, the platform invite link, and the
// Stripe return_url on the customer payment page. That last one is the worst of
// them: a payment could complete and strand the payer on an origin no browser
// can resolve.
//
// ── WHAT THIS DOES AND DOES NOT FORBID ────────────────────────────────────
//
// Reading the page origin is fine, and this deliberately allows it. Comparing
// it (`event.origin !== window.location.origin`) is a security check and one of
// the few things it is exactly right for. What is banned is BUILDING an
// outward-facing path from it — a link that has to survive being copied off the
// device.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

/** Paths that mean the URL is leaving this device. */
const OUTWARD = /\/(portal|invite|pay|signup|lead)\//;

describe("a link a customer will open is not built from the page origin", () => {
  const files = walk(root);

  it("finds source to scan, rather than passing on an empty set", () => {
    expect(files.length).toBeGreaterThan(200);
    // The rule is only meaningful if appUrl exists to be used instead.
    expect(readFileSync(join(root, "lib/app-origin.ts"), "utf8")).toMatch(/export function appUrl/);
  });

  it("never joins window.location.origin to an outward-facing path", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("window.location.origin")) continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("window.location.origin")) return;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        // The expression usually fits on one line; allow the next one for a
        // wrapped template literal.
        const window_ = line + "\n" + (lines[i + 1] ?? "");
        if (OUTWARD.test(window_)) {
          offenders.push(`${file.slice(root.length + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(
      offenders,
      "use appUrl() — window.location.origin is capacitor://localhost in the native build:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // The shape the line-adjacent scan above cannot see, because the assignment
  // and the path can be a dozen lines apart:
  //
  //   const base = typeof window !== "undefined" ? window.location.origin : appOrigin();
  //
  // It reads as careful SSR handling and is backwards for the native build: it
  // prefers the page origin whenever a browser exists, and inside the binary a
  // browser DOES exist with an origin no customer can open. Both instances of
  // this idiom in the repo were bugs — the portal sign-in address the owner
  // reported, and the Stripe return url on onboarding — and in both the
  // fallback was already the right answer for every platform.
  it("never prefers the page origin over appOrigin/appUrl in a ternary", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("window.location.origin")) continue;
      src.split("\n").forEach((line, i) => {
        if (!line.includes("window.location.origin")) return;
        // Skip comments. The three call sites that got this RIGHT all explain
        // themselves in prose that names both spellings, and a scan that reads
        // its own documentation as a violation is worse than no scan.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        // Falling back to the canonical origin means the canonical origin was
        // what was wanted; the browser branch is the mistake.
        if (/appOrigin\(\)|appUrl\(/.test(line)) {
          offenders.push(`${file.slice(root.length + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(
      offenders,
      "if the fallback is appOrigin()/appUrl(), use it unconditionally — the " +
        "browser branch is capacitor://localhost in the native build:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("never hands the page origin to Stripe as a return url", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        if (!/return_?[Uu]rl/.test(line)) return;
        if (!line.includes("window.location.origin")) return;
        offenders.push(`${file.slice(root.length + 1)}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "a Stripe return_url must be a real origin; a payment can otherwise " +
        "complete and strand the payer:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
