import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceKeyProblem } from "@/integrations/supabase/service-key";

// On 2026-10-15 a local dev server had the anon key in SERVICE_ROLE_KEY. Its
// supabaseAdmin acted as anon against production: 169 review-queue counts
// failed on has_permission and 96 weather cache writes failed RLS. The admin
// client now refuses a key that is provably not a service key, and the
// migration below gives anon a clean table-level refusal on both tables.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION = join(
  ROOT,
  "supabase",
  "migrations",
  "20261016150000_the-anonymous-role-never-reads-the-review-queue.sql",
);

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.dummy-signature`;

const ANON_JWT = jwt({ iss: "supabase", ref: "local", role: "anon" });
const AUTHENTICATED_JWT = jwt({ iss: "supabase", ref: "local", role: "authenticated" });
const SERVICE_JWT = jwt({ iss: "supabase", ref: "local", role: "service_role" });

describe("serviceKeyProblem", () => {
  it("rejects a publishable key", () => {
    expect(serviceKeyProblem("sb_publishable_xxx")).toMatch(/SERVICE_ROLE_KEY/);
  });

  it("rejects a JWT whose role is anon", () => {
    expect(serviceKeyProblem(ANON_JWT)).toMatch(/anon\/publishable/);
  });

  it("rejects a JWT whose role is authenticated", () => {
    expect(serviceKeyProblem(AUTHENTICATED_JWT)).not.toBeNull();
  });

  it("accepts a JWT whose role is service_role", () => {
    expect(serviceKeyProblem(SERVICE_JWT)).toBeNull();
  });

  it("accepts the secret-key placeholder the Playwright config uses", () => {
    expect(serviceKeyProblem("sb_secret_placeholder")).toBeNull();
  });

  it("accepts an opaque string", () => {
    expect(serviceKeyProblem("test-service-key")).toBeNull();
  });

  it("accepts a three-part string whose middle is not JSON", () => {
    expect(serviceKeyProblem("abc.def.ghi")).toBeNull();
  });

  it("never puts the key in the message", () => {
    for (const key of ["sb_publishable_xxx", ANON_JWT, AUTHENTICATED_JWT]) {
      const message = serviceKeyProblem(key) ?? "";
      expect(message).not.toContain(key);
      for (const part of key.split(".")) expect(message).not.toContain(part);
      expect(message).toMatch(/anonymous visitor/);
    }
  });
});

describe("the admin client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54421");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses an anon JWT the first time it is used", async () => {
    vi.stubEnv("SERVICE_ROLE_KEY", ANON_JWT);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    expect(() => supabaseAdmin.from).toThrow(/SERVICE_ROLE_KEY holds the anon\/publishable key/);
  });

  it("builds normally with a service_role JWT", async () => {
    vi.stubEnv("SERVICE_ROLE_KEY", SERVICE_JWT);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    expect(() => supabaseAdmin.from).not.toThrow();
  });
});

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("narrows the review_items read policy to authenticated", () => {
    expect(sql).toMatch(
      /ALTER\s+POLICY\s+"Read review items with the directory"\s+ON\s+public\.review_items\s+TO\s+authenticated\s*;/i,
    );
  });

  it("revokes anon on both tables", () => {
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+public\.review_items\s+FROM\s+anon\s*;/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+public\.weather_forecast_cache\s+FROM\s+anon\s*;/i);
  });

  it("grants has_permission to nobody and adds no weather cache policy", () => {
    expect(sql).not.toMatch(/GRANT[^;]*has_permission/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY[^;]*weather_forecast_cache/i);
  });
});
