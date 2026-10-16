// A walk report is not a cleanup email, and a cleanup email did not change.
//
// #410: for a dog walk the completion email becomes a walk report: who walked
// which dogs, when, for how long, pee and poo when the walker recorded them,
// and the walker's note for the client. For every other visit the email and
// the push are exactly what they were. The second half is pinned against a
// frozen copy of the template from before walks existed
// (tests/support/fixtures/visit-completed-before-walks.tsx), rendered with
// the same props, so "exactly" means byte for byte.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { template as before } from "./support/fixtures/visit-completed-before-walks";
import { walkReportEmail, WALK_PUSH_BODY } from "@/lib/walk-report";

const now = TEMPLATES["visit-completed"];

const PET_WASTE_PROPS: Record<string, unknown>[] = [
  {},
  { orgName: "Acme Scoop Co.", clientName: "Jane", visitDate: "Mon, Sep 28" },
  {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    visitDate: "Mon, Sep 28",
    address: "123 Main St, Austin",
    photoUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
    gatePhotoUrl: "https://example.com/gate.jpg",
    checklist: ["All areas walked", "Gate latched"],
    orgPhone: "(512) 555-0100",
    orgEmail: "hi@acme.test",
  },
];

const walkProps = (over: Partial<Parameters<typeof walkReportEmail>[0]> = {}) => ({
  orgName: "Happy Paws",
  clientName: "Jane",
  visitDate: "Mon, Oct 19",
  address: "4417 N Ravenswood Ave",
  photoUrls: ["https://example.com/walk-1.jpg"],
  checklist: ["Water refreshed"],
  walk: walkReportEmail({
    startedAt: "2026-10-19T14:05:00Z",
    completedAt: "2026-10-19T14:37:00Z",
    timezone: "America/Chicago",
    pee: true,
    poo: false,
    reportNote: "Bella pulled toward the park and met a beagle.",
    dogNames: ["Bella", "Max"],
    walkerName: "Alejandra Villanueva",
    ...over,
  }),
});

describe("a pet-waste completion email", () => {
  it("renders exactly as it did before walks, for every shape of props", async () => {
    for (const props of PET_WASTE_PROPS) {
      const old = await render(React.createElement(before.component, props as any));
      const cur = await render(React.createElement(now.component, props as any));
      expect(cur).toBe(old);
      expect(now.subject(props)).toBe(before.subject(props));
    }
  });

  it("keeps its push", () => {
    const fn = readFileSync("src/lib/my-day.functions.ts", "utf8");
    // A sitting visit's push (#411) sits between the walk's and the cleanup's.
    expect(fn).toMatch(
      /title: walk \? walk\.push\.title : sit \? sit\.push\.title : "Visit completed"/,
    );
    expect(fn).toContain("`We just cleaned up at ${address}.`");
    expect(fn).toContain('"Your yard visit is complete."');
  });
});

describe("a walk's completion email", () => {
  it("is a walk report", async () => {
    const props = walkProps();
    const html = await render(React.createElement(now.component, props));
    expect(now.subject(props)).toBe("Happy Paws walked Bella and Max today");
    expect(html).toContain("Walk complete");
    expect(html).toContain("Alejandra from Happy Paws walked Bella and Max");
    // 14:05 and 14:37 UTC are 9:05 and 9:37 in Chicago in October.
    expect(html).toMatch(/Out from 9:05\s?AM to 9:37\s?AM, 32 minutes\./);
    expect(html).toContain("Pee: yes");
    expect(html).toContain("Poo: no");
    expect(html).toContain("Bella pulled toward the park and met a beagle.");
    expect(html).toContain("Water refreshed");
    expect(html).toContain("https://example.com/walk-1.jpg");
  });

  it("says nothing of cleaning up", async () => {
    const html = await render(React.createElement(now.component, walkProps()));
    expect(html).not.toMatch(/dirty work|cleaned up|yard visit/i);
    expect(WALK_PUSH_BODY).toBe("Your walk is done.");
  });

  it("leaves out what was not recorded", async () => {
    const props = walkProps({ startedAt: null, pee: null, poo: null, reportNote: "  " });
    const html = await render(React.createElement(now.component, props));
    expect(html).not.toContain("Pee:");
    expect(html).not.toContain("Poo:");
    expect(html).not.toContain("minutes");
    expect(html).not.toContain("A note from");
    expect(html).toMatch(/Back home at 9:37\s?AM\./);
  });

  it("says 'your dog' when no dog is on file, and never more than three photos", async () => {
    const props = {
      ...walkProps({ dogNames: [] }),
      photoUrls: ["1", "2", "3", "4"].map((n) => `https://example.com/p${n}.jpg`),
    };
    const html = await render(React.createElement(now.component, props));
    expect(now.subject(props)).toBe("Happy Paws walked your dog today");
    expect(html).toContain("p3.jpg");
    expect(html).not.toContain("p4.jpg");
  });
});

describe("the sender", () => {
  const fn = readFileSync("src/lib/my-day.functions.ts", "utf8");
  const server = readFileSync("src/lib/walk-report.server.ts", "utf8");

  it("asks for a walk report and passes it only when there is one", () => {
    expect(fn).toMatch(/walkCompletionFor\(data\.visitId\)/);
    expect(fn).toMatch(/\.\.\.\(walk \? \{ walk: walk\.email \} : \{\}\)/);
    expect(fn).toMatch(/body: walk\s*\? walk\.push\.body/);
  });

  it("is a walk report only for a dog-walking visit", () => {
    expect(server).toMatch(/service_line !== "dog_walking"\) return null/);
  });

  it("does not touch complete_visit or start_visit", () => {
    const mig = readFileSync(
      "supabase/migrations/20261015210000_a-walk-report-says-how-the-walk-went.sql",
      "utf8",
    );
    expect(mig).not.toMatch(/FUNCTION public\.(complete_visit|start_visit)/);
  });
});
