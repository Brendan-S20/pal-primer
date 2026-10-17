// A pet sitting visit's email is a visit report (#411), and a walk's and a
// cleanup's did not change.
//
// For a pet sitting visit the completion email says who checked on which pets
// (or that they had company overnight), when the sitter was in and out, what
// each pet got, any medication missed with the reason, and the sitter's note.
// A missed medication also gets its own email, once per visit, and the last
// visit of a stay sends a stay summary. The pet waste half is pinned byte for
// byte by tests/a-walk-report-is-not-a-cleanup-email.test.tsx; this file pins
// that a `sit` prop is the only way into the sit branch, and what it says.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { walkReportEmail } from "@/lib/walk-report";
import {
  SIT_PUSH,
  careByPet,
  careLine,
  missedMedNotice,
  missedMeds,
  petNamesPhrase,
  sitReportEmail,
  sitReportSubject,
  sitTimesSentence,
  staySummaryCount,
  staySummaryDates,
  type CareRow,
} from "@/lib/sit-report";

const visitCompleted = TEMPLATES["visit-completed"];
const missedTemplate = TEMPLATES["sit-missed-meds"];
const summaryTemplate = TEMPLATES["stay-summary"];

const TZ = "America/Chicago";
const PETS = [
  { id: "luna", name: "Luna" },
  { id: "max", name: "Max" },
];

const row = (over: Partial<CareRow>): CareRow => ({
  pet_id: "luna",
  kind: "feed",
  med_name: null,
  status: "done",
  missed_reason: null,
  note: null,
  at: "2026-10-19T13:05:00Z",
  ...over,
});

const ROWS: CareRow[] = [
  row({ kind: "feed", at: "2026-10-19T13:05:00Z" }),
  row({ pet_id: "max", kind: "water", at: "2026-10-19T13:07:00Z" }),
  row({ kind: "meds", med_name: "Insulin", at: "2026-10-19T13:10:00Z" }),
  row({
    pet_id: "max",
    kind: "meds",
    med_name: "Apoquel",
    status: "missed",
    missed_reason: "He spat it out twice",
    at: "2026-10-19T13:12:00Z",
  }),
  row({ pet_id: null, kind: "litter", at: "2026-10-19T13:20:00Z" }),
];

const sit = (over: Partial<Parameters<typeof sitReportEmail>[0]> = {}) =>
  sitReportEmail({
    overnight: false,
    startedAt: "2026-10-19T13:02:00Z",
    completedAt: "2026-10-19T13:31:00Z",
    timezone: TZ,
    pets: PETS,
    rows: ROWS,
    reportNote: "  Luna napped in the sun.  ",
    sitterName: "Taylor Brooks",
    ...over,
  });

const sitProps = (over: Parameters<typeof sit>[0] = {}) => ({
  orgName: "Happy Paws",
  clientName: "Jane",
  visitDate: "Mon, Oct 19",
  photoUrls: ["https://example.com/sit-1.jpg"],
  sit: sit(over),
});

/** The text a client reads, with tags and entities gone. */
const textOf = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("what each pet got", () => {
  it("says it in one line per entry, on the business's clock", () => {
    const n = (s: string) => s.replace(/[  ]/g, " ");
    expect(n(careLine(row({ kind: "feed" }), TZ))).toBe("Fed at 8:05 AM");
    expect(n(careLine(row({ kind: "water" }), TZ))).toBe("Fresh water at 8:05 AM");
    expect(n(careLine(row({ kind: "litter" }), TZ))).toBe("Litter or yard cleaned at 8:05 AM");
    expect(n(careLine(row({ kind: "meds", med_name: "Insulin" }), TZ))).toBe(
      "Insulin given at 8:05 AM",
    );
    expect(
      careLine(
        row({
          kind: "meds",
          med_name: "Insulin",
          status: "missed",
          missed_reason: "Hid under the bed",
        }),
        TZ,
      ),
    ).toBe("Insulin missed: Hid under the bed");
  });

  it("groups by pet in the order they first appear, with All pets for none", () => {
    const groups = careByPet(ROWS, PETS, TZ);
    expect(groups.map((g) => g.pet)).toEqual(["Luna", "Max", "All pets"]);
    expect(groups[0].lines).toHaveLength(2);
    expect(groups[1].lines[1]).toBe("Apoquel missed: He spat it out twice");
  });

  it("lists every missed medication with its pet and reason, and nothing else", () => {
    expect(missedMeds(ROWS, PETS)).toEqual([
      { pet: "Max", med: "Apoquel", reason: "He spat it out twice" },
    ]);
    expect(
      missedMeds(
        ROWS.filter((r) => r.status === "done"),
        PETS,
      ),
    ).toEqual([]);
  });

  it("names the pets, or says your pets", () => {
    expect(petNamesPhrase(["Luna"])).toBe("Luna");
    expect(petNamesPhrase(["Luna", "Max"])).toBe("Luna and Max");
    expect(petNamesPhrase([])).toBe("your pets");
  });
});

