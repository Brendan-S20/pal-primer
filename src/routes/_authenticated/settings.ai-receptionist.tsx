import { useLaunchCopy } from "@/lib/launch-copy";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  getAiReceptionistSettings,
  updateAiReceptionistSettings,
  listAiReceptionistLogs,
} from "@/lib/ai-receptionist.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { formatDateTime, formatPhone } from "@/lib/format";
import { RECEPTIONIST_LAUNCHED } from "@/lib/receptionist-launch";
import { titleHead } from "@/lib/page-title";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";

export const Route = createFileRoute("/_authenticated/settings/ai-receptionist")({
  head: () => titleHead("AI receptionist", "Settings"),
  component: Page,
});

// Shown to the owner in the persona box, so it is written for them: no tool
// names. The server's own prompt (ai-receptionist.server) already tells the
// model which tool quotes a price; this only sets the tone.
const DEFAULT_PERSONA =
  "You are a friendly, concise receptionist for a pet service company. Answer in one or two short sentences. Only give prices you have looked up for this business, never a guess. Offer to have someone from the office follow up when you are unsure.";

function Page() {
  const copy = useLaunchCopy();
  const qc = useQueryClient();
  const getFn = useServerFn(getAiReceptionistSettings);
  const saveFn = useServerFn(updateAiReceptionistSettings);
  const logsFn = useServerFn(listAiReceptionistLogs);

  const { data, isLoading } = useQuery({ queryKey: ["ai-recep"], queryFn: () => getFn({}) });
  const { data: logs } = useQuery({ queryKey: ["ai-recep-logs"], queryFn: () => logsFn({}) });

  const [enabled, setEnabled] = useState(false);
  const [faq, setFaq] = useState("");
  const [persona, setPersona] = useState(() => copy(DEFAULT_PERSONA));
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceGreeting, setVoiceGreeting] = useState("");

  useEffect(() => {
    if (!data) return;
    setEnabled(!!data.ai_receptionist_enabled);
    setFaq(data.ai_receptionist_faq ?? "");
    setPersona(data.ai_receptionist_persona ?? copy(DEFAULT_PERSONA));
    setVoiceEnabled(!!(data as any).ai_voice_enabled);
    setVoiceGreeting((data as any).ai_voice_greeting ?? "");
  }, [data, copy]);

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          enabled,
          faq: faq || null,
          persona: persona || null,
          voice_enabled: voiceEnabled,
          voice_greeting: voiceGreeting || null,
        },
      }),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["ai-recep"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          AI Receptionist
          {!RECEPTIONIST_LAUNCHED && <ComingSoonBadge />}
        </h2>
        {/* Worded as what it WILL do until it launches: it needs the
            business's own number, which no business has yet either. */}
        <p className="text-sm text-muted-foreground">
          {RECEPTIONIST_LAUNCHED
            ? "Answers texts and calls to your business number using your FAQ and your own prices. It can quote, take down a new client's details, and hand off to a person."
            : "When it launches, it will answer texts and calls to your business number from your FAQ and prices, quote, take a new client's details, and hand off to a person. It is not on yet; you can write its FAQ and persona now."}
        </p>
      </div>

      <div className="space-y-4 rounded-lg border bg-card p-4">
        <label className="flex items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!RECEPTIONIST_LAUNCHED}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          Enable AI receptionist on this org's SMS number
        </label>
        {/* Until launch the add-on cannot be bought (addon-launch.ts), so
            this must not send anyone to Billing to buy it. */}
        <p className="text-xs text-muted-foreground">
          {RECEPTIONIST_LAUNCHED ? (
            <>
              The AI Receptionist is a plan add-on. If it isn't on your plan yet, add it in{" "}
              <Link to="/settings/billing" className="underline">
                Settings → Plan &amp; billing
              </Link>{" "}
              first; you can draft the persona and FAQ below either way.
            </>
          ) : (
            copy(
              "Coming soon. It can be added to your plan once it launches. You can draft the persona and FAQ below now.",
            )
          )}
        </p>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">Persona / system instructions</span>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={5}
            className="block w-full rounded border bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">FAQ knowledge base</span>
          <textarea
            value={faq}
            onChange={(e) => setFaq(e.target.value)}
            rows={12}
            placeholder="Q: Do you service my area?&#10;A: We service all zip codes 606xx…&#10;&#10;Q: What if my dog is home?&#10;A: We can work around most dogs but ask that aggressive dogs be indoors…"
            className="block w-full rounded border bg-background px-3 py-2 text-sm font-mono"
          />
          <span className="text-xs text-muted-foreground">
            Freeform text. The AI reads all of it when asked a question it can't quote a price for.
          </span>
        </label>

        <div className="border-t pt-4">
          <label className="flex items-center gap-3 text-sm font-medium">
            <input
              type="checkbox"
              checked={voiceEnabled}
              disabled={!RECEPTIONIST_LAUNCHED}
              onChange={(e) => setVoiceEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            Enable AI voice receptionist on inbound calls
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {RECEPTIONIST_LAUNCHED
              ? "Answers calls using your persona, FAQ and prices. If it can't help, it asks the caller to leave a voicemail."
              : copy(
                  "When it launches, it will use the same persona and FAQ as texts. The caller's words are transcribed and the reply is read back to them. If it can't help, the caller is asked to leave a voicemail.",
                )}
          </p>
          <label className="mt-3 block space-y-1 text-sm">
            <span className="font-medium">Greeting (spoken first)</span>
            <input
              value={voiceGreeting}
              onChange={(e) => setVoiceGreeting(e.target.value)}
              placeholder="Hi, thanks for calling Acme. How can I help?"
              className="block w-full rounded border bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
      </div>

      <section>
        <h2 className="mb-2 text-lg font-medium">Recent AI conversations</h2>
        {!logs?.logs.length ? (
          <p className="text-sm text-muted-foreground">No AI replies yet.</p>
        ) : (
          <div className="space-y-3">
            {logs.logs.map((l: any) => (
              <div key={l.id} className="rounded-lg border bg-card p-3 text-sm">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-3xs font-medium uppercase ${l.channel === "voice" ? "bg-blue-100 text-blue-800" : "bg-muted"}`}>
                      {l.channel ?? "sms"}
                    </span>
                    {formatDateTime(l.created_at)} · {formatPhone(l.from_number)}
                    {l.channel === "voice" && l.turn != null ? ` · turn ${l.turn}` : ""}
                  </span>
                  <span>
                    {l.latency_ms}ms
                    {l.escalated ? " · escalated" : ""}
                    {l.error ? " · error" : ""}
                  </span>
                </div>
                <div className="mt-1"><strong>Them:</strong> {l.user_text}</div>
                <div><strong>AI:</strong> {l.reply_text ?? <em className="text-muted-foreground">(no reply)</em>}</div>
                {Array.isArray(l.tool_calls) && l.tool_calls.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    tools: {l.tool_calls.map((t: any) => t.name).join(", ")}
                  </div>
                )}
                {l.error && <div className="mt-1 text-xs text-destructive">{l.error}</div>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
