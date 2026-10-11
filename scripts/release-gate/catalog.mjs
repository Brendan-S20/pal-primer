// scripts/check-stripe-catalog.mjs, three ways, for the release gate.
//
//   1. As shipped: TEST key + the private database. The database stores LIVE
//      price ids, so in test mode every stored id is "does not exist". This is
//      the run the gate was asked for; its result is reported as it comes.
//   2. The database as B2 leaves it (amounts moved to $15/$99/$199, stored ids
//      untouched), with each stored id mapped to its TEST twin: the price the
//      live id mirrors (no lookup key since the setup script moved the key).
//      This is what the checker will say in LIVE mode after B2 + B3 unless the
//      stored ids are repointed.
//   3. The same with the stored ids repointed to the prices the lookup keys
//      name, which is what the app charges.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_SQL } from "../check-stripe-catalog.mjs";

function runChecker(ROOT, args, env) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/check-stripe-catalog.mjs"), ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
  });
  const out = `${r.stdout}${r.stderr}`;
  const problems = out
    .split("\n")
    .filter((l) => /^\s+- /.test(l))
    .map((l) => l.trim().slice(2));
  return { status: r.status, head: out.split("\n")[0], problems };
}

export async function runCatalogChecks({ check, cfg, ROOT, allPrices }) {
  const shaped = allPrices.map((p) => ({ ...p, product: p.product.id }));
  const dir = mkdtempSync(join(tmpdir(), "release-gate-"));
  const pricesFile = join(dir, "prices.json");
  writeFileSync(pricesFile, JSON.stringify({ data: shaped }));

  await check("check-stripe-catalog: TEST key + private DB, as shipped", async () => {
    const r = runChecker(ROOT, [], { SUPABASE_DB_URL: cfg.dbUrl, STRIPE_SECRET_KEY: cfg.key });
    const allMissing =
      r.problems.length > 0 &&
      r.problems.every((p) => /does not exist in this Stripe account/.test(p));
    return {
      pass: r.status === 0,
      evidence: `exit ${r.status}; ${r.head}; ${r.problems.length} problem(s)${allMissing ? ", every one 'does not exist in this Stripe account': the DB stores LIVE price ids" : `: ${r.problems.join(" | ")}`}`,
    };
  });

  const db = spawnSync("psql", [cfg.dbUrl, "-At", "-c", CATALOG_SQL], { encoding: "utf8" });
  const catalog = JSON.parse(db.stdout.trim());
  const productFor = (key, slug) =>
    allPrices.find((p) => p.product.metadata?.[key] === slug)?.product.id;
  const keyed = (k) => allPrices.find((p) => p.lookup_key === k)?.id;
  const twin = (key, slug, interval, fallbackKey) =>
    allPrices.find(
      (p) =>
        !p.lookup_key &&
        p.product.metadata?.[key] === slug &&
        (p.recurring?.interval ?? null) === interval,
    )?.id ?? keyed(fallbackKey);
  const addonKey = (slug) => `addon_${slug.replace(/-/g, "_")}`;

  function mapped(repointed) {
    const c = structuredClone(catalog);
    for (const p of c.plans) {
      if (!p.is_active || !p.stripe_product_id) continue;
      p.stripe_product_id = productFor("plan_slug", p.slug);
      p.stripe_price_id = keyed(`${p.slug}_base_monthly`);
      p.stripe_annual_price_id = keyed(`${p.slug}_base_annual`);
      p.stripe_seat_price_id = repointed
        ? keyed(`${p.slug}_seat_monthly`)
        : twin("plan_slug", p.slug, "month", `${p.slug}_seat_monthly`);
      p.stripe_annual_seat_price_id = repointed
        ? keyed(`${p.slug}_seat_annual`)
        : twin("plan_slug", p.slug, "year", `${p.slug}_seat_annual`);
    }
    for (const a of c.addons) {
      if (!a.is_active || !a.stripe_price_id) continue;
      a.stripe_product_id = productFor("addon_slug", a.slug);
      const interval = a.billing_interval === "one_time" ? null : a.billing_interval;
      a.stripe_price_id = repointed
        ? keyed(addonKey(a.slug))
        : twin("addon_slug", a.slug, interval, addonKey(a.slug));
    }
    return c;
  }

  for (const [label, repointed] of [
    ["stored ids unchanged (as B2 leaves them)", false],
    ["stored ids repointed to the lookup-key prices", true],
  ]) {
    await check(`check-stripe-catalog: test twin of the DB after B2, ${label}`, async () => {
      const f = join(dir, `catalog-${repointed}.json`);
      writeFileSync(f, JSON.stringify(mapped(repointed)));
      const r = runChecker(ROOT, ["--catalog-from", f, "--prices-from", pricesFile], {});
      return {
        pass: r.status === 0,
        evidence: `exit ${r.status}; ${r.head}${r.problems.length ? `; ${r.problems.length} problem(s): ${r.problems.join(" | ")}` : ""}`,
      };
    });
  }
}
