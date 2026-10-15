import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

it("client-only aliases navigate after mount instead of throwing during hydration", () => {
  const root = fileURLToPath(new URL("../src/routes/_authenticated", import.meta.url));
  const files = readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith(".tsx"));
  const aliases = files.filter((file) =>
    readFileSync(join(root, String(file)), "utf8").includes("<RedirectFallback"),
  );
  expect(aliases.length).toBeGreaterThanOrEqual(5);
  for (const file of aliases) {
    const source = readFileSync(join(root, String(file)), "utf8");
    expect(source, String(file)).toMatch(/clientRedirect: true/);
    expect(source, String(file)).not.toMatch(/beforeLoad\s*:/);
    expect(source, String(file)).not.toMatch(/\bredirect\s*\(/);
  }
});
