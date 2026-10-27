// A completed visit can be reopened, or marked missed, from the client's
// Visits tab (#532).
//
// The shared visit drawer (dashboard, schedule board) had Reopen and Mark
// missed; the client's Visits tab popup, a different component, did not. Both
// now draw CompletedVisitActions. This pins the role rule, the confirm, the
// billing refusal and that both popups use the one component.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const perms = vi.hoisted(() => ({ role: "owner" as string | null, canBill: true }));
vi.mock("@/hooks/useMyRole", () => ({
  usePermissions: () => ({
    can: (p: string) => (p === "manage_client_billing" ? perms.canBill : false),
    role: perms.role,
    loading: false,
  }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/visits.functions", () => ({
  reopenVisitFromOffice: vi.fn(),
  markVisitMissedFromOffice: vi.fn(),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

const {
  CompletedVisitActions,
  COMPLETED_VISIT_CONFIRM,
  canChangeCompletedVisit,
  runCompletedVisitAction,
} = await import("@/components/CompletedVisitActions");

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function draw(role: string | null, canBill: boolean, status = "completed") {
  perms.role = role;
  perms.canBill = canBill;
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CompletedVisitActions, { visit: { id: "v1", status } }),
      ),
    );
  } finally {
    client.clear();
  }
}

describe("who sees Reopen and Mark missed", () => {
  it("owner and office manager (manage_client_billing) see both", () => {
    for (const role of ["owner", "office_manager"]) {
      const html = draw(role, true);
      expect(html).toMatch(/>Reopen</);
      expect(html).toMatch(/>Mark missed</);
    }
  });

  it("a dispatcher sees both, as on the shared drawer and the server", () => {
    const html = draw("dispatcher", false);
    expect(html).toMatch(/>Reopen</);
    expect(html).toMatch(/>Mark missed</);
    expect(canChangeCompletedVisit("dispatcher", false)).toBe(true);
  });

  it("anyone else gets the permission note and no buttons", () => {
    const html = draw("tech", false);
    expect(html).not.toMatch(/>Reopen</);
    expect(html).not.toMatch(/>Mark missed</);
    expect(html).toContain("You do not have permission to change this completed visit.");
    expect(canChangeCompletedVisit(null, false)).toBe(false);
  });

  it("draws nothing on a visit that is not completed", () => {
    for (const status of ["scheduled", "in_progress", "missed", "skipped"]) {
      expect(draw("owner", true, status)).toBe("");
    }
  });

  it("matches the server's role list", () => {
    expect(read("src/lib/visits.functions.ts")).toContain(
      '["owner", "office_manager", "dispatcher"].includes(caller.role)',
    );
  });
});

describe("what pressing them does", () => {
  const fns = () => ({
    reopen: vi.fn(async () => ({ ok: true })),
    markMissed: vi.fn(async () => ({ ok: true })),
  });

  it("asks first, and the question says what happens to billing", async () => {
    for (const action of ["reopen", "missed"] as const) {
      expect(String(COMPLETED_VISIT_CONFIRM[action].description)).toMatch(
        /not billed unless it is completed again/,
      );
    }
    const f = fns();
    const confirm = vi.fn(async () => false);
    const r = await runCompletedVisitAction({
      action: "reopen",
      visitId: "v1",
      code: null,
      confirm,
      ...f,
    });
    expect(confirm).toHaveBeenCalledWith(COMPLETED_VISIT_CONFIRM.reopen);
    expect(r).toEqual({ status: "canceled" });
    expect(f.reopen).not.toHaveBeenCalled();
  });

  it("reopen calls reopenVisitFromOffice; missed calls markVisitMissedFromOffice with the code", async () => {
    const f = fns();
    const confirm = vi.fn(async () => true);
    expect(
      await runCompletedVisitAction({ action: "reopen", visitId: "v1", code: null, confirm, ...f }),
    ).toEqual({ status: "done", message: "Visit reopened" });
    expect(f.reopen).toHaveBeenCalledWith({ data: { visitId: "v1" } });

    expect(
      await runCompletedVisitAction({
        action: "missed",
        visitId: "v1",
        code: "weather",
        confirm,
        ...f,
      }),
    ).toEqual({ status: "done", message: "Visit marked missed" });
    expect(f.markMissed).toHaveBeenCalledWith({ data: { visitId: "v1", code: "weather" } });
  });

  it("an invoiced visit is refused with the server's own message", async () => {
    const blocker =
      "This visit is already on invoice INV-1034. Void or remove that invoice line before changing the visit status.";
    for (const action of ["reopen", "missed"] as const) {
      const f = {
        reopen: vi.fn(async () => {
          throw new Error(blocker);
        }),
        markMissed: vi.fn(async () => {
          throw new Error(blocker);
        }),
      };
      const r = await runCompletedVisitAction({
        action,
        visitId: "v1",
        code: null,
        confirm: async () => true,
        ...f,
      });
      expect(r).toEqual({ status: "refused", message: blocker });
    }
  });
});

describe("both popups draw the one component", () => {
  const tab = read("src/components/client-detail/VisitsTab.tsx");
  const drawer = read("src/components/VisitDetailDrawer.tsx");
  const own = read("src/components/CompletedVisitActions.tsx");

  it("the client Visits tab and the shared drawer use CompletedVisitActions", () => {
    expect(tab).toMatch(/<CompletedVisitActions visit=\{v\} \/>/);
    expect(drawer).toMatch(/<CompletedVisitActions visit=\{v\} \/>/);
  });

  it("neither keeps a copy of the server calls", () => {
    for (const src of [tab, drawer]) {
      expect(src).not.toMatch(/reopenVisitFromOffice|markVisitMissedFromOffice/);
    }
  });

  it("the Visits tab reads its open visit from the list, so the new status shows in place", () => {
    expect(tab).toMatch(/visits\.find\(\(x\) => x\.id === detailVisitId\)/);
  });

  it("speaks of a visit, never a service", () => {
    const words = own.replace(/\/\/.*$/gm, "");
    expect(words).not.toMatch(/\b(walk|stay|overnight|groom|lesson|scoop|cleanup|drop.in)s?\b/i);
  });
});
