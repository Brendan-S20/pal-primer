// The navigation and phone/tablet half of the launch pass, held by rendering
// the pieces and reading the wiring. The browser half, at real widths and at
// the iPad sizes with touch on, is
// tests/viewports/one-list-for-the-evening-round.spec.ts.
//
//   * One Inbox for everything waiting on the office.
//   * One Reports entry, whose three pages are tabs of one area.
//   * The setup checklist on a phone shows the next step, not seven.
//   * Invoices on a phone come most-actionable first.
//   * Schedule lanes at tablet width stack rather than squeeze the tech's name.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let pathname = "/reports";
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string; [k: string]: unknown }) => (
    <a
      href={to}
      aria-current={rest["aria-current"] as "page" | undefined}
      className={rest.className as string}
    >
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname } }),
}));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@/lib/onboarding.functions", () => ({
  getOnboardingStatus: vi.fn(),
  dismissOnboarding: vi.fn(),
}));

import { OnboardingChecklist, stepVisibility } from "@/components/OnboardingChecklist";
import { ReportsNav, REPORT_PATHS } from "@/components/ReportsNav";
import { byWhatNeedsDoing, invoiceActionRank } from "@/lib/invoice-order";
import { canAccess, ROUTE_ROLES, type AppRole } from "@/hooks/useMyRole";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function render(node: ReactNode, seed: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}
const asRole = (role: AppRole) => (qc: QueryClient) =>
  qc.setQueryData(["my-org"], { organization: { id: "org", role } });

describe("the setup checklist on a phone", () => {
  const steps = [
    { id: "a", done: true },
    { id: "b", done: false },
    { id: "c", done: false },
    { id: "d", done: true },
  ];

  it("folded: finished steps hidden, the next one shown, the rest only at a desk", () => {
    expect(stepVisibility(steps, false)).toEqual({
      a: "hidden",
      b: "shown",
      c: "desktop-only",
      d: "hidden",
    });
  });

  it("opened: everything, finished ones included", () => {
    expect(Object.values(stepVisibility(steps, true))).toEqual([
      "shown",
      "shown",
      "shown",
      "shown",
    ]);
  });

  it("renders that way, with a way to open the rest", () => {
    const html = render(<OnboardingChecklist />, (qc) => {
      asRole("owner")(qc);
      qc.setQueryData(["onboarding-status"], {
        completed: 2,
        total: 4,
        dismissed: false,
        steps: steps.map((s) => ({
          ...s,
          label: `Step ${s.id}`,
          description: "",
          to: "/x",
          cta: "Do it",
        })),
      });
    });
    const li = (id: string) => html.match(new RegExp(`<li data-step="${id}" class="([^"]*)"`))![1];
    expect(li("a")).toMatch(/(^| )hidden( |$)/);
    expect(li("d")).toMatch(/(^| )hidden( |$)/);
    expect(li("b")).not.toMatch(/hidden/);
    expect(li("c")).toMatch(/max-md:hidden/);
    expect(html).toContain("Show all 4 steps");
    expect(html).toContain('aria-label="Dismiss the setup checklist"');
  });
});

