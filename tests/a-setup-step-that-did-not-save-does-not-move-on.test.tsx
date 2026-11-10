// A step that did not save says so and does not move on; one that did shows
// up in Settings straight away (Detroit Doo Disposal onboarding, 2026-11-09;
// #766). The server half -- that each value lands where Settings reads it --
// is tests/what-onboarding-saves-settings-shows.test.ts. This is the screen
// half, run without a DOM because the repo has none:
//
//   - stepSave, the one contract every /setup form saves through, executed
//     with react-query's own MutationObserver;
//   - finishSignup, Get started's last step, executed with fakes;
//   - the wiring, read from source: every setup save goes through stepSave,
//     and refreshes the query key the matching Settings screen reads;
//   - Settings > Business, rendered, showing what onboarding saved.

/* eslint-disable @typescript-eslint/no-explicit-any -- fakes */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/lib/org.functions", () => ({ getOrgBranding: vi.fn(), updateOrgBranding: vi.fn() }));
vi.mock("@/lib/stations.functions", () => ({ listFacilities: vi.fn() }));
vi.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: ({ id, value }: { id: string; value: string }) => (
    <input id={id} value={value} readOnly />
  ),
}));

import { stepSave } from "@/lib/setup-step-save";
import { finishSignup, newSignupProgress, signupErrorMessage } from "@/lib/finish-signup";
import { BusinessDetailsCard, DumpSitesCard } from "@/components/settings/BusinessDetailsCards";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ── stepSave ───────────────────────────────────────────────────────────────

async function runStep(save: () => Promise<unknown>) {
  const qc = new QueryClient();
  const invalidated: unknown[] = [];
  const spy = vi
    .spyOn(qc, "invalidateQueries")
    .mockImplementation(async (f: any) => void invalidated.push(f.queryKey));
  const notify = { success: vi.fn(), error: vi.fn() };
  const onSaved = vi.fn();
  const obs = new MutationObserver(
    qc,
    stepSave({
      qc,
      save,
      refresh: [["org-branding"], ["waste-facilities"]],
      saved: "Saved",
      onSaved,
      notify,
    }),
  );
  await obs.mutate().catch(() => undefined);
  spy.mockRestore();
  return { notify, onSaved, invalidated };
}

