import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

/** Screenshot pass for the pet sitting path. Lives outside tests/viewports so
 *  the sweep suite does not have to name it. */
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /sit-411-shots\.spec\.ts$/,
  timeout: 180_000,
});
