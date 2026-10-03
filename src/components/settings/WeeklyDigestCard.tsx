import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import {
  previewWeeklyDigest,
  sendWeeklyDigestNow,
  getDigestSettings,
  updateDigestSettings,
} from "@/lib/digest.functions";

// ── THE WEEKLY DIGEST, WHERE AN OWNER LOOKS FOR AN EMAIL ─────────────────
//
// This was a tab on Analytics. The digest is an email to the owner, and an
// owner who wants to stop an email, or send it to somebody else, opens
// Settings → Emails; the email's own footer had to send them to "Analytics →
// Weekly digest" because nothing else did (launch pass, 2026-10,
// recommendation 5). Moved whole: the same four server functions, the same
// warning when it is on with nobody to send to, the same preview.

export function WeeklyDigestCard() {
  const previewFn = useServerFn(previewWeeklyDigest);
  const sendFn = useServerFn(sendWeeklyDigestNow);
  const settingsFn = useServerFn(getDigestSettings);
  const updateFn = useServerFn(updateDigestSettings);
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ["digest", "settings"],
    queryFn: () => settingsFn(),
  });

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [recipient, setRecipient] = useState<string>("");
  const initialized = useMemo(() => settings.data != null, [settings.data]);
  if (initialized && enabled === null) {
    setEnabled(settings.data!.enabled);
    setRecipient(settings.data!.recipientEmail ?? "");
  }

  // What is SAVED, not what is typed. A half-entered address in the box does
  // not make the Monday job able to send — only the stored value does, so the
  // warning has to key off that or it would disappear as soon as someone
  // started typing and stop telling the truth.
  const savedRecipient = (settings.data?.recipientEmail ?? "").trim();

  const preview = useMutation({
    mutationFn: () => previewFn(),
    onError: (e: Error) => toast.error(e.message),
  });

  const send = useMutation({
    mutationFn: () => sendFn({ data: recipient ? { recipientOverride: recipient } : {} }),
    onSuccess: (r) => toast.success(`Digest queued to ${r.recipient}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: () =>
      updateFn({
        data: { enabled: enabled ?? true, recipientEmail: recipient.trim() || null },
      }),
    onSuccess: () => {
      toast.success("Digest settings saved");
      qc.invalidateQueries({ queryKey: ["digest", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const p = preview.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly digest to you</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Every Monday morning, we email a plain-language summary of the past week: revenue,
            visits, new clients, at-risk accounts, and 2-3 recommendations worked out from those
            numbers.
          </p>

          {/* This panel promised a Monday email from the day it shipped, and for
              months nothing was ever sent — no scheduler existed, and no
              organization had a recipient. The schedule exists now; the second
              half is this. A checkbox reading "Enabled" beside a promise the
              product cannot keep is how a feature stays broken without anyone
              filing a bug: the owner believes it is on, and the absence of an
              email is indistinguishable from a quiet week. */}
          {initialized && (enabled ?? true) && !savedRecipient && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">No digest will be sent yet.</p>
                <p className="mt-0.5 text-muted-foreground">
                  This is switched on, but there is no address to send to. Add one below and save,
                  and the first digest goes out on the next Monday.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div>
              <Label htmlFor="digest-email">Send to</Label>
              <Input
                id="digest-email"
                type="email"
                placeholder="owner@yourbusiness.com"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </div>
            {/* The label wraps the box, so the whole 44px row is the target.
                On Analytics this was a 16px box beside an unclickable word;
                Settings → Emails is opened on a phone. */}
            <label
              htmlFor="digest-enabled"
              className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium"
            >
              <input
                id="digest-enabled"
                type="checkbox"
                checked={enabled ?? true}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 shrink-0"
              />
              Enabled
            </label>
            <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>

          {settings.data?.lastSentAt ? (
            <p className="text-xs text-muted-foreground">
              Last sent {formatDateTime(settings.data.lastSentAt)}.
            </p>
          ) : savedRecipient ? (
            <p className="text-xs text-muted-foreground">
              Not sent yet. The first one goes out on the next Monday.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => preview.mutate()} disabled={preview.isPending}>
              {preview.isPending ? "Generating preview…" : "Preview this week"}
            </Button>
            <Button
              variant="outline"
              onClick={() => send.mutate()}
              disabled={send.isPending || (!recipient && !settings.data?.recipientEmail)}
            >
              {send.isPending ? "Sending…" : "Send now"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {p && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Preview: {p.metrics.orgName} · {p.metrics.weekLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-medium">{p.insights.headline}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {p.metrics.stats.map((s) => (
                <div key={s.label} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className="text-lg font-semibold">{s.value}</div>
                  {s.delta && <div className="text-xs text-emerald-600">{s.delta}</div>}
                </div>
              ))}
            </div>

            {p.insights.insights.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold">What stood out</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {p.insights.insights.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            )}

            {p.insights.recommendations.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold">Suggested next steps</h4>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {p.insights.recommendations.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ol>
              </div>
            )}

            {p.metrics.alerts.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold text-amber-700">Needs attention</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
                  {p.metrics.alerts.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
