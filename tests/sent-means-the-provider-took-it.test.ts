// "Sent" claims when nothing was sent (#612, F-02 / R2-14).
//
// Setup step 4 said "Invite sent", the new-client page "Welcome email sent",
// the client's portal panel "Sign-in code emailed" and an invoice "Sent", and
// the invoice's sent_at was stamped, all without the mail provider having
// accepted anything. With email off, nothing had gone and every label said it
// had.
//
// Now each follows the provider's answer, the way Team invites already did
// (#568). With email off each says "not sent" and offers the link, and
// sent_at stays null: it is stamped by the queue processor when Resend takes
// the invoice email, and by nothing that only queues it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const toastCalls: Array<{ kind: string; msg: string; opts?: { action?: { label: string } } }> = [];
vi.mock("sonner", () => {
  const rec = (kind: string) => (msg: string, opts?: { action?: { label: string } }) => {
    toastCalls.push({ kind, msg, opts });
    return `t${toastCalls.length}`;
  };
  return {
    toast: Object.assign(rec("default"), {
      success: rec("success"),
      warning: rec("warning"),
      error: rec("error"),
      loading: rec("loading"),
      message: rec("message"),
    }),
  };
});
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("nothing should be read once the provider is known to be off");
      },
    },
  ),
}));

import { invoiceIdFromSendKey, invoiceSendKey } from "@/lib/email/invoice-send-key";
import { emailProviderConfigured } from "@/lib/email/provider.server";
import { enqueueAppEmail, priorOutcome } from "@/lib/email/enqueue.server";
import { emailStatusFromLog, FINAL_EMAIL_FAILURES } from "@/lib/email/send-status";
import {
  emailStatusForHandle,
  signEmailStatusHandle,
  verifyEmailStatusHandle,
} from "@/lib/email/status-handle.server";
import { notSentMessage, reportQueuedSend, waitForEmailOutcome } from "@/lib/send-report";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const ID = "11111111-1111-4111-8111-111111111111";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.RESEND_API_KEY;
  toastCalls.length = 0;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
  vi.useRealTimers();
});

describe("with email off nothing is queued, so nothing can claim it went", () => {
  it("knows when there is no provider", () => {
    delete process.env.RESEND_API_KEY;
    expect(emailProviderConfigured()).toBe(false);
    process.env.RESEND_API_KEY = "re_test";
    expect(emailProviderConfigured()).toBe(true);
  });

  it("a send that requires the provider is refused before anything is read or queued", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await enqueueAppEmail({
      organizationId: ID,
      clientId: ID,
      templateName: "invoice-sent",
      templateData: {},
      requireProvider: true,
    });
    expect(res).toEqual({ ok: false, reason: "provider_off" });
  });

  it("the invoice send, the auto-send and the welcome email all require it", () => {
    const send = strip(read("src/lib/notifications.functions.ts"));
    const nightly = strip(read("src/routes/api/public/hooks/nightly.ts"));
    const clients = strip(read("src/lib/clients.functions.ts"));
    expect(send).toMatch(/requireProvider: true/);
    expect(nightly).toMatch(
      /idempotencyKey: invoiceSendKey\(inv\.id\),[\s\S]*?requireProvider: true/,
    );
    expect(clients).toMatch(/templateName: "welcome",[\s\S]*?requireProvider: true/);
  });
});

