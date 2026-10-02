import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";

/**
 * A TECHNICIAN WHO CHOSE ESPAÑOL GETS SPANISH ON THE PARTS THEY WORK FROM.
 *
 * Launch pass, 2026-10. Preferences has offered Español since the field app
 * shipped, and es.ts had keys for Start, Complete, Skip, Call and every visit
 * status. Measured in a browser with `scoop.lang = es`, My day drew "Mi día"
 * and "1 de 3 hechas" at the top and then, on every card: Navigate, Call,
 * Start, Complete, More options, "scheduled", the time clock, the tab bar
 * (Today / Waste log / Alerts / More) and, in red capitals, SAFETY WARNINGS:
 * READ BEFORE ENTERING / Escape risk: close gate immediately. The keys were
 * there; nothing read them.
 *
 * Two checks. Every English key has a Spanish one, because i18next falls
 * back to English silently and a missing key looks exactly like a wired one
 * in review. And the strings a technician acts on are read through `t()` in
 * the files that draw them, not typed in as English literals.
 */

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("a technician who reads Spanish", () => {
  it("has a Spanish string for every English one", () => {
    const missing: string[] = [];
    for (const [group, entries] of Object.entries(en)) {
      const target = (es as Record<string, Record<string, string>>)[group] ?? {};
      for (const key of Object.keys(entries)) {
        if (!target[key]?.trim()) missing.push(`${group}.${key}`);
      }
    }
    expect(missing, "keys en.ts has and es.ts does not").toEqual([]);
  });

  it("has a Spanish label for every safety warning the card can show", () => {
    const src = read("src/routes/_authenticated/my-day.tsx");
    const block = src.slice(
      src.indexOf("const HAZARD_LABELS"),
      src.indexOf("function HazardBanner"),
    );
    const keys = [...block.matchAll(/^\s+(\w+):\s*\{\s*label:/gm)].map((m) => m[1]);
    expect(keys.length, "parsed no hazard keys, so this would pass vacuously").toBeGreaterThan(5);
    for (const k of keys) expect(es.hazards[k], `hazards.${k}`).toBeTruthy();
  });

  it("draws the field controls through t(), not as English literals", () => {
    const myDay = read("src/routes/_authenticated/my-day.tsx");
    for (const key of [
      "myDay.navigate",
      "myDay.call",
      "myDay.start",
      "myDay.complete",
      "myDay.skip",
      "myDay.takePhoto",
      "myDay.safetyWarnings",
      "myDay.moreOptions",
    ]) {
      expect(myDay, `my-day.tsx does not read ${key}`).toContain(`t("${key}")`);
    }
    expect(myDay).not.toMatch(/⚠ Safety warnings: read before entering/);
    expect(myDay).not.toMatch(/aria-hidden="true" \/> Navigate\b/);

    const bar = read("src/components/MobileTabBar.tsx");
    for (const key of ["nav.today", "nav.wasteLog", "nav.alerts", "nav.more"]) {
      expect(bar, `MobileTabBar does not read ${key}`).toContain(`t("${key}")`);
    }

    const clock = read("src/components/TimeClockCard.tsx");
    for (const key of ["clock.clockIn", "clock.clockOut", "clock.offTheClock"]) {
      expect(clock, `TimeClockCard does not read ${key}`).toContain(`t("${key}")`);
    }
  });
});
