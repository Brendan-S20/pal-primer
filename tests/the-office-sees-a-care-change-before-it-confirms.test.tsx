// #611 review: the office cannot confirm a client's care change it never saw.
//
// Confirming a requested stay applies the client's staged care to the live
// sitter card (migration 20261031130000). The staged changes reach the
// confirm control on the same read as the contact gaps and the clash check,
// so Confirm waits for that read to succeed: off while it loads, off with a
// retry when it fails, on once it has succeeded, with or without changes.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/stay-booking.functions", () => ({
  confirmStay: vi.fn(),
  getStayContactGaps: vi.fn(),
}));

const { ConfirmStayButton } = await import("@/components/client-detail/ConfirmStayButton");

const STAY = "00000000-0000-0000-0000-000000000611";
const KEY = ["stay-contact-gaps", STAY];

type Seed = { kind: "loading" } | { kind: "error" } | { kind: "success"; careChanges: unknown[] };

function draw(seed: Seed) {
  // No refetch on mount: the seeded state is the state that renders.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  if (seed.kind === "success") {
    client.setQueryData(KEY, { gaps: [], clash: null, careChanges: seed.careChanges });
  } else if (seed.kind === "error") {
    client
      .getQueryCache()
      .build(client, { queryKey: KEY })
      .setState({
        status: "error",
        fetchStatus: "idle",
        error: new Error("network"),
        errorUpdatedAt: Date.now(),
      });
  }
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ConfirmStayButton, { stayId: STAY, clientId: "c1" }),
      ),
    );
  } finally {
    client.clear();
  }
}

/** The Confirm button's opening tag. Its label changes while loading. */
function confirmButton(html: string): string {
  const m = /<button[^>]*>(?:Confirm stay|Checking…)<\/button>/.exec(html);
  if (!m) throw new Error(`no Confirm button in ${html}`);
  return m[0];
}
const disabled = (tag: string) => /\sdisabled=""/.test(tag);

describe("Confirm waits until the office has seen the request's care changes", () => {
  it("is off while the request's details load", () => {
    const html = draw({ kind: "loading" });
    expect(confirmButton(html)).toContain("Checking…");
    expect(disabled(confirmButton(html))).toBe(true);
    expect(html).not.toContain("data-stay-check-failed");
  });

  it("is off with an error and a retry when the read fails", () => {
    const html = draw({ kind: "error" });
    expect(disabled(confirmButton(html))).toBe(true);
    expect(html).toContain("data-stay-check-failed");
    expect(html).toMatch(/>Try again<\/button>/);
    expect(html).not.toContain("data-stay-care-changes");
  });

  it("is on once the read succeeds, with the staged care shown and said to apply now", () => {
    const html = draw({
      kind: "success",
      careChanges: [
        {
          petId: "p1",
          petName: "Luna",
          meds: [{ name: "Insulin", dose: "4 units", times: ["08:00", "20:00"], notes: null }],
        },
      ],
    });
    expect(disabled(confirmButton(html))).toBe(false);
    expect(html).toContain("data-stay-care-changes");
    expect(html).toContain("Insulin, 4 units, at 8 AM, 8 PM");
    expect(html).toMatch(/puts them on the sitter&#x27;s card now/);
    expect(html).not.toContain("data-stay-check-failed");
  });

  it("is on as before when the request carries no care changes", () => {
    const html = draw({ kind: "success", careChanges: [] });
    expect(disabled(confirmButton(html))).toBe(false);
    expect(html).not.toContain("data-stay-care-changes");
    expect(html).not.toContain("data-stay-check-failed");
  });
});
