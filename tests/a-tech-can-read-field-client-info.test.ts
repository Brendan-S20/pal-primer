import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const clients = readFileSync(join(root, "src/lib/clients.functions.ts"), "utf8");
const route = readFileSync(join(root, "src/routes/_authenticated/clients.$clientId.tsx"), "utf8");
const roles = readFileSync(join(root, "src/hooks/useMyRole.ts"), "utf8");

describe("a tech opens field-safe client info", () => {
  it("authorizes tech reads by an assigned visit before using the service client", () => {
    const start = clients.indexOf("export const getFieldClientInfo");
    const fn = clients.slice(start, clients.indexOf("/** Edit-client drawer", start));
    expect(fn).toMatch(/resolveCaller\(supabase, userId\)/);
    expect(fn).toMatch(/\.from\("staff"\)[\s\S]*?\.eq\("user_id", userId\)/);
    expect(fn).toMatch(
      /\.from\("visits"\)[\s\S]*?\.eq\("client_id", data\.clientId\)[\s\S]*?\.eq\("assigned_staff_id", staff\.id\)/,
    );
    expect(fn.indexOf('from("visits")')).toBeLessThan(fn.indexOf("supabaseAdmin"));
    expect(fn).toMatch(
      /select\("id, organization_id, display_name, account_type, primary_phone, notes"\)/,
    );
    expect(fn).not.toMatch(/portal_token|credit_balance_cents|autopay|tax_exempt/);
  });

  it("lets techs reach only client detail URLs and renders the restricted page", () => {
    expect(roles).toMatch(/role === "tech"[\s\S]*?\^\\\/clients\\\/\[0-9a-f\]/);
    expect(route).toMatch(/getFieldClientInfo/);
    expect(route).toMatch(/enabled: !roleLoading && !canViewDirectory/);
    // The restricted page is its own component, on the TECH_SCREENS list.
    expect(route).toMatch(/<FieldClientView/);
    expect(route).toMatch(/from "@\/components\/client-detail\/FieldClientView"/);
    expect(route).toMatch(/enabled: canViewDirectory/);
  });
});
