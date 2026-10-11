// The plumbing behind scripts/release-gate-test-mode.mjs: the guards that keep
// it on Stripe TEST mode and a LOCAL database, the loader that runs the app's
// own server functions from node, fixtures, and the cleanup ledger.
//
// ── HOW THE APP'S CODE IS CALLED ──────────────────────────────────────────
//
// Server functions are `createServerFn(...).handler(fn)`. Outside the TanStack
// Start build they cannot be called over HTTP, so this loads the real .ts files
// through jiti with four modules swapped:
//
//   @tanstack/react-start                  createServerFn returns the handler,
//                                          called with { data, context } where
//                                          context is a REAL signed-in Supabase
//                                          client for the fixture's owner, so
//                                          RLS applies exactly as in the app.
//   @/integrations/supabase/auth-middleware   a no-op (the context above is
//                                          what it would have produced).
//   @/lib/stripe-client.server             the real makeStripe, counted: every
//                                          client made and every HTTP request
//                                          it sends. "Refused before any Stripe
//                                          call" is measured, not read.
//   @/lib/invite-email.server              records the address and sends
//                                          nothing. No email leaves this run.
//
// Everything else (billing.functions, platform-addons.functions,
// users.functions, team-size, founding-offer, account-lock, account-deletion)
// is the code as it ships.
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHIMS = fileURLToPath(new URL("./shims/", import.meta.url));
export const RUN = `gate${Date.now().toString(36)}`;
const DAY = 86_400_000;

// ── Guards ─────────────────────────────────────────────────────────────────
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const FORBIDDEN_PORTS = /:(5442[1-7]|5452[1-7]|5432[1-7])\b/;

export function redact(s) {
  return String(s ?? "").replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, "<key>");
}

/** Env from `supabase status -o env` in the repo, unless already set. */
function supabaseStatusEnv() {
  try {
    const out = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Object.fromEntries(
      out
        .split("\n")
        .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
  } catch {
    return {};
  }
}

export function loadConfig() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (/^(sk|rk)_live_/.test(key)) {
    console.error("REFUSING: STRIPE_SECRET_KEY is a LIVE key. This gate runs in test mode only.");
    process.exit(2);
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    console.error("NOT ARMED: STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_).");
    process.exit(2);
  }
  const st = supabaseStatusEnv();
  const url = process.env.GATE_SUPABASE_URL ?? st.API_URL;
  const service = process.env.GATE_SERVICE_ROLE_KEY ?? st.SERVICE_ROLE_KEY;
  const anon = process.env.GATE_ANON_KEY ?? st.ANON_KEY;
  const dbUrl = process.env.GATE_DB_URL ?? st.DB_URL;
  if (!url || !service || !anon || !dbUrl) {
    console.error(
      "NOT ARMED: no local Supabase found (set GATE_SUPABASE_URL, GATE_SERVICE_ROLE_KEY, GATE_ANON_KEY, GATE_DB_URL).",
    );
    process.exit(2);
  }
  if (!LOCAL.test(new URL(url).origin) || !/@(127\.0\.0\.1|localhost)[:/]/.test(dbUrl)) {
    console.error(`REFUSING: ${url} is not a local database. This gate never touches production.`);
    process.exit(2);
  }
  if (FORBIDDEN_PORTS.test(url) || FORBIDDEN_PORTS.test(dbUrl)) {
    console.error(
      "REFUSING: that is a shared stack (54421-54427 is CI's proof database, 545xx is CI's, 543xx is " +
        "another project). Start a private stack on its own ports and project_id.",
    );
    process.exit(2);
  }
  // The app's own code reads these.
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = service;
  process.env.SERVICE_ROLE_KEY = service;
  // createPlanSubscription only hands this to the browser's Payment Element.
  process.env.STRIPE_PUBLISHABLE_KEY ??= "pk_test_release_gate_placeholder";
  return { key, url, service, anon, dbUrl };
}

// ── The app's code, loaded through jiti ───────────────────────────────────
export const gate = (globalThis.__releaseGate = {
  context: null,
  makeStripeCalls: 0,
  stripeRequests: 0,
  invitesSuppressed: [],
});

export function appLoader() {
  const jiti = createJiti(import.meta.url, {
    moduleCache: true,
    fsCache: false,
    interopDefault: true,
    alias: {
      "@tanstack/react-start": join(SHIMS, "react-start.mjs"),
      "@/integrations/supabase/auth-middleware": join(SHIMS, "auth-middleware.mjs"),
      "@/lib/stripe-client.server": join(SHIMS, "stripe-client.mjs"),
      "@/lib/invite-email.server": join(SHIMS, "invite-email.mjs"),
      "@": join(ROOT, "src"),
    },
  });
  return (rel) => jiti.import(join(ROOT, rel));
}

/** Run a server function as `who`, counting Stripe traffic around the call. */
export async function call(fn, who, data) {
  gate.context = { supabase: who.client, userId: who.userId };
  const before = { made: gate.makeStripeCalls, requests: gate.stripeRequests };
  try {
    const value = await fn({ data });
    return { ok: true, value, ...delta(before) };
  } catch (e) {
    return { ok: false, error: e, message: e?.message ?? String(e), ...delta(before) };
  } finally {
    gate.context = null;
  }
}
function delta(b) {
  return {
    stripeClients: gate.makeStripeCalls - b.made,
    stripeRequests: gate.stripeRequests - b.requests,
  };
}

