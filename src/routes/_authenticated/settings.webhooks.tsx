import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  rotateWebhookSecret,
  sendWebhookTest,
  updateWebhookEndpoint,
} from "@/lib/webhooks.functions";
import { WEBHOOK_EVENTS, WEBHOOK_SIGNATURE_HEADER, type WebhookEventType } from "@/lib/webhooks";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDateTime } from "@/lib/format";
import { pageTitle } from "@/lib/page-title";
import { focusFirstInvalid } from "@/lib/form-errors";

export const Route = createFileRoute("/_authenticated/settings/webhooks")({
  head: () => ({ meta: [{ title: pageTitle("Zapier & webhooks", "Settings") }] }),
  component: WebhookSettings,
});

type Endpoint = {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  include_contact: boolean;
  secret_last4: string | null;
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
};

type Delivery = {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
};

const EVENT_LABEL: Record<string, string> = Object.fromEntries(
  WEBHOOK_EVENTS.map((e) => [e.type, e.label]),
);

function errorText(e: unknown, fallback: string): string {
  return (e as Error)?.message || fallback;
}

/** The events picker, used by both the add form and the edit panel. One
 *  column on a phone, two from `sm`, three from `lg`, so each label keeps a
 *  whole line and each checkbox its 44px touch box. */
/** Whether this endpoint's deliveries carry the customer's email and phone.
 *  Off unless the owner ticks it, because a webhook URL is somebody else's
 *  system and contact details are the part of a record most worth guarding. */
function ContactOption({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-start gap-3 py-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <span className="min-w-0">
        <span className="block">Include client email and phone</span>
        <span className="block text-xs text-muted-foreground">
          Adds a <code className="font-mono">contact</code> object to events about a client or lead,
          for things like adding new clients to a mailing list. Only turn this on for a system you
          trust with your clients&apos; details.
        </span>
      </span>
    </label>
  );
}

function EventPicker({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm text-muted-foreground">Send these events</legend>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {WEBHOOK_EVENTS.map((e) => {
          const id = `${idPrefix}-${e.type}`;
          const checked = value.includes(e.type);
          return (
            <label key={e.type} htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm">
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(c) =>
                  onChange(c ? [...value, e.type] : value.filter((t) => t !== e.type))
                }
              />
              <span className="min-w-0">
                <span className="block">{e.label}</span>
                <span className="block break-all font-mono text-2xs text-muted-foreground">
                  {e.type}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The one time a secret is shown. */
function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="space-y-3 rounded border border-primary/40 bg-primary/5 p-4">
      <div>
        <h3 className="font-medium">Signing secret</h3>
        <p className="text-sm text-muted-foreground">
          Copy it now and paste it into the system receiving the events. It is stored encrypted and
          will not be shown again. If you lose it, rotate the secret.
        </p>
      </div>
      <code className="block select-all break-all rounded bg-background px-3 py-2 font-mono text-xs">
        {secret}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check className="h-4 w-4 shrink-0" /> : <Copy className="h-4 w-4 shrink-0" />}
          {copied ? "Copied" : "Copy secret"}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

function DeliveryRow({ d }: { d: Delivery }) {
  const tone =
    d.status === "succeeded"
      ? "text-green-700 dark:text-green-400"
      : d.status === "failed"
        ? "text-red-600"
        : "text-amber-700 dark:text-amber-400";
  const statusLabel =
    d.status === "succeeded" ? "Delivered" : d.status === "failed" ? "Failed" : "Retrying";
  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`font-medium ${tone}`}>{statusLabel}</span>
        <span className="break-all font-mono text-xs">{d.event_type}</span>
        {d.last_status_code != null && (
          <span className="text-xs text-muted-foreground">HTTP {d.last_status_code}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}
        </span>
        <span className="text-xs text-muted-foreground">{formatDateTime(d.created_at)}</span>
      </div>
      {d.status === "pending" && d.attempts > 0 && d.next_attempt_at && (
        <div className="text-xs text-muted-foreground">
          Next try {formatDateTime(d.next_attempt_at)}
        </div>
      )}
      {d.last_error && (
        <div className="break-words text-xs text-muted-foreground">{d.last_error}</div>
      )}
    </li>
  );
}