describe("a pet sitting visit's completion email", () => {
  it("is a visit report for a drop-in", async () => {
    const props = sitProps();
    expect(visitCompleted.subject(props)).toBe("Happy Paws checked on Luna and Max today");
    const text = textOf(await render(React.createElement(visitCompleted.component, props)));
    expect(text).toContain(
      "Hi Jane, Taylor from Happy Paws checked on Luna and Max on Mon, Oct 19.",
    );
    expect(text).toContain("In at 8:02 AM, out at 8:31 AM.");
    expect(text).toContain("Fed at 8:05 AM");
    expect(text).toContain("Insulin given at 8:10 AM");
    expect(text).toContain("Apoquel missed: He spat it out twice");
    expect(text).toContain("One medication was not given.");
    expect(text).toContain("A note from Taylor:");
    expect(text).toContain("Luna napped in the sun.");
    expect(text).not.toMatch(/cleaned up|yard visit|walked/i);
  });

  it("says the pets had company for an overnight", async () => {
    const props = sitProps({ overnight: true });
    expect(visitCompleted.subject(props)).toBe("Luna and Max had company overnight");
    const text = textOf(await render(React.createElement(visitCompleted.component, props)));
    expect(text).toContain("Overnight stay");
    expect(text).toContain("stayed overnight with Luna and Max");
    expect(text).toContain("Checked in at 8:02 AM, checked out at 8:31 AM.");
  });

  it("leaves out what was not logged", async () => {
    const props = sitProps({ rows: [], reportNote: null, sitterName: null, startedAt: null });
    const text = textOf(await render(React.createElement(visitCompleted.component, props)));
    expect(text).toContain("Hi Jane, Happy Paws checked on Luna and Max");
    expect(text).not.toContain("A note from");
    expect(text).not.toContain("was not given");
    expect(text).toContain("Out at 8:31 AM.");
    expect(sitTimesSentence({ overnight: false })).toBe("");
  });

  it("has its own push for a drop-in and an overnight", () => {
    expect(SIT_PUSH.drop_in.title).toBe("Visit complete");
    expect(SIT_PUSH.overnight.body).toBe("Your pets had company overnight.");
  });

  it("subject falls back to Your sitter", () => {
    expect(sitReportSubject(null, "Luna", false)).toBe("Your sitter checked on Luna today");
  });
});

describe("a walk's and a cleanup's email did not move", () => {
  it("a walk is still a walk report, even with a sit prop absent", async () => {
    const props = {
      orgName: "Happy Paws",
      clientName: "Jane",
      walk: walkReportEmail({
        startedAt: "2026-10-19T14:05:00Z",
        completedAt: "2026-10-19T14:37:00Z",
        timezone: TZ,
        pee: true,
        poo: null,
        reportNote: null,
        dogNames: ["Bella"],
        walkerName: "Alejandra",
      }),
    };
    expect(visitCompleted.subject(props)).toBe("Happy Paws walked Bella today");
    const text = textOf(await render(React.createElement(visitCompleted.component, props)));
    expect(text).not.toMatch(/checked on|had company|Care log/);
  });

  it("a cleanup's subject and words are the cleanup's", async () => {
    const props = { orgName: "Acme Scoop Co.", clientName: "Jane", visitDate: "Mon, Sep 28" };
    expect(visitCompleted.subject(props)).toBe("Acme Scoop Co. completed today's visit");
    const text = textOf(await render(React.createElement(visitCompleted.component, props)));
    expect(text).not.toMatch(/checked on|had company|medication/i);
  });

  it("the server reads the sit report only for a pet sitting visit", () => {
    const fn = readFileSync("src/lib/my-day.functions.ts", "utf8");
    expect(fn).toMatch(/const sitting = svc\?\.service_line === "pet_sitting";/);
    expect(fn).toMatch(
      /sitting \? import\("@\/lib\/sit-report\.server"\) : Promise\.resolve\(null\)/,
    );
    expect(fn).toMatch(/\.\.\.\(sit \? \{ sit: sit\.email \} : \{\}\)/);
    expect(fn).toMatch(/sitReport\.afterSitCompleted\(data\.visitId\)/);
    const server = readFileSync("src/lib/sit-report.server.ts", "utf8");
    expect(server).toMatch(/service_line === "pet_sitting" \? v : null/);
  });
});

