// #831 review: the signup notice about the verify link was chosen from a flag
// read after `await finishSignup(...)`. Once the send is fire-and-forget
// (#824, so "Create my workspace" does not wait on the mail provider), that
// flag is still false when the notice is drawn, and every new owner would
// read "We could not send a link" for a link that went out. The notice now
// comes from the send's own settlement, whenever that is.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sendWithVerifyNotice, signupVerifyNotice } from "@/lib/verify-email-copy";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// The shape #824 gives finishSignup: start the send, do not wait for it.
async function fireAndForgetFinish(send: () => Promise<unknown>) {
  void Promise.resolve()
    .then(() => send())
    .catch(() => {});
  return "workspace" as const;
}

describe("the signup verify notice", () => {
  it("says sent once a send that outlives finishSignup resolves", async () => {
    const d = deferred();
    const notify = vi.fn();
    const send = sendWithVerifyNotice(() => d.promise, "a@b.co", notify);
    expect(await fireAndForgetFinish(send)).toBe("workspace");
    await flush();
    // finishSignup has returned and the send is still out: nothing said yet.
    expect(notify).not.toHaveBeenCalled();
    d.resolve();
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(signupVerifyNotice("a@b.co", true));
  });

  it("says not sent when that send rejects, and still reports the failure", async () => {
    const d = deferred();
    const notify = vi.fn();
    const send = sendWithVerifyNotice(() => d.promise, "a@b.co", notify);
    const settled = send();
    d.reject(new Error("queue down"));
    await expect(settled).rejects.toThrow("queue down");
    expect(notify).toHaveBeenCalledWith(signupVerifyNotice("a@b.co", false));
  });

  it("get-started reads no flag after finishSignup", () => {
    const page = readFileSync(new URL("../src/routes/get-started.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/sendEmailVerification: sendWithVerifyNotice\(/);
    expect(page).not.toMatch(/verifySent/);
  });
});
