// A campaign needs the business's postal address.
//
// CAN-SPAM wants two things in every commercial email: a working unsubscribe
// and the sender's physical postal address. The address is
// organizations.contact_address, which the footer already prints on every
// customer email when it is filled in, and which is optional everywhere
// else. For a campaign it is not optional, and the refusal is made in three
// places, each of which would be enough on its own:
//
//   the page      says so before anybody presses Send, with a link to fix it
//   the server    sendCampaign refuses before touching the database
//   the database  start_email_campaign refuses under the lock, so a caller
//                 that skipped the server check still sends nothing
//
// The third is proved against Postgres in
// tests/sql/nobody-could-send-a-seasonal-offer.proof.sql.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEND_BLOCKER_TEXT, sendBlockers, startOutcomeText } from "@/lib/campaigns";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const content = {
  subject: "Spring deep clean",
  heading: "Spring",
  body: "Twenty dollars off.",
  buttonLabel: null,
  buttonUrl: null,
};

describe("without an address, nothing sends", () => {
  it("no address, or a blank one, blocks", () => {
    for (const contactAddress of [null, undefined, "", "   "]) {
      expect(sendBlockers({ contactAddress, content, recipientCount: 12 })).toContain("no_address");
    }
  });

  it("an address, and it is the only thing missing, clears it", () => {
    expect(
      sendBlockers({
        contactAddress: "1200 W Wilson Ave, Chicago, IL",
        content,
        recipientCount: 12,
      }),
    ).toEqual([]);
  });

  it("the reason is said in words, with the law it comes from", () => {
    expect(SEND_BLOCKER_TEXT.no_address).toMatch(/business address/);
    expect(SEND_BLOCKER_TEXT.no_address).toMatch(/CAN-SPAM/);
    expect(startOutcomeText("no_address")).toBe(SEND_BLOCKER_TEXT.no_address);
  });

  it("the server asks before it starts anything", () => {
    const fns = read("src/lib/campaigns.functions.ts");
    const send = fns.slice(fns.indexOf("export const sendCampaign"));
    const blockAt = send.indexOf("contactAddress: org.contactAddress");
    const throwAt = send.indexOf("if (blockers.length > 0) {");
    const startAt = send.indexOf('db.rpc("start_email_campaign"');
    expect(blockAt).toBeGreaterThan(-1);
    expect(throwAt).toBeGreaterThan(blockAt);
    expect(startAt).toBeGreaterThan(throwAt);
  });

  it("and the database asks again, under the lock", () => {
    const sql = read("supabase/migrations/20260929070000_nobody-could-send-a-seasonal-offer.sql");
    const fn = sql.slice(sql.indexOf("FUNCTION public.start_email_campaign("));
    const lockAt = fn.indexOf("FOR UPDATE;");
    const addressAt = fn.indexOf("SELECT contact_address INTO _address");
    const insertAt = fn.indexOf("INSERT INTO public.email_campaign_recipients");
    expect(lockAt).toBeGreaterThan(-1);
    expect(addressAt).toBeGreaterThan(lockAt);
    expect(fn).toMatch(
      /IF _address IS NULL OR length\(btrim\(_address\)\) = 0 THEN\s+RETURN 'no_address';/,
    );
    expect(insertAt).toBeGreaterThan(addressAt);
  });

  it("the page warns wherever Send is, and links to where the address is set", () => {
    const parts = read("src/components/campaigns/CampaignParts.tsx");
    expect(parts).toMatch(/to="\/settings\/client-portal"/);
    // That page is where the address is edited (see the four-things test).
    expect(read("src/components/settings/ClientPortalCards.tsx")).toMatch(/Business address/);
    expect(read("src/components/campaigns/CampaignEditor.tsx")).toMatch(
      /\{!contactAddress && <NoAddressWarning \/>\}/,
    );
    expect(read("src/routes/_authenticated/campaigns.index.tsx")).toMatch(/<NoAddressWarning \/>/);
  });
});

describe("the other things that stop Send", () => {
  it("an empty message, an empty audience, or too many", () => {
    const addr = "1 Main St";
    expect(
      sendBlockers({
        contactAddress: addr,
        content: { ...content, subject: " " },
        recipientCount: 3,
      }),
    ).toContain("no_subject");
    expect(
      sendBlockers({
        contactAddress: addr,
        content: { ...content, body: "\n\n" },
        recipientCount: 3,
      }),
    ).toContain("no_body");
    expect(sendBlockers({ contactAddress: addr, content, recipientCount: 0 })).toEqual([
      "no_recipients",
    ]);
    expect(sendBlockers({ contactAddress: addr, content, recipientCount: 5001 })).toEqual([
      "too_many",
    ]);
    expect(sendBlockers({ contactAddress: addr, content, recipientCount: 5000 })).toEqual([]);
  });
});
