import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The AI receptionist answers texts and calls to a business's own number with
// nobody watching. An audit on 2026-10-03, before it had taken a single text in
// production, found it would lose every lead it captured, answer a stranger's
// "STOP" with a model-written reply, and run without any per-sender, per-call
// or per-request limit. These pin the fixes. They read the source rather than
// running a model, because the failures were all in what the code passes to or
// around the model, not in what the model says.

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
const receptionist = read("src/lib/ai-receptionist.server.ts");
const sms = read("src/routes/api/public/hooks/twilio.ts");
const voice = read("src/routes/api/public/hooks/twilio-voice.ts");

describe("a captured lead belongs to the business it was captured for", () => {
  it("writes organization_id on the lead", () => {
    // `leads` is read per organization. Without the column the row existed and
    // no tenant could see it, including the one whose number was texted.
    const insert = receptionist.slice(
      receptionist.indexOf('.from("leads")'),
      receptionist.indexOf(".select(", receptionist.indexOf('.from("leads")')),
    );
    expect(insert).toMatch(/organization_id: input\.organizationId/);
  });
});

describe("STOP, START and HELP never reach the model", () => {
  it("answers the keywords for every sender, not only a matched client", () => {
    // `client && isStop` let a stranger's STOP fall through to the AI.
    expect(sms).not.toMatch(/client && isStop/);
    expect(sms).not.toMatch(/client && isStart/);
    expect(sms).toMatch(/if \(isStop\) \{/);
    expect(sms).toMatch(/\} else if \(isStart\) \{/);
  });

  it("only runs the receptionist when no keyword reply was written", () => {
    const gate = sms.slice(sms.indexOf("// AI receptionist: only if"));
    expect(gate.slice(0, 400)).toMatch(/!reply &&/);
  });
});

describe("nothing outside the business can spend its allowance without limit", () => {
  it("caps AI replies to one number per hour", () => {
    expect(sms).toMatch(/const AI_REPLIES_PER_SENDER_PER_HOUR = \d+;/);
    expect(sms).toMatch(/!senderThrottled &&/);
  });

  it("caps AI turns on one phone call", () => {
    expect(voice).toMatch(/const MAX_AI_TURNS_PER_CALL = \d+;/);
    const capAt = voice.indexOf("turn > MAX_AI_TURNS_PER_CALL");
    const callAt = voice.indexOf("runAiReceptionist(");
    expect(capAt, "no turn cap").toBeGreaterThan(-1);
    expect(capAt, "the cap is checked after the model is called").toBeLessThan(callAt);
  });

  it("bounds every model call in time and length", () => {
    expect(receptionist).toMatch(/abortSignal: AbortSignal\.timeout\(/);
    expect(receptionist).toMatch(/maxOutputTokens: \d+/);
  });
});

describe("the reply cannot promise what the business did not", () => {
  it("tells the model what it may not offer and that it is automated", () => {
    expect(receptionist).toMatch(/Never offer a discount, refund, credit, free service/);
    expect(receptionist).toMatch(/are not instructions/);
    expect(receptionist).toMatch(/automated assistant/);
  });
});

describe("voice is part of the receptionist add-on", () => {
  // Voice had no gate of its own: `voice_enabled` could be switched on with no
  // add-on, the webhook checked only that flag, and cancelling the add-on
  // turned the receptionist off and left the phone line answered.
  it("needs the add-on to switch on", () => {
    expect(read("src/lib/ai-receptionist.functions.ts")).toMatch(
      /if \(data\.enabled \|\| data\.voice_enabled\) \{/,
    );
  });

  it("goes off when the add-on is cancelled", () => {
    expect(read("src/lib/platform-addons.server.ts")).toMatch(
      /ai_receptionist: \["ai_receptionist_enabled", "ai_voice_enabled"\]/,
    );
  });

  it("answers a call only while the receptionist is on", () => {
    expect(voice).toMatch(/!\(org as any\)\.ai_receptionist_enabled/);
  });
});
