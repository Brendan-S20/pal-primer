// A route's notFoundComponent is a function of its own (#630).
//
// The router's code splitter moves `notFoundComponent` into a chunk of its own
// (`?tsr-split=notFoundComponent`). When the function named there is ALSO used
// elsewhere in the file (say, rendered by the page component when a lookup
// comes back empty), the split leaves `SplitNotFoundComponent` undefined and
// the production build fails:
//
//   [PARSE_ERROR] Export 'SplitNotFoundComponent' is not defined
//     src/routes/pros.$slug.quote.tsx?tsr-split=notFoundComponent
//
// That is what the bun (Lovable) build reported for the directory's
// /pros/$slug and /pros/$slug/quote on #760. The dev server, typecheck and
// every test were green, and the npm build passed on another machine, so
// only the publish path found it. signup.$slug.tsx already does it right:
// `notFoundComponent: SignupPageUnavailable`, a wrapper that only renders
// the shared `<Unavailable />`.
//
// The rule: the identifier named in `notFoundComponent:` appears exactly twice
// in its file, once there and once where it is declared.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative } from "./support/repo-paths";

const ROOT = join(import.meta.dirname, "..");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : /\.tsx$/.test(f) ? [p] : [];
  });
}

/** Every `notFoundComponent: Name` in a file whose Name is used anywhere else. */
export function sharedNotFoundComponents(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/notFoundComponent:\s*([A-Za-z_$][\w$]*)\s*[,}\n]/g)) {
    const name = m[1];
    const uses = src.match(new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g"));
    if ((uses?.length ?? 0) > 2) out.push(name);
  }
  return out;
}

describe("a route's notFoundComponent is a function of its own", () => {
  it("finds the routes that declare one, so a green run means checked", () => {
    const files = routeFiles(join(ROOT, "src/routes")).filter((f) =>
      readFileSync(f, "utf8").includes("notFoundComponent:"),
    );
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("is never also used by the page it belongs to", () => {
    const offenders = routeFiles(join(ROOT, "src/routes")).flatMap((f) =>
      sharedNotFoundComponents(readFileSync(f, "utf8")).map(
        (n) =>
          `${repoRelative(f, ROOT)}: notFoundComponent ${n} is also used elsewhere in the file. ` +
          `Give the route a wrapper of its own (function ${n}Route() { return <${n} />; }).`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("catches the shape that broke the bun build, and passes the fix", () => {
    const broken = `
      export const Route = createFileRoute("/x")({ component: Page, notFoundComponent: NotListed });
      function Page() { if (!data) return <NotListed />; return null; }
      function NotListed() { return <p>gone</p>; }`;
    expect(sharedNotFoundComponents(broken)).toEqual(["NotListed"]);
    const fixed = `
      export const Route = createFileRoute("/x")({ component: Page, notFoundComponent: NotListedRoute });
      function Page() { if (!data) return <NotListed />; return null; }
      function NotListed() { return <p>gone</p>; }
      function NotListedRoute() { return <NotListed />; }`;
    expect(sharedNotFoundComponents(fixed)).toEqual([]);
  });
});
