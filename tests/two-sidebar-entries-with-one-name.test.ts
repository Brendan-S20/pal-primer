// No two sidebar entries share a name in any language.
//
// QA row 37 (2026-10): in Spanish the Setup group and the Settings item were
// both "Configuración"; in Chinese Setup and Settings were both "设置", and
// the Billing group and the Invoices item were both "账单". A person who
// reads the sidebar in one of those languages saw two identical labels that
// lead to different places, with nothing to tell them apart.
//
// The sidebar shows group headings and item titles together, so the check is
// across both: every `nav.group.*` and `nav.item.*` value in a locale is
// distinct from every other.

import { describe, expect, it } from "vitest";
import en from "../src/lib/i18n/locales/en";
import es from "../src/lib/i18n/locales/es";
import ar from "../src/lib/i18n/locales/ar";
import zh from "../src/lib/i18n/locales/zh";

type NavTree = { nav: { group: Record<string, string>; item: Record<string, string> } };

const LOCALES = { en, es, ar, zh } as unknown as Record<string, NavTree>;

describe("sidebar labels", () => {
  for (const [code, locale] of Object.entries(LOCALES)) {
    it(`${code}: no group heading or item shares a label with another`, () => {
      const seen = new Map<string, string>();
      const clashes: string[] = [];
      const entries = [
        ...Object.entries(locale.nav.group).map(([k, v]) => [`nav.group.${k}`, v] as const),
        ...Object.entries(locale.nav.item).map(([k, v]) => [`nav.item.${k}`, v] as const),
      ];
      for (const [key, label] of entries) {
        const norm = label.trim().toLocaleLowerCase();
        const prior = seen.get(norm);
        if (prior) clashes.push(`${prior} and ${key} are both "${label}"`);
        else seen.set(norm, key);
      }
      expect(clashes).toEqual([]);
    });
  }

  it("uses the labels QA asked for", () => {
    expect((es as unknown as NavTree).nav.group.Setup).toBe("Puesta en marcha");
    expect((zh as unknown as NavTree).nav.group.Setup).toBe("初始设置");
    expect((zh as unknown as NavTree).nav.item.invoices).toBe("发票");
  });
});
