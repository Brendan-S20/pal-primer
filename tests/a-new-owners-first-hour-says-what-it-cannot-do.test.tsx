// @vitest-environment happy-dom
// #1065, three first-hour moments from the Nov 27 QA run: a property-outline
// map that stayed a blank grey box, an invoice that said "Scheduled to send"
// to a client with no email, and an invite toast lying over the header search.
/* eslint-disable @typescript-eslint/no-explicit-any -- module mocks stand in for router and server-fn types */
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeGoogleMaps } from "./support/fake-google-maps";

const maps = vi.hoisted(() => ({ renderer: null as any }));
vi.mock("@/lib/maps/use-map-renderer", () => ({ useMapRenderer: () => maps.renderer }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: any) => ({
    options,
    useSearch: () => ({}),
    useParams: () => ({ invoiceId: "inv-1" }),
  }),
  Link: ({ children, to, params, search }: any) =>
    createElement(
      "a",
      {
        "data-to": to,
        "data-params": JSON.stringify(params),
        "data-search": JSON.stringify(search),
      },
      children,
    ),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: any) => fn,
  useServerFn: (f: any) => f,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: () => b,
      validator: () => b,
      handler: () => vi.fn(async () => ({})),
    };
    return b;
  },
  createMiddleware: () => ({ server: () => ({}) }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/components/motion/PullToRefresh", () => ({ PullToRefresh: () => null }));
vi.mock("@/components/FieldCollectionsCard", () => ({ FieldCollectionsCard: () => null }));
vi.mock("@/components/HelpTip", () => ({ HelpTip: () => null }));
vi.mock("@/hooks/useOrgToday", () => ({
  useOrgToday: () => "2026-11-27",
  useOrgTimezone: () => "America/Detroit",
}));
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ role: "owner", orgId: "org" }),
  usePermissions: () => ({ role: "owner", permissions: [], can: () => true }),
}));
vi.mock("@/lib/motion/use-motion-list", () => ({ useMotionList: () => null }));
vi.mock("@/components/client-detail/EditDrawer", () => ({
  EditDrawer: ({ children, open }: any) => (open ? createElement("div", null, children) : null),
  DrawerFooter: ({ children }: any) => createElement("div", null, children),
}));
// The menu is closed in a static frame; print what it would hold.
vi.mock("@/components/RowActions", () => ({
  RowActions: ({ actions }: any) =>
    createElement(
      "ul",
      null,
      ...actions.map((a: any) => createElement("li", { key: a.label }, a.label)),
    ),
}));

import { BoundarySketch } from "@/components/BoundarySketch";
import { InvoiceCard, InvoiceRow } from "@/components/InvoiceRow";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { Route as InvoicesRoute } from "@/routes/_authenticated/invoices.index";
import { createGoogleRenderer } from "@/lib/maps/google-renderer";
import { createLeafletRenderer } from "@/lib/maps/leaflet-renderer";
import { US_VIEW } from "@/lib/maps/types";

const read = (f: string) => readFileSync(f, "utf8");

let qc: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const html = (el: React.ReactElement) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, el));

describe("a map that has not drawn says so, and that the step can be skipped", () => {
  let root: Root;
  let host: HTMLDivElement;
  let paint: (() => void) | null;
  const fakeRenderer = () => ({
    onTilesPainted: (cb: () => void) => {
      paint = cb;
      return () => {};
    },
    onMapClick: () => () => {},
    setView: () => {},
    fitBounds: () => {},
    addMarker: () => ({ remove() {} }),
    addPolygon: () => ({ remove() {} }),
    addPolyline: () => ({ remove() {} }),
  });
  const mount = () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(BoundarySketch, {
          center: { lat: 42.33, lng: -83.05 },
          initial: null,
          unloadedHint: "You can skip this step: press Continue.",
        }),
      ),
    );
  };
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const status = () => host.querySelector('[role="status"]')?.textContent ?? "";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    paint = null;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    maps.renderer = null;
  });

  it("a map that never paints", () => {
    maps.renderer = fakeRenderer();
    mount();
    wait(7000);
    expect(status()).toBe("");
    wait(1500);
    expect(status()).toBe("The map hasn't loaded. You can skip this step: press Continue.");
  });

  it("a map that was never made", () => {
    mount();
    wait(8500);
    expect(status()).toContain("The map hasn't loaded.");
  });

  it("a map that paints in time says nothing; a late paint takes the notice away", () => {
    maps.renderer = fakeRenderer();
    mount();
    act(() => paint!());
    wait(9000);
    expect(status()).toBe("");
    act(() => root.unmount());
    host.remove();
    mount();
    wait(9000);
    expect(status()).toContain("hasn't loaded");
    act(() => paint!());
    expect(status()).toBe("");
  });

  it("the new-client wizard says how to skip", () => {
    expect(read("src/routes/_authenticated/clients.new.tsx")).toMatch(
      /unloadedHint="You can skip this step: press Continue\./,
    );
  });
});

