// The Intuit client id and secret come only from the server's environment.
//
// Intuit's assessment asks where the client secret is kept. The answer is
// "only in the server's env, read in one server-only file", and this holds
// src/ to it: QBO_CLIENT_ID and QBO_CLIENT_SECRET are read in
// src/lib/qbo-config.server.ts and nowhere else; nothing spells them
// VITE_QBO_* or reads them from import.meta.env (which Vite inlines into the
// browser bundle); and that file is only ever loaded from server code.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

const ROOT = join(import.meta.dirname, "..");
const CONFIG = "src/lib/qbo-config.server.ts";

function sourceFiles(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

const files = sourceFiles().map((p) => ({ rel: repoRelative(p, ROOT), src: readFileSync(p, "utf8") }));

describe("the Intuit credentials", () => {
  it("are read in exactly one file, which is server-only", () => {
    const readers = files.filter((f) => /QBO_CLIENT_(ID|SECRET)/.test(f.src)).map((f) => f.rel);
    expect(readers).toEqual([CONFIG]);
    expect(CONFIG).toMatch(/\.server\.ts$/);
  });

  it("are never given a name or a read that ships them to the browser", () => {
    for (const f of files) {
      expect(f.src, f.rel).not.toMatch(/VITE_QBO|import\.meta\.env\.QBO|import\.meta\.env\[["']QBO/);
    }
  });

  it("are loaded only by server code", () => {
    // Static imports from a client file would put the module (and anything it
    // closes over) in the client graph. Allowed: other .server files, the API
    // routes, and the dynamic import inside a server function's handler.
    for (const f of files.filter((f) => f.src.includes("qbo-config.server"))) {
      if (f.rel === CONFIG) continue;
      const serverOnly = /\.server\.ts$/.test(f.rel) || f.rel.startsWith("src/routes/api/");
      if (serverOnly) continue;
      expect(f.rel, `${f.rel} imports qbo-config.server`).toMatch(/\.functions\.ts$/);
      expect(f.src, `${f.rel} imports qbo-config.server statically`).not.toMatch(
        /^import[^;]*from\s+["']@\/lib\/qbo-config\.server["']/m,
      );
    }
  });

  it("never reach the browser in a response: the status function returns a yes/no", () => {
    const fns = files.find((f) => f.rel === "src/lib/accounting.functions.ts")!.src;
    expect(fns).toMatch(/configured: qboCredentials\(\) !== null/);
    expect(fns).not.toMatch(/clientSecret|clientId/);
  });
});

describe("the tokens", () => {
  it("are never logged", () => {
    // Every console call in the QuickBooks modules, checked for anything
    // that could hold a credential.
    const qbo = files.filter((f) => /src\/lib\/(qbo-[^/]+|accounting[^/]*)\.ts$|qbo-callback\.ts$/.test(f.rel));
    expect(qbo.length).toBeGreaterThan(5);
    for (const f of qbo) {
      for (const m of f.src.matchAll(/console\.\w+\(([^;]*)\);/g)) {
        // The words in a message are fine ("token exchange failed"); what is
        // passed beside them is what gets printed. Strings out, then no
        // argument may name a token, the secret, a request or response body,
        // or the bare OAuth `code`.
        const args = m[1].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "");
        expect(args, `${f.rel}: ${m[0].slice(0, 100)}`).not.toMatch(
          /token|secret|credential|authorization|basic|body|refresh|access|(?<![.\w])code\b|\bconn\b|\btok\b|\bdeps\b/i,
        );
      }
    }
  });
});
