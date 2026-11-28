// @vitest-environment happy-dom
// The rest of #1043, #1030 and #1011 found still broken on Nov 27.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/hooks/useMyProfile", () => ({
  useMyProfile: () => ({
    staff: { id: "s1", display_name: "Test Owner", avatar_url: null },
    authEmail: "owner@example.com",
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getUser: vi.fn(), updateUser: vi.fn() } },
  isImpersonationTab: () => false,
}));

import * as guide from "@/lib/setup-guide";
import { AccountMenu } from "@/components/AccountMenu";
import { UNDER_REVIEW_LINE } from "@/lib/texting-registration";

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

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

afterEach(async () => {
  await unmountAll();
  localStorage.clear();
});

const steps = (done: string[]) =>
  (
    [
      ["business", "Your business details"],
      ["zones", "Your service area and price"],
      ["clients", "Add or import clients"],
      ["staff", "Who runs the route"],
      ["dump_site", "Where the day ends"],
      ["payouts", "Get paid"],
    ] as const
  ).map(([id, label]) => ({ id, label, done: done.includes(id) }));

describe("a skipped setup step is not announced as next (#1043-7)", () => {
  const four = ["business", "zones", "clients", "staff"];

  it("moves on to an open step that was not skipped", () => {
    const b = guide.setupBanner(steps(four), null, ["dump_site"]);
    expect(b.nextLabel).toBe("Get paid");
    expect(b.step).toBe("payouts");
    expect(b.done).toBe(4);
  });

  it("names no next step when every open one was skipped, and still resumes", () => {
    const b = guide.setupBanner(steps(four), null, ["dump_site", "payouts"]);
    expect(b.nextLabel).toBeNull();
    expect(b.step).toBe("dump_site");
    expect(b.cta).toBe("Continue setup (4 of 6)");
  });

  it("names the skipped step they have gone back to as where they resume, not as Next", () => {
    const b = guide.setupBanner(steps(four), "dump_site", ["dump_site"]);
    expect(b.step).toBe("dump_site");
    expect(b.nextLabel).toBeNull();
  });

  it("keeps the skipped steps per person, once each, and reads bad storage as none", () => {
    guide.rememberSkippedStep("u1", "dump_site");
    guide.rememberSkippedStep("u1", "dump_site");
    expect(guide.readSkippedSteps("u1")).toEqual(["dump_site"]);
    expect(guide.readSkippedSteps("u2")).toEqual([]);
    localStorage.setItem("hs:setup-skipped:u1", "{not json");
    expect(guide.readSkippedSteps("u1")).toEqual([]);
    localStorage.setItem("hs:setup-skipped:u1", '{"a":1}');
    expect(guide.readSkippedSteps("u1")).toEqual([]);
  });

  it("is recorded by Skip for now and read by the banner, checklist and page", () => {
    expect(src("src/routes/_authenticated/setup.tsx")).toMatch(
      /if \(!current\.done\) rememberSkippedStep\(guide\.userId, current\.id\);\s*if \(isLast\)/,
    );
    for (const p of [
      "src/routes/_authenticated/setup.tsx",
      "src/components/SetupGuideBanner.tsx",
      "src/components/OnboardingChecklist.tsx",
    ])
      expect(src(p)).toMatch(/readSkippedSteps\(guide\.userId\)/);
  });
});

describe("the sidebar name and the avatar open the same menu (#1030-7)", () => {
  it("opens the account menu, with Sign out, from a control it is given", async () => {
    const onSignOut = vi.fn();
    await render(<AccountMenu onSignOut={onSignOut} trigger={<button>Test Owner</button>} />);
    expect(reads("Sign out")).toBe(false);
    await act(async () => {
      button("Test Owner")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await until(() => reads("owner@example.com"));
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === "Sign out"),
    );
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("is what the foot of the sidebar draws, with the shell's own sign-out", () => {
    const sidebar = src("src/components/AppSidebar.tsx");
    expect(sidebar).toMatch(/<AccountMenu\s+onSignOut=\{onSignOut\}\s+trigger=\{/);
    expect(sidebar).not.toMatch(/<Link\s+to="\/profile"/);
    expect(src("src/routes/_authenticated/route.tsx")).toContain(
      "<AppSidebar onSignOut={handleSignOut} />",
    );
  });
});

describe("setup says where services are named (#1030-1)", () => {
  it("names the default service beside the price, with the way to add or rename", () => {
    const setup = src("src/routes/_authenticated/setup.tsx");
    const note = setup.slice(setup.indexOf("data-setup-service-note"));
    expect(note.slice(0, 600)).toContain("{PET_WASTE_SERVICE_NAME}");
    expect(note.slice(0, 600)).toContain('<Link to="/settings/services"');
  });
});

describe("the texting copy says under review once (#1011-7)", () => {
  it("quotes the status line instead of the label and then the line again", () => {
    expect(UNDER_REVIEW_LINE).toBe("Under review, usually ready shortly");
    const page = src("src/routes/_authenticated/settings.sms.tsx");
    expect(page).toContain("This page then shows “{UNDER_REVIEW_LINE}”.");
    expect(page).not.toContain("UNDER_REVIEW_LINE.toLowerCase()");
  });
});
