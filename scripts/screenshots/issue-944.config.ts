import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

// On-demand PR evidence for #944; does not add a test to the gated viewport suite.
export default defineConfig({ ...base, testDir: ".", testMatch: /issue-944\.spec\.ts$/ });
