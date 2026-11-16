// Every permission the iOS app can trigger has a usage string in Info.plist.
//
// ── WHY ───────────────────────────────────────────────────────────────────
//
// iOS terminates an app, on the spot and with no prompt, the first time it
// touches a privacy-protected API (camera, photos, location, Bluetooth,
// microphone, contacts, Face ID) without the matching NS…UsageDescription
// in Info.plist. That is a crash on a device and a rejection at review, and
// nothing on the web side can see it: the call is made by a plugin's
// native code. #726 (Apple's launch-crash rejection of 1.0 build 465 on an
// iPad Air) had no crash log, and this is one of the causes a static check
// CAN rule out, so it is checked here rather than assumed.
//
// ── WHERE THE REQUIRED KEYS COME FROM ─────────────────────────────────────
//
// Not from a hand list of keys, which drifts the day a plugin is added. The
// required set is DERIVED from what is in the repo now:
//   - package.json: each installed Capacitor plugin maps to the keys its
//     native code can trigger, and every installed plugin must be in that
//     map — with keys, or explicitly with none — so a new plugin cannot be
//     added without somebody deciding what it needs.
//   - src/: a capture= image input, getUserMedia, MediaRecorder, a file
//     input accepting video/ or audio/, navigator.geolocation, a camera
//     call that saves to the gallery, a request for "always" location.
//   - ios/App/App/**/*.swift: the framework classes that prompt.
// Then Info.plist is parsed and each required key must hold a non-empty
// string.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ── A small plist reader: the top-level <dict> of an XML property list ────

type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue };

function parsePlist(xml: string): Record<string, PlistValue> {
  const body = xml
    .replace(/<\?xml[\s\S]*?\?>/, "")
    .replace(/<!DOCTYPE[\s\S]*?>/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const open = /^\s*<plist(\s[^>]*)?>/.exec(body);
  if (!open || !/<\/plist>\s*$/.test(body)) throw new Error("plist: no <plist> root");
  const tokens =
    body
      .slice(open[0].length)
      .replace(/<\/plist>\s*$/, "")
      .match(/<\/?[A-Za-z]+\s*\/?>|[^<]+/g) ?? [];
  let i = 0;
  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const skipText = () => {
    while (i < tokens.length && !tokens[i].startsWith("<") && tokens[i].trim() === "") i++;
  };
  const textUntil = (close: string): string => {
    let s = "";
    while (i < tokens.length && tokens[i] !== close) s += tokens[i++];
    if (tokens[i] !== close) throw new Error(`plist: missing ${close}`);
    i++;
    return unescape(s);
  };
  const value = (): PlistValue => {
    skipText();
    const tag = tokens[i++];
    switch (tag.replace(/\s+/g, "")) {
      case "<string/>":
        return "";
      case "<string>":
        return textUntil("</string>");
      case "<integer>":
      case "<real>":
        return Number(textUntil(tag.replace("<", "</")));
      case "<true/>":
        return true;
      case "<false/>":
        return false;
      case "<date>":
        return textUntil("</date>");
      case "<data>":
        return textUntil("</data>").replace(/\s+/g, "");
      case "<array/>":
        return [];
      case "<dict/>":
        return {};
      case "<array>": {
        const out: PlistValue[] = [];
        for (;;) {
          skipText();
          if (tokens[i] === "</array>") {
            i++;
            return out;
          }
          out.push(value());
        }
      }
      case "<dict>": {
        const out: Record<string, PlistValue> = {};
        for (;;) {
          skipText();
          if (tokens[i] === "</dict>") {
            i++;
            return out;
          }
          if (tokens[i++] !== "<key>")
            throw new Error(`plist: expected <key>, got ${tokens[i - 1]}`);
          const key = textUntil("</key>");
          out[key] = value();
        }
      }
      default:
        throw new Error(`plist: unexpected ${tag}`);
    }
  };
  const top = value();
  if (typeof top !== "object" || Array.isArray(top)) throw new Error("plist: root is not a dict");
  return top as Record<string, PlistValue>;
}

// ── What can trigger a permission ─────────────────────────────────────────

/**
 * Every Capacitor plugin installed must be listed here: with the usage keys
 * its native iOS code can trigger, or with [] when it triggers none. A new
 * plugin that is not listed fails the test, so its keys are decided once,
 * when it is added, instead of discovered on a device.
 */
const PLUGIN_KEYS: Record<string, string[]> = {
  // Takes photos and picks them from the library.
  "@capacitor/camera": ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"],
  "@capacitor/geolocation": ["NSLocationWhenInUseUsageDescription"],
  // The Stripe Terminal SDK talks to readers over Bluetooth and checks the
  // phone's location for every payment, as card networks require.
  "@capacitor-community/stripe-terminal": [
    "NSBluetoothAlwaysUsageDescription",
    "NSLocationWhenInUseUsageDescription",
  ],
  // Plugins that would need keys if they were ever installed.
  "@capacitor-mlkit/barcode-scanning": ["NSCameraUsageDescription"],
  "@capacitor-community/barcode-scanner": ["NSCameraUsageDescription"],
  "@capacitor-community/contacts": ["NSContactsUsageDescription"],
  "@capacitor-community/bluetooth-le": ["NSBluetoothAlwaysUsageDescription"],
  "@capacitor-community/speech-recognition": [
    "NSMicrophoneUsageDescription",
    "NSSpeechRecognitionUsageDescription",
  ],
  "@capacitor-community/media": [
    "NSPhotoLibraryUsageDescription",
    "NSPhotoLibraryAddUsageDescription",
  ],
  "@capgo/capacitor-native-biometric": ["NSFaceIDUsageDescription"],
  "@aparajita/capacitor-biometric-auth": ["NSFaceIDUsageDescription"],
  // No privacy-protected API.
  "@capacitor-community/apple-sign-in": [],
  "@capacitor-community/in-app-review": [],
  "@capacitor/app": [],
  "@capacitor/browser": [],
  "@capacitor/filesystem": [], // the app's own container only
  "@capacitor/haptics": [],
  "@capacitor/network": [],
  "@capacitor/preferences": [],
  "@capacitor/push-notifications": [], // asks at runtime; no Info.plist key
  "@capacitor/share": [],
  "@capacitor/splash-screen": [],
  "@capacitor/status-bar": [],
};
/** The runtime and tooling, not plugins. */
const NOT_PLUGINS = new Set([
  "@capacitor/core",
  "@capacitor/cli",
  "@capacitor/ios",
  "@capacitor/android",
]);

/** Swift framework classes whose use prompts, and the key each needs. */
const SWIFT_KEYS: [RegExp, string[]][] = [
  [/\bAVCaptureDevice\b/, ["NSCameraUsageDescription"]],
  [/\bPHPhotoLibrary\b/, ["NSPhotoLibraryUsageDescription"]],
  [/\bCLLocationManager\b/, ["NSLocationWhenInUseUsageDescription"]],
  [/\bCBCentralManager\b/, ["NSBluetoothAlwaysUsageDescription"]],
  [/\bCNContactStore\b/, ["NSContactsUsageDescription"]],
  [/\bLAContext\b/, ["NSFaceIDUsageDescription"]],
];

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function walk(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel, ext));
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

