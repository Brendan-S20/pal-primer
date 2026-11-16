// R2-45: Confirm skip is disabled until the details box has something in it,
// and that used to be all — a grey button and no reason. The rule (a trimmed,
// non-empty detail is required) is unchanged; what this pins is that the
// screen now SAYS so while the button is disabled for that reason, and stops
// saying so the moment it is not.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import i18n from "@/lib/i18n";
import { SkipConfirmRow } from "@/components/my-day/SkipConfirmRow";

const noop = () => {};
const render = (reason: string, pending = false) =>
  renderToStaticMarkup(
    createElement(SkipConfirmRow, { reason, pending, onConfirm: noop, onCancel: noop }),
  );

/** The Confirm button's opening tag — the first <button> in the row. */
const confirmTag = (html: string) => html.match(/<button[^>]*>/)![0];

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("Confirm skip says why it is disabled", () => {
  for (const reason of ["", "   ", "\n\t"]) {
    it(`blank details (${JSON.stringify(reason)}): disabled, with the hint wired to it`, async () => {
      await i18n.changeLanguage("en");
      const html = render(reason);
      const tag = confirmTag(html);
      expect(html).toContain("Confirm skip");
      expect(tag).toMatch(/\sdisabled=""/);
      expect(html).toContain(i18n.t("skip.detailsRequired"));
      expect(html).toContain("data-skip-details-required");
      const describedBy = tag.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(describedBy).toBeTruthy();
      expect(html).toContain(`id="${describedBy}"`);
    });
  }

  it("written details: enabled and the hint is gone", async () => {
    await i18n.changeLanguage("en");
    const html = render("Gate locked, no code");
    const tag = confirmTag(html);
    expect(tag).not.toMatch(/\sdisabled=""/);
    expect(tag).not.toContain("aria-describedby");
    expect(html).not.toContain(i18n.t("skip.detailsRequired"));
    expect(html).not.toContain("data-skip-details-required");
  });

  it("written details while saving: disabled, but not blamed on the details", async () => {
    const html = render("Gate locked", true);
    expect(confirmTag(html)).toMatch(/\sdisabled=""/);
    expect(html).not.toContain("data-skip-details-required");
  });

  for (const lng of ["es", "ar", "zh"]) {
    it(`the hint is translated in ${lng}`, async () => {
      await i18n.changeLanguage(lng);
      const html = render("");
      const en = i18n.getFixedT("en")("skip.detailsRequired");
      const local = i18n.t("skip.detailsRequired");
      expect(local).not.toBe(en);
      expect(html).toContain(local);
    });
  }

  it("My Day draws the row, so the hint is on the real skip panel", () => {
    const src = readFileSync(join(__dirname, "..", "src/routes/_authenticated/my-day.tsx"), "utf8");
    expect(src).toMatch(/<SkipConfirmRow\s[^>]*reason=\{reason\}/);
    expect(src).not.toMatch(/disabled=\{!reason\.trim\(\) \|\| skip\.isPending\}/);
  });
});
