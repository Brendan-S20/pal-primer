import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  confirmQuickBooksDisconnected,
  disconnectQuickBooks,
  getQuickBooksStatus,
  listQuickBooksChoices,
  listSyncLog,
  saveQuickBooksMapping,
  syncAllPaidInvoices,
} from "@/lib/accounting.functions";
import { startAccountingOAuth } from "@/lib/accounting-oauth.functions";
import { qboCallbackErrorMessage } from "@/lib/qbo-redirect";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { usePermissions } from "@/hooks/useMyRole";
import { formatDateTime } from "@/lib/format";
import { pageTitle } from "@/lib/page-title";

// QuickBooks Online sync (Xero was dropped on 2026-10-09).
//
// Intuit's app settings point three URLs here, and each is handled on load:
//   ?connect=quickbooks       Connect/Reconnect URL. An owner or office
//                             manager is sent straight into the OAuth flow;
//                             anyone else sees the button.
//   ?disconnected=quickbooks  Disconnect URL, after the user disconnects from
//                             inside QuickBooks. Says so, and has the server
//                             mark the connection disconnected once QuickBooks
//                             confirms it no longer accepts the token.
//   ?connected / ?qbo_error   Where the OAuth callback sends the browser back.
export const Route = createFileRoute("/_authenticated/settings/accounting")({
  head: () => ({ meta: [{ title: pageTitle("Accounting", "Settings") }] }),
  component: AccountingSettings,
});

const SUPPORT_EMAIL = "support@houndstack.com";

type Banner = { tone: "ok" | "warn" | "error"; text: string };

