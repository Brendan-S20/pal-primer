import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

// On-demand PR evidence; does not add a new test to the gated viewport suite.
export default defineConfig({ ...base, testDir: ".", testMatch: /issue-884\.spec\.ts$/ });
