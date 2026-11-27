// The import page tells a Sweep&Go or Jobber owner where to find their export.
// Until #490 both hints named menus neither vendor's help center describes
// ("Settings → Data Export", "Gear icon → Imports & Exports → Export Data").
// These pin the paths the vendors documented on 2026-10-17.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const FILE = "src/routes/_authenticated/imports.index.tsx";
const src = readFileSync(join(ROOT, FILE), "utf8");

// Since #1069 the Sweep&Go hint follows a real export (trial, 2026-11-27):
// the Client List CSV and Billing > Residential Subscriptions.
const SWEEPGO =
  "In Sweep&Go, go to Clients > Residential Clients, open the three dots menu and choose Client List CSV. Upload it as it came: the name, cell phone (or home phone), email, status, referral source and the address all come through. For recurring services, open Billing > Residential Subscriptions, add Canceled to the status filter if you like, and choose CSV: the plan, its dogs and how often (\"2d-1xW\"), the price per cleanup and the start and end dates come through, and canceled plans are refused with the reason. Sweep&Go's exports have no dogs' names, gate codes or last visit, so add those by hand. Every plan comes in paused for you to check and turn on. Import clients first, then recurring services.";
// Since #857 the Jobber hint no longer asks the owner to add a frequency
// column. A real Recurring jobs report (Jobber trial, 2026-11-27) does have
// "Visit frequency", and the Visits report adds the last and next visit.
// The balance comes from the client export itself.
const JOBBER =
  "In Jobber, go to Clients > More Actions > Export Clients and choose CSV. Jobber emails the file (up to 1,500 clients per file, admin users only). Upload it as it came: the service address, tags, internal notes and account balance all come through. For recurring services, export Insights > Reports > Recurring jobs with All Columns: how often, the price per visit and the start date come through. Add the Visits report too and each plan also gets its last and next visit. Plans billed as a fixed price are refused, since Jobber's total for them is per billing period, not per visit. Every plan comes in paused for you to check and turn on. Import clients first, then recurring services.";

describe("import hints name menus the vendors document", () => {
  it("shows the documented Sweep&Go and Jobber paths word for word", () => {
    expect(src).toContain(`sweepgo: ${JSON.stringify(SWEEPGO)}`);
    expect(src).toContain(`jobber: ${JSON.stringify(JOBBER)}`);
  });

  it("no longer names the undocumented menus", () => {
    for (const old of [
      "Settings → Data Export",
      "Customers, Locations, and Pets",
      "Imports & Exports → Export Data",
      "Admin → Data → Export Clients",
      "so add one",
    ]) {
      expect(src, `${FILE} still says "${old}"`).not.toContain(old);
    }
  });
});
