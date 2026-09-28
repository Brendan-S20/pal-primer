import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";

// The "Visit complete" email told a customer their visit happened "on
// 2026-09-28", the database's spelling of the date, and its template has
// always been able to show up to three photos while the only sender passed
// none, so the completion photo a tech is required to take never reached the
// customer it proves the work to. Found 2026-09-28 while scoping a
// gate-latched photo.

const sender = readFileSync("src/lib/my-day.functions.ts", "utf8");
const payload = sender.slice(sender.indexOf('templateName: "visit-completed"'));
const templateData = payload.slice(payload.indexOf("templateData:"), payload.indexOf("});"));

describe("the sender", () => {
  it("formats the date for a person", () => {
    expect(templateData).toMatch(/visitDate: formatDay\(v\.scheduled_on\)/);
  });

  it("passes the completion photos, signed, from the private bucket", () => {
    expect(templateData).toMatch(/photoUrls/);
    expect(sender).toMatch(/\.from\("visit-photos"\)\s*\.createSignedUrls\(paths,/);
    expect(sender).toMatch(/\.eq\("kind", "completion"\)/);
  });
});

describe("the template", () => {
  it("draws the photos it is given", async () => {
    const html = await render(
      React.createElement(TEMPLATES["visit-completed"].component, {
        orgName: "Acme Scoop Co.",
        visitDate: "Mon, Sep 28",
        photoUrls: ["https://example.com/signed/photo-1.jpg"],
      }),
    );
    expect(html).toContain("https://example.com/signed/photo-1.jpg");
    expect(html).toContain("on Mon, Sep 28");
  });
});