describe("stepSave", () => {
  it("a failed save shows the server's sentence and does NOT advance the step", async () => {
    const r = await runStep(async () => {
      throw new Error("permission denied for table organizations");
    });
    expect(r.notify.error).toHaveBeenCalledWith("permission denied for table organizations");
    expect(r.onSaved).not.toHaveBeenCalled();
    expect(r.notify.success).not.toHaveBeenCalled();
  });

  it("a failed save still refreshes Settings, because part of it may have landed", async () => {
    const r = await runStep(async () => {
      throw new Error("second write failed");
    });
    expect(r.invalidated).toEqual([["org-branding"], ["waste-facilities"]]);
  });

  it("an error with no message still says something", async () => {
    const r = await runStep(async () => {
      throw new Error("");
    });
    expect(r.notify.error).toHaveBeenCalledWith(expect.stringMatching(/didn't save/));
  });

  it("a successful save says so, refreshes, and advances", async () => {
    const r = await runStep(async () => ({ ok: true }));
    expect(r.notify.success).toHaveBeenCalledWith("Saved");
    expect(r.onSaved).toHaveBeenCalledWith({ ok: true });
    expect(r.invalidated).toEqual([["org-branding"], ["waste-facilities"]]);
  });
});

// ── finishSignup ───────────────────────────────────────────────────────────

const form = {
  email: " owner@example-scoop.com ",
  password: "correct horse",
  orgName: "Detroit Test Scooping",
  displayName: "Pat Owner",
  phone: " 313-555-0142 ",
  smsConsent: true,
  promoCode: "",
};

function deps(over: Record<string, any> = {}) {
  return {
    registerAccount: vi.fn(async () => ({ ok: true })),
    signIn: vi.fn(async () => ({ error: null })),
    acceptPendingInvite: vi.fn(async () => null),
    bootstrapOrganization: vi.fn(async () => ({ promoStored: null })),
    recordSmsConsent: vi.fn(async () => ({ ok: true })),
    sendEmailVerification: vi.fn(async () => ({ ok: true })),
    readAttribution: () => ({}),
    clearAttribution: vi.fn(),
    timezone: () => "America/Detroit",
    consentText: "I agree to receive texts.",
    onPromoLost: vi.fn(),
    ...over,
  };
}

describe("finishSignup", () => {
  it("sends the mobile number to bootstrapOrganization, consent box or not", async () => {
    for (const smsConsent of [true, false]) {
      const d = deps();
      await finishSignup({ ...form, smsConsent }, newSignupProgress(), d);
      expect(d.bootstrapOrganization.mock.calls[0][0].data).toMatchObject({
        phone: "313-555-0142",
        timezone: "America/Detroit",
      });
    }
  });

  it("records consent only when the box was ticked", async () => {
    const d = deps();
    await finishSignup({ ...form, smsConsent: false }, newSignupProgress(), d);
    expect(d.recordSmsConsent).not.toHaveBeenCalled();
  });

  it("a failed consent record stops the signup, instead of moving on without it", async () => {
    const d = deps({
      recordSmsConsent: vi.fn(async () => {
        throw new Error("consent write refused");
      }),
    });
    const progress = newSignupProgress();
    await expect(finishSignup(form, progress, d)).rejects.toThrow("consent write refused");
    expect(progress).toEqual({ registered: true, bootstrapped: true, consentSaved: false });
    expect(signupErrorMessage(new Error("consent write refused"), progress)).toMatch(
      /^Your account is created, but setup did not finish: consent write refused.*Try again/,
    );
  });

  it("Try again resumes: no second account ('already has an account'), no second business", async () => {
    let fail = true;
    const d = deps({
      recordSmsConsent: vi.fn(async () => {
        if (fail) throw new Error("timeout");
        return { ok: true };
      }),
    });
    const progress = newSignupProgress();
    await expect(finishSignup(form, progress, d)).rejects.toThrow();
    fail = false;
    await expect(finishSignup(form, progress, d)).resolves.toBe("workspace");
    expect(d.registerAccount).toHaveBeenCalledTimes(1);
    expect(d.bootstrapOrganization).toHaveBeenCalledTimes(1);
    expect(d.recordSmsConsent).toHaveBeenCalledTimes(2);
  });

  it("a failed business build is retried on Try again, without re-registering", async () => {
    let fail = true;
    const d = deps({
      bootstrapOrganization: vi.fn(async () => {
        if (fail) throw new Error("Your phone number was not saved: x");
        return { promoStored: null };
      }),
    });
    const progress = newSignupProgress();
    await expect(finishSignup(form, progress, d)).rejects.toThrow(/phone number was not saved/);
    fail = false;
    await finishSignup(form, progress, d);
    expect(d.registerAccount).toHaveBeenCalledTimes(1);
    expect(d.bootstrapOrganization).toHaveBeenCalledTimes(2);
  });

  it("a failed sign-in is not counted as registered", async () => {
    const d = deps({ signIn: vi.fn(async () => ({ error: new Error("bad") })) });
    const progress = newSignupProgress();
    await expect(finishSignup(form, progress, d)).rejects.toThrow("bad");
    expect(progress.registered).toBe(false);
    expect(signupErrorMessage(new Error("bad"), progress)).toBe("bad");
  });

  it("a pending invitation joins the team and builds nothing", async () => {
    const d = deps({ acceptPendingInvite: vi.fn(async () => "org-x") });
    await expect(finishSignup(form, newSignupProgress(), d)).resolves.toBe("joined-team");
    expect(d.bootstrapOrganization).not.toHaveBeenCalled();
  });

  it("the verification email stays best-effort", async () => {
    const d = deps({
      sendEmailVerification: vi.fn(async () => {
        throw new Error("queue down");
      }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(finishSignup(form, newSignupProgress(), d)).resolves.toBe("workspace");
    spy.mockRestore();
  });

  it("Get started uses it, and its Back button cannot undo an account", () => {
    const gs = read("src/routes/get-started.tsx");
    expect(gs).toMatch(/await finishSignup\(/);
    expect(gs).toMatch(/setError\(signupErrorMessage\(err, progress\.current\)\)/);
    expect(gs).toMatch(/disabled=\{busy \|\| progress\.current\.registered\}/);
    expect(gs).not.toMatch(/console\.error\("sms consent record failed"/);
  });

  it("the deferred (OAuth / confirm-email) bootstrap applies the phone and reports a lost consent", () => {
    const ew = read("src/lib/ensure-workspace.ts");
    expect(ew).toMatch(/phone: typeof md\.phone === "string"/);
    const failed = ew.slice(ew.indexOf('"deferred sms consent record failed"'));
    expect(failed.slice(0, 400)).toMatch(/toast\.warning\(/);
  });
});

// ── The wiring ─────────────────────────────────────────────────────────────

const SETUP = read("src/routes/_authenticated/setup.tsx");
const DAY_END = read("src/components/SetupDayEndPanel.tsx");

describe("every setup save goes through stepSave", () => {
  for (const [file, src] of [
    ["setup.tsx", SETUP],
    ["SetupDayEndPanel.tsx", DAY_END],
  ] as const) {
    it(`${file}: no useMutation of its own`, () => {
      const all = src.match(/useMutation\(/g) ?? [];
      const viaStep = src.match(/useMutation\(\s*stepSave\(/g) ?? [];
      expect(all.length).toBeGreaterThan(0);
      expect(viaStep.length).toBe(all.length);
    });
  }
});

/** The query keys a file reads, from its useQuery calls. */
function readKeys(file: string): string[] {
  return [...read(file).matchAll(/useQuery\(\{\s*queryKey: \[("[^"]+")/g)].map((m) => m[1]);
}

describe("each setup save refreshes the key its Settings screen reads", () => {
  const cases: Array<[step: string, refresh: RegExp, reader: string, key: string]> = [
    [
      "dump site",
      /refresh: \[\["waste-facilities"\]\]/,
      "src/routes/_authenticated/waste-log.tsx",
      '"waste-facilities"',
    ],
    [
      "dump site",
      /refresh: \[\["waste-facilities"\]\]/,
      "src/components/settings/BusinessDetailsCards.tsx",
      '"waste-facilities"',
    ],
    ["price", /\["std-pricing"\]/, "src/components/StandardPricingCard.tsx", '"std-pricing"'],
    [
      "price",
      /\["zones"\], \["zone-coverage"\]/,
      "src/routes/_authenticated/zones.tsx",
      '"zone-coverage"',
    ],
    [
      "team",
      /\["staff-addresses"\], \["org-users"\]/,
      "src/routes/_authenticated/settings.users.tsx",
      '"org-users"',
    ],
    [
      "team",
      /\["staff-addresses"\], \["org-users"\]/,
      "src/routes/_authenticated/settings.users.tsx",
      '"staff-addresses"',
    ],
    [
      "business",
      /\["org-branding"\],\s*\["dispatch-settings"\]/,
      "src/components/settings/BusinessDetailsCards.tsx",
      '"org-branding"',
    ],
    [
      "business",
      /\["org-branding"\],\s*\["dispatch-settings"\]/,
      "src/routes/_authenticated/settings.business.tsx",
      '"dispatch-settings"',
    ],
  ];
  for (const [step, refresh, reader, key] of cases) {
    it(`${step}: ${reader.split("/").pop()} reads ${key}, and setup refreshes it`, () => {
      expect(readKeys(reader)).toContain(key);
      expect(SETUP).toMatch(refresh);
    });
  }

  it('nothing in setup refreshes a key no screen reads (it said ["facilities"])', () => {
    expect(SETUP).not.toMatch(/\["facilities"\]/);
  });

  it("the day-end step refreshes Settings > Users too", () => {
    expect(DAY_END).toMatch(/refresh: \[\["staff-addresses"\], \["org-users"\]/);
  });
});

describe("setup's price per visit is the one price (#766)", () => {
  it("after the zone, the same price goes to Standard pricing and the default service", () => {
    const save = SETUP.slice(SETUP.indexOf("const createdZone = useRef"));
    const create = save.indexOf("await createFn(");
    const adopt = save.indexOf("await adoptFn({ data: { basePriceCents, perDogAddlCents } })");
    expect(create).toBeGreaterThan(-1);
    expect(adopt).toBeGreaterThan(create);
  });

  it("a retry after the price write failed does not create a second zone", () => {
    expect(SETUP).toMatch(/if \(!createdZone\.current\) \{/);
    expect(SETUP).toMatch(/createdZone\.current = zone\.id;/);
  });
});

// ── Settings > Business shows it ───────────────────────────────────────────

function render(node: ReactNode, seed: Record<string, unknown>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("Settings > Business", () => {
  const branding = {
    name: "Detroit Test Scooping",
    contact_phone: "313-555-0142",
    contact_email: "owner@example-scoop.com",
    contact_address: "1 Woodward Ave, Detroit, MI 48226",
  };

  it("shows name, phone, contact email and address as saved by onboarding, editable", () => {
    const html = render(<BusinessDetailsCard canEdit />, { "org-branding": branding });
    for (const [id, v] of [
      ["business-name", branding.name],
      ["business-phone", branding.contact_phone],
      ["business-email", branding.contact_email],
      ["business-address", branding.contact_address],
    ]) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*value="${v}"|value="${v}"[^>]*id="${id}"`));
    }
    expect(html).toContain("Save business details");
  });

  it("is read-only for a role that cannot write it", () => {
    const html = render(<BusinessDetailsCard canEdit={false} />, { "org-branding": branding });
    expect(html).not.toContain("Save business details");
  });

  it("lists the dump site added in setup, with a way to manage it", () => {
    const html = render(<DumpSitesCard />, {
      "waste-facilities": {
        facilities: [
          { id: "f1", name: "County transfer station", address: "100 Dump Rd", active: true },
        ],
      },
    });
    expect(html).toContain("County transfer station");
    expect(html).toContain("100 Dump Rd");
    expect(html).toMatch(/href="\/waste-log"[^>]*>Manage dump sites/);
  });

  it("the page carries both cards, and the dump sites only for a pet-waste business", () => {
    const page = read("src/routes/_authenticated/settings.business.tsx");
    expect(page).toMatch(/<BusinessDetailsCard canEdit=\{canManageSettings\} \/>/);
    expect(page).toMatch(/known && petWaste \? <DumpSitesCard \/> : null/);
  });
});
