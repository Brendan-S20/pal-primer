import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BOOKABLE_SERVICE_LINES, serviceLinesOrDefault } from "@/lib/service-lines";

vi.mock("@/lib/groom.functions", () => ({
  listServiceSizeRules: vi.fn(),
  upsertServiceSizeRule: vi.fn(),
  deleteServiceSizeRule: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => createElement("a", {}, children),
}));
vi.mock("@/lib/page-title", () => ({ pageTitle: () => "", useDocumentTitle: () => {} }));
import { PetSizeFields } from "@/components/client-detail/PetSizeFields";
import { AddonGroomFields } from "@/components/settings/AddonGroomFields";
import { ServiceSizeRulesEditor } from "@/components/settings/ServiceSizeRulesEditor";
import { FieldClientView } from "@/components/client-detail/FieldClientView";
import i18n from "@/lib/i18n";

const petFields = (grooming: boolean, size = "small") =>
  renderToStaticMarkup(
    createElement(PetSizeFields, {
      size,
      coatType: "long",
      weightLb: "32.5",
      grooming,
      onChange: () => {},
    }),
  );
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("grooming owner fields", () => {
  it("keeps the size picker for every org, with imported text intact and extra large available", () => {
    const html = petFields(false, "about 40 lb");
    expect(html).toContain('value="about 40 lb" selected=""');
    for (const size of ["Small", "Medium", "Large", "Extra large"]) expect(html).toContain(size);
  });
  it("shows no matrix, coat, weight or add-on appointment fields for pet waste or an unreadable org answer", () => {
    for (const raw of [["pet_waste"], null, undefined, []]) {
      const grooming = serviceLinesOrDefault(raw).includes("mobile_grooming");
      expect(petFields(grooming)).not.toMatch(/Coat type|Weight \(lb\)/);
      expect(
        renderToStaticMarkup(
          createElement(AddonGroomFields, {
            grooming,
            durationMin: "0",
            serviceLine: "",
            onChange: () => {},
          }),
        ),
      ).toBe("");
    }
    expect(
      renderToStaticMarkup(
        createElement(ServiceSizeRulesEditor, { serviceId: "unused", serviceLine: "pet_waste" }),
      ),
    ).toBe("");
    expect(BOOKABLE_SERVICE_LINES).not.toContain("mobile_grooming");
  });
  it("shows coat and weight for grooming and labels the add-on fields", () => {
    expect(petFields(true)).toMatch(/Coat type/);
    expect(petFields(true)).toMatch(/Weight \(lb\)/);
    const html = renderToStaticMarkup(
      createElement(AddonGroomFields, {
        grooming: true,
        durationMin: "10",
        serviceLine: "mobile_grooming",
        onChange: () => {},
      }),
    );
    expect(html).toContain("Minutes");
    expect(html).toContain("Offered with");
    expect(html).toContain("Any service line");
  });
  it("wires both pet editors to the organization's service lines and the matrix to the service line", () => {
    for (const file of [
      "src/components/client-detail/PropertiesTab.tsx",
      "src/routes/_authenticated/clients.new.tsx",
    ]) {
      const src = read(file);
      expect(src).toContain('lines.includes("mobile_grooming")');
      expect(src).toMatch(/<PetSizeFields[\s\S]*?grooming=\{grooming\}/);
    }
    expect(read("src/routes/_authenticated/settings.services.tsx")).toMatch(
      /s\.service_line === "mobile_grooming" && <Button/,
    );
    expect(read("src/components/settings/ServiceSizeRulesEditor.tsx")).toContain(
      "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]",
    );
  });
});

describe("tech pet details", () => {
  it("translates extra large and every coat in all four locales, and hides coats outside grooming", async () => {
    const coats = ["short", "medium", "long", "double", "curly", "wire"];
    const dogs = coats.map((coat, i) => ({
      id: String(i),
      property_id: "p",
      name: `Pet ${i}`,
      weight_class: "xlarge",
      coat_type: coat,
    }));
    for (const lng of ["en", "es", "ar", "zh"]) {
      await i18n.changeLanguage(lng);
      const props = {
        client: { display_name: "Client" },
        properties: [{ id: "p", street: "Street" }],
        dogs,
      };
      const html = renderToStaticMarkup(
        createElement(FieldClientView, { ...props, grooming: true }),
      );
      expect(html).toContain(i18n.t("fieldClient.dogSize.xlarge"));
      for (const coat of coats) expect(html).toContain(i18n.t(`fieldClient.coatType.${coat}`));
      const waste = renderToStaticMarkup(createElement(FieldClientView, props));
      for (const coat of coats) expect(waste).not.toContain(i18n.t(`fieldClient.coatType.${coat}`));
      expect(html).not.toContain("fieldClient.coatType.");
    }
    await i18n.changeLanguage("en");
  });
});
