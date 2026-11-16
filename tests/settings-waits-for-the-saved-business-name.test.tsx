// @vitest-environment happy-dom
//
// #945. After sign-in an owner opened Settings and read their business name
// as a blank field. The name was saved; the read had not answered yet, and
// BusinessDetailsCard drew `q.data?.name ?? ""` into the input meanwhile. A
// blank field that looks editable reads as lost data. The Client portal
// card, which edits the same row, was worse: its fields started as defaults,
// Save sent all of them, and typing a name enabled Save before the row had
// arrived (or after it had failed to), so the defaults could be written over
// the logo, phone, email and portal policy.
//
// Driven with a settings response that is held back until the test lets it
// go, the way a slow sign-in makes it: before the answer there is no field
// to type in and no Save to press, only a loading status; after it, the
// saved name is in the field and Save works. A failed read shows an error
// with Try again, not a blank form, and Try again reads again.
//
// Against the cards as they were on f640e34 this fails at the first
// assertion of each block: the name field is on screen, empty.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAVED = {
  name: "Maple Street Scoopers",
  contact_phone: "555-010-0199",
  contact_email: "office@maple-street.example",
  contact_address: "12 Elm St, Springfield",
  brand_color: "#123456",
  logo_url: "https://example.test/logo.png",
  portal_reschedule_cutoff_hours: 24,
  portal_allow_self_reschedule: false,
  portal_allow_vacation_hold: true,
  portal_allow_frequency_change: false,
  portal_auto_apply_changes: true,
  country: "US",
};

const getOrgBranding = vi.fn();
const updateOrgBranding = vi.fn(async () => ({}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/org.functions", () => ({
  getOrgBranding: (...a: unknown[]) => getOrgBranding(...a),
  updateOrgBranding: (...a: unknown[]) => updateOrgBranding(...(a as [])),
  getMyOrg: vi.fn(async () => ({ organization: { name: SAVED.name, portal_slug: "maple" } })),
  setPortalSlug: vi.fn(),
  suggestPortalSlug: vi.fn(),
}));
vi.mock("@/lib/stations.functions", () => ({
  listFacilities: vi.fn(async () => ({ facilities: [] })),
}));
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ role: "owner", orgId: "org" }),
  usePermissions: () => ({ can: () => true, role: "owner" }),
}));
vi.mock("@/hooks/useMyProfile", () => ({
  useMyProfile: () => ({ authEmail: "owner@example.test" }),
}));
// A plain text box: the real one loads Google Places.
vi.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: ({
    id,
    value,
    onChangeText,
    disabled,
  }: {
    id: string;
    value: string;
    onChangeText: (v: string) => void;
    disabled?: boolean;
  }) =>
    createElement("input", {
      id,
      value,
      disabled,
      onChange: (e: { target: { value: string } }) => onChangeText(e.target.value),
    }),
}));

import { BusinessDetailsCard } from "@/components/settings/BusinessDetailsCards";
import { BrandingCard } from "@/components/settings/ClientPortalCards";

/** A response the test releases by hand. */
function held<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  getOrgBranding.mockReset();
  updateOrgBranding.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, node));
  });
}

/** Let a released promise reach react-query (which batches its notifications
 *  on a timer) and the re-render it causes. */
async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}

const field = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`);
const button = (label: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
/** Every text box a person could type into right now. */
const editable = () =>
  [...host.querySelectorAll<HTMLInputElement>("input, select, textarea")].filter(
    (el) => !el.disabled && el.type !== "hidden",
  );

describe("Settings → Business details waits for the saved name (#945)", () => {
  it("shows no editable or empty field and no Save before the answer, then the saved name", async () => {
    const res = held<typeof SAVED>();
    getOrgBranding.mockReturnValue(res.promise);
    await mount(createElement(BusinessDetailsCard, { canEdit: true }));

    // Before: loading, and nothing to type into or save with.
    expect(field("business-name")).toBeNull();
    expect(editable()).toEqual([]);
    const save = button(/Save business details/);
    expect(save === undefined || save.disabled).toBe(true);
    const status = host.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.textContent).toMatch(/Loading your saved business details/);

    // After: the saved name, editable, and Save on.
    res.resolve(SAVED);
    await settle();
    expect(field("business-name")?.value).toBe(SAVED.name);
    expect(field("business-name")?.disabled).toBe(false);
    expect(field("business-phone")?.value).toBe(SAVED.contact_phone);
    expect(button(/Save business details/)?.disabled).toBe(false);
    expect(host.querySelector("[data-settings-loading]")).toBeNull();
  });

  it("a failed read is an error with Try again, not a blank form, and Try again reads again", async () => {
    getOrgBranding.mockRejectedValueOnce(new Error("network"));
    await mount(createElement(BusinessDetailsCard, { canEdit: true }));
    await settle();

    expect(field("business-name")).toBeNull();
    expect(editable()).toEqual([]);
    expect(button(/Save business details/)).toBeUndefined();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/could not load your saved business details/);
    const retry = button(/Try again/);
    expect(retry).toBeDefined();

    getOrgBranding.mockResolvedValueOnce(SAVED);
    await act(async () => retry!.click());
    await settle();
    expect(getOrgBranding).toHaveBeenCalledTimes(2);
    expect(field("business-name")?.value).toBe(SAVED.name);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("Settings → Client portal waits for the saved row before Save can send it (#945)", () => {
  it("draws no field and no Save until the row is here, then the saved values", async () => {
    const res = held<typeof SAVED>();
    getOrgBranding.mockReturnValue(res.promise);
    await mount(createElement(BrandingCard));

    expect(field("portal-org-name")).toBeNull();
    expect(editable()).toEqual([]);
    const save = button(/Save portal settings/);
    expect(save === undefined || save.disabled).toBe(true);

    res.resolve(SAVED);
    await settle();
    expect(field("portal-org-name")?.value).toBe(SAVED.name);
    expect(button(/Save portal settings/)?.disabled).toBe(false);
    expect(updateOrgBranding).not.toHaveBeenCalled();
  });

  it("a failed read offers Try again and never a Save of the defaults", async () => {
    getOrgBranding.mockRejectedValueOnce(new Error("network"));
    await mount(createElement(BrandingCard));
    await settle();

    expect(field("portal-org-name")).toBeNull();
    expect(button(/Save portal settings/)).toBeUndefined();
    expect(button(/Try again/)).toBeDefined();
    expect(updateOrgBranding).not.toHaveBeenCalled();
  });
});
