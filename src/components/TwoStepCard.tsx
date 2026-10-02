// Two-step sign-in, on the profile page. Each person turns it on for
// themselves; nothing here is set for anybody else.
//
// Turning it on is enrol + confirm one code, because a factor that was never
// confirmed proves nothing: Supabase keeps it "unverified", and the database
// ignores unverified factors (public.mfa_satisfied). Turning it off needs a
// session that already passed the second step, which every session inside the
// app has once a factor exists -- the shell sends any other to /two-step.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Loader2, MessageSquare, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { supabase } from "@/integrations/supabase/client";
import {
  clearUnverifiedFactors,
  secondStepErrorMessage,
  verifiedFactors,
  type SecondStepFactor,
} from "@/lib/mfa";

type Pending =
  | { kind: "totp"; factorId: string; qr: string; secret: string }
  | { kind: "phone-number" }
  | { kind: "phone-code"; factorId: string; challengeId: string; phone: string };

function qrSrc(qr: string): string {
  return qr.startsWith("data:") ? qr : `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`;
}

/** "(312) 555-0142" and "312-555-0142" become +13125550142; a number that
 *  already starts with + is kept as typed, digits only. */
export function toE164(raw: string): string | null {
  const t = raw.trim();
  const digits = t.replace(/\D/g, "");
  if (t.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function TwoStepCard() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const factorsQ = useQuery({
    queryKey: ["mfa-factors"],
    queryFn: verifiedFactors,
    staleTime: 30_000,
  });
  const factors = factorsQ.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["mfa-factors"] });

  const reset = () => {
    setPending(null);
    setCode("");
    setPhone("");
    setError(null);
  };

  const startApp = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearUnverifiedFactors();
      const { data, error: err } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator app ${new Date().toISOString().slice(0, 10)}`,
      });
      if (err || !data) throw err ?? new Error("Could not start.");
      setPending({
        kind: "totp",
        factorId: data.id,
        qr: data.totp.qr_code,
        secret: data.totp.secret,
      });
    } catch (e) {
      setError(secondStepErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendPhoneCode = async () => {
    const e164 = toE164(phone);
    if (!e164) return setError("Enter a mobile number, like (312) 555-0142.");
    setBusy(true);
    setError(null);
    try {
      await clearUnverifiedFactors();
      const { data, error: err } = await supabase.auth.mfa.enroll({
        factorType: "phone",
        phone: e164,
        friendlyName: `Text message ${e164.slice(-4)}`,
      });
      if (err || !data) throw err ?? new Error("Could not start.");
      const ch = await supabase.auth.mfa.challenge({ factorId: data.id });
      if (ch.error || !ch.data) throw ch.error ?? new Error("Could not send the text.");
      setPending({ kind: "phone-code", factorId: data.id, challengeId: ch.data.id, phone: e164 });
    } catch (e) {
      setError(secondStepErrorMessage(e, "phone"));
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending || pending.kind === "phone-number") return;
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) return setError("Enter the 6-digit code.");
    setBusy(true);
    setError(null);
    const result =
      pending.kind === "totp"
        ? await supabase.auth.mfa.challengeAndVerify({ factorId: pending.factorId, code: clean })
        : await supabase.auth.mfa.verify({
            factorId: pending.factorId,
            challengeId: pending.challengeId,
            code: clean,
          });
    setBusy(false);
    if (result.error) {
      setCode("");
      return setError(
        secondStepErrorMessage(result.error, pending.kind === "totp" ? "totp" : "phone"),
      );
    }
    toast.success("Two-step sign-in is on. You'll be asked for a code when you sign in.");
    reset();
    refresh();
  };

  const remove = useMutation({
    mutationFn: async (f: SecondStepFactor) => {
      const { error: err } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (err) throw err;
    },
    onSuccess: () => {
      toast.success("Removed");
      refresh();
    },
    onError: (e) => toast.error(secondStepErrorMessage(e)),
  });

  return (
    <Card>
      {dialog}
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Two-step sign-in
        </CardTitle>
        <CardDescription>
          {factors.length
            ? "On. Signing in asks for your password and then a code."
            : "Off. Add a second step so a stolen password alone can't open your account."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {factorsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : factors.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {factors.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                {f.type === "totp" ? (
                  <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{f.label}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={async () => {
                    const last = factors.length === 1;
                    if (
                      await confirm({
                        title: last ? "Turn off two-step sign-in?" : `Remove ${f.label}?`,
                        description: last
                          ? "Your password alone will open your account again."
                          : "You can still sign in with your other second step.",
                        confirmLabel: last ? "Turn off" : "Remove",
                        destructive: true,
                      })
                    )
                      remove.mutate(f);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {!pending && (
          <div className="flex flex-wrap gap-2">
            {!factors.some((f) => f.type === "totp") && (
              <Button type="button" disabled={busy} onClick={startApp}>
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4 shrink-0" />
                )}
                Use an authenticator app
              </Button>
            )}
            {!factors.some((f) => f.type === "phone") && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setPending({ kind: "phone-number" });
                }}
              >
                <MessageSquare className="mr-2 h-4 w-4 shrink-0" />
                Use text messages
              </Button>
            )}
          </div>
        )}

        {pending?.kind === "totp" && (
          <form className="space-y-3" onSubmit={confirmCode}>
            <p className="text-sm">
              Scan this with an authenticator app (Google Authenticator, 1Password, Authy), then
              enter the 6-digit code it shows.
            </p>
            <img
              src={qrSrc(pending.qr)}
              alt="QR code for your authenticator app"
              className="h-44 w-44 max-w-full rounded-md border bg-white p-2"
            />
            <p className="text-xs text-muted-foreground">
              Can't scan? Enter this key instead:{" "}
              <code className="break-all font-mono text-foreground">{pending.secret}</code>
            </p>
            <CodeInput value={code} onChange={setCode} />
            <PendingButtons busy={busy} onCancel={reset} label="Turn on" />
          </form>
        )}

        {pending?.kind === "phone-number" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="two-step-phone">Mobile number</Label>
              <Input
                id="two-step-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(312) 555-0142"
                className="sm:max-w-64"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy} onClick={sendPhoneCode}>
                {busy ? "Sending…" : "Text me a code"}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {pending?.kind === "phone-code" && (
          <form className="space-y-3" onSubmit={confirmCode}>
            <p className="text-sm">We texted a 6-digit code to {pending.phone}.</p>
            <CodeInput value={code} onChange={setCode} />
            <PendingButtons busy={busy} onCancel={reset} label="Turn on" />
          </form>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Lose your phone and you'll need HoundStack support to turn this off, so keep the
          authenticator app backed up (1Password and Authy do this).
        </p>
      </CardContent>
    </Card>
  );
}

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="two-step-setup-code">6-digit code</Label>
      <Input
        id="two-step-setup-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono tracking-[0.3em] sm:max-w-48"
      />
    </div>
  );
}

function PendingButtons({
  busy,
  onCancel,
  label,
}: {
  busy: boolean;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy}>
        {busy ? "Checking…" : label}
      </Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
