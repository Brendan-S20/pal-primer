// #894: a plan can be imported while its client's billing update fails.
// The saved warning must stay visible after the owner reloads the result.
import { beforeEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
  status: "committed",
  warnings: ["Billing frequency was not changed for Priya Sample: billing update refused."],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ batchId: "batch" }),
  }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => () => undefined,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
  useQuery: () => ({
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: {
      batch: {
        id: "batch",
        status: state.status,
        entity: "services",
        source: "jobber",
        created_at: "2026-11-12T12:00:00Z",
        error: state.status === "failed" ? "The import stopped after the plan was created." : null,
        stats: { total: 1, create: 1, created: 1, failed: 0, warnings: state.warnings },
      },
      rows: [],
      retryBlock: "Some rows went in before this import stopped.",
      undoBlock: null,
    },
  }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/imports.functions", () => ({
  getImportBatch: vi.fn(),
  commitImport: vi.fn(),
  cancelImport: vi.fn(),
  retryImport: vi.fn(),
  undoImport: vi.fn(),
  IMPORT_SOURCE_LABELS: { jobber: "Jobber" },
}));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgTimezone: () => "America/Detroit" }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock("@/lib/client-book-queries", () => ({ afterClientBookChanged: vi.fn() }));

const { Route } = await import("@/routes/_authenticated/imports.$batchId");
const route = Route as unknown as { options: { component: () => ReactNode } };
const page = () => renderToStaticMarkup(createElement(route.options.component));

beforeEach(() => {
  state.status = "committed";
  state.warnings = ["Billing frequency was not changed for Priya Sample: billing update refused."];
});

it.each(["committed", "failed"])("shows the saved billing warning on a %s import", (status) => {
  state.status = status;
  const html = page();
  expect(html).toContain('role="alert" aria-label="Import warnings"');
  expect(html).toContain(`<li>${state.warnings[0]}</li>`);
  expect(html).toContain("Check these import warnings");
  if (status === "committed") expect(html).toContain("Import committed:");
  else expect(html).toContain("The import stopped after the plan was created.");
});

it("does not show a warning panel for a batch with no warnings", () => {
  state.warnings = [];
  expect(page()).not.toContain('aria-label="Import warnings"');
});
