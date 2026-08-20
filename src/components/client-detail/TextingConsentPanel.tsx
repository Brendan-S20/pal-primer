/**
 * Whether this client may be texted, and how to make it so.
 *
 * ── WHY THIS EXISTS, WRITTEN DOWN BECAUSE IT WAS A REAL FAILURE ───────────
 *
 * The consent model (migration 20260805020000) added a hard guard: no consent
 * on file, no message, on every send path. It shipped WITHOUT this panel. The
 * PR that shipped it said consent could be recorded "from the customer's page",
 * which was not true — the server function existed and nothing called it.
 *
 * The effect was worse than a missing feature. Texting worked before and
 * stopped, and the only thing on screen was the composer failing with "No
 * texting consent on file for this client" and no way to grant it. A guard with
 * no path to satisfy it is not a safeguard, it is a wall.
 *
 * So this panel says three things, in this order, because that is the order the
 * questions arrive in: can I text them, why not, and what do I do about it.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, MessageSquareOff, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SMS_CONSENT_TEXT, recordClientSmsConsent } from "@/lib/clients.functions";
import { formatPhone } from "@/lib/format";

const digits = (p: string | null | undefined) => (p ?? "").replace(/[^0-9]/g, "");

export function TextingConsentPanel({ client }: { client: any }) {
  const qc = useQueryClient();
  const recordFn = useServerFn(recordClientSmsConsent);
  const [attested, setAttested] = useState(false);

  const record = useMutation({
    mutationFn: () => recordFn({ data: { clientId: client.id } }),
    onSuccess: () => {
      toast.success("Consent recorded. You can text this client now.");
      setAttested(false);
      qc.invalidateQueries({ queryKey: ["client", client.id] });
      qc.invalidateQueries({ queryKey: ["sms-consent-coverage"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hasPhone = Boolean(client.primary_phone);
  const consentAt: string | null = client.sms_consent_at ?? null;
  // Consent is for a NUMBER, not a person. A trigger normally clears it when
  // the number changes; this catches a row written before that existed.
  const consentMatchesPhone =
    consentAt != null && digits(client.primary_phone) === digits(client.sms_consent_phone);
  const stopped = Boolean(client.sms_opt_out);
  const paused = Boolean(client.comms_paused);

  const canText = hasPhone && consentAt != null && consentMatchesPhone && !stopped && !paused;

  // Exactly the reasons `client_may_be_texted` checks, in the same precedence.
  // If these two ever disagree the panel becomes a liar, so they are kept in
  // one list rather than scattered through the JSX.
  const blockers: string[] = [];
  if (!hasPhone) blockers.push("No phone number on file.");
  else if (stopped)
    blockers.push(
      "They replied STOP. Only they can undo that, by texting START or opting in from their portal.",
    );
  else if (paused)
    blockers.push("Communications are paused for this client. Lift the hold to text them.");
  else if (consentAt == null) blockers.push("No texting consent on file.");
  else if (!consentMatchesPhone)
    blockers.push(
      `Consent was given for ${formatPhone(client.sms_consent_phone) || "a different number"}, and the number on file has changed since.`,
    );

  // Recording on someone's behalf is only offered where it is the honest
  // remedy. After a STOP it is not: re-consenting for them would override a
  // refusal they made themselves, which is the thing carriers police.
  const mayRecord = hasPhone && !stopped && !canText;

  return (
    <section className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          {canText ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          ) : (
            <MessageSquareOff className="h-4 w-4 text-amber-600" />
          )}
          Texting consent
        </h2>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            canText ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {canText ? "Can be texted" : "Cannot be texted"}
        </span>
      </div>

      {canText ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Consented {new Date(consentAt!).toLocaleDateString()} for{" "}
          {formatPhone(client.sms_consent_phone)}
          {client.sms_consent_source === "portal"
            ? ". They opted in themselves from the client portal."
            : client.sms_consent_source === "staff"
              ? ". Recorded by your team."
              : client.sms_consent_source
                ? `. Source: ${client.sms_consent_source}`
                : ""}
        </p>
      ) : (
        <p className="mt-2 text-xs text-amber-700">{blockers[0]}</p>
      )}

      {/* The stored wording, shown back. A carrier audit asks what this client
          agreed to, and the answer has to be the words themselves rather than
          a link to whatever the current copy happens to say. */}
      {consentAt && client.sms_consent_text && (
        <blockquote className="mt-3 rounded border-l-2 border-muted-foreground/30 bg-muted/40 p-2 text-2xs italic text-muted-foreground">
          {client.sms_consent_text}
        </blockquote>
      )}

      {mayRecord && (
        <div className="mt-4 space-y-3 rounded-md border p-3">
          <div className="text-xs font-medium">Record consent you already have</div>
          <p className="text-2xs text-muted-foreground">
            Only if this client has actually agreed: in person, on a signed service agreement,
            or over the phone. This is stored as staff-recorded and is auditable. If you are not
            sure, send them their portal link and let them opt in themselves.
          </p>
          <blockquote className="rounded border-l-2 border-muted-foreground/30 bg-muted/40 p-2 text-2xs italic">
            {SMS_CONSENT_TEXT}
          </blockquote>
          {/* An unticked-by-default attestation, not a bare button. The whole
              point of the consent record is that somebody stands behind it;
              a one-click "mark consented" is how a book of 300 clients gets
              rubber-stamped in an afternoon. */}
          <label className="flex items-start gap-2 text-2xs">
            <Checkbox
              checked={attested}
              onCheckedChange={(v) => setAttested(v === true)}
              className="mt-0.5"
            />
            <span>
              {client.display_name} agreed to the above for{" "}
              <strong>{formatPhone(client.primary_phone)}</strong>, and I can evidence it.
            </span>
          </label>
          <Button
            size="sm"
            disabled={!attested || record.isPending}
            onClick={() => record.mutate()}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            {record.isPending ? "Recording…" : "Record consent"}
          </Button>
        </div>
      )}
    </section>
  );
}
