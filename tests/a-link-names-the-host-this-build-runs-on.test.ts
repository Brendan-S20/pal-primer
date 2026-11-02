// #660 (R2-15 / F-30). Portal, pay, signup-form, embed, Preview and Download
// PDF links were built in the browser with `appUrl()`, which reads the
// server's environment. A browser has none, so every one of them named
// app.houndstack.com: on localhost, on staging, and in a native build pointed
// at a local API. Android then left the app for Chrome and reached production
// with tokens that only existed locally.
//
// The fix is `linkUrl()` / `linkOrigin()` in src/lib/app-origin.ts. This file
// pins the rule it follows, the call sites that use it, and the two native
// hand-offs that no longer leave the app: the PDF is saved and shared from
// the bytes the server function already returned, and the portal opens in a
// sheet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLinkOrigin } from "@/lib/app-origin";
import { nativePdfName } from "@/lib/pdf-file-name";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l))
    .join("\n");

const FALLBACK = "https://app.houndstack.com";
const page = (origin: string) => {
  const u = new URL(origin);
  return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
};
const web = (origin: string) =>
  resolveLinkOrigin({
    location: page(origin),
    nativeApiOrigin: "",
    nativeBundle: false,
    fallback: FALLBACK,
  });

describe("a link built in the browser names the host this build runs on", () => {
  it("is the dev server on localhost", () => {
    expect(web("http://localhost:8080")).toBe("http://localhost:8080");
    expect(web("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("is a live-reload native build's dev server on the LAN", () => {
    expect(web("http://192.168.1.20:8080")).toBe("http://192.168.1.20:8080");
  });

  it("is the staging host on staging, and production on production", () => {
    expect(web("https://staging.houndstack.com")).toBe("https://staging.houndstack.com");
    expect(web("https://app.houndstack.com")).toBe("https://app.houndstack.com");
  });

  it("is the canonical host on a Lovable preview, which stops serving", () => {
    expect(web("https://id-preview--abc.lovable.app")).toBe(FALLBACK);
    expect(web("https://abc.lovableproject.com")).toBe(FALLBACK);
    expect(web("https://abc.lovable.dev")).toBe(FALLBACK);
  });

  it("is the build's API origin in a native bundle, never the bundle's own origin", () => {
    for (const bundle of ["capacitor://localhost", "https://localhost"]) {
      expect(
        resolveLinkOrigin({
          location: page(bundle),
          nativeApiOrigin: "http://10.0.2.2:8080/",
          nativeBundle: true,
          fallback: FALLBACK,
        }),
      ).toBe("http://10.0.2.2:8080");
    }
  });

  it("never returns a bundle origin, even with no API origin baked in", () => {
    expect(
      resolveLinkOrigin({
        location: page("https://localhost"),
        nativeApiOrigin: "",
        nativeBundle: true,
        fallback: FALLBACK,
      }),
    ).toBe(FALLBACK);
    expect(
      resolveLinkOrigin({
        location: {
          protocol: "capacitor:",
          hostname: "localhost",
          origin: "capacitor://localhost",
        },
        nativeApiOrigin: "",
        nativeBundle: false,
        fallback: FALLBACK,
      }),
    ).toBe(FALLBACK);
  });

  it("is the server's answer where there is no page", () => {
    expect(
      resolveLinkOrigin({
        location: null,
        nativeApiOrigin: "",
        nativeBundle: false,
        fallback: "https://x.example",
      }),
    ).toBe("https://x.example");
  });
});

// The screens a staffer builds a link on. Each was on appUrl/appOrigin, which
// in a browser is always the production fallback.
const CALL_SITES = [
  "src/components/client-detail/ClientHeader.tsx",
  "src/components/client-detail/comms-panels.tsx",
  "src/components/client-detail/ReviewsReferralsTab.tsx",
  "src/components/InvoiceDrawer.tsx",
  "src/components/InvoiceRow.tsx",
  "src/components/settings/ClientPortalCards.tsx",
  "src/components/signup/SignupFlow.tsx",
  "src/routes/_authenticated/invoices.$invoiceId.tsx",
  "src/routes/_authenticated/quotes.$quoteId.tsx",
  "src/routes/_authenticated/settings.online-signup.tsx",
  "src/routes/_authenticated/leads.tsx",
  "src/routes/platform.invites.tsx",
];

describe("the staff screens build links with linkUrl", () => {
  it.each(CALL_SITES)("%s", (file) => {
    const src = codeOnly(read(file));
    expect(src).toMatch(/\blink(Url|Origin)\(/);
    expect(src).not.toMatch(/\bapp(Url|Origin)\(/);
  });

  it("the signup page's link and embed code come from linkOrigin at render", () => {
    const src = read("src/routes/_authenticated/settings.online-signup.tsx");
    expect(src).toMatch(/const APP_ORIGIN = linkOrigin\(\);/);
    expect(src).toMatch(/<iframe src="\$\{publicUrl\}\?embed=1"/);
  });
});

describe("Download PDF stays in the native app", () => {
  const button = read("src/components/DownloadPdfButton.tsx");

  it("saves the server function's bytes and opens the share sheet", () => {
    const code = codeOnly(button);
    expect(code).toMatch(/import\("@capacitor\/filesystem"\)/);
    expect(code).toMatch(/import\("@capacitor\/share"\)/);
    expect(code).toMatch(/directory: Directory\.Cache/);
    expect(code).toMatch(
      /if \(isNative\(\)\) await shareNativePdf\(file\.filename, file\.base64\);/,
    );
  });

  it("does not hand a PDF link to the browser", () => {
    expect(codeOnly(button)).not.toMatch(/@capacitor\/browser|Browser\.open|nativeUrl/);
    for (const f of [
      "src/components/InvoiceDrawer.tsx",
      "src/routes/_authenticated/invoices.$invoiceId.tsx",
      "src/routes/_authenticated/quotes.$quoteId.tsx",
    ]) {
      expect(codeOnly(read(f)), f).not.toMatch(/nativeUrl|\/api\/public\/(invoice|quote)-pdf/);
    }
  });

  it("names the file something every share target accepts", () => {
    expect(nativePdfName("Invoice INV-0042.pdf")).toBe("Invoice-INV-0042.pdf");
    expect(nativePdfName("../../etc/passwd")).toBe("etc-passwd.pdf");
    expect(nativePdfName("Quote: Smith & Sons / 2026.PDF")).toBe("Quote-Smith-Sons-2026.pdf");
    expect(nativePdfName("")).toBe("document.pdf");
  });

  it("the plugins are registered on both platforms", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["@capacitor/filesystem"]).toBeTruthy();
    expect(pkg.dependencies["@capacitor/share"]).toBeTruthy();
    const gradle = read("android/capacitor.settings.gradle");
    expect(gradle).toMatch(/include ':capacitor-filesystem'/);
    expect(gradle).toMatch(/include ':capacitor-share'/);
    const spm = read("ios/App/CapApp-SPM/Package.swift");
    expect(spm).toMatch(/CapacitorFilesystem/);
    expect(spm).toMatch(/CapacitorShare/);
    // The share sheet reads the cache through the app's FileProvider.
    expect(read("android/app/src/main/res/xml/file_paths.xml")).toMatch(/<cache-path /);
  });
});

describe("the portal opens in a sheet inside the app", () => {
  const header = codeOnly(read("src/components/client-detail/ClientHeader.tsx"));

  it("Preview and Open portal both open the sheet, not a window", () => {
    expect(header).toMatch(/<PortalPreviewSheet/);
    expect(header).toMatch(/setPortalSheet\(\{ src: portalPath, preview: true \}\)/);
    expect(header).not.toMatch(/window\.open\(portalUrl/);
    expect(header).not.toMatch(/location\.href = portalUrl/);
  });

  it("the web preview frame loads from this origin, so it carries the preview session", () => {
    // portalPath is a path; only the native build uses the absolute linkUrl.
    expect(header).toMatch(/src: IS_NATIVE_BUNDLE \? portalUrl : portalPath/);
  });
});
