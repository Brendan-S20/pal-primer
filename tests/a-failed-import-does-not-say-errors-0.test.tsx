// #926: a failed import showed "Errors 0", which reads as a clean result.
// The tile now counts the rows that failed, or says the import stopped, and
// never makes a number up. #925: the "All imports" link is a 44px target on
// touch and scrolls into view clear of the sticky top bar.
import { beforeEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importErrorsTile } from "@/lib/import-status";

const state = vi.hoisted(() => ({
  status: "failed",
  warnings: [] as string[],
  stats: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ batchId: "batch" }),
  }),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
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
        stats: { ...state.stats, warnings: state.warnings },
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

const errorsTile = (html: string) => {
  const at = html.indexOf('data-stat="errors"');
  expect(at, "the Errors tile is on the page").toBeGreaterThan(-1);
  const tile = html.slice(html.indexOf(">", at) + 1, html.indexOf("</div></div>", at));
  return tile
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

beforeEach(() => {
  state.status = "failed";
  state.warnings = [];
  state.stats = {};
});

it("says Stopped, not 0, when a failed import has no row to blame", () => {
  state.stats = { total: 1, create: 1, created: 1, failed: 0, errors: 0 };
  const tile = errorsTile(page());
  expect(tile).toContain("Stopped");
  expect(tile).not.toMatch(/Errors 0\b/);
  // And the reason is still on the page, where the tile points.
  expect(page()).toContain("The import stopped after the plan was created.");
});

it("says Stopped when a failed import saved no stats at all", () => {
  state.stats = {};
  expect(errorsTile(page())).toContain("Stopped");
});

it("counts the rows a failed import refused, commit and preview together", () => {
  state.stats = { total: 6, create: 6, created: 2, failed: 3, errors: 1 };
  const tile = errorsTile(page());
  expect(tile).toBe("Errors 4");
});

it("leaves a committed import's Errors as the preview's count, 0 included", () => {
  state.status = "committed";
  state.stats = { total: 1, create: 1, created: 1, failed: 0, errors: 0 };
  expect(errorsTile(page())).toBe("Errors 0");
  state.stats = { total: 3, create: 2, created: 2, failed: 1, errors: 1 };
  expect(errorsTile(page())).toBe("Errors 1");
});

it("decides the tile the same way on its own", () => {
  expect(importErrorsTile("failed", { failed: 0, errors: 0 })).toEqual({ kind: "stopped" });
  expect(importErrorsTile("failed", null)).toEqual({ kind: "stopped" });
  expect(importErrorsTile("failed", { failed: "3" })).toEqual({ kind: "stopped" });
  expect(importErrorsTile("failed", { failed: 2, errors: 1 })).toEqual({ kind: "count", count: 3 });
  expect(importErrorsTile("previewing", { errors: 5, failed: 9 })).toEqual({
    kind: "count",
    count: 5,
  });
  expect(importErrorsTile("committed", {})).toEqual({ kind: "count", count: 0 });
});

it("gives All imports a 44px touch target that scrolls clear of the top bar (#925)", () => {
  state.stats = { total: 1 };
  const link = page().match(/<a href="\/imports"[^>]*>← All imports<\/a>/);
  expect(link, "the back link renders").not.toBeNull();
  expect(link![0]).toContain("touch:min-h-11");
  expect(link![0]).toContain("inline-flex");
  expect(link![0]).toMatch(
    /scroll-mt-\[calc\(var\(--hs-banner-h,0px\)\+env\(safe-area-inset-top\)\+4rem\)\]/,
  );
});
