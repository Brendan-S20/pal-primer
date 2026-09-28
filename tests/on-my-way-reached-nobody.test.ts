// "On my way" reached nobody.
//
// It was a text a tech sent from "More options", with no name and no time,
// and it refused every client with no texting consent on file, which on day
// one is every imported client. Now it names the tech, gives the arrival
// window when there is an honest one, goes by email when a text cannot, and
// can be sent for the tech when they tap Navigate.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { etaPhrase, onMyWayText, shouldSendOnNavigate, techFirstName } from "@/lib/on-my-way";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const TZ = "America/Chicago";
// 10:00 AM Chicago on Sep 28 (CDT, UTC-5).
const NOW = new Date("2026-09-28T15:00:00Z");

describe("what it says", () => {
  it("names the tech by first name", () => {
    expect(techFirstName("Sam Rivera")).toBe("Sam");
    expect(techFirstName("  Priya  ")).toBe("Priya");
    expect(techFirstName("")).toBeNull();
    expect(techFirstName(null)).toBeNull();
  });

  it("gives a window that has not started as a window", () => {
    expect(etaPhrase("2026-09-28T15:15:00Z", "2026-09-28T15:45:00Z", TZ, NOW)).toBe(
      "between 10:15 AM and 10:45 AM",
    );
  });

  it("gives a window already under way as its end", () => {
    expect(etaPhrase("2026-09-28T14:45:00Z", "2026-09-28T15:30:00Z", TZ, NOW)).toBe("by 10:30 AM");
  });

  it("says nothing about a window that has passed", () => {
    // Telling a customer "between 9:00 and 9:30" at 10:00 is worse than silence.
    expect(etaPhrase("2026-09-28T14:00:00Z", "2026-09-28T14:30:00Z", TZ, NOW)).toBeNull();
    expect(etaPhrase(null, null, TZ, NOW)).toBeNull();
    expect(etaPhrase("not a date", null, TZ, NOW)).toBeNull();
  });

  it("reads on the org's clock, not the server's", () => {
    expect(etaPhrase("2026-09-28T15:15:00Z", null, "America/Los_Angeles", NOW)).toBe(
      "around 8:15 AM",
    );
  });

  it("puts the business in the text, because the number is the platform's", () => {
    expect(
      onMyWayText({
        customerName: "Jane",
        orgName: "Acme Scoop",
        techName: "Sam",
        eta: "by 10:30 AM",
      }),
    ).toBe(
      "Hi Jane, Sam from Acme Scoop is on the way for today's visit, arriving by 10:30 AM. Reply STOP to opt out.",
    );
    expect(
      onMyWayText({ customerName: "Jane", orgName: "Acme Scoop", techName: null, eta: null }),
    ).toBe("Hi Jane, your Acme Scoop tech is on the way for today's visit. Reply STOP to opt out.");
  });

  it("has an email for when it cannot be texted", async () => {
    const html = await render(
      React.createElement(TEMPLATES["on-my-way"].component, {
        orgName: "Acme Scoop",
        clientName: "Jane",
        techName: "Sam",
        eta: "between 10:15 AM and 10:45 AM",
      }),
    );
    expect(html).toContain("Sam from Acme Scoop");
    expect(html).toContain("between 10:15 AM and 10:45 AM");
    const subject = TEMPLATES["on-my-way"].subject as (d: Record<string, unknown>) => string;
    expect(subject({ techName: "Sam", eta: "by 10:30 AM" })).toBe(
      "Sam is on the way, arriving by 10:30 AM",
    );
  });
});

describe("when Navigate sends it", () => {
  const base = {
    enabled: true,
    status: "scheduled",
    scheduledOn: "2026-09-28",
    orgToday: "2026-09-28",
    sentAt: null,
  };

  it("sends for today's unstarted stop when the owner turned it on", () => {
    expect(shouldSendOnNavigate(base)).toEqual({ send: true });
  });

  it("sends once per visit", () => {
    expect(shouldSendOnNavigate({ ...base, sentAt: "2026-09-28T14:00:00Z" })).toEqual({
      send: false,
      reason: "already_sent",
    });
  });

  it("does not send for tomorrow's stop, a started one, or with the setting off", () => {
    expect(shouldSendOnNavigate({ ...base, scheduledOn: "2026-09-29" }).send).toBe(false);
    expect(shouldSendOnNavigate({ ...base, status: "in_progress" }).send).toBe(false);
    expect(shouldSendOnNavigate({ ...base, enabled: false }).send).toBe(false);
  });
});

describe("the wiring", () => {
  const server = read("src/lib/on-my-way.server.ts");
  const myDay = read("src/routes/_authenticated/my-day.tsx");

  it("falls through to email on every SMS refusal", () => {
    const sms = server.slice(server.indexOf("async function trySms"));
    for (const reason of [
      "turned off",
      "no phone",
      "opted out",
      "on hold",
      "no consent",
      "no sender",
      "carrier refused",
    ]) {
      expect(sms, reason).toContain(`"${reason}"`);
    }
    expect(server).toMatch(/if \(sms\.ok\) \{[\s\S]*?\} else \{[\s\S]*?templateName: "on-my-way"/);
  });

  it("stamps the visit, with the service role, only when something went", () => {
    expect(server).toMatch(/if \(result\.sent\) \{[\s\S]*?supabaseAdmin[\s\S]*?on_my_way_sent_at/);
  });

  it("is sent from Navigate, and never queued offline", () => {
    expect(myDay).toMatch(/onClick=\{announceOnNavigate\}/);
    const fn = myDay.slice(
      myDay.indexOf("const announceOnNavigate"),
      myDay.indexOf("const sms = useMutation"),
    );
    expect(fn).toMatch(/navigator\.onLine === false\) return;/);
    expect(fn).toMatch(/trigger: "navigate"/);
    expect(fn).not.toMatch(/runOrQueue/);
  });

  it("offers the button whether or not the client has a phone", () => {
    const i = myDay.indexOf("Send &ldquo;on my way&rdquo;");
    expect(i).toBeGreaterThan(-1);
    const before = myDay.slice(i - 600, i);
    expect(before).toMatch(/onMyWay\.mutate\(\)/);
    expect(before).not.toMatch(/primary_phone && \(\s*<Button[\s\S]*onMyWay/);
  });

  it("has one wording, so the old SMS kind is gone", () => {
    const msgs = read("src/lib/messages.functions.ts");
    expect(msgs).not.toMatch(/your tech is on the way/);
    expect(msgs).toMatch(/kind: z\.enum\(\["reminder", "completed"\]\)/);
  });

  it("is off for businesses that existed, and on for new ones", () => {
    const mig = read("supabase/migrations/20260928160000_on-my-way-reached-nobody.sql");
    expect(mig).toMatch(/notify_email_on_my_way boolean NOT NULL DEFAULT true/);
    expect(mig).toMatch(/on_my_way_on_navigate boolean NOT NULL DEFAULT true/);
    expect(mig).toMatch(/SET notify_email_on_my_way = false,\s*on_my_way_on_navigate = false;/);
  });
});
