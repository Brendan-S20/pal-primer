// /auth had no visible way to create an account (#791).
//
// The screen read as sign-in only: the tab said "Sign in · HoundStack", there
// was no Sign up or Create account control anywhere, and the only hint was a
// line of grey footer copy saying that typing an email "walks you straight into
// account setup". A new owner looking for a sign-up button found none and could
// reasonably bounce. This renders the real page, signed out, the way a browser
// first receives it, and reads what a person sees.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => () => {},
  useRouter: () => ({ history: { replace: () => {} } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ removeQueries: () => {} }),
}));
vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: {} } }));
vi.mock("@/lib/auth-entry.functions", () => ({ checkEmailAccount: async () => ({}) }));
vi.mock("@/lib/platform-onboarding.functions", () => ({ lookupInviteByToken: async () => ({}) }));
// The shell's logo is a router <Link>; the card inside it is what is under test.
vi.mock("@/components/PublicShell", () => ({
  PublicShell: ({ children }: { children: unknown }) =>
    createElement("main", null, children as never),
}));
vi.mock("@/hooks/useOfflineSignOut", () => ({
  useOfflineSignOut: () => ({ signOut: async () => true, dialog: null }),
}));

const { Route } = await import("@/routes/auth");
const route = Route as unknown as {
  options: { component: () => unknown; head: () => { meta: Array<Record<string, string>> } };
};

const html = renderToStaticMarkup(createElement(route.options.component as never));
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
  attrs: m[1],
  label: text(m[2]),
}));

describe("/auth, signed out, on the first step (#791)", () => {
  it("has a visible Create account button", () => {
    const cta = buttons.find((b) => /create (an |your )?account|sign up/i.test(b.label));
    expect(
      cta,
      `no sign-up control among: ${buttons.map((b) => b.label).join(" | ")}`,
    ).toBeTruthy();
    // A control, not a submit of the email form: it must not need an email first.
    expect(cta!.attrs).toContain('type="button"');
    expect(cta!.attrs).not.toMatch(/\sdisabled(="[^"]*")?(\s|$)/);
  });

  it("keeps Continue for people who already have an account", () => {
    expect(buttons.map((b) => b.label)).toContain("Continue");
  });

  it("does not hide sign-up in footer copy any more", () => {
    expect(text(html)).not.toMatch(
      /Entering your email above walks you straight into account setup/,
    );
  });

  it("names sign-up in the tab title, not sign-in alone", () => {
    const title = route.options.head().meta.find((m) => "title" in m)!.title;
    expect(title).toMatch(/create an account|sign up/i);
    expect(title).not.toMatch(/^Sign in ·/);
  });
});
