// @vitest-environment happy-dom
// #1043-3: Invoicing saves on a button, and leaving with unsaved changes said
// nothing. Run in a real router, because the guard is the router's.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, Suspense, type ComponentType, type ReactNode } from "react";

vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-start")>()),
  useServerFn: (f: unknown) => f,
}));
vi.mock("@/lib/automation.functions", () => ({
  getAutomationSettings: async () => ({
    auto_invoice_enabled: true,
    invoice_net_days: 15,
    invoice_grace_days: 3,
  }),
  updateAutomationSettings: async () => ({}),
}));
vi.mock("@/lib/sales-tax.functions", () => ({
  getSalesTaxSettings: async () => ({ rateBps: 0, label: "Sales tax" }),
  updateSalesTaxSettings: async () => ({}),
}));

import { Route as Invoicing } from "@/routes/_authenticated/settings.invoicing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Rendered with react-dom into the document; these are the few queries needed.
const roots: { root: Root; el: HTMLElement }[] = [];
async function render(node: ReactNode) {
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  roots.push({ root, el });
  await act(async () => root.render(node));
}
async function unmountAll() {
  for (const { root, el } of roots.splice(0)) {
    await act(async () => root.unmount());
    el.remove();
  }
  document.body.innerHTML = "";
}
const tick = () => act(() => new Promise<void>((r) => setTimeout(r, 10)));
async function until(check: () => unknown) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out; the page reads: ${document.body.textContent}`);
}
const reads = (text: string) => (document.body.textContent ?? "").includes(text);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const click = async (el: Element | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
};

afterEach(unmountAll);

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
async function type(id: string, value: string) {
  const el = input(id);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const Page = Invoicing.options.component as ComponentType;
  const page = createRoute({
    getParentRoute: () => root,
    path: "/settings/invoicing",
    component: () => (
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    ),
  });
  const other = createRoute({
    getParentRoute: () => root,
    path: "/dashboard",
    component: () => <p>The dashboard</p>,
  });
  const billing = createRoute({
    getParentRoute: () => root,
    path: "/settings/billing",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, other, billing]),
    history: createMemoryHistory({ initialEntries: ["/settings/invoicing"] }),
  });
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await until(() => input("netdays") && input("taxrate"));
  return router;
}

const leave = (router: { navigate: (o: never) => Promise<unknown> }) =>
  act(async () => {
    void router.navigate({ to: "/dashboard" } as never);
  });

describe("leaving Settings, Invoicing", () => {
  it("goes straight through when nothing changed", async () => {
    const router = await open();
    expect(reads("Unsaved changes")).toBe(false);
    await leave(router as never);
    await until(() => reads("The dashboard"));
    expect(reads("Leave without saving?")).toBe(false);
  });

  it("asks when the net terms were not saved, and stays when told to", async () => {
    const router = await open();
    await type("netdays", "30");
    await until(() => reads("Unsaved changes"));
    await leave(router as never);
    await until(() => reads("Leave without saving?"));
    await click(button("Stay on this page"));
    await until(() => !reads("Leave without saving?"));
    expect(router.state.location.pathname).toBe("/settings/invoicing");
    expect(input("netdays").value).toBe("30");
  });

  it("asks for an unsaved sales tax rate too, and leaves when told to", async () => {
    const router = await open();
    await type("taxrate", "6");
    await until(() => reads("Unsaved changes"));
    await leave(router as never);
    await until(() => reads("Leave without saving?"));
    await click(button("Leave without saving"));
    await until(() => reads("The dashboard"));
  });

  it("does not ask once a field is typed back to what is saved", async () => {
    const router = await open();
    await type("taxrate", "6");
    await until(() => reads("Unsaved changes"));
    await type("taxrate", "0.00");
    await until(() => !reads("Unsaved changes"));
    await leave(router as never);
    await until(() => reads("The dashboard"));
  });
});
