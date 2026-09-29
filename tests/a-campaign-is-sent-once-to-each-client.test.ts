// A campaign is sent once to each client.
//
// Three things stand between a double press, a retry or a worker that died
// mid-batch and a second copy in somebody's inbox:
//
//   1. start_email_campaign locks the campaign and only a DRAFT can start, so
//      the second press is told "already sent" (proved against Postgres in
//      tests/sql/nobody-could-send-a-seasonal-offer.proof.sql).
//   2. email_campaign_recipients is UNIQUE (campaign_id, client_id): one row
//      per client, whatever inserts arrive.
//   3. every email carries Idempotency-Key campaign-<id>-<clientId>, which
//      Resend dedupes for 24 hours. That is the backstop for (2)'s one gap: a
//      row claimed, queued, and then taken again after ten minutes because
//      the worker died before writing "queued".
//
// This file proves (3) end to end through feedCampaignLane, and that the
// sender uses the campaign lane, the client-scoped unsubscribe, and is NOT a
// manual send (so the imported comms hold still applies).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { campaignIdempotencyKey } from "@/lib/campaigns";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const CAMPAIGN = "c0ffee00-0000-4000-8000-000000000001";
const ORG = "0a000000-0000-4000-8000-0000000000aa";
const CLIENT_1 = "c1000000-0000-4000-8000-000000000001";
const CLIENT_2 = "c1000000-0000-4000-8000-000000000002";

const sent: any[] = [];
const recipientUpdates: Array<{ patch: any; filters: Array<[string, unknown]> }> = [];
const rpcs: string[] = [];
let claimed: any[] = [];
let optedOutRows: any[] = [];

vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: vi.fn(async (p: any) => {
    sent.push(p);
    return { ok: true, messageId: `msg-${p.clientId}` };
  }),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let patch: any = null;
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      ilike: (k: string, v: unknown) => (filters.push([k, v]), b),
      in: (k: string, v: unknown) => (filters.push([k, v]), b),
      update: (p: any) => ((patch = p), b),
      limit: () => Promise.resolve({ data: table === "clients" ? optedOutRows : [], error: null }),
      then: (res: (v: unknown) => unknown) => {
        if (table === "email_campaign_recipients" && patch)
          recipientUpdates.push({ patch, filters });
        const data =
          table === "email_campaigns"
            ? [
                {
                  id: CAMPAIGN,
                  subject: "Spring deep clean",
                  heading: "Spring",
                  body: "Twenty off.",
                  button_label: null,
                  button_url: null,
                },
              ]
            : null;
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return b;
  };
  return {
    supabaseAdmin: {
      from,
      rpc: async (fn: string) => {
        rpcs.push(fn);
        if (fn === "claim_email_campaign_recipients") return { data: claimed, error: null };
        return { data: 0, error: null };
      },
    },
  };
});

const { feedCampaignLane } = await import("@/lib/campaigns.server");

beforeEach(() => {
  sent.length = 0;
  recipientUpdates.length = 0;
  rpcs.length = 0;
  optedOutRows = [];
  claimed = [CLIENT_1, CLIENT_2].map((client_id, i) => ({
    recipient_id: `r${i + 1}`,
    campaign_id: CAMPAIGN,
    organization_id: ORG,
    client_id,
    email: `client${i + 1}@example.com`,
  }));
});

