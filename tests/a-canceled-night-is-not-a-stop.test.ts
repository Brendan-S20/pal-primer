// gaps-r2-08: after an early return the stay's canceled nights stayed on the
// sitter's My Day as full cards (Navigate, Call, money due) and in the count
// ("0 of 2 done"). A canceled visit is not a stop: it is out of the count and
// the cards, folded under one line in the tech's language.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dayAtAGlance } from "@/lib/my-day-progress";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const myDay = readFileSync(join(ROOT, "src/routes/_authenticated/my-day.tsx"), "utf8");
const upcoming = readFileSync(join(ROOT, "src/lib/my-day.functions.ts"), "utf8");
const day = (...statuses: string[]) => statuses.map((status, i) => ({ id: `v${i}`, status }));

describe("the done count", () => {
  it("a day of one completed walk and a canceled night is 1 of 1 done", () => {
    expect(dayAtAGlance(day("completed", "canceled"))).toMatchObject({
      completedCount: 1,
      total: 1,
      pct: 100,
    });
  });

  it("the audit's day: one scheduled stop and a canceled night is 0 of 1, not 0 of 2", () => {
    const r = dayAtAGlance(day("scheduled", "canceled"));
    expect(r.total).toBe(1);
    expect(r.nextUp?.id).toBe("v0");
  });

  it("a day of only canceled visits has nothing to do and nothing next", () => {
    expect(dayAtAGlance(day("canceled", "canceled"))).toMatchObject({
      total: 0,
      pct: 0,
      nextUp: undefined,
      activeVisit: undefined,
    });
  });
});

describe("My Day draws no card for a canceled visit", () => {
  it("cards, count and map read the route's stops, not the raw day", () => {
    expect(myDay).toContain(
      "const visits = useMemo(() => routeStops(dayAsWorked), [dayAsWorked]);",
    );
    expect(myDay).toMatch(/dayAtAGlance\(visits\)/);
    expect(myDay).toMatch(/<MyDayMap\s+visits=\{visits\}/);
  });

  it("the canceled ones are folded under one line, with no Navigate or Call", () => {
    const at = myDay.indexOf("canceledVisits.length > 0 && (");
    expect(at).toBeGreaterThan(-1);
    const block = myDay.slice(at, myDay.indexOf("</details>", at));
    expect(block).toContain("<details");
    expect(block).toContain('t("myDay.canceledStops", { count: canceledVisits.length })');
    expect(block).not.toMatch(/VisitCard|Navigate|tel:/);
  });

  it("a day whose only visits are canceled is not an upcoming workday", () => {
    expect(upcoming).toMatch(/if \(v\.status === "canceled"\) continue;/);
  });

  it("says it in every language", () => {
    for (const [name, locale] of Object.entries({ en, es, ar, zh })) {
      const m = (locale as unknown as { myDay: Record<string, string | undefined> }).myDay;
      expect(m.canceledStops_other, name).toBeTruthy();
      expect(m.canceledStopsHint, name).toBeTruthy();
    }
  });
});
