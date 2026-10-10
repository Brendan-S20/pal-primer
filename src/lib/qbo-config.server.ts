// QuickBooks Online: where the app's Intuit credentials come from, and which
// Intuit environment they belong to.
//
// THE ONLY FILE IN src/ THAT READS QBO_CLIENT_ID OR QBO_CLIENT_SECRET.
// tests/quickbooks-credentials-stay-on-the-server.test.ts holds every other
// file to that, and to never spelling them `VITE_*` or `import.meta.env.*`,
// which is how a server secret ends up in the browser bundle. Server-only by
// name (`.server.ts`), and nothing here is ever returned to a caller except
// the environment name and a yes/no for "configured".

export type QboEnvironment = "sandbox" | "production";

/** `QBO_ENVIRONMENT=production` selects production; anything else, including
 *  unset, is the sandbox. A typo therefore fails safe: it talks to test
 *  companies, never to a customer's real books. */
export function qboEnvironment(env: NodeJS.ProcessEnv = process.env): QboEnvironment {
  return env.QBO_ENVIRONMENT?.trim().toLowerCase() === "production" ? "production" : "sandbox";
}

export type QboCredentials = { clientId: string; clientSecret: string };

/** The app's Intuit keys, or null when either is missing. */
export function qboCredentials(env: NodeJS.ProcessEnv = process.env): QboCredentials | null {
  const clientId = env.QBO_CLIENT_ID?.trim();
  const clientSecret = env.QBO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Intuit's OpenID discovery documents. The OAuth endpoints (authorize, token,
 *  revoke) are read from these at run time rather than written down here. */
export const QBO_DISCOVERY_URL: Record<QboEnvironment, string> = {
  sandbox: "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
  production: "https://developer.api.intuit.com/.well-known/openid_configuration",
};

/** The Accounting API host. Not in the discovery document, which describes
 *  OAuth only; Intuit documents these two hosts per environment. */
export const QBO_API_BASE: Record<QboEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};

/** Intuit retired minor versions 1 to 74 in 2025; 75 is the floor. */
export const QBO_MINOR_VERSION = 75;

/** Read and write to the company's accounting data, nothing else (no
 *  payments, payroll or OpenID profile). */
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