describe("the idempotency key", () => {
  it("is campaign-<campaign id>-<client id>", () => {
    expect(campaignIdempotencyKey(CAMPAIGN, CLIENT_1)).toBe(`campaign-${CAMPAIGN}-${CLIENT_1}`);
  });

  it("is the same on every attempt and different for every client", () => {
    expect(campaignIdempotencyKey(CAMPAIGN, CLIENT_1)).toBe(
      campaignIdempotencyKey(CAMPAIGN, CLIENT_1),
    );
    expect(campaignIdempotencyKey(CAMPAIGN, CLIENT_1)).not.toBe(
      campaignIdempotencyKey(CAMPAIGN, CLIENT_2),
    );
  });

  it("reaches the mail provider as Idempotency-Key", () => {
    // enqueueAppEmail puts it on the payload; the processor sends it as the
    // header Resend dedupes on.
    expect(read("src/lib/email/enqueue.server.ts")).toMatch(/idempotency_key: idempotencyKey,/);
    expect(read("src/routes/email/queue/process.ts")).toMatch(
      /fetchHeaders\["Idempotency-Key"\] = String\(payload\.idempotency_key\)/,
    );
  });
});

describe("feeding the campaign lane", () => {
  it("queues each claimed client once, keyed by campaign and client", async () => {
    const r = await feedCampaignLane(10);
    expect(r).toEqual({ claimed: 2, queued: 2, skipped: 0 });
    expect(sent.map((p) => p.idempotencyKey)).toEqual([
      `campaign-${CAMPAIGN}-${CLIENT_1}`,
      `campaign-${CAMPAIGN}-${CLIENT_2}`,
    ]);
  });

  it("on the campaign lane, with the client-scoped unsubscribe, and not as a manual send", async () => {
    await feedCampaignLane(10);
    for (const p of sent) {
      expect(p.templateName).toBe("campaign");
      expect(p.queue).toBe("campaign_emails");
      expect(p.clientUnsubscribe).toBe(true);
      // manual: true would bypass the imported comms hold AND lift it.
      expect(p.manual).toBeUndefined();
      expect(p.organizationId).toBe(ORG);
    }
  });

  it("marks each row queued only if it is still the claimed row it took", async () => {
    await feedCampaignLane(10);
    expect(recipientUpdates).toHaveLength(2);
    for (const u of recipientUpdates) {
      expect(u.patch.status).toBe("queued");
      expect(u.filters).toContainEqual(["status", "claimed"]);
    }
    expect(rpcs).toEqual(["claim_email_campaign_recipients", "settle_email_campaigns"]);
  });

  it("skips an address another client row unsubscribed after Send was pressed", async () => {
    optedOutRows = [{ id: "someone-else" }];
    const r = await feedCampaignLane(10);
    expect(r.queued).toBe(0);
    expect(sent).toEqual([]);
    expect(recipientUpdates.every((u) => u.patch.status === "skipped")).toBe(true);
    expect(recipientUpdates[0].patch.skip_reason).toBe("address_opted_out");
  });

  it("asks for nothing when there is no room", async () => {
    const r = await feedCampaignLane(0);
    expect(r).toEqual({ claimed: 0, queued: 0, skipped: 0 });
    expect(rpcs).toEqual([]);
  });
});

describe("the guards in front of the key", () => {
  const migration = () =>
    read("supabase/migrations/20260929070000_nobody-could-send-a-seasonal-offer.sql");

  it("one recipient row per client per campaign", () => {
    expect(migration()).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_recipients_once_key\s+ON public\.email_campaign_recipients \(campaign_id, client_id\)/,
    );
    expect(migration()).toMatch(/ON CONFLICT \(campaign_id, client_id\) DO NOTHING/);
  });

  it("only a draft can start, under a lock", () => {
    const fn = migration().slice(migration().indexOf("FUNCTION public.start_email_campaign("));
    expect(fn).toMatch(/FOR UPDATE;/);
    expect(fn).toMatch(/IF _c\.status <> 'draft' THEN\s+RETURN 'already_started';/);
  });

  it("and a second press is answered, not sent", () => {
    const fns = read("src/lib/campaigns.functions.ts");
    const send = fns.slice(fns.indexOf("export const sendCampaign"));
    expect(send).toMatch(
      /if \(row\.status !== "draft"\) \{\s+return \{\s+outcome: "already_started"/,
    );
    expect(send).toMatch(/if \(outcome === "already_started"\) \{\s+return \{ outcome,/);
  });
});