function AccountingSettings() {
  const { can, loading: roleLoading } = usePermissions();
  const canManage = can("manage_settings");
  const search = useLocation().search as Record<string, unknown>;
  const { confirm, dialog } = useConfirmDialog();

  const statusFn = useServerFn(getQuickBooksStatus);
  const choicesFn = useServerFn(listQuickBooksChoices);
  const logFn = useServerFn(listSyncLog);
  const startOAuth = useServerFn(startAccountingOAuth);
  const saveMapping = useServerFn(saveQuickBooksMapping);
  const disconnect = useServerFn(disconnectQuickBooks);
  const confirmDisconnected = useServerFn(confirmQuickBooksDisconnected);
  const syncAll = useServerFn(syncAllPaidInvoices);

  const status = useQuery({ queryKey: ["qbo-status"], queryFn: () => statusFn(), enabled: canManage });
  const conn = status.data?.connection ?? null;
  const connected = conn?.status === "connected";
  const choices = useQuery({
    queryKey: ["qbo-choices", conn?.realm_id],
    queryFn: () => choicesFn(),
    enabled: canManage && connected,
    retry: false,
  });
  const logs = useQuery({ queryKey: ["qbo-sync-log"], queryFn: () => logFn(), enabled: canManage });

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [serviceItem, setServiceItem] = useState("");
  const [taxItem, setTaxItem] = useState("");
  const [deposit, setDeposit] = useState("");

  useEffect(() => {
    if (!conn) return;
    setServiceItem(conn.service_item_id ?? "");
    setTaxItem(conn.sales_tax_item_id ?? "");
    setDeposit(conn.deposit_account_id ?? "");
  }, [conn?.service_item_id, conn?.sales_tax_item_id, conn?.deposit_account_id]);

  async function connect() {
    setBusy(true);
    setMsg(null);
    try {
      const { url } = await startOAuth({ data: { provider: "quickbooks", origin: window.location.origin } });
      window.location.href = url;
    } catch (err: any) {
      setMsg(err?.message ?? "Couldn't start connecting QuickBooks.");
      setBusy(false);
    }
  }

  // The URLs Intuit and the callback send people to, handled once each.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || roleLoading) return;
    const p = (k: string) => (typeof search[k] === "string" ? (search[k] as string) : null);
    const clear = () => window.history.replaceState(null, "", "/settings/accounting");
    if (p("disconnected") === "quickbooks") {
      handled.current = true;
      setBanner({ tone: "warn", text: "QuickBooks is disconnected." });
      clear();
      if (canManage) {
        confirmDisconnected()
          .then((r) => {
            if (r.state === "still_connected") {
              setBanner({
                tone: "warn",
                text: "QuickBooks still accepts HoundStack's connection, so it was left connected. Use Disconnect below to end it.",
              });
            }
            status.refetch();
            logs.refetch();
          })
          .catch(() => status.refetch());
      }
      return;
    }
    const err = qboCallbackErrorMessage(p("qbo_error"));
    if (err) {
      handled.current = true;
      setBanner({ tone: "error", text: err });
      clear();
      return;
    }
    if (p("connected") === "quickbooks") {
      handled.current = true;
      setBanner({ tone: "ok", text: "QuickBooks is connected. Choose where invoices post below, then send them." });
      clear();
      return;
    }
    if (p("connect") === "quickbooks") {
      if (!canManage) {
        handled.current = true;
        clear();
        return;
      }
      if (!status.data) return; // wait for it, to know whether keys are set
      handled.current = true;
      clear();
      if (status.data.configured) void connect();
    }
  }, [roleLoading, canManage, status.data, search]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await saveMapping({
        data: {
          service_item_id: serviceItem || null,
          sales_tax_item_id: taxItem || null,
          deposit_account_id: deposit || null,
        },
      });
      await status.refetch();
      setMsg("Saved.");
    } catch (err: any) {
      setMsg(err?.message ?? "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function runSync() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await syncAll();
      setMsg(
        r.total === 0
          ? "Everything paid is already in QuickBooks."
          : `Sent ${r.ok} of ${r.total} paid invoices with their payments${r.failed ? `; ${r.failed} had an error, listed below` : ""}.${r.stopped ? ` Stopped: ${r.stopped}` : ""}`,
      );
    } catch (err: any) {
      setMsg(err?.message ?? "Sync failed.");
    } finally {
      setBusy(false);
      status.refetch();
      logs.refetch();
    }
  }

  async function onDisconnect() {
    const ok = await confirm({
      title: "Disconnect QuickBooks?",
      description:
        "HoundStack's access is revoked at Intuit and its tokens are deleted. Nothing already in QuickBooks is changed or removed.",
      destructive: true,
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await disconnect();
      setBanner({ tone: "warn", text: "QuickBooks is disconnected." });
    } catch (err: any) {
      setMsg(err?.message ?? "Couldn't disconnect.");
    } finally {
      setBusy(false);
      status.refetch();
      logs.refetch();
    }
  }

  const items = choices.data?.items ?? [];
  const accounts = choices.data?.depositAccounts ?? [];
  const errors = (logs.data ?? []).filter((l) => l.status === "error");

  return (
    <div className="space-y-6">
      {dialog}
      <div>
        <h2 className="text-lg font-semibold">QuickBooks Online</h2>
        <p className="text-sm text-muted-foreground">
          Send paid invoices, and the payments that paid them, to your QuickBooks Online company. Each
          one is sent once and updated in place after that, and each client is added to QuickBooks
          only once.
        </p>
      </div>

      {banner && <BannerBox banner={banner} />}

      {conn?.status === "needs_reconnect" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span className="min-w-0">
              QuickBooks needs to be reconnected. Nothing is syncing until it is. Your choices below are kept.
            </span>
          </div>
          <button type="button" onClick={connect} disabled={busy} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60 touch:min-h-11 shrink-0">
            Reconnect QuickBooks
          </button>
        </div>
      )}

      <div className="rounded border bg-card p-4">
        <h2 className="mb-3 font-medium">Connection</h2>
        {!roleLoading && !canManage ? (
          <div className="space-y-2">
            <button type="button" disabled className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60 touch:min-h-11">
              Connect to QuickBooks
            </button>
            <p className="text-xs text-muted-foreground">Only an owner or office manager can connect QuickBooks.</p>
          </div>
        ) : status.isLoading || roleLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : status.data && !status.data.configured ? (
          <p className="text-sm text-muted-foreground">
            QuickBooks isn't set up on this server yet. Contact support at {SUPPORT_EMAIL}.
          </p>
        ) : connected ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 text-sm">
              <div className="font-medium">
                Connected
                {status.data?.environment === "sandbox" && (
                  <span className="ms-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                    Sandbox
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Company ID <span dir="ltr">{conn?.realm_id}</span>
                {conn?.connected_at && ` · since ${formatDateTime(conn.connected_at)}`}
                {conn?.last_sync_at && ` · last sync ${formatDateTime(conn.last_sync_at)}`}
              </div>
            </div>
            <button type="button" onClick={onDisconnect} disabled={busy} className="rounded border px-3 py-2 text-sm disabled:opacity-60 touch:min-h-11 shrink-0 text-red-600">
              Disconnect
            </button>
          </div>
        ) : conn?.status === "needs_reconnect" ? (
          <p className="text-sm text-muted-foreground">Reconnect QuickBooks with the button above.</p>
        ) : (
          <div className="space-y-2">
            <button type="button" onClick={connect} disabled={busy} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60 touch:min-h-11">
              Connect to QuickBooks
            </button>
            <p className="text-xs text-muted-foreground">
              You'll sign in to Intuit and choose a company. HoundStack never sees your Intuit password.
            </p>
          </div>
        )}
      </div>

      {canManage && connected && (
        <form onSubmit={save} className="space-y-3 rounded border bg-card p-4">
          <h2 className="font-medium">Where invoices post</h2>
          {choices.isError ? (
            <p className="text-sm text-red-600">{(choices.error as Error)?.message ?? "Couldn't read your QuickBooks lists."}</p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-3">
            <ChoiceSelect
              label="Product or service for invoice lines"
              hint="Its income account is where the revenue lands. Pick a non-taxable one: sales tax goes across as its own line."
              value={serviceItem}
              onChange={setServiceItem}
              options={items}
              empty="Choose…"
            />
            <ChoiceSelect
              label="Product or service for sales tax"
              hint="Only if you charge sales tax. Point its account at your sales tax liability, not income. A taxed invoice won't send until this is set."
              value={taxItem}
              onChange={setTaxItem}
              options={items}
              empty="None"
            />
            <ChoiceSelect
              label="Deposit payments to"
              hint="Blank leaves them in Undeposited Funds, QuickBooks' default."
              value={deposit}
              onChange={setDeposit}
              options={accounts}
              empty="Undeposited Funds"
            />
          </div>
          <button
            type="submit"
            disabled={busy || choices.isLoading}
            className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60 touch:min-h-11"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      {canManage && connected && (
        <div className="space-y-2 rounded border bg-card p-4">
          <h2 className="font-medium">Send to QuickBooks</h2>
          <p className="text-sm text-muted-foreground">
            Sends up to 50 paid invoices that aren't in QuickBooks yet, with their payments, and any
            new payment on an invoice already there. A single invoice can also be sent from its own page.
          </p>
          <button type="button" onClick={runSync} disabled={busy || !conn?.service_item_id} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60 touch:min-h-11">
            {busy ? "Sending…" : "Send paid invoices and payments now"}
          </button>
          {!conn?.service_item_id && (
            <p className="text-xs text-muted-foreground">Choose a product or service above first.</p>
          )}
        </div>
      )}

      {msg && <p className="text-sm">{msg}</p>}

      {canManage && (
        <div className="rounded border bg-card p-4">
          <h2 className="mb-1 font-medium">Recent activity</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            {errors.length
              ? `${errors.length} recent error${errors.length === 1 ? "" : "s"}. The Intuit ID on each is what Intuit support asks for.`
              : "Every call to QuickBooks is recorded here, with Intuit's ID for it."}
          </p>
          {logs.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : logs.data?.length ? (
            <ul className="divide-y text-sm">
              {logs.data.map((l) => (
                <li key={l.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
                  <div className="min-w-0">
                    <div>
                      <span className={l.status === "success" ? "text-green-600" : "text-red-600"}>
                        {l.status === "success" ? "OK" : "Error"}
                      </span>
                      {" · "}
                      {l.entity_type}
                      {l.remote_id && <span className="text-muted-foreground"> → QuickBooks #{l.remote_id}</span>}
                    </div>
                    {l.message && <div className="break-words text-xs text-muted-foreground">{l.message}</div>}
                    {(l.intuit_tid || l.error_code) && (
                      <div className="break-all text-xs text-muted-foreground">
                        {l.error_code && <>Code {l.error_code}</>}
                        {l.error_code && l.intuit_tid && " · "}
                        {l.intuit_tid && (
                          <>
                            Intuit ID <span dir="ltr" className="font-mono">{l.intuit_tid}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">{formatDateTime(l.created_at)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          )}
        </div>
      )}

      <div className="rounded border bg-card p-4 text-sm">
        <h2 className="mb-1 font-medium">Help</h2>
        <p className="text-muted-foreground">
          Questions about QuickBooks sync? See the{" "}
          <Link to="/help" search={{ article: undefined }} className="font-medium text-primary underline">
            Knowledge Center
          </Link>{" "}
          or email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-primary underline">
            {SUPPORT_EMAIL}
          </a>
          . For an error, include the Intuit ID from Recent activity.
        </p>
        <p className="mt-2 text-muted-foreground">
          Prefer a file?{" "}
          <Link to="/tax-reports" className="font-medium text-primary underline">
            Download your invoices in QuickBooks&apos; import format
          </Link>{" "}
          from the accountant reports.
        </p>
      </div>
    </div>
  );
}

function BannerBox({ banner }: { banner: Banner }) {
  const tone =
    banner.tone === "ok"
      ? "border-green-600/40 bg-green-600/5"
      : banner.tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10"
        : "border-destructive/40 bg-destructive/5";
  const Icon = banner.tone === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <div role="status" className={`flex items-start gap-2 rounded border p-4 text-sm ${tone}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">{banner.text}</span>
    </div>
  );
}

function ChoiceSelect(p: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
  empty: string;
}) {
  // A saved Id that is no longer in the list (made inactive in QuickBooks)
  // stays selectable, so saving the form does not silently clear it.
  const missing = p.value && !p.options.some((o) => o.id === p.value);
  return (
    <label className="block min-w-0 text-sm">
      <span className="mb-1 block text-muted-foreground">{p.label}</span>
      <select
        className="w-full min-w-0 rounded border bg-background px-2 py-1"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      >
        <option value="">{p.empty}</option>
        {missing && <option value={p.value}>QuickBooks #{p.value}</option>}
        {p.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-xs text-muted-foreground">{p.hint}</span>
    </label>
  );
}