describe("the missed medication email", () => {
  const props = {
    orgName: "Happy Paws",
    clientName: "Jane",
    pets: "Max",
    day: "Mon, Oct 19",
    missed: [{ pet: "Max", med: "Apoquel", reason: "He spat it out twice." }],
  };

  it("names the pet, the medication and the reason", async () => {
    expect(missedTemplate.subject(props)).toBe("A medication was missed for Max");
    const text = textOf(await render(React.createElement(missedTemplate.component, props)));
    expect(text).toContain(
      "at the visit on Mon, Oct 19 the sitter could not give this medication:",
    );
    expect(text).toContain("Max: Apoquel. He spat it out twice.");
    expect(text).toContain("Happy Paws has been told.");
  });

  it("is sent once per visit, under its own switch", () => {
    const server = readFileSync("src/lib/sit-report.server.ts", "utf8");
    expect(server).toMatch(
      /templateName: "sit-missed-meds",\s*notifyKey: "notify_email_missed_meds",/,
    );
    expect(server).toMatch(/idempotencyKey: `missed-meds-\$\{v\.id\}`,\s*oncePerKey: true,/);
    expect(server).toMatch(/if \(missed\.length === 0\) return;/);
  });

  it("tells the office in plain words", () => {
    expect(
      missedMedNotice({
        sitter: "Taylor",
        pet: "Luna",
        med: "Insulin",
        reason: "Hid",
        client: "Jane Doe",
      }),
    ).toEqual({ title: "Taylor missed Luna's Insulin", body: "Hid. Jane Doe" });
    expect(
      missedMedNotice({ sitter: null, pet: null, med: "Insulin", reason: "", client: null }),
    ).toEqual({ title: "A sitter missed Insulin", body: "" });
  });
});

describe("the stay summary", () => {
  const props = {
    orgName: "Happy Paws",
    clientName: "Jane",
    pets: "Luna and Max",
    dates: staySummaryDates("overnight", "2026-10-19", "2026-10-24"),
    visitsDone: 5,
    visitsTotal: 5,
    overnight: true,
    missed: [{ day: "Tue, Oct 20", pet: "Max", med: "Apoquel", reason: "He spat it out." }],
    portalUrl: "https://example.com/portal/acme/token/visits",
  };

  it("gives the dates, the visits done, the missed medications and the portal link", async () => {
    expect(summaryTemplate.subject(props)).toBe("Stay summary for Luna and Max");
    const html = await render(React.createElement(summaryTemplate.component, props));
    const text = textOf(html);
    expect(text).toContain("Check-in Oct 19, check-out Oct 24");
    expect(text).toContain("5 of 5 nights done.");
    expect(text).toContain("Tue, Oct 20, Max: Apoquel. He spat it out.");
    expect(html).toContain('href="https://example.com/portal/acme/token/visits"');
  });

  it("says every medication was given when none was missed", async () => {
    const text = textOf(
      await render(React.createElement(summaryTemplate.component, { ...props, missed: [] })),
    );
    expect(text).toContain("Every medication was given.");
  });

  it("counts nights or visits", () => {
    expect(staySummaryCount({ visitsDone: 9, visitsTotal: 10, overnight: false })).toBe(
      "9 of 10 visits",
    );
    expect(staySummaryCount({ visitsDone: 1, visitsTotal: 1, overnight: true })).toBe(
      "1 of 1 night",
    );
    expect(staySummaryDates("drop_in", "2026-10-19", "2026-10-23")).toBe("Oct 19 to Oct 23");
  });

  it("is sent once per stay, after its last visit, linking to the portal visits page", () => {
    const server = readFileSync("src/lib/sit-report.server.ts", "utf8");
    expect(server).toMatch(/x\.status === "scheduled" \|\| x\.status === "in_progress"/);
    expect(server).toMatch(/idempotencyKey: `stay-summary-\$\{stay\.id\}`,\s*oncePerKey: true,/);
    expect(server).toMatch(/portalUrl: `\$\{base\}\/visits`/);
  });
});

describe("the copy", () => {
  it("has no em dash in any sit email or report", () => {
    for (const f of [
      "src/lib/sit-report.ts",
      "src/lib/sit-report.server.ts",
      "src/lib/email-templates/sit-missed-meds.tsx",
      "src/lib/email-templates/stay-summary.tsx",
      "src/lib/email-templates/visit-completed.tsx",
    ])
      expect(readFileSync(f, "utf8"), f).not.toContain(String.fromCharCode(0x2014));
  });
});
