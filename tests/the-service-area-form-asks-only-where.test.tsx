// @vitest-environment happy-dom
//
// #958 acceptance 1, the form: a walker, sitter, groomer or trainer is asked
// WHERE they work (the ZIP at the middle, prefilled from the business
// address as #946 does, and how far), and nothing priced: no per-visit price,
// no extra dog, no first cleanup. Save makes a zone through createZone and
// finishes only the area part.
//
// Fixture data only: a made-up business on a made-up street in Lansing, MI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const world = vi.hoisted(() => ({
  branding: {
    contact_address: "12 Fixture Ln, Lansing, MI 48933",
    latitude: 42.73 as number | null,
    longitude: -84.55 as number | null,
  },
  toast: { success: vi.fn(), error: vi.fn() },
  createZone: vi.fn(async (_: unknown) => ({ id: "zone-1" })),
  geocodePostal: vi.fn(async ({ data }: { data: { postalCode: string } }) =>
    data.postalCode === "48906"
      ? { point: { latitude: 42.77, longitude: -84.58 } }
      : { point: null },
  ),
}));

vi.mock("sonner", () => ({ toast: world.toast }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/lib/org.functions", () => ({ getOrgBranding: async () => world.branding }));
vi.mock("@/lib/zones.functions", () => ({
  createZone: world.createZone,
  geocodePostal: world.geocodePostal,
}));

import { ServiceAreaOnlyForm } from "@/components/SetupServiceArea";

let host: HTMLElement;
let root: Root | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function open(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  });
  // Until the business address has loaded, as a person would see it arrive.
  const want = world.branding.contact_address ? "48933" : "";
  for (let i = 0; i < 50 && (!qc.getQueryData(["org-branding"]) || zip()?.value !== want); i++)
    await settle();
  await settle();
}

const zip = () => host.querySelector<HTMLInputElement>("#setup-area-zip")!;

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  await act(async () => {
    host
      .querySelector("form[data-setup-service-area-form]")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  world.branding = {
    contact_address: "12 Fixture Ln, Lansing, MI 48933",
    latitude: 42.73,
    longitude: -84.55,
  };
  world.createZone.mockClear();
  world.geocodePostal.mockClear();
  world.toast.success.mockClear();
  world.toast.error.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

describe("#958 the service-area form for a business that does not scoop", () => {
  it("asks where and how far, and nothing priced", async () => {
    await open(<ServiceAreaOnlyForm done={false} onSaved={() => {}} />);
    expect(zip().value).toBe("48933");
    expect(host.textContent).toMatch(/How far you travel/);
    expect(host.querySelectorAll('input[type="number"]')).toHaveLength(0);
    expect(host.textContent).not.toMatch(/per visit|extra dog|first cleanup|\$/i);
    // Every distance is a real button, at least the sm size the setup uses.
    expect(host.querySelectorAll("button[aria-pressed]")).toHaveLength(5);
  });

  it("saves a 15-mile circle on the business's own pin, with no price, and finishes the part", async () => {
    const onSaved = vi.fn();
    await open(<ServiceAreaOnlyForm done={false} onSaved={onSaved} saveLabel="Save area" />);
    expect(host.querySelector('[data-setup-action="save-area"]')!.textContent).toBe("Save area");
    await save();
    expect(world.toast.error).not.toHaveBeenCalled();
    expect(world.geocodePostal).not.toHaveBeenCalled();
    expect(world.createZone).toHaveBeenCalledTimes(1);
    expect(world.createZone.mock.calls[0][0]).toEqual({
      data: {
        name: "Main service area",
        geoMatchMode: "radius",
        fillZipsFromShape: true,
        centerLatitude: 42.73,
        centerLongitude: -84.55,
        radiusMeters: Math.round(15 * 1609.344),
      },
    });
    expect(world.toast.success).toHaveBeenCalledWith("Service area saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("centres on another ZIP's middle when one is typed, at the distance picked", async () => {
    await open(<ServiceAreaOnlyForm done={false} onSaved={() => {}} />);
    await type(zip(), "48906");
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "5 miles")!.click();
    });
    await save();
    expect(world.geocodePostal).toHaveBeenCalledWith({ data: { postalCode: "48906" } });
    expect(world.createZone.mock.calls[0][0]).toMatchObject({
      data: { centerLatitude: 42.77, centerLongitude: -84.58, radiusMeters: 8047 },
    });
  });

  it("refuses with no ZIP and no pin, says why beside Save, and writes nothing", async () => {
    world.branding = { contact_address: "", latitude: null, longitude: null };
    const onSaved = vi.fn();
    await open(<ServiceAreaOnlyForm done={false} onSaved={onSaved} />);
    await save();
    expect(world.createZone).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.querySelector("[data-setup-error]")!.textContent).toBe(
      "Enter the ZIP code at the middle of the area you serve.",
    );
  });

  it("a failed save is said, and the part stays open", async () => {
    world.createZone.mockImplementationOnce(async () => {
      throw new Error("permission denied for table zones");
    });
    const onSaved = vi.fn();
    await open(<ServiceAreaOnlyForm done={false} onSaved={onSaved} />);
    await save();
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.querySelector("[data-setup-error]")!.textContent).toBe(
      "permission denied for table zones",
    );
  });

  it("once done, says so and offers another area instead of the form again", async () => {
    await open(<ServiceAreaOnlyForm done onSaved={() => {}} />);
    expect(host.querySelector("[data-setup-service-area-form]")).toBeNull();
    expect(host.textContent).toMatch(/Clients inside your service area can book online/);
    expect(host.textContent).toMatch(/Add another area/);
  });
});
