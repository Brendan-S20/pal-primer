import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

// On-demand PR evidence for the #946 follow-ups; does not add a test to the gated viewport suite.
export default defineConfig({ ...base, testDir: ".", testMatch: /issue-946-followups\.spec\.ts$/ });