describe("invoices on a phone, most actionable first", () => {
  const today = "2026-10-02";
  const rows = [
    { id: "paid-new", status: "paid", due_on: "2026-09-30" },
    { id: "open-later", status: "open", due_on: "2026-10-09" },
    { id: "void", status: "void", due_on: "2026-09-01" },
    { id: "overdue", status: "open", due_on: "2026-09-20" },
    { id: "draft", status: "draft", due_on: null },
    { id: "open-today", status: "open", due_on: "2026-10-02" },
  ];

  it("overdue, then open, then draft, then paid, then void", () => {
    expect(byWhatNeedsDoing(rows, today).map((r) => r.id)).toEqual([
      "overdue",
      "open-later",
      "open-today",
      "draft",
      "paid-new",
      "void",
    ]);
  });

  it("an invoice due today is not overdue yet, on the org's day", () => {
    expect(invoiceActionRank({ status: "open", due_on: today }, today)).toBe(1);
    expect(invoiceActionRank({ status: "open", due_on: "2026-10-01" }, today)).toBe(0);
  });

  it("drives the phone's cards and only them; the table keeps its order", () => {
    const page = read("src/routes/_authenticated/invoices.index.tsx");
    expect(page).toMatch(/byWhatNeedsDoing\(filtered, orgTodayIso\)/);
    expect(page).toMatch(/\{phoneOrder\.map\(\(inv\) => \(\s*<InvoiceCard/);
    expect(page).toMatch(/\{filtered\.map\(\(inv\) => \(\s*<InvoiceRow/);
    expect(page).toMatch(/<div className="max-md:order-first">\s*<NewInvoiceDialog \/>/);
  });
});

describe("one Reports area", () => {
  // Read as source: importing the sidebar pulls in its server functions.
  const sidebar = read("src/components/AppSidebar.tsx");

  it("the sidebar has one Reports entry, highlighted on all three pages", () => {
    expect(sidebar).not.toMatch(/url: "\/analytics"/);
    expect(sidebar).not.toMatch(/url: "\/tax-reports"/);
    expect(sidebar).toMatch(
      /\{ title: "Reports", url: "\/reports", icon: BarChart3, alsoActiveOn: REPORT_PATHS \}/,
    );
    expect(sidebar).toMatch(/isActive\(item\.url\) \|\| !!item\.alsoActiveOn\?\.some/);
    expect(REPORT_PATHS).toEqual(["/reports", "/analytics", "/tax-reports"]);
  });

  it("each of the three pages opens with the tabs", () => {
    for (const f of ["reports", "analytics", "tax-reports"]) {
      expect(read(`src/routes/_authenticated/${f}.tsx`), f).toMatch(/<ReportsNav \/>/);
    }
  });

  it("renders the three tabs and marks the open one", () => {
    pathname = "/analytics";
    const html = render(<ReportsNav />, asRole("owner"));
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toMatch(/<a href="\/analytics" aria-current="page"/);
    expect(html).not.toMatch(/<a href="\/reports" aria-current/);
    expect(html).toMatch(/touch:min-h-11/);
    expect(html).toMatch(/overflow-x-auto/);
  });

  it("draws nothing for a role that can open none of them", () => {
    expect(render(<ReportsNav />, asRole("dispatcher"))).toBe("");
  });
});

describe("one Inbox", () => {
  it("is in the nav for the office, and not for a technician", () => {
    const sidebar = read("src/components/AppSidebar.tsx");
    const overview = sidebar.slice(
      sidebar.indexOf('label: "Overview"'),
      sidebar.indexOf('label: "Operations"'),
    );
    expect([...overview.matchAll(/url: "([^"]+)"/g)].map((m) => m[1])).toEqual([
      "/dashboard",
      "/inbox",
      "/leads",
    ]);
    expect(ROUTE_ROLES["/inbox"]).toEqual(["owner", "office_manager", "dispatcher"]);
    expect(canAccess("tech", "/inbox")).toBe(false);
  });

  it("counts a conversation as waiting only when the client spoke last", async () => {
    const { threadsAwaitingReply } = await import("@/lib/inbox");
    expect(
      threadsAwaitingReply([
        { id: 1, direction: "inbound" },
        { id: 2, direction: "outbound" },
      ]).map((t) => t.id),
    ).toEqual([1]);
  });

  it("reads each list under the key its own page uses, so the two cannot disagree", () => {
    const inbox = read("src/routes/_authenticated/inbox.tsx");
    for (const key of [
      '["message-threads"]',
      '["review-queue", "count"]',
      '["disputes"]',
      '["notifications"]',
    ]) {
      expect(inbox).toContain(`queryKey: ${key}`);
    }
    // and draws a section only for a role that can open the page behind it
    for (const path of ["/messages", "/concerns", "/review", "/disputes"]) {
      expect(inbox).toContain(`can("${path}") && (`);
    }
  });
});

describe("Schedule lanes at tablet width", () => {
  const routes = read("src/routes/_authenticated/routes.tsx");
  it("stack below 32rem of board instead of splitting it into two narrow lanes", () => {
    expect(routes).toMatch(/@min-\[32rem\]:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4/);
    expect(routes).not.toMatch(/@md:grid-cols-2/);
  });
  it("wrap the lane controls under the name rather than truncating the name", () => {
    expect(routes).toMatch(
      /data-lane-header\s+className="flex flex-wrap items-center justify-between/,
    );
    expect(routes).toMatch(/<div className="min-w-0 flex-\[1_1_9rem\]">/);
  });
});
