// Apple rejects an upload that calls a "required reason" API without saying
// why (ITMS-91053), and the App Privacy label has to agree with what the app
// declares. Issue #488. The app ships no manifest of its own until this one:
// only Capacitor core has a PrivacyInfo.xcprivacy, and none of the plugins do.
//
// The collected data types below MUST match the App Privacy label in
// /workspace/shared/houndstack-golive/app-store-privacy-label.md, under
// "Final list to enter in App Store Connect". Update both together. The label
// is a legal statement, and so is this file.
//
// The API reasons come from a scan of the native sources:
// - UserDefaults, CA92.1: @capacitor/preferences (UserDefaults.standard) and
//   @capacitor-community/apple-sign-in (UserDefaults()).
// - FileTimestamp, C617.1: @capacitor/camera's ion-ios-camera reads the
//   creation date of the photo it just wrote to NSTemporaryDirectory. That
//   library has its own manifest, but its Package.swift does not ship it.
//   @capacitor/filesystem (#660, saving a PDF to share) reads creation and
//   modification dates of files in the app's own cache: same category, same
//   reason.
// When a native dependency is added or upgraded, rescan it.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MANIFEST = "ios/App/App/PrivacyInfo.xcprivacy";
const PROJECT = "ios/App/App.xcodeproj/project.pbxproj";

const COLLECTED = [
  "NSPrivacyCollectedDataTypeName",
  "NSPrivacyCollectedDataTypeEmailAddress",
  "NSPrivacyCollectedDataTypePhoneNumber",
  "NSPrivacyCollectedDataTypePhysicalAddress",
  "NSPrivacyCollectedDataTypePaymentInfo",
  "NSPrivacyCollectedDataTypeOtherFinancialInfo",
  "NSPrivacyCollectedDataTypePreciseLocation",
  "NSPrivacyCollectedDataTypeEmailsOrTextMessages",
  "NSPrivacyCollectedDataTypePhotosorVideos",
  "NSPrivacyCollectedDataTypeOtherUserContent",
  "NSPrivacyCollectedDataTypeUserID",
  "NSPrivacyCollectedDataTypeDeviceID",
  "NSPrivacyCollectedDataTypePurchaseHistory",
  "NSPrivacyCollectedDataTypeCrashData",
  "NSPrivacyCollectedDataTypeOtherDiagnosticData",
];

const manifest = () => readFileSync(MANIFEST, "utf8");

// The text between <key>name</key><array> and its closing </array>, counting
// nested arrays so a dict's Purposes array does not end it early.
function arrayAfter(plist: string, key: string): string | null {
  const open = new RegExp(`<key>${key}</key>\\s*<array>`).exec(plist);
  if (!open) return null;
  let depth = 1;
  const tag = /<array>|<\/array>/g;
  tag.lastIndex = open.index + open[0].length;
  for (let m = tag.exec(plist); m; m = tag.exec(plist)) {
    depth += m[0] === "<array>" ? 1 : -1;
    if (depth === 0) return plist.slice(open.index + open[0].length, m.index);
  }
  return null;
}

const dicts = (array: string) => array.split("<dict>").slice(1);
const stringAfter = (dict: string, key: string) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(dict)?.[1] ?? null;
const boolAfter = (dict: string, key: string) => {
  const m = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(dict);
  return m ? m[1] === "true" : null;
};
const strings = (text: string) => [...text.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);

function reasonsFor(category: string): string[] | null {
  const array = arrayAfter(manifest(), "NSPrivacyAccessedAPITypes");
  if (!array) return null;
  const entry = dicts(array).find((d) => stringAfter(d, "NSPrivacyAccessedAPIType") === category);
  if (!entry) return null;
  const reasons = arrayAfter(entry, "NSPrivacyAccessedAPITypeReasons");
  return reasons === null ? null : strings(reasons);
}

// The file ids in a native target's Copy Bundle Resources phase.
function resourcesOf(target: string): string[] {
  const pbx = readFileSync(PROJECT, "utf8");
  const block = new RegExp(
    `/\\* ${target} \\*/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?buildPhases = \\(([\\s\\S]*?)\\);`,
  ).exec(pbx);
  if (!block) throw new Error(`no PBXNativeTarget named ${target} in ${PROJECT}`);
  const phaseId = /(\w{24}) \/\* Resources \*\//.exec(block[1])?.[1];
  if (!phaseId) throw new Error(`${target} has no Resources build phase`);
  const phase = new RegExp(
    `${phaseId} /\\* Resources \\*/ = \\{\\s*isa = PBXResourcesBuildPhase;[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`,
  ).exec(pbx);
  if (!phase) throw new Error(`Resources phase ${phaseId} not found`);
  return [...phase[1].matchAll(/\/\* ([^*]+?) in Resources \*\//g)].map((m) => m[1]);
}

const deps = (): Record<string, string> =>
  JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {};

describe("the iOS privacy manifest", () => {
  it("exists", () => {
    expect(existsSync(MANIFEST)).toBe(true);
  });

  it("is a resource of the App target, and not of the RouteActivity extension", () => {
    expect(resourcesOf("App")).toContain("PrivacyInfo.xcprivacy");
    expect(resourcesOf("RouteActivity")).not.toContain("PrivacyInfo.xcprivacy");
  });

  it("says the app does not track", () => {
    expect(boolAfter(manifest(), "NSPrivacyTracking")).toBe(false);
    expect(arrayAfter(manifest(), "NSPrivacyTrackingDomains") ?? "").not.toMatch(/<string>/);
  });

  it("gives CA92.1 for UserDefaults while @capacitor/preferences is installed", () => {
    if (!deps()["@capacitor/preferences"]) return;
    expect(reasonsFor("NSPrivacyAccessedAPICategoryUserDefaults")).toEqual(["CA92.1"]);
  });

  it("gives C617.1 for file timestamps while @capacitor/camera is installed", () => {
    if (!deps()["@capacitor/camera"]) return;
    expect(reasonsFor("NSPrivacyAccessedAPICategoryFileTimestamp")).toEqual(["C617.1"]);
  });

  it("collects exactly the types on the App Privacy label, linked, not tracking, for app functionality", () => {
    const array = arrayAfter(manifest(), "NSPrivacyCollectedDataTypes");
    expect(array).not.toBeNull();
    const entries = dicts(array!);
    const types = entries.map((d) => stringAfter(d, "NSPrivacyCollectedDataType"));
    expect([...types].sort()).toEqual([...COLLECTED].sort());
    for (const d of entries) {
      const type = stringAfter(d, "NSPrivacyCollectedDataType");
      expect(boolAfter(d, "NSPrivacyCollectedDataTypeLinked"), type ?? "").toBe(true);
      expect(boolAfter(d, "NSPrivacyCollectedDataTypeTracking"), type ?? "").toBe(false);
      expect(
        strings(arrayAfter(d, "NSPrivacyCollectedDataTypePurposes") ?? ""),
        type ?? "",
      ).toEqual(["NSPrivacyCollectedDataTypePurposeAppFunctionality"]);
    }
  });
});
