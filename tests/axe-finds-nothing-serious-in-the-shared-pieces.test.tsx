// @vitest-environment jsdom
//
// axe-core over the shared pieces the round-2 audit traced most of its 496
// serious/critical nodes to (gaps-r2-11, extending F-29), rendered on the
// client the way the app renders them, effects and all, and scanned in jsdom.
//
// ── WHAT THIS CAN AND CANNOT SEE ──────────────────────────────────────────
//
// jsdom has no layout. axe's color-contrast and scrollable-region-focusable
// rules need computed geometry and colour, so here they come back
// "incomplete" rather than as violations, and a green run says nothing about
// either. Both are checked statically in `a-control-with-no-name.test.ts`
// instead (the contrast by computing the ratio from src/styles.css). What
// jsdom CAN see is everything about names, roles and structure: button-name,
// select-name, label, aria-progressbar-name, nested-interactive,
// aria-allowed-attr and the rest of axe's critical/serious set.
//
// ── A RATCHET FROM ZERO ───────────────────────────────────────────────────
//
// Every surface below reports zero serious or critical violations now. A
// change that gives one of them an unnamed control, a button inside a
// button, or a progress bar with no name fails here and names the rule and
// the element. To extend it, render another piece and add it to SURFACES;
// whole screens belong in the Playwright viewport suite, which has layout.

import { describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import axe from "axe-core";
import en from "../src/lib/i18n/locales/en";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useServerFn: (f: unknown) => f,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) =>
    createElement("a", { href: to, className }, children),
  useNavigate: () => () => undefined,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/dashboard" } }),
  createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
}));
// Nothing here may reach a network: openSetupGuide() writes to the auth user.
vi.mock("@/integrations/supabase/client", () => {
  const ok = () => Promise.resolve({ data: { user: null, session: null }, error: null });
  return {
    isImpersonationTab: () => false,
    supabase: {
      auth: {
        getUser: ok,
        getSession: ok,
        updateUser: ok,
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    },
  };
});
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn(async () => null) }));
vi.mock("@/lib/onboarding.functions", () => ({
  getOnboardingStatus: vi.fn(async () => null),
  dismissOnboarding: vi.fn(),
}));
vi.mock("@/lib/notifications-center.functions", () => ({
  listMyNotifications: vi.fn(async () => ({ notifications: [], unread: 0 })),
}));

import { SetupGuideBanner } from "@/components/SetupGuideBanner";
import { openSetupGuide } from "@/lib/setup-guide";
import { Progress } from "@/components/ui/progress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

const STEPS = ["business", "zones", "clients", "staff", "payouts"].map((id, i) => ({
  id,
  done: i < 2,
  label: `Step ${id}`,
  description: "",
  to: "/x",
  cta: "Do it",
}));

let mounted: Root | null = null;

/** Rendered on the client into the document axe scans. */
async function render(node: ReactElement, role: string): Promise<HTMLElement> {
  if (mounted) act(() => mounted!.unmount());
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["my-org"], { organization: { id: "org", role } });
  qc.setQueryData(["onboarding-status"], {
    completed: 2,
    total: STEPS.length,
    dismissed: false,
    steps: STEPS,
  });
  document.documentElement.lang = "en";
  document.body.innerHTML = "<main></main>";
  const host = document.querySelector("main")!;
  mounted = createRoot(host);
  await act(async () => {
    mounted!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(I18nextProvider, { i18n }, node),
      ),
    );
  });
  return host;
}

type Found = { rule: string; impact: string | null | undefined; nodes: string[] };

/** axe's serious and critical violations in the document, as rule + selector. */
async function scan(): Promise<Found[]> {
  // color-contrast off: with no layout it can only say "incomplete", and it
  // asks jsdom for a canvas on the way (see the note at the top).
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(" ")),
    }));
}

async function preferencesPage(): Promise<ReactElement> {
  const mod = await import("@/routes/_authenticated/settings.preferences");
  const route = mod.Route as unknown as { options: { component: () => ReactElement } };
  return createElement(route.options.component);
}

async function mobileTabBar(): Promise<ReactElement> {
  const { MobileTabBar } = await import("@/components/MobileTabBar");
  return createElement(MobileTabBar);
}

const SURFACES: {
  name: string;
  role: string;
  render: () => Promise<ReactElement>;
  /** Something only this surface draws, so a blank or wrong render fails. */
  proof: string;
}[] = [
  {
    name: "SetupGuideBanner",
    role: "owner",
    render: async () => {
      openSetupGuide();
      return createElement(SetupGuideBanner);
    },
    proof: '[data-testid="setup-guide-banner"]',
  },
  {
    name: "Progress (the setup bar)",
    role: "owner",
    render: async () => createElement(Progress, { value: 40, "aria-label": "Setup progress" }),
    proof: '[role="progressbar"][aria-valuenow="40"]',
  },
  {
    name: "MobileTabBar, office",
    role: "owner",
    render: mobileTabBar,
    proof: 'a[href="/clients"]',
  },
  { name: "MobileTabBar, tech", role: "tech", render: mobileTabBar, proof: 'a[href="/my-day"]' },
  {
    name: "Settings › Preferences, owner",
    role: "owner",
    render: preferencesPage,
    proof: "#pref-phone-menu",
  },
  {
    name: "Settings › Preferences, tech",
    role: "tech",
    render: preferencesPage,
    proof: '[aria-labelledby="pref-haptics-label"]',
  },
];

describe("axe: no serious or critical violations in the shared pieces", () => {
  for (const s of SURFACES) {
    it(s.name, async () => {
      const host = await render(await s.render(), s.role);
      // A blank render passes every rule; refuse to measure one.
      expect(host.querySelector(s.proof)).not.toBeNull();
      expect(await scan()).toEqual([]);
    });
  }

  it("the scan finds what it is for", async () => {
    document.body.innerHTML = renderToStaticMarkup(
      createElement(
        "main",
        null,
        createElement(
          "div",
          { role: "button", tabIndex: 0 },
          createElement("button", { type: "button", role: "combobox" }),
        ),
        createElement("div", { role: "progressbar", "aria-valuenow": 3 }),
      ),
    );
    const rules = (await scan()).map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining(["aria-progressbar-name", "button-name", "nested-interactive"]),
    );
  });
});