// ── Fixtures ───────────────────────────────────────────────────────────────
export function makeFixtures(cfg) {
  const admin = createClient(cfg.url, cfg.service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const pool = [];
  let n = 0;

  async function newUser(label) {
    n += 1;
    const email = `${RUN}-${label}-${n}@release-gate.test`;
    const password = `${RUN}-pw-${n}-${Math.random().toString(36).slice(2)}`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    return { userId: data.user.id, email, password };
  }

  async function poolUsers(k) {
    while (pool.length < k) pool.push((await newUser("staff")).userId);
    return pool.slice(0, k);
  }

  /**
   * An org with an owner who can sign in, `people` enabled users (the owner is
   * one), `disabled` more turned off, and the billing columns given.
   */
  async function org({ label, plan, people = 1, disabled = 0, fieldTechOwner = false, ...cols }) {
    const owner = await newUser(label);
    const planId = plan ? await planIdFor(plan) : null;
    const { data: o, error } = await admin
      .from("organizations")
      .insert({ name: `Release gate ${label} ${RUN}` })
      .select("id")
      .single();
    if (error) throw new Error(`insert org: ${error.message}`);
    must(
      await admin
        .from("user_roles")
        .insert({ user_id: owner.userId, organization_id: o.id, role: "owner" }),
    );
    must(
      await admin.from("staff").insert({
        organization_id: o.id,
        user_id: owner.userId,
        role: "owner",
        display_name: `Owner ${label}`,
        active: true,
        ...(fieldTechOwner
          ? { is_field_tech: true, routing_available: true, is_field_tech_overridden: true }
          : {}),
      }),
    );
    const others = await poolUsers(people - 1 + disabled);
    const rows = others.map((uid, i) => ({
      organization_id: o.id,
      user_id: uid,
      role: "tech",
      display_name: `Person ${i + 2}`,
      active: i < people - 1,
    }));
    if (rows.length) must(await admin.from("staff").insert(rows));
    must(
      await admin
        .from("organizations")
        .update({ ...(planId ? { plan_id: planId } : {}), ...cols })
        .eq("id", o.id),
    );
    const client = createClient(cfg.url, cfg.anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: s, error: sErr } = await client.auth.signInWithPassword({
      email: owner.email,
      password: owner.password,
    });
    if (sErr) throw new Error(`sign in: ${sErr.message}`);
    return { orgId: o.id, userId: owner.userId, client, token: s.session.access_token, label };
  }

  const planIds = new Map();
  async function planIdFor(slug) {
    if (!planIds.has(slug)) {
      const { data } = await admin.from("platform_plans").select("id").eq("slug", slug).single();
      planIds.set(slug, data.id);
    }
    return planIds.get(slug);
  }

  async function addonIdFor(slug) {
    const { data } = await admin
      .from("platform_addons")
      .select("id, status, is_active")
      .eq("slug", slug)
      .single();
    return data;
  }

  async function staffOf(orgId) {
    const { data } = await admin
      .from("staff")
      .select("id, active, user_id")
      .eq("organization_id", orgId)
      .order("created_at");
    return data ?? [];
  }

  async function count(table, orgId) {
    const { count: c } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgId);
    return c ?? 0;
  }

  return { admin, org, newUser, planIdFor, addonIdFor, staffOf, count, poolUsers };
}

function must(r) {
  if (r?.error) throw new Error(r.error.message);
  return r;
}

export const daysFromNow = (d) => new Date(Date.now() + d * DAY).toISOString();

// ── Stripe, for verifying and cleaning up ─────────────────────────────────
export function makeVerifier(cfg, apiVersion) {
  const stripe = new Stripe(cfg.key, { apiVersion });
  const ledger = { customers: new Set(), clocks: new Set(), promotionCodes: [] };

  /** Attach a test card and pay the subscription's open first invoice. */
  async function pay(subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    ledger.customers.add(customer);
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer });
    const inv =
      typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id;
    await stripe.invoices.pay(inv, { payment_method: pm.id });
    return await stripe.subscriptions.retrieve(subscriptionId);
  }

  /** price id of an invoice line, across API shapes. */
  const linePrice = (l) => l.pricing?.price_details?.price ?? l.price?.id ?? null;
  const lineDiscount = (l) => (l.discount_amounts ?? []).reduce((a, d) => a + (d.amount ?? 0), 0);

  async function invoiceLines(invoiceId) {
    const out = [];
    for await (const l of stripe.invoices.listLineItems(invoiceId, { limit: 100 })) out.push(l);
    return out;
  }

  async function cleanup() {
    const done = { customers: 0, clocks: 0, errors: [] };
    for (const c of ledger.customers) {
      try {
        await stripe.customers.del(c);
        done.customers += 1;
      } catch (e) {
        if (!/No such customer/.test(e.message)) done.errors.push(`${c}: ${redact(e.message)}`);
      }
    }
    for (const c of ledger.clocks) {
      try {
        await stripe.testHelpers.testClocks.del(c);
        done.clocks += 1;
      } catch (e) {
        done.errors.push(`${c}: ${redact(e.message)}`);
      }
    }
    return done;
  }

  return { stripe, ledger, pay, linePrice, lineDiscount, invoiceLines, cleanup };
}

export function sourceText(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
