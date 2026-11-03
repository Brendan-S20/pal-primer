// What a cold launch of the app shows before anyone has signed in, from the
// native round-2 audit (Pixel 10a and iPhone Duo, shipped bundle):
//
//   native-r2-01  in Android dark mode the status bar was white icons on the
//                 cream sign-in page, until the signed-in shell set a style;
//   R2-56         the email field autofocused, so the keyboard came up over
//                 the splash, and flashed over the dashboard on a signed-in
//                 launch on its way through /auth.
//
// And one from the iPad pass: native-r2-10, the Invoices period date fields
// ran into each other because their wrappers had no width.
//
// Source checks: the outcomes (contrast, no keyboard) are device checks
// listed on the PR.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the status bar before the shell (native-r2-01)", () => {
  it("Android's app theme asks for dark icons from the first frame", () => {
    const xml = read("android/app/src/main/res/values/styles.xml");
    const theme = xml.slice(
      xml.indexOf('<style name="AppTheme.NoActionBar"'),
      xml.indexOf("</style>", xml.indexOf('<style name="AppTheme.NoActionBar"')),
    );
    expect(theme).toMatch(/<item name="android:windowLightStatusBar">true<\/item>/);
  });

  it("the root sets the style on boot, not only the signed-in shell", () => {
    expect(codeOnly(read("src/routes/__root.tsx"))).toMatch(/m\.initStatusBar\(\)/);
    expect(codeOnly(read("src/routes/_authenticated/route.tsx"))).toMatch(
      /native\.initStatusBar\(\)/,
    );
  });
});

describe("no keyboard on launch (R2-56)", () => {
  it("the email field autofocuses on the web only", () => {
    const src = codeOnly(read("src/routes/auth.tsx"));
    const email = src.slice(
      src.indexOf('id="si-email"'),
      src.indexOf("/>", src.indexOf('id="si-email"')),
    );
    expect(email).toMatch(/autoFocus=\{!IS_NATIVE_BUNDLE\}/);
    expect(email).not.toMatch(/autoFocus\s*\n/);
  });
});

describe("the Invoices period fields (native-r2-10)", () => {
  it("each date field's wrapper has a width and does not shrink", () => {
    const src = read("src/routes/_authenticated/invoices.index.tsx");
    for (const id of ["invoices-from", "invoices-to"]) {
      const at = src.indexOf(`htmlFor="${id}"`);
      const wrapper = src.slice(src.lastIndexOf("<div", at), at);
      expect(wrapper, id).toMatch(/className="w-40 shrink-0"/);
      const input = src.slice(
        src.indexOf(`id="${id}"`),
        src.indexOf("/>", src.indexOf(`id="${id}"`)),
      );
      expect(input, id).toMatch(/className=\{DATE_FILTER_INPUT\}/);
    }
    expect(src).toMatch(/const DATE_FILTER_INPUT = "min-w-0 appearance-none";/);
  });
});
