// #784: Create client on a second client, at a manual price after "No zone
// matches", did nothing anyone could see. The browser half is
// tests/e2e/a-second-client-with-a-manual-price-is-created.spec.ts; these are
// the two pieces of it that need no server.

import { describe, expect, it } from "vitest";

import { createFailedMessage } from "@/lib/create-client-error";
import { typedPriceCents } from "@/lib/typed-price";

describe("a price typed into the $ box", () => {
  it.each([
    ["20", 2000],
    ["$20", 2000],
    ["$ 20", 2000],
    [" 20.00 ", 2000],
    ["19.999", 2000],
    ["1,200", 120000],
    [".5", 50],
    ["20.", 2000],
  ])("%j is %d cents", (typed, cents) => {
    expect(typedPriceCents(typed)).toBe(cents);
  });

  it.each(["", " ", "$", "0", "$0.00", "-5", "abc", "20abc", "1.2.3", "$$20"])(
    "%j is no price",
    (typed) => {
      expect(typedPriceCents(typed)).toBeNull();
    },
  );
});

describe("what stays under Create client when it did not finish", () => {
  it("passes the server's own reason through", () => {
    expect(
      createFailedMessage(
        new Error("Your free trial has ended. Choose a plan to keep adding customers."),
        "Your free trial has ended. Choose a plan to keep adding customers.",
      ),
    ).toBe(
      "Create client did not finish. Your free trial has ended. Choose a plan to keep adding customers.",
    );
  });

  it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])(
    "a request with no answer (%s) says to check before trying again",
    (msg) => {
      const text = createFailedMessage(new TypeError(msg));
      expect(text).toMatch(/did not finish/);
      expect(text).toMatch(/check clients/i);
      expect(text).not.toContain(msg);
    },
  );

  it("an answer with no client in it is not a client", () => {
    expect(createFailedMessage(null)).toMatch(/did not finish/);
  });
});