interface Requirement {
  key: string;
  because: string;
}

function requiredKeys(): Requirement[] {
  const req: Requirement[] = [];
  const need = (keys: string[], because: string) => {
    for (const key of keys) req.push({ key, because });
  };

  // package.json
  const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
    (n) => /capacitor/.test(n) && !NOT_PLUGINS.has(n),
  );
  for (const name of installed) {
    const keys = PLUGIN_KEYS[name];
    if (!keys) {
      throw new Error(
        `${name} is installed but not in PLUGIN_KEYS: decide which Info.plist usage keys its iOS code can trigger (or [] for none) and add it`,
      );
    }
    need(keys, `package.json installs ${name}`);
  }

  // src/
  const srcFiles = walk("src", /\.(ts|tsx)$/);
  for (const file of srcFiles) {
    const code = codeOnly(read(file));
    if (/\bsaveToGallery\s*:\s*true\b/.test(code)) {
      need(["NSPhotoLibraryAddUsageDescription"], `${file} saves camera photos to the gallery`);
    }
    if (/requestAlwaysAuthorization|backgroundLocation|["']always["']\s*[,)}]/.test(code)) {
      if (/geolocation|location/i.test(code)) {
        need(
          ["NSLocationAlwaysAndWhenInUseUsageDescription"],
          `${file} asks for "always" location`,
        );
      }
    }
    if (/\bgetUserMedia\b|\bMediaRecorder\b/.test(code)) {
      need(["NSMicrophoneUsageDescription", "NSCameraUsageDescription"], `${file} records media`);
    }
    // A file input whose accept list (literal, or a MIME table in the same
    // file) names video or audio: the picker offers to record one.
    if (/type=["']file["']/.test(code)) {
      if (/["'`][^"'`]*\bvideo\/[^"'`]*["'`]/.test(code)) {
        need(
          ["NSMicrophoneUsageDescription", "NSCameraUsageDescription"],
          `${file} has a file input that accepts video`,
        );
      }
      if (/["'`][^"'`]*\baudio\/[^"'`]*["'`]/.test(code)) {
        need(["NSMicrophoneUsageDescription"], `${file} has a file input that accepts audio`);
      }
    }
    if (/\bcapture=(["'{])/.test(code)) {
      need(["NSCameraUsageDescription"], `${file} has a capture= input that opens the camera`);
    }
    if (/\bnavigator\.geolocation\b/.test(code)) {
      need(["NSLocationWhenInUseUsageDescription"], `${file} uses navigator.geolocation`);
    }
  }

  // Swift in the app target
  for (const file of walk("ios/App/App", /\.swift$/)) {
    const code = codeOnly(read(file));
    for (const [pattern, keys] of SWIFT_KEYS) {
      if (pattern.test(code)) need(keys, `${file} uses ${pattern.source.replace(/\\b/g, "")}`);
    }
  }
  return req;
}

function missingUsageStrings(plistXml: string, req: Requirement[]): string[] {
  const plist = parsePlist(plistXml);
  const missing = new Map<string, string[]>();
  for (const { key, because } of req) {
    const v = plist[key];
    if (typeof v === "string" && v.trim() !== "") continue;
    missing.set(key, [...(missing.get(key) ?? []), because]);
  }
  return [...missing].map(([key, why]) => `${key} (needed: ${[...new Set(why)].join("; ")})`);
}

// ── The checks ────────────────────────────────────────────────────────────

describe("the plist reader", () => {
  it("reads strings, booleans, arrays, nested dicts and empty strings", () => {
    const p = parsePlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>A</key><string>x &amp; y</string>
  <key>B</key><true/>
  <key>C</key><array><string>1</string><dict><key>D</key><string/></dict></array>
  <key>E</key><string></string>
</dict></plist>`);
    expect(p.A).toBe("x & y");
    expect(p.B).toBe(true);
    expect(p.C).toEqual(["1", { D: "" }]);
    expect(p.E).toBe("");
  });

  it("parses the app's Info.plist and finds the scene manifest", () => {
    const p = parsePlist(read("ios/App/App/Info.plist"));
    expect(p.UIApplicationSceneManifest).toBeTypeOf("object");
    expect(p.CFBundleDisplayName).toBe("HoundStack");
  });
});

describe("the required keys are derived from the repo", () => {
  const req = requiredKeys();
  const keys = new Set(req.map((r) => r.key));

  it("finds what the app uses today", () => {
    // If one of these stops being required, the repo changed, not the test.
    expect(keys).toContain("NSCameraUsageDescription"); // @capacitor/camera, capture=
    expect(keys).toContain("NSPhotoLibraryUsageDescription"); // @capacitor/camera
    expect(keys).toContain("NSLocationWhenInUseUsageDescription"); // geolocation, Stripe
    expect(keys).toContain("NSBluetoothAlwaysUsageDescription"); // Stripe Terminal
    expect(req.some((r) => r.because.includes("capture="))).toBe(true);
    expect(req.some((r) => r.because.includes("navigator.geolocation"))).toBe(true);
  });
});

describe("Info.plist has a usage string for every permission the app can trigger", () => {
  it("has a non-empty usage string for every required key", () => {
    expect(missingUsageStrings(read("ios/App/App/Info.plist"), requiredKeys())).toEqual([]);
  });

  it("fails a plist missing NSCameraUsageDescription", () => {
    const fixture = read("tests/fixtures/ios-info-plist/missing-camera.plist");
    const missing = missingUsageStrings(fixture, requiredKeys());
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/^NSCameraUsageDescription \(needed: .*@capacitor\/camera/);
  });

  it("treats an empty usage string as missing", () => {
    const blank = read("ios/App/App/Info.plist").replace(
      /(<key>NSBluetoothAlwaysUsageDescription<\/key>\s*)<string>[^<]*<\/string>/,
      "$1<string>  </string>",
    );
    expect(missingUsageStrings(blank, requiredKeys())).toEqual([
      expect.stringMatching(/^NSBluetoothAlwaysUsageDescription /),
    ]);
  });
});
