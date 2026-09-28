import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { render } from "react-email";
import {
  groupRemindersByClient,
  reminderDay,
  reminderDayLabel,
  tomorrowOf,
} from "@/lib/visit-reminders.server";
import { TEMPLATES } from "@/lib/email-templates/registry";

// Settings -> Automation had a "Day-before visit reminder" switch and nothing
// sent one on a schedule: the only sender was a button a tech taps, over SMS,
// which carrier registration blocks. The nightly job (09:00 UTC) now emails
// every client with a visit tomorrow. These pin the parts that are easy to get
// quietly wrong: whose "tomorrow" it is, one email per client, and that the
// switch actually gates the send.

describe("tomorrow is the organization's tomorrow", () => {
  // 09:00 UTC on Sep 28: 04:00 in Chicago, 23:00 the day before in Honolulu,
  // 19:00 on the 28th in Sydney.
  const RUN = new Date("2026-09-28T09:00:00Z");

  it("Chicago's job at 4 AM reminds for the 29th", () => {
    expect(reminderDay("America/Chicago", RUN)).toBe("2026-09-29");
  });
  it("Honolulu is still on the 27th, so it reminds for the 28th", () => {
    expect(reminderDay("Pacific/Honolulu", RUN)).toBe("2026-09-28");
  });
  it("Sydney is on the 28th and reminds for the 29th", () => {
    expect(reminderDay("Australia/Sydney", RUN)).toBe("2026-09-29");
  });
  it("month and year ends roll over", () => {
    expect(tomorrowOf("2026-09-30")).toBe("2026-10-01");
    expect(tomorrowOf("2026-12-31")).toBe("2027-01-01");
    expect(tomorrowOf("2028-02-28")).toBe("2028-02-29");
  });
});

describe("one email per client", () => {
  it("groups a client's properties and drops duplicates and blanks", () => {
    const batches = groupRemindersByClient([
      {
        id: "v1",
        client_id: "a",
        scheduled_on: "2026-09-29",
        properties: { street: "1 Elm St", city: "Austin" },
      },
      {
        id: "v2",
        client_id: "a",
        scheduled_on: "2026-09-29",
        properties: { street: "9 Oak Ave", city: "Austin" },
      },
      {
        id: "v3",
        client_id: "a",
        scheduled_on: "2026-09-29",
        properties: { street: "1 Elm St", city: "Austin" },
      },
      { id: "v4", client_id: "b", scheduled_on: "2026-09-29", properties: null },
      { id: "v5", client_id: null, scheduled_on: "2026-09-29", properties: { street: "x" } },
    ]);
    expect(batches).toEqual([
      { clientId: "a", addresses: ["1 Elm St, Austin", "9 Oak Ave, Austin"] },
      { clientId: "b", addresses: [] },
    ]);
  });
});

describe("the email", () => {
  it("names the day in words, not the database's format", () => {
    expect(reminderDayLabel("2026-09-29")).toBe("Tuesday, September 29");
  });

  it("is registered and renders the day, the address and the portal link", async () => {
    const entry = TEMPLATES["visit-reminder"];
    expect(entry, "registered under the name the sender uses").toBeTruthy();
    const html = await render(
      React.createElement(entry.component, {
        orgName: "Acme Scoop Co.",
        clientName: "Dana",
        dayLabel: "Tuesday, September 29",
        addresses: ["1 Elm St, Austin"],
        portalUrl: "https://app.houndstack.com/portal/acme/tok",
      }),
    );
    expect(html).toContain("Tuesday, September 29");
    expect(html).toContain("1 Elm St, Austin");
    expect(html).toContain("https://app.houndstack.com/portal/acme/tok");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("the switch gates the send", () => {
  const nightly = readFileSync("src/routes/api/public/hooks/nightly.ts", "utf8");
  it("the nightly job reads the column and only sends when it is on", () => {
    expect(nightly).toMatch(/notify_email_visit_reminder/);
    expect(nightly).toMatch(
      /if \(org\.notify_email_visit_reminder\)\s*\{[\s\S]{0,200}sendVisitReminderEmails/,
    );
  });
  it("the owner can see and change it", () => {
    const page = readFileSync("src/routes/_authenticated/settings.emails.tsx", "utf8");
    const fns = readFileSync("src/lib/email-settings.functions.ts", "utf8");
    expect(page).toMatch(/key: "notify_email_visit_reminder"/);
    expect(fns.match(/notify_email_visit_reminder/g)?.length).toBe(2);
  });
});