function EndpointCard({
  ep,
  deliveries,
  onChanged,
  onSecret,
}: {
  ep: Endpoint;
  deliveries: Delivery[];
  onChanged: () => void;
  onSecret: (secret: string) => void;
}) {
  const { confirm, dialog } = useConfirmDialog();
  const update = useServerFn(updateWebhookEndpoint);
  const rotate = useServerFn(rotateWebhookSecret);
  const remove = useServerFn(deleteWebhookEndpoint);
  const test = useServerFn(sendWebhookTest);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [events, setEvents] = useState<string[]>(ep.events);
  const [description, setDescription] = useState(ep.description);
  const [includeContact, setIncludeContact] = useState(ep.include_contact);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e, `${label} failed.`) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-3 rounded border bg-card p-4">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="break-all font-mono text-sm">{ep.url}</div>
          {ep.description && (
            <div className="break-words text-sm text-muted-foreground">{ep.description}</div>
          )}
        </div>
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${
            ep.enabled
              ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {ep.enabled ? "On" : "Off"}
        </span>
      </div>

      {!ep.enabled && ep.disabled_reason && (
        <p className="text-sm text-red-600">
          {ep.disabled_reason}
          {ep.disabled_at ? ` (${formatDateTime(ep.disabled_at)})` : ""}.
        </p>
      )}

      <div className="flex flex-wrap gap-1">
        {ep.events.map((t) => (
          <span key={t} className="rounded bg-muted px-2 py-0.5 text-xs" title={t}>
            {EVENT_LABEL[t] ?? t}
          </span>
        ))}
        {ep.include_contact && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
            Includes email and phone
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="break-all">Secret whsec_...{ep.secret_last4 ?? "????"}</span>
        {ep.last_success_at && <span>Last delivered {formatDateTime(ep.last_success_at)}</span>}
        {ep.consecutive_failures > 0 && (
          <span>
            {ep.consecutive_failures} failed{" "}
            {ep.consecutive_failures === 1 ? "delivery" : "deliveries"} in a row
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run("Test", async () => {
              const r = await test({ data: { id: ep.id } });
              setMsg(
                r.ok
                  ? { ok: true, text: `Test event delivered (HTTP ${r.status_code}).` }
                  : { ok: false, text: `Test event failed. ${r.error ?? ""}`.trim() },
              );
              onChanged();
            })
          }
        >
          Send test event
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setEvents(ep.events);
            setDescription(ep.description);
            setIncludeContact(ep.include_contact);
            setEditing((v) => !v);
          }}
          aria-expanded={editing}
        >
          {editing ? "Cancel edit" : "Edit"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(ep.enabled ? "Switching off" : "Switching on", async () => {
              await update({ data: { id: ep.id, enabled: !ep.enabled } });
              onChanged();
            })
          }
        >
          {ep.enabled ? "Switch off" : "Switch on"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            const ok = await confirm({
              title: "Rotate the signing secret?",
              description:
                "Events are signed with the new secret from now on. The receiving system will reject them until you paste the new secret into it.",
              confirmLabel: "Rotate",
            });
            if (!ok) return;
            await run("Rotating", async () => {
              const r = await rotate({ data: { id: ep.id } });
              onSecret(r.secret);
              onChanged();
            });
          }}
        >
          Rotate secret
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-red-600"
          disabled={busy}
          onClick={async () => {
            const ok = await confirm({
              title: "Delete this webhook?",
              description: "Nothing more is sent to it, and its delivery history is removed.",
              destructive: true,
              confirmLabel: "Delete",
            });
            if (!ok) return;
            await run("Deleting", async () => {
              await remove({ data: { id: ep.id } });
              onChanged();
            });
          }}
        >
          Delete
        </Button>
      </div>

      {msg && (
        <p
          role="status"
          className={`break-words text-sm ${msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}`}
        >
          {msg.text}
        </p>
      )}

      {editing && (
        <form
          className="space-y-3 rounded border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run("Saving", async () => {
              await update({
                data: {
                  id: ep.id,
                  description,
                  events: events as WebhookEventType[],
                  includeContact,
                },
              });
              setEditing(false);
              onChanged();
            });
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Description</span>
            <Input
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <EventPicker idPrefix={`edit-${ep.id}`} value={events} onChange={setEvents} />
          <ContactOption
            id={`edit-${ep.id}-contact`}
            checked={includeContact}
            onChange={setIncludeContact}
          />
          <Button type="submit" size="sm" disabled={busy || events.length === 0}>
            Save changes
          </Button>
        </form>
      )}

      <details>
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
          Recent deliveries ({deliveries.length})
        </summary>
        {deliveries.length ? (
          <ul className="divide-y">
            {deliveries.map((d) => (
              <DeliveryRow key={d.id} d={d} />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">
            Nothing sent yet. Send a test event, or wait for one of the events above to happen.
          </p>
        )}
      </details>
    </li>
  );
}

function WebhookSettings() {
  const endpoints = useQuery({
    queryKey: ["webhook-endpoints"],
    queryFn: () => (listWebhookEndpoints as any)() as Promise<Endpoint[] | null>,
  });
  const deliveries = useQuery({
    queryKey: ["webhook-deliveries"],
    queryFn: () => (listWebhookDeliveries as any)() as Promise<Delivery[] | null>,
  });
  const create = useServerFn(createWebhookEndpoint);

  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["visit.completed"]);
  const [includeContact, setIncludeContact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  // Add webhook used to sit disabled until a URL was typed and an event
  // ticked, without saying so. Now it says which, on submit.
  const [showErrors, setShowErrors] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const urlError = !url.trim() ? "Paste the address to send events to." : null;
  const eventsError = events.length === 0 ? "Tick at least one event to send." : null;

  const list = endpoints.data ?? [];
  const byEndpoint = new Map<string, Delivery[]>();
  for (const d of deliveries.data ?? []) {
    byEndpoint.set(d.endpoint_id, [...(byEndpoint.get(d.endpoint_id) ?? []), d]);
  }

  function refresh() {
    void endpoints.refetch();
    void deliveries.refetch();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (urlError || eventsError) {
      setShowErrors(true);
      focusFirstInvalid(formRef.current);
      return;
    }
    setShowErrors(false);
    setBusy(true);
    setErr(null);
    try {
      const r = await create({
        data: { url, description, events: events as WebhookEventType[], includeContact },
      });
      setSecret(r.secret);
      setUrl("");
      setDescription("");
      setEvents(["visit.completed"]);
      setIncludeContact(false);
      setAdding(false);
      refresh();
    } catch (e2) {
      setErr(errorText(e2, "Could not add the webhook."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Zapier &amp; webhooks</h2>
        <p className="text-sm text-muted-foreground">
          Send events from HoundStack to Zapier, Make, n8n or your own system as they happen: a
          visit completed, an invoice paid, a new lead. Each one is a signed JSON POST to an HTTPS
          address you choose.
        </p>
      </div>

      {secret && <SecretReveal secret={secret} onDone={() => setSecret(null)} />}

      <div className="rounded border bg-card p-4">
        {!adding ? (
          <Button type="button" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 shrink-0" />
            Add a webhook
          </Button>
        ) : (
          <form ref={formRef} onSubmit={add} noValidate className="space-y-4">
            <h3 className="font-medium">Add a webhook</h3>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">URL to send events to</span>
              <Input
                type="url"
                inputMode="url"
                autoComplete="off"
                required
                placeholder="https://hooks.zapier.com/hooks/catch/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={showErrors && !!urlError}
                aria-describedby={showErrors && urlError ? "new-webhook-url-error" : undefined}
                className={`font-mono ${showErrors && urlError ? "border-destructive" : ""}`}
              />
              {showErrors && urlError && (
                <span id="new-webhook-url-error" className="mt-1 block text-xs text-destructive">
                  {urlError}
                </span>
              )}
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Description (optional)</span>
              <Input
                value={description}
                maxLength={200}
                placeholder="Zapier: new clients to Mailchimp"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <EventPicker idPrefix="new" value={events} onChange={setEvents} />
            {showErrors && eventsError && (
              <p className="text-xs text-destructive">{eventsError}</p>
            )}
            <ContactOption id="new-contact" checked={includeContact} onChange={setIncludeContact} />
            {err && <p className="break-words text-sm text-red-600">{err}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Checking the address..." : "Add webhook"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAdding(false)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>

      <section className="space-y-3">
        <h3 className="font-medium">Your webhooks</h3>
        {endpoints.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : endpoints.error ? (
          <p className="text-sm text-red-600">
            {errorText(endpoints.error, "Could not load webhooks.")}
          </p>
        ) : list.length ? (
          <ul className="space-y-3">
            {list.map((ep) => (
              <EndpointCard
                key={ep.id}
                ep={ep}
                deliveries={byEndpoint.get(ep.id) ?? []}
                onChanged={refresh}
                onSecret={setSecret}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No webhooks yet.</p>
        )}
      </section>

      <details className="rounded border bg-card p-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
          How to check a request came from HoundStack
        </summary>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p>
            Read <code>t</code> and <code>v1</code> from{" "}
            <code className="font-mono">{WEBHOOK_SIGNATURE_HEADER}</code>. Use the raw request
            body and whole signing secret for the HMAC below. Compare its hex value with{" "}
            <code>v1</code>. Reject timestamps over five minutes old.
          </p>
          <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs text-foreground">
            {`expected = hex(HMAC_SHA256(secret, t + "." + body))`}
          </pre>
          <p>
            Without a 2xx response within 10 seconds, delivery retries after 1 minute, 5 minutes,
            30 minutes, 2 hours and 12 hours. Redirects are not followed. Use the body&apos;s{" "}
            <code>id</code> to ignore repeats.
          </p>
          <p>
            After 5 deliveries in a row fail, the webhook is switched off and the owners are notified.
          </p>
          <p>
            Events include IDs, names, amounts and dates. Enable &ldquo;Include client email and
            phone&rdquo; to add{" "}
            <code className="break-all font-mono">
              data.contact = {`{ "email": ..., "phone": ... }`}
            </code>{" "}
            when sent. Turning it off stops contact details on pending deliveries.
          </p>
        </div>
      </details>
    </div>
  );
}
