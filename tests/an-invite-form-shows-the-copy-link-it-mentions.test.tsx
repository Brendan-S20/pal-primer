// The invite form named a Copy link it did not have (#775).
//
// Settings > Users & roles said "If it doesn't arrive, use Copy link below"
// under a form with nothing below it. Copy link was on a pending-invite row,
// which does not exist before the first invite, and on the WARNING toast only,
// so an owner whose email did go out had no way to copy the link at all.
//
// Acceptance, and where each is held:
//   1. With zero pending invites the form does not say "Copy link below":
//      inviteFormHelp, and the source of InvitePanel.
//   2. After Send invite the link can be copied whether or not emailSent is
//      true: InviteLinkCard rendered both ways, the toast action on both tones.
//   3. Visible without hunting at 390 and 1280: the card sits directly under
//      the form, in a wrapping row whose link field can shrink.
//
// No invite is sent here: nothing calls the server, and the page is read as
// source. The repo has no DOM, so the card is rendered to static markup.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { inviteFormHelp, inviteLinkCardStatus } from "@/lib/invite-copy";
import { InviteLinkCard } from "@/components/settings/InviteLinkCard";

const ROOT = join(import.meta.dirname, "..");
const page = readFileSync(join(ROOT, "src/routes/_authenticated/settings.users.tsx"), "utf8");
const LINK = "https://app.example.test/invite/abc123def456";

describe("the help under the invite form names only a Copy link that is on screen", () => {
  it("with zero pending invites and nothing sent, it does not point at a Copy link", () => {
    const help = inviteFormHelp({ pendingCount: 0, justSent: false });
    expect(help).not.toMatch(/copy link below/i);
    expect(help).not.toMatch(/use copy link/i);
    expect(help).toMatch(/after you send the invite/i);
  });

  it("with pending invites, it points at the row where Copy link is", () => {
    expect(inviteFormHelp({ pendingCount: 2, justSent: false })).toMatch(
      /Copy link next to their invite under Pending invites/,
    );
  });

  it("right after a send, it points at the card above it", () => {
    expect(inviteFormHelp({ pendingCount: 0, justSent: true })).toMatch(/Copy link above/);
  });

  it("the page no longer carries the old sentence, and renders the help from the rule", () => {
    expect(page).not.toMatch(/use Copy link below/);
    expect(page).toMatch(/inviteFormHelp\(\{/);
  });

  it("no sentence uses an em dash", () => {
    for (const pendingCount of [0, 1]) {
      for (const justSent of [false, true]) {
        expect(inviteFormHelp({ pendingCount, justSent })).not.toContain("—");
      }
    }
    for (const sent of [true, false]) {
      expect(inviteLinkCardStatus("created", "a@b.co", sent).message).not.toContain("—");
    }
  });
});

describe("after Send invite the link can be copied whether or not the email went out", () => {
  for (const emailSent of [true, false]) {
    it(`emailSent=${emailSent}: the card shows the link and a Copy link button`, () => {
      const html = renderToStaticMarkup(
        <InviteLinkCard
          sent={{ email: "pat@example.com", link: LINK, emailSent, action: "created" }}
          onCopy={() => undefined}
          onDismiss={() => undefined}
        />,
      );
      expect(html).toContain(`value="${LINK}"`);
      expect(html).toMatch(/<button[^>]*>Copy link<\/button>/);
      expect(html).toContain("pat@example.com");
      if (emailSent) expect(html).toMatch(/Emailed to pat@example\.com/);
      else expect(html).toMatch(/did not go out/);
    });
  }

  it("Copy link hands the card's own link to the copier", () => {
    const onCopy = vi.fn();
    const el = InviteLinkCard({
      sent: { email: "pat@example.com", link: LINK, emailSent: true, action: "resent" },
      onCopy,
      onDismiss: () => undefined,
    });
    // Walk the element tree to the Copy link button and press it.
    type Node = { props?: { children?: unknown; onClick?: () => void } } | null;
    const find = (n: unknown): Node => {
      if (!n || typeof n !== "object") return null;
      const node = n as NonNullable<Node>;
      if (node.props?.children === "Copy link") return node;
      const kids = ([] as unknown[]).concat(node.props?.children ?? []);
      for (const k of kids) {
        const hit = find(k);
        if (hit) return hit;
      }
      return null;
    };
    find(el)?.props?.onClick?.();
    expect(onCopy).toHaveBeenCalledWith(LINK);
  });

  it("the page keeps the sent invite on the form, success or not", () => {
    // Set from the server's answer whenever it carries a link, with no
    // condition on emailSent.
    expect(page).toMatch(
      /setSent\(r\.link \? \{ id, email: to, link: r\.link, emailSent: r\.emailSent, action \} : null\)/,
    );
    expect(page).toMatch(/<InviteLinkCard sent=\{sent\}/);
  });

  it("the success toast carries Copy link too, not only the warning", () => {
    expect(page).toMatch(/toast\.success\(said\.message, \{ action: copy \}\)/);
    expect(page).toMatch(/toast\.warning\(said\.message, \{ duration: 15000, action: copy \}\)/);
  });

  it("revoking the invite on the card takes the card away", () => {
    expect(page).toMatch(/setSent\(\(s\) => \(s\?\.id === id \? null : s\)\)/);
  });
});

describe("the card is where the eye already is, at phone and desktop widths", () => {
  it("renders directly under the form, before the help and the pending list", () => {
    const form = page.indexOf("</form>");
    const card = page.indexOf("<InviteLinkCard");
    const help = page.indexOf("{inviteFormHelp(");
    const pending = page.indexOf("Pending invites</div>");
    expect(form).toBeGreaterThan(0);
    expect(card).toBeGreaterThan(form);
    expect(help).toBeGreaterThan(card);
    expect(pending).toBeGreaterThan(help);
  });

  it("a long link gives way rather than pushing Copy link off a 390px phone", () => {
    const html = renderToStaticMarkup(
      <InviteLinkCard
        sent={{ email: "x@y.co", link: LINK + "x".repeat(200), emailSent: true, action: "created" }}
        onCopy={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(html).toMatch(/class="[^"]*flex flex-wrap[^"]*"/);
    expect(html).toMatch(/<input[^>]*class="[^"]*min-w-0[^"]*flex-1/);
    expect(html).toMatch(/<button[^>]*class="[^"]*shrink-0[^"]*"[^>]*>Copy link/);
  });
});

describe("a toast's Copy link is big enough for a thumb", () => {
  it("sonner's 24px buttons get the 44px touch floor, under the touch variant's own query", () => {
    const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
    expect(css).toMatch(
      /@media \(pointer: coarse\), \(max-width: 767px\) \{\s*\[data-sonner-toast\] \[data-button\] \{\s*min-height: 44px;\s*min-width: 44px;\s*flex-shrink: 0;/,
    );
  });
});
