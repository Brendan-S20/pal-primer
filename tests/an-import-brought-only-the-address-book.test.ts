import { describe, expect, it } from "vitest";
import {
  mapBalanceRow,
  mapServiceRow,
  parseFrequency,
  parseImportDate,
  parseMoneyCents,
  parseTags,
  parseWeekdays,
} from "@/lib/import-services";
import { autoMap, mapClientRow, TARGET_FIELDS_BY_ENTITY } from "@/lib/imports.functions";

// A Jobber shop with 400 weekly customers came across with its address book
// and nothing else: zero services, zero prices, zero balances, and its Tags
// folded into notes (persona review, 2026-09-27). These pin the parsing of the
// cells a real export actually holds.

describe("how often", () => {
  it.each([
    ["Weekly", { frequency: "weekly" }],
    ["Every week", { frequency: "weekly" }],
    ["Weekly on Tuesdays", { frequency: "weekly" }],
    ["Every 2 weeks", { frequency: "biweekly" }],
    ["Every other week", { frequency: "biweekly" }],
    ["Bi-weekly", { frequency: "biweekly" }],
    ["Every 3 weeks", { frequency: "weekly", intervalWeeks: 3 }],
    ["Twice a week", { frequency: "twice_weekly" }],
    ["2x per week", { frequency: "twice_weekly" }],
    ["Monthly", { frequency: "monthly" }],
    ["Every 10 days", { frequency: "every_n_days", intervalDays: 10 }],
    ["One-time", { frequency: "one_time" }],
    ["Tuesday", { frequency: "weekly" }],
  ])("%s", (text, want) => {
    expect(parseFrequency(text)).toEqual(want);
  });

  it("says so when it cannot tell, rather than guessing weekly", () => {
    expect(parseFrequency("As needed")).toBeNull();
    expect(parseFrequency("Every 40 weeks")).toBeNull();
  });
});

describe("the other cells", () => {
  it("weekdays named anywhere", () => {
    expect(parseWeekdays("Tue & Fri")).toEqual([2, 5]);
    expect(parseWeekdays("Weekly on Thursdays")).toEqual([4]);
    expect(parseWeekdays("Weekly")).toEqual([]);
  });

  it("money as exports write it", () => {
    expect(parseMoneyCents("$1,234.50")).toBe(123450);
    expect(parseMoneyCents("25")).toBe(2500);
    expect(parseMoneyCents("(45.00)")).toBe(-4500);
    expect(parseMoneyCents("n/a")).toBeNull();
    expect(parseMoneyCents("1.2.3")).toBeNull();
  });

  it("dates, US month first, and refuses impossible ones", () => {
    expect(parseImportDate("10/01/2026")).toBe("2026-10-01");
    expect(parseImportDate("10/1/26")).toBe("2026-10-01");
    expect(parseImportDate("2026-10-01")).toBe("2026-10-01");
    expect(parseImportDate("02/30/2026")).toBeNull();
    expect(parseImportDate("next week")).toBeNull();
  });

  it("tags split on ; , and |, without repeats", () => {
    expect(parseTags("Weekly; Tuesday, VIP | Tuesday")).toEqual(["Weekly", "Tuesday", "VIP"]);
    expect(parseTags("   ")).toBeNull();
  });
});

describe("a Jobber row", () => {
  const headers = ["Client J-ID", "Client name", "Visit frequency", "Visit total", "Day", "Start date"];
  const mapping = autoMap("jobber", headers, "services");

  it("auto-maps the service fields", () => {
    expect(mapping).toMatchObject({
      client_external_id: "Client J-ID",
      client_name: "Client name",
      frequency: "Visit frequency",
      price_per_visit: "Visit total",
      service_day: "Day",
      start_date: "Start date",
    });
  });

  it("becomes a plan", () => {
    const { mapped, error } = mapServiceRow(
      {
        "Client J-ID": "81",
        "Client name": "Dana Fox",
        "Visit frequency": "Every 2 weeks",
        "Visit total": "$32.00",
        Day: "Tuesday",
        "Start date": "10/06/2026",
      },
      mapping,
    );
    expect(error).toBeNull();
    expect(mapped).toMatchObject({
      client_external_id: "81",
      frequency: "biweekly",
      price_cents: 3200,
      preferred_weekdays: [2],
      started_on: "2026-10-06",
    });
  });

  it("refuses a row it cannot price, and says which cell", () => {
    expect(mapServiceRow({ "Client name": "Dana Fox", "Visit total": "call" }, mapping).error).toMatch(
      /Price not understood: "call"/,
    );
  });

  it("a Tags column lands in tags, not notes", () => {
    const clientMapping = autoMap("jobber", ["Display Name", "Tags", "Notes"], "clients");
    expect(clientMapping.tags).toBe("Tags");
    expect(clientMapping.notes).toBe("Notes");
    const { mapped } = mapClientRow(
      { "Display Name": "Dana Fox", Tags: "Weekly;Tuesday", Notes: "Side gate" },
      clientMapping,
    );
    expect(mapped?.tags).toEqual(["Weekly", "Tuesday"]);
    expect(mapped?.notes).toBe("Side gate");
  });
});

describe("opening balances", () => {
  const mapping = autoMap("generic_csv", ["client_name", "balance", "due_date"], "balances");

  it("an amount owed becomes a balance row", () => {
    const { mapped } = mapBalanceRow({ client_name: "Dana Fox", balance: "$64.00", due_date: "10/15/2026" }, mapping);
    expect(mapped).toMatchObject({ client_name: "Dana Fox", amount_cents: 6400, due_on: "2026-10-15" });
  });

  it("zero and credits are refused with a reason", () => {
    expect(mapBalanceRow({ client_name: "A", balance: "0.00" }, mapping).error).toMatch(/zero/);
    expect(mapBalanceRow({ client_name: "A", balance: "-12" }, mapping).error).toMatch(/credit/);
  });

  it("both kinds need a client, by ID or by name", () => {
    expect(TARGET_FIELDS_BY_ENTITY.balances).toContain("client_name");
    expect(mapBalanceRow({ balance: "10" }, mapping).error).toMatch(/Missing the client/);
  });
});
