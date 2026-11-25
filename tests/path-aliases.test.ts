import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aliasHref, PATH_ALIASES } from "../src/lib/path-alias";

describe("sign-in / sign-up path aliases (#1041)", () => {
  it("sends the sign-in paths to /auth and /signup to /sign-up", () => {
    expect(PATH_ALIASES["/sign-in"]).toBe("/auth");
    expect(PATH_ALIASES["/signin"]).toBe("/auth");
    expect(PATH_ALIASES["/login"]).toBe("/auth");
    expect(PATH_ALIASES["/signup"]).toBe("/sign-up");
  });

  it("keeps the query string byte for byte", () => {
    expect(aliasHref("/sign-up", "?ref=12e3&utm_source=a%20b&email=x%2By@z.co")).toBe(
      "/sign-up?ref=12e3&utm_source=a%20b&email=x%2By@z.co",
    );
    expect(aliasHref("/auth", "ref=ab")).toBe("/auth?ref=ab");
  });

  it("adds no ? when there is no query", () => {
    expect(aliasHref("/auth", "")).toBe("/auth");
    expect(aliasHref("/auth", "?")).toBe("/auth");
    expect(aliasHref("/auth", null)).toBe("/auth");
  });

  it("registers each alias route, and /signup as an index so /signup/$slug and /signup/success stay children of root", () => {
    const tree = readFileSync("src/routeTree.gen.ts", "utf8");
    for (const p of ["/sign-in", "/signin", "/login", "/signup/"]) {
      expect(tree).toContain(`path: '${p}'`);
    }
    expect(tree).toContain("'/signup/$slug'");
    expect(tree).toContain("'/signup/success'");
  });
});
