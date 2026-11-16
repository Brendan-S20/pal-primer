import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

// On-demand PR evidence for #959; does not add a test to the gated viewport suite.
export default defineConfig({ ...base, testDir: ".", testMatch: /issue-959\.spec\.ts$/ });
