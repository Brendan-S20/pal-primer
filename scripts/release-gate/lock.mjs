// NP-12 for scripts/release-gate-test-mode.mjs: the trial lock, export after a
// cancelled plan, and the deletion job's DRY RUN, on backdated fixtures in the
// private database. The job's switches are read from source and never set: the
// production job stays OFF.
const DAY = 86_400_000;
const at = (ms) => new Date(Date.now() + ms).toISOString();

export async function runLockChecks(ctx) {
  const { check, call, fx, billing, lockServer, exporter, deletion, subscribeAndPay, sourceText } =
    ctx;
  const H = 3_600_000;
  const trial = { plan_status: "trialing", billing_status: "trialing" };
  const cancelled = { plan_status: "canceled", billing_status: "canceled" };
  // Created after TRIAL_ENFORCEMENT_FROM (2026-08-16), so the lock applies. Each
  // is seeded while it is still paying (seed_demo_org refuses a locked or
  // cancelled account), then moved into the state under test.
  const make = async (label, created, final, fieldTechOwner = true) => {
    const o = await fx.org({
      label,
      plan: "launch",
      fieldTechOwner,
      created_at: created,
      plan_status: "active",
      billing_status: "active",
    });
    if (fieldTechOwner) {
      const { error } = await o.client.rpc("seed_demo_org", { _org_id: o.orgId });
      if (error) console.log(`      (seed_demo_org for ${label}: ${error.message})`);
    }
    const { error } = await fx.admin.from("organizations").update(final).eq("id", o.orgId);
    if (error) throw new Error(error.message);
    return o;
  };
  const A = await make("np12-day14", at(-14 * DAY - H), { trial_ends_at: at(-H), ...trial });
  const A13 = await make("np12-day13", at(-13 * DAY), { trial_ends_at: at(DAY), ...trial }, false);
  const B = await make("np12-cancel10", at(-50 * DAY), {
    current_period_end: at(-10 * DAY),
    ...cancelled,
  });
  const C = await make("np12-cancel31", at(-50 * DAY), {
    current_period_end: at(-31 * DAY),
    ...cancelled,
  });

  const bearer = (o) => `Bearer ${o.token}`;
  const CLIENTS = { filename: "src/lib/clients.functions.ts", name: "listClients" };
  const CHECKOUT = { filename: "src/lib/billing.functions.ts", name: "createPlanSubscription" };
  const refused = async (o, meta) => {
    lockServer.forgetAccountLocks();
    try {
      await lockServer.refuseIfLocked({ authorization: bearer(o), meta });
      return "allowed";
    } catch (e) {
      return `refused: ${e.message}`;
    }
  };

  await check(
    "NP-12 day 14 locks a trial account (server middleware); day 13 does not",
    async () => {
      const lock = (await lockServer.lockForUser(A.userId)).lock;
      const clients = await refused(A, CLIENTS);
      const checkout = await refused(A, CHECKOUT);
      const exp = await call(exporter.exportAccountData, A);
      const day13 = (await lockServer.lockForUser(A13.userId)).lock;
      const day13clients = await refused(A13, CLIENTS);
      const ok =
        lock.locked &&
        lock.reason === "trial_ended" &&
        /^refused/.test(clients) &&
        checkout === "allowed" &&
        !exp.ok &&
        !day13.locked &&
        day13clients === "allowed";
      return {
        pass: ok,
        evidence: `day 14: ${JSON.stringify(lock)}; listClients ${clients}; createPlanSubscription ${checkout}; export ${exp.ok ? "ALLOWED" : `"${exp.message}"`}; day 13: locked=${day13.locked}, listClients ${day13clients}`,
      };
    },
  );

  await check("NP-12 a cancelled plan can export for 30 days, and not after", async () => {
    const lockB = (await lockServer.lockForUser(B.userId)).lock;
    const expB = await call(exporter.exportAccountData, B);
    const rows = expB.ok
      ? Object.fromEntries(Object.entries(expB.value.tables).map(([k, v]) => [k, v.length]))
      : null;
    const choose = await refused(B, CHECKOUT);
    const expC = await call(exporter.exportAccountData, C);
    const ok =
      lockB.locked &&
      lockB.reason === "plan_ended" &&
      expB.ok &&
      rows.clients > 0 &&
      choose === "allowed" &&
      !expC.ok &&
      /30 days/.test(expC.message);
    return {
      pass: ok,
      evidence: `ended 10 days ago: ${JSON.stringify(lockB)}; export ok=${expB.ok} rows ${JSON.stringify(rows)}; choose a plan ${choose}; ended 31 days ago: "${expC.message ?? "ALLOWED"}"`,
    };
  });

  const TABLES = [
    "clients",
    "properties",
    "dogs",
    "subscriptions",
    "visits",
    "invoices",
    "payments",
    "staff",
    "user_roles",
  ];
  const snapshot = async () => {
    const out = {};
    for (const o of [A, B, C]) {
      for (const t of TABLES) out[`${o.label}.${t}`] = await fx.count(t, o.orgId);
      const { data } = await fx.admin
        .from("organizations")
        .select("name, deleted_at")
        .eq("id", o.orgId)
        .single();
      out[`${o.label}.name`] = `${data.name}|${data.deleted_at}`;
    }
    const { count } = await fx.admin
      .from("account_deletion_schedule")
      .select("*", { count: "exact", head: true });
    out.schedule = count ?? 0;
    return out;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mine = (r) =>
    r.perAccount.filter((p) => [A, B, C].some((o) => o.orgId === p.organizationId));

  await check("NP-12 deletion job ships OFF (source switches)", async () => ({
    pass:
      deletion.ACCOUNT_DELETION_ENABLED === false &&
      deletion.ACCOUNT_DELETION_DEPLOYED_ON === null &&
      /ACCOUNT_DELETION_ENABLED = false/.test(sourceText("src/lib/account-deletion.server.ts")),
    evidence: `ACCOUNT_DELETION_ENABLED=${deletion.ACCOUNT_DELETION_ENABLED}, ACCOUNT_DELETION_DEPLOYED_ON=${deletion.ACCOUNT_DELETION_DEPLOYED_ON}`,
  }));

  await check("NP-12 deletion DRY RUN lists what it would delete and deletes nothing", async () => {
    const before = await snapshot();
    const r = await deletion.runAccountDeletion();
    const r2 = await deletion.runAccountDeletion({ deployedOn: "2026-08-01" });
    const r3 = await deletion.runAccountDeletion({
      forceDryRun: true,
      enabled: true,
      deployedOn: "2026-08-01",
    });
    const after = await snapshot();
    // "No earlier than deploy + 30 days": the deploy date is a DATE, so its midnight.
    const floor = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 30 * DAY;
    const accounts = mine(r);
    const a = accounts.find((p) => p.organizationId === A.orgId);
    const cDue = mine(r2).find((p) => p.organizationId === C.orgId)?.due;
    const ok =
      r.dryRun &&
      r2.dryRun &&
      r3.dryRun &&
      accounts.length === 3 &&
      Date.parse(r.earliestDeleteAfter) >= floor &&
      r.dueNow === 0 &&
      a &&
      Object.values(a.deleted).some((n) => n > 0) &&
      cDue === true &&
      same(before, after);
    return {
      pass: ok,
      evidence:
        `default run: dryRun ${r.dryRun}, deploy ${r.deployedOn} (hypothetical ${r.deployedOnIsHypothetical}), ${r.accounts} account(s), ${r.recordsToDelete} record(s) to delete, ${r.recordsKept} kept, earliest ${r.earliestDeleteAfter}, due now ${r.dueNow}; ` +
        `day-14 org would delete ${JSON.stringify(a?.deleted)} and keep ${JSON.stringify(a?.kept)}; ` +
        `with deploy 2026-08-01 (still off): dryRun ${r2.dryRun}, due ${r2.dueNow}, cancelled-31d due=${cDue}; forced preview dryRun ${r3.dryRun}; rows before == after: ${same(before, after)}`,
    };
  });

  await check(
    "NP-12 the database refuses a real purge with no deploy date, or on deploy day",
    async () => {
      const noDate = await fx.admin.rpc("purge_locked_account", {
        _org: C.orgId,
        _dry_run: false,
        _deployed_on: null,
        _now: new Date().toISOString(),
      });
      const today = await fx.admin.rpc("purge_locked_account", {
        _org: C.orgId,
        _dry_run: false,
        _deployed_on: new Date().toISOString().slice(0, 10),
        _now: new Date().toISOString(),
      });
      const left = await fx.count("properties", C.orgId);
      return {
        pass:
          !!noDate.error &&
          /no deploy date/.test(noDate.error.message) &&
          !!today.error &&
          /not due/.test(today.error.message) &&
          left > 0,
        evidence: `no deploy date: "${noDate.error?.message ?? "DELETED"}"; deploy today: "${today.error?.message ?? "DELETED"}"; properties left ${left}`,
      };
    },
  );

  await check(
    "NP-12 deletion only targets accounts the app locks (pre-2026-08-16 cancelled account)",
    async () => {
      const OLD = await fx.org({
        label: "np12-old-cancel",
        plan: "launch",
        created_at: "2026-08-01T12:00:00Z",
        current_period_end: at(-40 * DAY),
        ...cancelled,
      });
      const lock = (await lockServer.lockForUser(OLD.userId)).lock;
      const r = await deletion.runAccountDeletion({ deployedOn: "2026-08-01" });
      const cand = r.perAccount.find((p) => p.organizationId === OLD.orgId);
      return {
        pass: !cand || lock.locked,
        evidence: `org created 2026-08-01, plan ended 40 days ago: app lock ${JSON.stringify(lock)}; deletion candidate ${cand ? `yes (${cand.reason}, delete_after ${cand.deleteAfter}, due ${cand.due})` : "no"}`,
      };
    },
  );

  await check(
    "NP-12 choosing a plan unlocks at once and cancels the scheduled deletion",
    async () => {
      const { sub } = await subscribeAndPay(A, "launch", "month");
      const lock = (await lockServer.lockForUser(A.userId)).lock;
      const clients = await refused(A, CLIENTS);
      const r = await deletion.runAccountDeletion();
      const still = r.perAccount.some((p) => p.organizationId === A.orgId);
      return {
        pass: !lock.locked && clients === "allowed" && !still,
        evidence: `paid ${sub.id} (${sub.status}); lock ${JSON.stringify(lock)}; listClients ${clients}; still a deletion candidate: ${still}`,
      };
    },
  );
}
