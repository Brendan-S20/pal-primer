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

const SWEEPGO =
  "In Sweep&Go, go to Clients > Residential Clients, open the three dots menu and choose Client List CSV. For commercial clients, go to Clients > Commercial Clients, open the three dots menu and export the client list or the locations list. Sweep&Go's help does not describe a dogs export or a balance export, so use the HoundStack template for those if you need them.";
// Since #857 the Jobber hint no longer asks the owner to add a frequency
// column: the Recurring jobs report has none, and each plan comes in paused
// for the owner to set. The balance comes from the client export itself.
const JOBBER =
  "In Jobber, go to Clients > More Actions > Export Clients and choose CSV. Jobber emails the file (up to 1,500 clients per file, admin users only). Upload it as it came: the service address, tags, internal notes and account balance all come through. For recurring services, export Insights > Reports > Recurring jobs report; it has no visit frequency column, so each plan comes in paused for you to set how often and turn on. Import clients first, then recurring services.";

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
