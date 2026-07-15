import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  listAccountingConnections,
  upsertAccountingConnection,
  disconnectAccounting,
  listSyncLog,
  syncAllPaidInvoices,
} from "@/lib/accounting.functions";
import { startAccountingOAuth } from "@/lib/accounting-oauth.functions";
import { useConfirmDialog } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/_authenticated/settings/accounting")({
  head: () => ({ meta: [{ title: "Accounting sync · Settings" }] }),
  component: AccountingSettings,
});

type Provider = "quickbooks" | "xero";

// Kill switch for the QBO/Xero Connect buttons (per Brendan, 2026-07-14):
// disabled until the provider OAuth apps are approved and the QBO_*/XERO_*
// secrets are set. Everything downstream stays built and ready.
const ACCOUNTING_CONNECT_ENABLED = false;

function AccountingSettings() {
  const router = useRouter();
  const { confirm, dialog } = useConfirmDialog();
  const conns = useQuery({
    queryKey: ["accounting-connections"],
    queryFn: () => (listAccountingConnections as any)(),
  });
  const logs = useQuery({
    queryKey: ["accounting-sync-log"],
    queryFn: () => (listSyncLog as any)(),
  });
  const upsert = useServerFn(upsertAccountingConnection);
  const disconnect = useServerFn(disconnectAccounting);
  const syncAll = useServerFn(syncAllPaidInvoices);
  const startOAuth = useServerFn(startAccountingOAuth);

  async function connect(provider: Provider) {
    setBusy(true); setMsg(null);
    try {
      const { url } = await startOAuth({ data: { provider, origin: window.location.origin } });
      window.location.href = url;
    } catch (err: any) {
      setMsg(err?.message ?? "Failed to start connect flow");
      setBusy(false);
    }
  }

  const [provider, setProvider] = useState<Provider>("quickbooks");
  const [realmId, setRealmId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [income, setIncome] = useState("");
  const [autoSync, setAutoSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await upsert({
        data: {
          provider,
          realm_id: realmId || null,
          tenant_id: tenantId || null,
          access_token: accessToken || null,
          refresh_token: refreshToken || null,
          default_income_account: income || null,
          auto_sync: autoSync,
        },
      });
      setAccessToken(""); setRefreshToken("");
      router.invalidate();
      conns.refetch();
      setMsg("Saved.");
    } catch (err: any) {
      setMsg(err?.message ?? "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function runSync() {
    setBusy(true); setMsg(null);
    try {
      const res = await (syncAll as any)();
      setMsg(`Synced ${res.ok}/${res.total} paid invoices${res.failed ? ` (${res.failed} failed)` : ""}.`);
      logs.refetch();
    } catch (err: any) {
      setMsg(err?.message ?? "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      {dialog}
      <div>
        <h1 className="text-2xl font-semibold">Accounting sync</h1>
        <p className="text-sm text-muted-foreground">
          Push paid invoices to QuickBooks Online or Xero. Use the Connect buttons below to authorize your accounting provider. Tokens are refreshed automatically.
        </p>
      </div>

      <div className="rounded border bg-card p-4">
        <h2 className="mb-3 font-medium">Connect a provider</h2>
        {/* Per Brendan (2026-07-14): QBO/Xero connect disabled until the OAuth
            apps are approved and QBO_/XERO_ secrets are configured. The full
            flow (authorize → callback → refresh) is built — flip
            ACCOUNTING_CONNECT_ENABLED to re-enable. */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => connect("quickbooks")}
            disabled={busy || !ACCOUNTING_CONNECT_ENABLED}
            className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60"
          >
            Connect QuickBooks Online
          </button>
          <button
            onClick={() => connect("xero")}
            disabled={busy || !ACCOUNTING_CONNECT_ENABLED}
            className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60"
          >
            Connect Xero
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {ACCOUNTING_CONNECT_ENABLED
            ? "You'll be redirected to QuickBooks or Xero to authorize the connection securely. No credentials are entered here."
            : "QuickBooks and Xero connections are coming soon. They'll light up here once the integrations are activated."}
        </p>
      </div>

      <div className="rounded border bg-card p-4">
        <h2 className="mb-3 font-medium">Connected integrations</h2>
        {conns.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : conns.data?.length ? (
          <ul className="divide-y">
            {conns.data.map((c: any) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="font-medium capitalize">{c.provider}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.provider === "quickbooks" ? `Realm ${c.realm_id ?? "-"}` : `Tenant ${c.tenant_id ?? "-"}`}
                    {" · "}Auto-sync {c.auto_sync ? "on" : "off"}
                    {c.last_sync_at && ` · Last sync ${new Date(c.last_sync_at).toLocaleString()}`}
                  </div>
                </div>
                <button
                  className="text-xs text-red-600 hover:underline"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: `Disconnect ${c.provider}?`,
                        description: "Paid invoices will no longer sync to this provider.",
                        destructive: true,
                        confirmLabel: "Disconnect",
                      }))
                    )
                      return;
                    await disconnect({ data: { id: c.id } });
                    conns.refetch();
                  }}
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No integrations connected yet.</p>
        )}
        {conns.data && conns.data.length > 0 && (
          <button
            onClick={runSync}
            disabled={busy}
            className="mt-4 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60"
          >
            {busy ? "Syncing…" : "Sync all paid invoices now"}
          </button>
        )}
      </div>

      {/* Finding #31: manual OAuth-token entry is a security anti-pattern once
          the "Connect" OAuth flow above exists. Tucked behind an Advanced
          disclosure for support/debugging only, with the token fields masked. */}
      <details className="rounded border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Advanced: enter connection details manually
        </summary>
        <p className="mt-1 mb-3 text-xs text-muted-foreground">
          For support use only. Prefer the "Connect" buttons above. OAuth tokens should not need to
          be pasted by hand.
        </p>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Provider</span>
            <select
              className="w-full rounded border bg-background px-2 py-1"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              <option value="quickbooks">QuickBooks Online</option>
              <option value="xero">Xero</option>
            </select>
          </label>
          {provider === "quickbooks" ? (
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Realm ID (Company ID)</span>
              <input className="w-full rounded border bg-background px-2 py-1" value={realmId} onChange={(e) => setRealmId(e.target.value)} />
            </label>
          ) : (
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Tenant ID</span>
              <input className="w-full rounded border bg-background px-2 py-1" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
            </label>
          )}
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Access token</span>
          <input type="password" autoComplete="off" className="w-full rounded border bg-background px-2 py-1 font-mono text-xs" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="Paste OAuth access token" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Refresh token (optional)</span>
          <input type="password" autoComplete="off" className="w-full rounded border bg-background px-2 py-1 font-mono text-xs" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">
            Default income {provider === "quickbooks" ? "account (QBO Account Id)" : "account code"}
          </span>
          <input className="w-full rounded border bg-background px-2 py-1" value={income} onChange={(e) => setIncome(e.target.value)} placeholder={provider === "quickbooks" ? "e.g. 79" : "e.g. 200"} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
          Auto-sync paid invoices nightly
        </label>
        <button disabled={busy} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60">
          {busy ? "Saving…" : "Save connection"}
        </button>
        {msg && <p className="text-sm">{msg}</p>}
      </form>
      </details>

      <div className="rounded border bg-card p-4">
        <h2 className="mb-3 font-medium">Recent sync activity</h2>
        {logs.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : logs.data?.length ? (
          <ul className="divide-y text-sm">
            {logs.data.map((l: any) => (
              <li key={l.id} className="flex items-start justify-between py-2">
                <div>
                  <div>
                    <span className={l.status === "success" ? "text-green-600" : "text-red-600"}>{l.status}</span>
                    {" · "}
                    {l.direction} {l.entity_type}
                    {l.remote_id && <span className="text-muted-foreground"> → {l.remote_id}</span>}
                  </div>
                  {l.message && <div className="text-xs text-muted-foreground">{l.message}</div>}
                </div>
                <div className="text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString()}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sync activity yet.</p>
        )}
      </div>
    </div>
  );
}
