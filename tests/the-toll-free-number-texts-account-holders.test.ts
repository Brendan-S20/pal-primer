// HoundStack's toll-free number texts account holders. Nobody else.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// Twilio rejected HoundStack's toll-free verification. The resubmission
// (2026-10-06) says the number texts ACCOUNT HOLDERS ONLY: the people who sign
// in to HoundStack, for verification codes, security alerts, billing notices
// and support replies. It says the number is "not used for marketing or to
// message account holders' own customers".
//
// The code on main said the opposite. Every automated text to a business's
// client (reminders, on my way, visit completed, overdue invoices, a declined
// card, portal sign-in codes) chose its sender as
//
//     platformTwilioFrom() ?? org.sms_from_number
//
// which PREFERS the platform number, and `sendTwilioSms` defaulted to gateway
// mode, the platform's own Twilio account, whenever `credentials` was left
// out. So a text to a business's client reached HoundStack's number by
// omission. A number approved on a description its traffic contradicts gets
// blocked after approval, which is a worse place than rejected.
//
// Now: a business's client is texted only from that business's own
// subaccount (`endCustomerSmsSender`), and with none, not texted at all. The
// platform number and gateway mode are for account holders, and every place
// that names either is allowlisted below with its reason.
//
// ── WHAT IT CHECKS, BY PARSING ────────────────────────────────────────────
//
//   1. Nothing outside PLATFORM_NUMBER_ALLOWED calls
//      `platformAccountHolderFrom()`, and nothing anywhere names
//      `platformTwilioFrom`, the old name, whose every use was the fallback.
//   2. Nothing outside GATEWAY_ALLOWED builds `{ mode: "gateway" }`. Today
//      that list is EMPTY: there is no account-holder text in this codebase
//      (staff two-step codes go through Supabase Auth, billing notices by
//      email). The first one goes here, with its reason.
//   3. Every `sendTwilioSms({...})` names its `credentials`, and outside
//      GATEWAY_ALLOWED they are `<sender>.credentials`, where `<sender>` is
//      bound to `endCustomerSmsSender(...)` or is a parameter typed
//      `EndCustomerSmsSender`. Its `from` and `messagingServiceSid`, when
//      given, come from that same sender, so a subaccount's credentials
//      cannot be paired with somebody else's number.
//   4. Every file that sends is in SENDS, classified, so a new send site has
//      to say who it texts before this goes green.
//   5. The platform number's env var and the gateway URL are each read in
//      exactly one file.
//
// Parsed rather than grepped because the question is about binding (where
// did `sender` come from) and every file involved explains the old bug in a
// comment that a text match would find as the bug.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");

/** Every place that may call `platformAccountHolderFrom()`, and why each one
 *  is about an account holder. */
const PLATFORM_NUMBER_ALLOWED: Record<string, string> = {
  "src/routes/api/public/hooks/twilio.ts":
    "inbound: recognises a text sent TO the platform number, answers STOP/START/HELP in HoundStack's name, and routes it to no business",
};

/** Every place that may send in gateway mode (the platform's own account),
 *  and why each one texts an account holder. Empty: nothing does today. */
const GATEWAY_ALLOWED: Record<string, string> = {};

/** Every file that calls `sendTwilioSms`, and who it texts. A file here that
 *  is not in GATEWAY_ALLOWED may only send through endCustomerSmsSender. */
const SENDS: Record<string, string> = {
  "src/lib/messages.functions.ts":
    "END_CUSTOMER: staff-to-client message, and the visit reminder / visit completed buttons",
  "src/lib/on-my-way.server.ts": "END_CUSTOMER: on my way (email when it cannot text)",
  "src/lib/my-day.functions.ts": "END_CUSTOMER: automatic review request after a visit (email otherwise)",
  "src/lib/reviews.functions.ts": "END_CUSTOMER: review request from the client page (email otherwise)",
  "src/lib/portal-auth.server.ts": "END_CUSTOMER: client portal sign-in code (email otherwise)",
  "src/routes/api/public/hooks/stripe.ts": "END_CUSTOMER: card declined on autopay",
  "src/routes/api/public/hooks/nightly.ts": "END_CUSTOMER: overdue invoice reminder (email otherwise)",
  "src/lib/client-sms-consent.server.ts":
    "END_CUSTOMER: the opt-in confirmation after a client agrees to texts (#538), only once the business can text",
};

/** The definitions themselves. */
const DEFINES_SENDER = "src/lib/twilio-credentials.server.ts";
const DEFINES_SEND = "src/lib/twilio.server.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const lineOf = (src: ts.SourceFile, n: ts.Node) =>
  src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function containsCallTo(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && calleeName(n) === name) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Where `name` is bound, looking outward from `from`: a `const`/`let` in an
 *  enclosing block, or a parameter of an enclosing function. */
function bindingOf(
  name: string,
  from: ts.Node,
): ts.VariableDeclaration | ts.ParameterDeclaration | null {
  for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      for (const st of n.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        }
      }
    }
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return p;
      }
    }
  }
  return null;
}