describe("both renderers report the first paint", () => {
  const opts = { initialView: US_VIEW, style: "satellite", gestures: "map" } as const;

  it("Google: on tilesloaded, and at once for a surface that asks afterwards", () => {
    const w: any = { document };
    installFakeGoogleMaps(w);
    const r = createGoogleRenderer(w.google.maps, document.createElement("div"), opts);
    const early = vi.fn();
    r.onTilesPainted(early);
    expect(early).not.toHaveBeenCalled();
    (r as any).map.trigger("tilesloaded");
    expect(early).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    r.onTilesPainted(late);
    expect(late).toHaveBeenCalledTimes(1);
    r.destroy();
  });

  it("Leaflet: on the imagery layer's first tile, not on a label over a blank box", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const r = createLeafletRenderer(el, opts);
    const cb = vi.fn();
    r.onTilesPainted(cb);
    const [imagery, labels] = (r as any).base;
    labels.fire("tileload");
    expect(cb).not.toHaveBeenCalled();
    imagery.fire("tileload");
    expect(cb).toHaveBeenCalledTimes(1);
    r.destroy();
    el.remove();
  });
});

describe("an invoice for a client with no email does not claim it will be sent", () => {
  const held = {
    id: "inv-1",
    client_id: "c-1",
    number: 1001,
    status: "open",
    kind: "service",
    currency: "usd",
    total_cents: 2500,
    subtotal_cents: 2500,
    period_start: null,
    period_end: null,
    due_on: "2026-12-12",
    send_after: "2026-11-30",
    sent_at: null,
    public_token: "tok",
    created_at: "2026-11-27T15:00:00Z",
  };
  const noEmail = { display_name: "Pat", primary_email: null };
  const withEmail = { display_name: "Pat", primary_email: "pat@example.com" };

  it.each([
    ["row", InvoiceRow],
    ["phone card", InvoiceCard],
  ])("the %s", (_n, C: any) => {
    const without = html(createElement(C, { invoice: { ...held, clients: noEmail }, onOpen() {} }));
    expect(without).toContain("Can&#x27;t email: no address");
    expect(without).not.toContain("Scheduled");
    const having = html(
      createElement(C, { invoice: { ...held, clients: withEmail }, onOpen() {} }),
    );
    expect(having).toContain("Scheduled to send Mon, Nov 30");
    expect(having).not.toContain("no address");
  });

  it("the client's Billing tab, whose rows carry no client", () => {
    const row = (clientEmail: string | null | undefined) =>
      html(createElement(InvoiceRow, { invoice: held, clientEmail, onOpen() {} }));
    expect(row(null)).toContain("no address");
    expect(row(null)).not.toContain("Scheduled");
    // Not loaded: nothing is claimed either way.
    expect(row(undefined)).toContain("Scheduled to send");
    expect(read("src/components/client-detail/billing-panels.tsx")).toMatch(
      /clientEmail=\{clientEmail\}/,
    );
  });

  const drawer = (client: Record<string, unknown>) => {
    qc.setQueryData(["invoice-detail", "inv-1"], {
      invoice: held,
      client,
      lineItems: [],
      payments: [],
      cardPaymentsReady: false,
    });
    return html(createElement(InvoiceDrawer, { invoiceId: "inv-1", onClose() {} }));
  };

  it("the drawer says why, and offers an email, the pay link or the PDF, never a text", () => {
    const out = drawer(noEmail);
    expect(out).toContain("This invoice can&#x27;t be emailed. There&#x27;s no email address.");
    expect(out).toContain("Add an email");
    expect(out).toContain('data-search="{&quot;edit&quot;:true}"');
    expect(out).toContain("copy the pay link or ");
    expect(out).toContain("download the PDF");
    expect(out).not.toContain("Scheduled");
    expect(out).not.toContain("Send now");
    expect(out).not.toMatch(/text message|SMS/i);
  });

  it("the drawer is unchanged for a client with an email", () => {
    const out = drawer(withEmail);
    expect(out).toContain("Scheduled to send Mon, Nov 30");
    expect(out).toContain("Send now");
    expect(out).not.toContain("can&#x27;t be emailed");
  });

  it("the Invoices page loads the address and swaps both send actions for Add an email", () => {
    const page = (clients: Record<string, unknown>) => {
      qc.setQueryData(["invoices"], [{ ...held, clients }]);
      return html(createElement((InvoicesRoute as any).options.component));
    };
    const without = page(noEmail);
    expect(without).toContain("<li>Add an email</li>");
    expect(without).not.toContain("<li>Send now</li>");
    expect(without).not.toContain("<li>Send reminder</li>");
    const having = page(withEmail);
    expect(having).toContain("<li>Send now</li>");
    expect(having).not.toContain("<li>Add an email</li>");
    expect(read("src/lib/invoices.functions.ts")).toContain("clients(display_name, primary_email)");
  });

  it("the full invoice page shows the same notice, on screen only", () => {
    const src = read("src/routes/_authenticated/invoices.$invoiceId.tsx");
    expect(src).toMatch(/<InvoiceNoEmailNotice[\s\S]{0,200}className="print:hidden"/);
    expect(src).toMatch(/invoiceStatusChip\(invoice, noEmail \? undefined : today\)/);
  });
});

describe("toasts start below the app header", () => {
  // h-14 is 3.5rem; anything starting at 4rem or lower is clear of it.
  it.each([false, true])("native: %s", async (native) => {
    const { toastOffset } = await import("@/lib/toast-offset");
    expect(toastOffset(native).top).toContain("var(--hs-banner-h, 0px) + 4rem");
  });

  it("the app's one Toaster uses it on wide and phone screens", () => {
    const src = read("src/routes/__root.tsx");
    expect(src).toContain("const TOAST_OFFSET = toastOffset(IS_NATIVE_BUNDLE);");
    expect(src).toMatch(/offset=\{TOAST_OFFSET\}\s+mobileOffset=\{TOAST_OFFSET\}/);
  });
});
