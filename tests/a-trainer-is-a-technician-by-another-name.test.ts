import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { humanizeRole, roleLabelKey, techIsTrainer } from "@/lib/humanize";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

// train-17, the owner's decision (2026-11-02): a Trainer is a technician
// with another word. Same app_role, same permissions; only what the
// business's own staff read changes, and only for a business that runs
// training and nothing else.

describe("who reads Trainer", () => {
  it("a training-only business; a business with training and another line keeps Technician", () => {
    expect(techIsTrainer(["training"])).toBe(true);
    expect(techIsTrainer(["training", "dog_walking"])).toBe(false);
    expect(techIsTrainer(["pet_waste"])).toBe(false);
    expect(techIsTrainer([])).toBe(false);
    expect(techIsTrainer(null)).toBe(false);
  });

  it("relabels the tech role only, and the default is unchanged", () => {
    expect(humanizeRole("tech", ["training"])).toBe("Trainer");
    expect(humanizeRole("tech")).toBe("Technician");
    expect(humanizeRole("tech", ["pet_waste", "training"])).toBe("Technician");
    expect(humanizeRole("owner", ["training"])).toBe("Owner");
    expect(humanizeRole("dispatcher", ["training"])).toBe("Dispatcher");
  });

  it("names a translated key on a tech screen, in all four locales", () => {
    expect(roleLabelKey("tech", ["training"])).toBe("role.trainer");
    expect(roleLabelKey("tech", ["pet_waste"])).toBe("role.tech");
    expect(roleLabelKey("something_new")).toBe("role.other");
    for (const locale of [en, es, ar, zh] as Array<Record<string, any>>) {
      for (const key of ["owner", "office_manager", "dispatcher", "tech", "trainer", "other"])
        expect(typeof locale.role?.[key], key).toBe("string");
      for (const key of ["selectTrainer", "noTrainers", "pickTrainer"])
        expect(typeof locale.myDay?.[key], key).toBe("string");
    }
  });
});

describe("where the word is read", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the team page, the routes board, the dashboard and the profile go through the business's lines", () => {
    for (const file of [
      "src/routes/_authenticated/settings.users.tsx",
      "src/routes/_authenticated/routes.tsx",
      "src/routes/_authenticated/dashboard.tsx",
      "src/routes/_authenticated/profile.tsx",
    ]) {
      const code = read(file);
      expect(code, file).toMatch(/useRoleLabel\(\)/);
      expect(code, file).not.toMatch(/humanizeRole\(/);
    }
  });

  it("My Day translates the role and its own headers", () => {
    const code = read("src/routes/_authenticated/my-day.tsx");
    expect(code).not.toMatch(/humanizeRole\(/);
    expect(code).toMatch(/roleLabelKey\(role/);
    expect(code).toMatch(/myDay\.selectTrainer/);
  });

  it("a teammate invitation carries the label its business uses", () => {
    expect(read("src/lib/platform-onboarding.functions.ts")).toMatch(
      /role_label: humanizeRole\(inv\.role, inv\.organizations\?\.service_lines/,
    );
    expect(read("src/routes/invite.$token.tsx")).toMatch(/q\.data\.role_label \?\?/);
    expect(read("src/routes/get-started.tsx")).toMatch(/invite\.role_label \?\?/);
  });

  it("adds no role: app_role is untouched by this change", () => {
    const sql = read(
      "supabase/migrations/20261102172500_a-lesson-series-skips-closed-days-and-can-stop.sql",
    );
    expect(sql).not.toMatch(/app_role/);
  });
});
