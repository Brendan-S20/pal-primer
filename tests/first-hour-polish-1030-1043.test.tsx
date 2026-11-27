// #1030 and #1043: small first-hour fixes. Each describe names its item.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { humanizeEnum, humanizeRole } from "@/lib/humanize";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

vi.mock("@/hooks/useServiceLineAvailability", () => ({
  useServiceLineAvailability: () => null,
}));

describe("#1030 item 6: the invite email says Technician, not tech", () => {
  it("labels the role with the app's own word", () => {
    expect(humanizeRole("tech")).toBe("Technician");
    expect(humanizeRole("office_manager")).toBe("Office manager");
    const src = read("src/lib/invite-email.server.ts");
    expect(src).toContain("humanizeRole(role)");
    expect(src).not.toContain('role.replace(/_/g, " ")');
  });
});

describe("#1030 item 8: the verify-email landing says so", () => {
  it("toasts once on ?verified=1 and takes the flag off the address", () => {
    const src = read("src/routes/_authenticated/dashboard.tsx");
    expect(src).toContain('searchParams.get("verified") !== "1"');
    expect(src).toContain('toast.success("Your email is verified.")');
    expect(src).toContain('searchParams.delete("verified")');
  });
});

describe("#1043 item 1: the service picker's hint is not an error", () => {
  it("does not say 'Choose at least one service' while one is ticked", async () => {
    const { ServiceLinesChoices } = await import("@/components/ServiceLinesChoices");
    const html = renderToStaticMarkup(
      <ServiceLinesChoices lines={["pet_waste"]} onChange={() => undefined} />,
    );
    expect(html).not.toContain("Choose at least one service");
    expect(html).toContain("At least one service stays ticked");
  });
});

describe("#1043 item 4: a dog's temperament is capitalised where it is shown", () => {
  it("humanizes 'unknown'", () => {
    expect(humanizeEnum("unknown")).toBe("Unknown");
    expect(read("src/components/client-detail/PropertiesTab.tsx")).toContain(
      'humanizeEnum(d.temperament ?? "unknown")',
    );
    expect(read("src/components/VisitDetailDrawer.tsx")).toContain("humanizeEnum(d.temperament)");
  });
});

describe("#1043 item 5: Add client's on-site contact label matches its neighbours", () => {
  it("is not an uppercase section label", () => {
    const src = read("src/routes/_authenticated/clients.new.tsx");
    const at = src.indexOf("On-site visit contact <span");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at - 140, at)).not.toContain("uppercase");
  });
});

describe("#1043 item 9: the Team card shows a skeleton, not bare 'Loading…'", () => {
  it("has no bare Loading… line", () => {
    const src = read("src/routes/_authenticated/settings.users.tsx");
    expect(src).not.toContain('>Loading…</p>');
    expect(src).toContain("Loading the team");
  });
});
