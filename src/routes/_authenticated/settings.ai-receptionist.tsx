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

export const Route = createFileRoute("/_authenticated/settings/ai-receptionist")({
  component: Page,
});

const DEFAULT_PERSONA =
  "You are a friendly, concise SMS receptionist for a pet-waste cleanup company. Answer in 1-2 short sentences. Never invent prices. Use the get_pricing_quote tool. Offer to have a human follow up when unsure.";

function Page() {
  const qc = useQueryClient();
  const getFn = useServerFn(getAiReceptionistSettings);
  const saveFn = useServerFn(updateAiReceptionistSettings);
  const logsFn = useServerFn(listAiReceptionistLogs);

  const { data, isLoading } = useQuery({ queryKey: ["ai-recep"], queryFn: () => getFn({}) });
  const { data: logs } = useQuery({ queryKey: ["ai-recep-logs"], queryFn: () => logsFn({}) });

  const [enabled, setEnabled] = useState(false);
  const [faq, setFaq] = useState("");
  const [persona, setPersona] = useState(DEFAULT_PERSONA);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceGreeting, setVoiceGreeting] = useState("");

  useEffect(() => {
    if (!data) return;
    setEnabled(!!data.ai_receptionist_enabled);
    setFaq(data.ai_receptionist_faq ?? "");
    setPersona(data.ai_receptionist_persona ?? DEFAULT_PERSONA);
    setVoiceEnabled(!!(data as any).ai_voice_enabled);
    setVoiceGreeting((data as any).ai_voice_greeting ?? "");
  }, [data]);

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
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">AI SMS Receptionist</h2>
        <p className="text-sm text-muted-foreground">
          When enabled, inbound texts that aren't STOP/START/HELP are answered by an AI trained
          on your FAQ. It can quote prices, capture leads, and hand off to a human.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border bg-card p-4">
        <label className="flex items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          Enable AI receptionist on this org's SMS number
        </label>
        <p className="text-xs text-muted-foreground">
          The AI Receptionist is a plan add-on. If it isn't on your plan yet, add it in{" "}
          <Link to="/settings/billing" className="underline">
            Settings → Billing
          </Link>{" "}
          first; you can draft the persona and FAQ below either way.
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
              onChange={(e) => setVoiceEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            Enable AI voice receptionist on inbound calls
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Uses the same persona, FAQ, and tools as SMS. Twilio's built-in speech recognition
            captures what the caller says; the AI reply is spoken back via text-to-speech. If it
            can't help, the caller is asked to leave a voicemail.
          </p>
          <label className="mt-3 block space-y-1 text-sm">
            <span className="font-medium">Greeting (spoken first)</span>
            <input
              value={voiceGreeting}
              onChange={(e) => setVoiceGreeting(e.target.value)}
              placeholder="Hi, thanks for calling Acme Pet Waste. How can I help?"
              className="block w-full rounded border bg-background px-3 py-2 text-sm"
            />
          </label>
          <p className="mt-3 text-xs text-muted-foreground">
            In Twilio Console → your voice number → <em>A call comes in</em>, set{" "}
            <strong>HTTP POST</strong> to:
          </p>
          <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-xs">
            {typeof window !== "undefined" ? window.location.origin : ""}/api/public/hooks/twilio-voice?s=YOUR_TWILIO_INBOUND_SECRET
          </code>
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
                    {new Date(l.created_at).toLocaleString()} · {l.from_number}
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
