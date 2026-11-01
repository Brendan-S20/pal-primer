// What a person whose access was turned off actually sees.
//
// tests/off-means-off.test.ts proves the database and the server gate. This is
// the app half, run rather than read:
//
//   * the _authenticated shell's beforeLoad, given getMyOrg's answer, sends a
//     person who is off to /access-off -- not /no-workspace, whose form offers
//     to set up a business -- and a platform admin to /platform as before;
//   * the screen says which business, in the phone's language, with the name
//     the office typed isolated in a <bdi>, and offers Check again and Sign out.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

const getMyOrg = vi.fn();
const getPlatformContext = vi.fn();

vi.mock("@/lib/org.functions", () => ({ getMyOrg: () => getMyOrg() }));
vi.mock("@/lib/platform.functions", () => ({ getPlatformContext: () => getPlatformContext() }));
vi.mock("@/lib/offline/identity", () => ({
  resolveIdentity: async () => ({
    ok: true,
    userId: "u-tech",
    user: { id: "u-tech" },
    verified: true,
  }),
}));
vi.mock("@/lib/mfa", () => ({ needsSecondStep: async () => false }));
vi.mock("@/lib/offline/read-cache", () => ({
  ensureReadCachePersistence: () => {},
  clearPersistedReadCaches: () => {},
  signOutAndClearDevice: async () => {},
}));
vi.mock("@/lib/monitoring/client", () => ({
  setMonitoringIdentity: () => {},
  reportClientError: () => {},
}));

import { isRedirect } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import i18n from "@/lib/i18n";
import { Route } from "@/routes/_authenticated/route";
import { AccessOffCard } from "@/components/AccessOffCard";

async function landing(): Promise<string | "rendered"> {
  const queryClient = new QueryClient();
  const beforeLoad = Route.options.beforeLoad as (ctx: unknown) => Promise<unknown>;
  try {
    await beforeLoad({ context: { queryClient }, location: { href: "/my-day" } });
    return "rendered";
  } catch (e) {
    if (isRedirect(e)) return String(e.options.to);
    throw e;
  }
}

describe("the shell", () => {
  beforeEach(() => {
    getMyOrg.mockReset();
    getPlatformContext.mockReset();
    getPlatformContext.mockResolvedValue({ isPlatformAdmin: false });
  });

  it("sends a person who is off to /access-off, not to the set-up-a-business page", async () => {
    getMyOrg.mockResolvedValue({
      organization: null,
      accessTurnedOff: { organizationName: "Acme Scoop" },
    });
    expect(await landing()).toBe("/access-off");
  });

  it("still sends somebody with no business at all to /no-workspace", async () => {
    getMyOrg.mockResolvedValue({ organization: null, accessTurnedOff: null });
    expect(await landing()).toBe("/no-workspace");
  });

  it("still sends a platform admin to /platform", async () => {
    getMyOrg.mockResolvedValue({
      organization: null,
      accessTurnedOff: { organizationName: "Acme Scoop" },
    });
    getPlatformContext.mockResolvedValue({ isPlatformAdmin: true });
    expect(await landing()).toBe("/platform");
  });

  it("lets a person who is on in, as before", async () => {
    getMyOrg.mockResolvedValue({
      organization: { id: "org-1", name: "Acme Scoop", role: "tech" },
      accessTurnedOff: null,
    });
    expect(await landing()).toBe("rendered");
  });
});

function render(lang: string, state: Parameters<typeof AccessOffCard>[0]["state"]) {
  const t = i18n.cloneInstance({ lng: lang });
  return renderToStaticMarkup(
    <I18nextProvider i18n={t}>
      <AccessOffCard state={state} onCheckAgain={() => {}} onSignOut={() => {}} />
    </I18nextProvider>,
  );
}

describe("the screen", () => {
  it("names the business, isolated, and says who can undo it", () => {
    const html = render("en", { kind: "off", business: "Acme <Scoop> & Co", checkedAgain: false });
    expect(html).toContain("Your access to <bdi");
    expect(html).toContain("Acme &lt;Scoop&gt; &amp; Co</bdi> has been turned off.");
    expect(html).toContain("Ask the owner to reactivate you.");
    expect(html).toContain("Check again");
    expect(html).toContain("Sign out");
  });

  it("speaks the phone's language", () => {
    const html = render("es", { kind: "off", business: "Acme Scoop", checkedAgain: true });
    expect(html).toContain("Tu acceso a <bdi");
    expect(html).toContain("Pide al dueño que te reactive.");
    expect(html).toContain("Sigue desactivado.");
    expect(html).toContain("Cerrar sesión");
  });

  it("says something true when it cannot ask", () => {
    const html = render("en", { kind: "error" });
    expect(html).toContain("Couldn&#x27;t check right now.");
    expect(html).not.toContain("Your access to");
  });
});