describe("sent_at is the provider's acceptance, not the queue's", () => {
  it("maps a first-send key back to its invoice and nothing else", () => {
    expect(invoiceSendKey(ID)).toBe(`invoice-sent-${ID}`);
    expect(invoiceIdFromSendKey(invoiceSendKey(ID))).toBe(ID);
    expect(invoiceIdFromSendKey(`invoice-reminder-${ID}-2026-10-31`)).toBeNull();
    expect(invoiceIdFromSendKey(`welcome-${ID}`)).toBeNull();
    expect(invoiceIdFromSendKey("invoice-sent-not-a-uuid")).toBeNull();
    expect(invoiceIdFromSendKey(undefined)).toBeNull();
  });

  it("the manual send never writes sent_at, and hands back the pay link when it cannot go", () => {
    const send = strip(read("src/lib/notifications.functions.ts"));
    const handler = send.slice(send.indexOf("export const sendInvoiceEmail"));
    // The one write is the `sent` prior's arm: the send log already shows
    // the provider took it, and the processor's stamp did not land.
    expect(handler.match(/sent_at: /g)).toHaveLength(1);
    const sentArm = handler.slice(handler.indexOf('if (res.prior === "sent")'));
    expect(sentArm.indexOf("sent_at: ")).toBeGreaterThan(-1);
    expect(sentArm.indexOf("sent_at: ")).toBeLessThan(
      sentArm.indexOf('if (res.prior === "queued")'),
    );
    expect(handler).toMatch(/ok: false,\s*reason: res\.reason[\s\S]*?link: invoiceUrl/);
  });

  it("the nightly auto-send does not stamp on queueing", () => {
    const nightly = strip(read("src/routes/api/public/hooks/nightly.ts"));
    const okBranch = nightly.slice(
      nightly.indexOf("if (res.ok) {"),
      nightly.indexOf('} else if (res.reason === "already_sent" && res.prior === "sent")'),
    );
    expect(okBranch).toMatch(/sent\+\+/);
    expect(okBranch).not.toMatch(/sent_at/);
  });

  it("the queue processor stamps it after the provider accepts, once", () => {
    const proc = strip(read("src/routes/email/queue/process.ts"));
    const accepted = proc.indexOf("await sendViaResend(resendApiKey, payload)");
    const logged = proc.indexOf('status: "sent"', accepted);
    const stamp = proc.indexOf("invoiceIdFromSendKey(payload.idempotency_key)");
    expect(accepted).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(logged);
    expect(proc.slice(stamp)).toMatch(
      /\.update\(\{ sent_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("id", sentInvoiceId\)\s*\.is\("sent_at", null\)/,
    );
  });
});

describe("each label says sent only when it was, and 'not sent, copy link' when not", () => {
  it("the not-sent words", () => {
    expect(notSentMessage("Invoice", "a@b.co")).toBe(
      "Invoice not sent: the email to a@b.co did not go out. Copy the link and send it yourself.",
    );
  });

  it("nothing queued: warns not sent, with Copy link, and never says sent", async () => {
    const onSent = vi.fn();
    const poll = vi.fn();
    const out = await reportQueuedSend(
      { ok: false, statusHandle: null, recipient: "a@b.co", link: "https://x/pay/i/t" },
      { what: "Invoice", poll, onSent },
    );
    expect(out).toBe("failed");
    expect(poll).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe("warning");
    expect(toastCalls[0].msg).toMatch(/^Invoice not sent/);
    expect(toastCalls[0].opts.action.label).toBe("Copy link");
    expect(toastCalls.some((t) => t.kind === "success")).toBe(false);
  });

  it("queued then accepted: says sent only after the provider did, then refreshes", async () => {
    vi.useFakeTimers();
    const onSent = vi.fn();
    const answers = ["pending", "sent"];
    const poll = vi.fn(async () => ({
      status: answers.shift() ?? "sent",
      recipient: "a@b.co",
      error: null,
    }));
    const p = reportQueuedSend(
      { ok: true, statusHandle: "h1", recipient: "a@b.co", link: "https://x" },
      { what: "Welcome email", poll, onSent },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(toastCalls.map((t) => t.kind)).toEqual(["loading"]);
    expect(onSent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe("sent");
    expect(toastCalls.at(-1)).toMatchObject({
      kind: "success",
      msg: "Welcome email sent to a@b.co",
    });
    expect(onSent).toHaveBeenCalledOnce();
  });

  it("queued then refused by the provider: not sent, copy link", async () => {
    vi.useFakeTimers();
    // The server folds dlq / bounced / suppressed / complained into "failed".
    const poll = vi.fn(async () => ({ status: "failed", recipient: "a@b.co", error: "bad" }));
    const p = waitForEmailOutcome(poll, "h1");
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).outcome).toBe("failed");

    const p2 = reportQueuedSend(
      { ok: true, statusHandle: "h1", recipient: "a@b.co", link: "https://x" },
      { what: "Invoice", poll },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p2).toBe("failed");
    expect(toastCalls.at(-1)?.kind).toBe("warning");
    expect(toastCalls.at(-1)?.msg).toMatch(/^Invoice not sent/);
  });

  it("setup step 4 reads the provider's answer, like the Team page", () => {
    const setup = strip(read("src/routes/_authenticated/setup.tsx"));
    expect(setup).not.toMatch(/toast\.success\("Invite sent"\)/);
    expect(setup).toMatch(/if \(r\.emailSent\) toast\.success\(`Invite sent to \$\{to\}`\);/);
    expect(setup).toMatch(/else toastNotSent\("Invite", to, r\.link\);/);
  });

  it("the new-client page no longer says the welcome email went on queueing", () => {
    const page = strip(read("src/routes/_authenticated/clients.new.tsx"));
    expect(page).not.toMatch(/Welcome email sent to/);
    expect(page).toMatch(/what: "Welcome email"/);
    expect(page).toMatch(/statusHandle: welcomeStatusHandle/);
    // Quiet when the owner turned welcome emails off.
    expect(page).toMatch(/if \(primaryEmail && !welcomeTurnedOff\)/);
    expect(page).toMatch(/link: welcomeLink/);
  });

  it("every invoice send reports through the provider's answer", () => {
    for (const f of [
      "src/components/InvoiceDrawer.tsx",
      "src/components/InvoiceThisVisit.tsx",
      "src/routes/_authenticated/invoices.$invoiceId.tsx",
      "src/routes/_authenticated/invoices.index.tsx",
      "src/routes/_authenticated/quotes.$quoteId.tsx",
    ]) {
      const src = strip(read(f));
      expect(src, f).toMatch(/reportQueuedSend\(/);
      expect(src, f).not.toMatch(/"Invoice emailed"|Deposit invoice emailed|created and emailed/);
    }
  });

  it("the drawer says an unsent open invoice is not sent", () => {
    const drawer = read("src/components/InvoiceDrawer.tsx");
    expect(drawer).toMatch(
      /\{open &&\s*!inv\.sent_at &&\s*\(!inv\.send_after \|\| inv\.send_after <= today\) && \(\s*<MetaChip>Not sent: copy the pay link<\/MetaChip>/,
    );
  });

  it("the portal panel does not say 'emailed to' when email is off", () => {
    const fns = strip(read("src/lib/clients.functions.ts"));
    expect(fns).toMatch(/const emailOff = !emailProviderConfigured\(\);/);
    expect(fns).toMatch(/\.filter\(\(c\) => !\(c === "email" && emailOff\)\)/);
    const panel = strip(read("src/components/client-detail/ReviewsReferralsTab.tsx"));
    expect(panel).toMatch(/channelData\?\.emailOff/);
    expect(panel).toMatch(/not emailed: email is off\. Copy the link/);
  });
});

// The review of #635: three ways "sent" could still be said without the
// provider having taken anything.
describe("already sent means a `sent` row, nothing less (review blockers 1 and 2)", () => {
  it("folds a message's log rows into sent, queued or undelivered", () => {
    expect(priorOutcome(["pending"])).toBe("queued");
    expect(priorOutcome(["pending", "failed"])).toBe("queued");
    expect(priorOutcome(["pending", "failed", "dlq"])).toBe("undelivered");
    expect(priorOutcome(["pending", "suppressed"])).toBe("undelivered");
    expect(priorOutcome(["pending", "failed", "sent"])).toBe("sent");
  });

  it("the nightly stamps sent_at only for a message the provider took", () => {
    const nightly = strip(read("src/routes/api/public/hooks/nightly.ts"));
    expect(nightly).toMatch(
      /else if \(res\.reason === "already_sent" && res\.prior === "sent"\) \{\s*await supabaseAdmin\s*\.from\("invoices"\)\s*\.update\(\{ sent_at/,
    );
    // No other already_sent branch, and no other stamp.
    expect(nightly.match(/res\.reason === "already_sent"/g)).toHaveLength(1);
  });

  it("the manual send says alreadySent only for a `sent` prior; queued is polled, dead-lettered is not sent", () => {
    const send = strip(read("src/lib/notifications.functions.ts"));
    const branch = send.slice(send.indexOf('if (res.reason === "already_sent"'));
    const sentArm = branch.slice(
      branch.indexOf('if (res.prior === "sent")'),
      branch.indexOf('if (res.prior === "queued")'),
    );
    expect(sentArm).toMatch(/alreadySent: true/);
    expect(send.match(/alreadySent: true/g)).toHaveLength(2); // the sent_at check above, and this arm
    const queuedArm = branch.slice(branch.indexOf('if (res.prior === "queued")'));
    expect(queuedArm).toMatch(/statusHandle: await handle\(res\.messageId\)/);
    expect(queuedArm).toMatch(/ok: false,\s*reason: res\.reason/);
  });

  it("a queued first send toasts Sending, never sent; a refused one toasts not sent", async () => {
    vi.useFakeTimers();
    const onSent = vi.fn();
    const poll = vi.fn(async () => ({ status: "pending", recipient: "a@b.co", error: null }));
    const p = reportQueuedSend(
      { ok: true, statusHandle: "h", recipient: "a@b.co", link: "https://x" },
      { what: "Invoice", poll, onSent },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBe("pending");
    expect(onSent).not.toHaveBeenCalled();
    expect(toastCalls.some((t) => t.kind === "success")).toBe(false);
  });
});

describe("only a final failure is reported as not sent (review should-fix)", () => {
  it("is exactly dlq, bounced, suppressed and complained", () => {
    expect([...FINAL_EMAIL_FAILURES].sort()).toEqual([
      "bounced",
      "complained",
      "dlq",
      "suppressed",
    ]);
  });

  const row = (status: string) => ({ status, recipient_email: "a@b.co", error_message: "e" });
  it("a retryable failure is still pending", () => {
    expect(emailStatusFromLog([row("failed"), row("pending")]).status).toBe("pending");
    expect(emailStatusFromLog([row("failed"), row("failed"), row("pending")]).status).toBe(
      "pending",
    );
  });
  it("a final failure is failed, and sent beats everything", () => {
    expect(emailStatusFromLog([row("dlq"), row("failed"), row("pending")]).status).toBe("failed");
    expect(emailStatusFromLog([row("bounced"), row("sent"), row("pending")]).status).toBe("sent");
    expect(emailStatusFromLog([]).status).toBe("pending");
  });
});

describe("the poll reads the real status, for its own organization only (review blocker 3)", () => {
  const ORG = "22222222-2222-4222-8222-222222222222";
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const MSG = "44444444-4444-4444-8444-444444444444";
  const invoice = { kind: "invoice" as const, id: ID };

  beforeEach(() => {
    process.env.SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || "test-service-role-key";
  });

  it("a handle verifies only for the organization it was signed for, and not once altered", () => {
    const h = signEmailStatusHandle(ORG, invoice, MSG);
    expect(verifyEmailStatusHandle(ORG, h)).toEqual({ subject: invoice, messageId: MSG });
    expect(verifyEmailStatusHandle(OTHER, h)).toBeNull();
    expect(verifyEmailStatusHandle(ORG, h.replace(MSG, OTHER))).toBeNull();
    expect(verifyEmailStatusHandle(ORG, h.replace("invoice.", "client."))).toBeNull();
    expect(verifyEmailStatusHandle(ORG, MSG)).toBeNull();
  });

  it("returns the log's real answer once the handle and the subject check out", async () => {
    const readLog = vi.fn(async () => [
      { status: "sent", recipient_email: "a@b.co", error_message: null },
      { status: "pending", recipient_email: "a@b.co", error_message: null },
    ]);
    const ownsSubject = vi.fn(async () => true);
    const out = await emailStatusForHandle(ORG, signEmailStatusHandle(ORG, invoice, MSG), {
      ownsSubject,
      readLog,
    });
    expect(out).toEqual({ status: "sent", recipient: "a@b.co", error: null });
    expect(ownsSubject).toHaveBeenCalledWith(invoice);
    expect(readLog).toHaveBeenCalledWith(MSG);
  });

  it("reads nothing for another organization's handle, or a subject the caller cannot see", async () => {
    const readLog = vi.fn(async () => []);
    await expect(
      emailStatusForHandle(OTHER, signEmailStatusHandle(ORG, invoice, MSG), {
        ownsSubject: async () => true,
        readLog,
      }),
    ).rejects.toThrow("Not found");
    await expect(
      emailStatusForHandle(ORG, signEmailStatusHandle(ORG, invoice, MSG), {
        ownsSubject: async () => false,
        readLog,
      }),
    ).rejects.toThrow("Not found");
    expect(readLog).not.toHaveBeenCalled();
  });

  it("the server fn checks ownership with the caller's client and reads the log as the service role", () => {
    const send = strip(read("src/lib/notifications.functions.ts"));
    const poll = send.slice(send.indexOf("export const getEmailSendStatus"));
    expect(poll).toMatch(/z\.object\(\{ handle: z\.string\(\)/);
    expect(poll).not.toMatch(/messageId: z\./);
    expect(poll).toMatch(
      /ownsSubject: async[\s\S]*?context\.supabase[\s\S]*?\.eq\("organization_id", orgId\)/,
    );
    expect(poll).toMatch(/readLog: async[\s\S]*?supabaseAdmin\s*\.from\("email_send_log"\)/);
    expect(poll.indexOf("ownsSubject")).toBeLessThan(poll.indexOf("readLog"));
  });
});