/** `sender.credentials` → "sender", when `sender` came from the helper. */
function endCustomerSenderOf(expr: ts.Expression, src: ts.SourceFile): string | null {
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return null;
  const name = expr.expression.text;
  const b = bindingOf(name, expr);
  if (!b) return null;
  if (ts.isVariableDeclaration(b)) {
    return b.initializer && containsCallTo(b.initializer, "endCustomerSmsSender") ? name : null;
  }
  return b.type && b.type.getText(src) === "EndCustomerSmsSender" ? name : null;
}

/** A property's value: `key: value`, or for the shorthand `{ key }`, the
 *  name itself, which is a value bound somewhere else. */
function prop(
  obj: ts.ObjectLiteralExpression,
  key: string,
): { node: ts.Node; initializer: ts.Expression } | null {
  for (const p of obj.properties) {
    if (!p.name || !ts.isIdentifier(p.name) || p.name.text !== key) continue;
    if (ts.isPropertyAssignment(p)) return { node: p, initializer: p.initializer };
    if (ts.isShorthandPropertyAssignment(p)) return { node: p, initializer: p.name };
  }
  return null;
}

/** Each `sendTwilioSms(...)` in the file, with what is wrong with it. */
export function checkFile(text: string, filename: string): { sends: number; problems: string[] } {
  const src = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  let sends = 0;
  const at = (n: ts.Node) => `${filename}:${lineOf(src, n)}`;

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "platformTwilioFrom") {
      problems.push(
        `${at(node)}  platformTwilioFrom is gone. Its every use was ` +
          "`platformTwilioFrom() ?? org.sms_from_number`, which sent a business's client a text " +
          "from HoundStack's number. Use endCustomerSmsSender(orgId).",
      );
    }

    if (
      ts.isCallExpression(node) &&
      calleeName(node) === "platformAccountHolderFrom" &&
      !(filename in PLATFORM_NUMBER_ALLOWED)
    ) {
      problems.push(
        `${at(node)}  names HoundStack's toll-free number, which texts account holders only. ` +
          "A business's client is texted from the business's own number: endCustomerSmsSender(orgId). " +
          "If this really is an account holder, add the file to PLATFORM_NUMBER_ALLOWED with its reason.",
      );
    }

    if (ts.isObjectLiteralExpression(node) && filename !== DEFINES_SEND) {
      const mode = prop(node, "mode");
      if (
        mode &&
        ts.isStringLiteralLike(mode.initializer) &&
        mode.initializer.text === "gateway" &&
        !(filename in GATEWAY_ALLOWED)
      ) {
        problems.push(
          `${at(node)}  sends on the platform's own Twilio account (gateway mode), which texts ` +
            "account holders only. If this one does, add the file to GATEWAY_ALLOWED with its reason.",
        );
      }
    }

    if (ts.isCallExpression(node) && calleeName(node) === "sendTwilioSms") {
      sends++;
      let arg: ts.Expression | undefined = node.arguments[0];
      while (arg && (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg) || ts.isSatisfiesExpression(arg))) {
        arg = arg.expression;
      }
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        problems.push(`${at(node)}  sendTwilioSms needs an object literal, so who it texts can be read`);
      } else {
        const creds = prop(arg, "credentials");
        if (!creds) {
          problems.push(`${at(node)}  sendTwilioSms without credentials`);
        } else if (!(filename in GATEWAY_ALLOWED)) {
          const sender = endCustomerSenderOf(creds.initializer, src);
          if (!sender) {
            problems.push(
              `${at(creds.node)}  credentials must be \`<sender>.credentials\` from endCustomerSmsSender(orgId) ` +
                `(got \`${creds.initializer.getText(src)}\`). A business's client is texted from its own ` +
                "subaccount or not at all.",
            );
          } else {
            for (const key of ["from", "messagingServiceSid"]) {
              const p = prop(arg, key);
              if (p && !p.initializer.getText(src).startsWith(`${sender}.${key}`)) {
                problems.push(
                  `${at(p.node)}  \`${key}\` must come from the same sender as the credentials ` +
                    `(\`${sender}.${key}\`), not \`${p.initializer.getText(src)}\`.`,
                );
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return { sends, problems };
}

function scan() {
  const problems: string[] = [];
  const sending = new Set<string>();
  const envReaders = new Set<string>();
  const gatewayUrl = new Set<string>();
  for (const file of sourceFiles(join(root, "src"))) {
    const rel = repoRelative(file, root);
    const text = readFileSync(file, "utf8");
    const r = checkFile(text, rel);
    problems.push(...r.problems);
    if (r.sends > 0 && rel !== DEFINES_SEND) sending.add(rel);
    if (/process\.env\.PLATFORM_SMS_FROM_NUMBER/.test(text)) envReaders.add(rel);
    if (/connector-gateway\.lovable\.dev\/twilio/.test(text)) gatewayUrl.add(rel);
  }
  return { problems, sending, envReaders, gatewayUrl };
}

describe("HoundStack's toll-free number texts account holders, and nobody else", () => {
  const result = scan();

  it("no end-customer text names the platform number, gateway mode, or anything but the business's own subaccount", () => {
    expect(result.problems.join("\n")).toBe("");
  });

  it("every file that sends is classified, so a new one has to say who it texts", () => {
    expect([...result.sending].sort()).toEqual(Object.keys(SENDS).sort());
    for (const [file, why] of Object.entries(SENDS)) {
      expect(why, file).toMatch(/^(END_CUSTOMER|ACCOUNT_HOLDER): \S/);
      // An end-customer file cannot also be a gateway file.
      if (why.startsWith("END_CUSTOMER")) expect(GATEWAY_ALLOWED[file], file).toBeUndefined();
    }
  });

  it("every allowlisted site has a reason, and is about an account holder", () => {
    for (const [file, why] of [
      ...Object.entries(PLATFORM_NUMBER_ALLOWED),
      ...Object.entries(GATEWAY_ALLOWED),
    ]) {
      expect(why.length, file).toBeGreaterThan(20);
      expect(SENDS[file]?.startsWith("END_CUSTOMER") ?? false, file).toBe(false);
    }
  });

  it("reads the platform number in one place and calls the gateway from one place", () => {
    expect([...result.envReaders]).toEqual([DEFINES_SENDER]);
    expect([...result.gatewayUrl]).toEqual([DEFINES_SEND]);
  });

  it("would have caught what shipped, so a green run means checked", () => {
    // on-my-way.server.ts as it was on main before this test.
    const shipped = `
      async function trySms(p: any) {
        const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
        const from = platformTwilioFrom() ?? p.org.sms_from_number ?? null;
        const { sendTwilioSms } = await import("@/lib/twilio.server");
        await sendTwilioSms({ from, to: p.destPhone, body: p.body });
      }`;
    const r = checkFile(shipped, "src/lib/on-my-way.server.ts");
    expect(r.problems.some((m) => m.includes("platformTwilioFrom is gone"))).toBe(true);
    expect(r.problems.some((m) => m.includes("sendTwilioSms without credentials"))).toBe(true);

    // The same thing under the new name is still caught.
    const renamed = shipped.replace(/platformTwilioFrom/g, "platformAccountHolderFrom");
    expect(
      checkFile(renamed, "src/lib/on-my-way.server.ts").problems.some((m) =>
        m.includes("texts account holders only"),
      ),
    ).toBe(true);

    // messages.functions.ts's manual send fell back to gateway mode.
    const manual = `
      async function send(tenant: any, org: any) {
        await sendTwilioSms({
          to: "+1", body: "x", from: tenant?.from ?? org.sms_from_number,
          credentials: tenant
            ? { mode: "direct", accountSid: tenant.accountSid, authToken: tenant.authToken }
            : { mode: "gateway" },
        });
      }`;
    const m = checkFile(manual, "src/lib/messages.functions.ts").problems;
    expect(m.some((x) => x.includes("gateway mode"))).toBe(true);
    expect(m.some((x) => x.includes("credentials must be"))).toBe(true);
  });

  it("passes the shape it asks for, or the rule is unsatisfiable", () => {
    const fixed = `
      async function trySms(p: any) {
        const { endCustomerSmsSender } = await import("@/lib/twilio-credentials.server");
        const sender = await endCustomerSmsSender(p.orgId);
        if (!sender) return;
        await sendTwilioSms({
          to: p.to, body: p.body,
          from: sender.from ?? undefined,
          messagingServiceSid: sender.messagingServiceSid ?? undefined,
          credentials: sender.credentials,
        });
      }
      async function nightly(sender: EndCustomerSmsSender) {
        await sendTwilioSms({ to: "+1", body: "x", from: sender.from ?? undefined, credentials: sender.credentials });
      }`;
    expect(checkFile(fixed, "src/lib/x.ts")).toEqual({ sends: 2, problems: [] });
  });

  it("does not accept a subaccount's credentials paired with another number", () => {
    const mixed = `
      async function f(org: any) {
        const sender = await endCustomerSmsSender(org.id);
        await sendTwilioSms({ to: "+1", body: "x", from: org.sms_from_number, credentials: sender.credentials });
      }`;
    expect(checkFile(mixed, "src/lib/x.ts").problems).toHaveLength(1);
    // The shorthand spelling of the same thing.
    const shorthand = `
      async function f(org: any) {
        const sender = await endCustomerSmsSender(org.id);
        const from = org.sms_from_number;
        await sendTwilioSms({ to: "+1", body: "x", from, credentials: sender.credentials });
      }`;
    expect(checkFile(shorthand, "src/lib/x.ts").problems).toHaveLength(1);
  });

  it("does not accept credentials from anywhere but the helper", () => {
    const handRolled = `
      async function f(orgId: string) {
        const tenant = await resolveOrgTwilioConfig(orgId);
        const sender = { credentials: { mode: "direct", accountSid: tenant.accountSid, authToken: tenant.authToken } };
        await sendTwilioSms({ to: "+1", body: "x", credentials: sender.credentials });
      }`;
    expect(checkFile(handRolled, "src/lib/x.ts").problems).toHaveLength(1);
  });
});
