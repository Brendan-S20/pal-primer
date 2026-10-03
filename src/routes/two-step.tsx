// The second step of signing in, for somebody who turned two-step sign-in on.
//
// The signed-in shell sends a session here when it signed in with the password
// alone and the person has a verified factor (lib/mfa needsSecondStep). Until
// the code is accepted the database refuses this session everything
// (public.mfa_satisfied), so nothing else can usefully load; this page talks
// only to Supabase Auth.

import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { KeyRound, MessageSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PublicShell } from "@/components/PublicShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  needsSecondStep,
  safeNextPath,
  secondStepErrorMessage,
  verifiedFactors,
  type SecondStepFactor,
} from "@/lib/mfa";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/two-step")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === "string" ? s.next : undefined,
  }),
  head: () => ({ meta: [{ title: pageTitle("Enter your code") }] }),
  component: TwoStepPage,
});

function TwoStepPage() {
  const { next } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const qc = useQueryClient();
  const [factors, setFactors] = useState<SecondStepFactor[] | null>(null);
  const [active, setActive] = useState<SecondStepFactor | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const done = () => {
    // Everything cached so far was read as a session the database refused.
    qc.clear();
    router.history.push(safeNextPath(next));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        navigate({ to: "/auth" });
        return;
      }
      // Arrived here with nothing left to do (already verified, or no factor).
      if (!(await needsSecondStep())) {
        if (!cancelled) done();
        return;
      }
      try {
        const list = await verifiedFactors();
        if (cancelled) return;
        setFactors(list);
        setActive(list[0] ?? null);
      } catch (e) {
        if (!cancelled) setError(secondStepErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendText = async () => {
    if (!active || active.type !== "phone") return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.auth.mfa.challenge({ factorId: active.id });
    setBusy(false);
    if (err || !data) return setError(secondStepErrorMessage(err, "phone"));
    setChallengeId(data.id);
    setSentTo(active.label);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!active) return;
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) return setError("Enter the 6-digit code.");
    setBusy(true);
    setError(null);
    const result =
      active.type === "totp"
        ? await supabase.auth.mfa.challengeAndVerify({ factorId: active.id, code: clean })
        : challengeId
          ? await supabase.auth.mfa.verify({ factorId: active.id, challengeId, code: clean })
          : { error: { message: "Send the text first." } };
    if (result.error) {
      setBusy(false);
      setCode("");
      return setError(secondStepErrorMessage(result.error, active.type));
    }
    done();
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  };

  const other = factors?.find((f) => f.id !== active?.id) ?? null;

  return (
    <PublicShell tagline="One more step">
      <div className="space-y-5 rounded-xl border bg-card p-5 shadow-sm sm:p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Enter your code</h1>
          <p className="text-sm text-muted-foreground">
            {active?.type === "phone"
              ? "You turned on two-step sign-in. We'll text you a 6-digit code."
              : "You turned on two-step sign-in. Open your authenticator app and enter the 6-digit code it shows for HoundStack."}
          </p>
        </div>

        {factors === null && !error ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            {active?.type === "phone" && !challengeId ? (
              <Button type="button" className="w-full" disabled={busy} onClick={sendText}>
                <MessageSquare className="mr-2 h-4 w-4 shrink-0" />
                {busy ? "Sending…" : `Text me a code (${active.label.replace(/^Text to /, "")})`}
              </Button>
            ) : (
              <>
                {sentTo && (
                  <p className="text-sm text-muted-foreground" role="status">
                    Code sent. {sentTo}.
                  </p>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="two-step-code">6-digit code</Label>
                  <Input
                    id="two-step-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]*"
                    maxLength={7}
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="text-center font-mono text-lg tracking-[0.3em]"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy || !active}>
                  {busy ? "Checking…" : "Continue"}
                </Button>
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        )}

        {other && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => {
              setActive(other);
              setChallengeId(null);
              setSentTo(null);
              setCode("");
              setError(null);
            }}
          >
            {other.type === "phone" ? (
              <MessageSquare className="mr-2 h-4 w-4 shrink-0" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4 shrink-0" />
            )}
            {other.type === "phone" ? "Use a text message instead" : "Use the authenticator app"}
          </Button>
        )}

        <div className="space-y-2 border-t pt-4 text-sm text-muted-foreground">
          <p>
            Lost your phone? Contact HoundStack support from the email on your account; we can turn
            two-step off after confirming it's you.
          </p>
          <Button type="button" variant="ghost" className="px-0" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </PublicShell>
  );
}
