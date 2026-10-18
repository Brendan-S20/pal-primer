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
const JOBBER =
  "In Jobber, go to Clients > More Actions > Export Clients and choose CSV. Jobber emails the file (up to 1,500 clients per file, admin users only). For recurring services, export Insights > Reports > Recurring jobs report; it has no visit frequency column, so add one. For opening balances, export Insights > Reports > Client Balance Summary. Import clients first, then recurring services, then opening balances.";

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
    ]) {
      expect(src, `${FILE} still says "${old}"`).not.toContain(old);
    }
  });
});
