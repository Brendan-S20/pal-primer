import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getOrgAiSettings, setOrgAiSettings, clearOrgAiSettings, testOrgAiKey } from "@/lib/ai-settings.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/ai")({
  component: AiSettings,
});

function AiSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getOrgAiSettings);
  const setFn = useServerFn(setOrgAiSettings);
  const clearFn = useServerFn(clearOrgAiSettings);
  const testFn = useServerFn(testOrgAiKey);

  const q = useQuery({ queryKey: ["org-ai-settings"], queryFn: () => getFn() });
  const cfg = q.data as any;

  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  const saveMut = useMutation({
    mutationFn: () => setFn({ data: { provider, apiKey: apiKey.trim(), model: model.trim() || undefined } }),
    onSuccess: () => { toast.success("AI key saved"); setApiKey(""); qc.invalidateQueries({ queryKey: ["org-ai-settings"] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const clearMut = useMutation({
    mutationFn: () => clearFn(),
    onSuccess: () => { toast.success("AI key removed"); qc.invalidateQueries({ queryKey: ["org-ai-settings"] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const testMut = useMutation({
    mutationFn: () => testFn(),
    onSuccess: (r: any) => {
      if (r?.ok) toast.success(`Key works: ${r.provider} · ${r.model}`);
      else toast.error(r?.error ?? "Key check failed");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const defaultModel = cfg?.defaultModels?.[provider] ?? "";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">AI Tools</h1>
        <p className="text-sm text-muted-foreground">
          The AI features (marketing content, review replies, churn scoring, AI dispatch, and zone
          pricing) run on your own provider key. Bring an <strong>Anthropic</strong> or
          <strong> OpenAI</strong> API key. You're billed by them directly.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4 text-sm">
            {cfg?.configured ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium capitalize">{cfg.provider}</span> key configured
                  {cfg.keyLast4 ? <span className="text-muted-foreground"> · ····{cfg.keyLast4}</span> : null}
                  <div className="text-xs text-muted-foreground">Model: {cfg.model}</div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => testMut.mutate()} disabled={testMut.isPending}>
                    {testMut.isPending ? "Testing…" : "Test key"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => clearMut.mutate()} disabled={clearMut.isPending}>
                    Remove key
                  </Button>
                </div>
              </div>
            ) : cfg?.usingPlatformFallback ? (
              <p className="text-muted-foreground">
                Using the platform's default AI key. Add your own below to use your provider and billing.
              </p>
            ) : (
              <p className="text-amber-700">No AI key configured yet. The AI Tools won't run until you add one.</p>
            )}
          </div>

          <form
            className="space-y-4 rounded-lg border bg-card p-4"
            onSubmit={(e) => { e.preventDefault(); if (apiKey.trim()) saveMut.mutate(); }}
          >
            <div>
              <Label className="text-xs">Provider</Label>
              <div className="mt-1 flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={provider === "anthropic"} onChange={() => setProvider("anthropic")} />
                  Anthropic (Claude)
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={provider === "openai"} onChange={() => setProvider("openai")} />
                  OpenAI
                </label>
              </div>
            </div>
            <div>
              <Label htmlFor="ai-key" className="text-xs">API key</Label>
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Stored encrypted server-side and never shown again. Only the last 4 digits are displayed.
              </p>
            </div>
            <div>
              <Label htmlFor="ai-model" className="text-xs">Model (optional)</Label>
              <Input id="ai-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={defaultModel} />
              <p className="mt-1 text-xs text-muted-foreground">Defaults to {defaultModel} if left blank.</p>
            </div>
            <Button type="submit" disabled={saveMut.isPending || !apiKey.trim()}>
              {saveMut.isPending ? "Saving…" : "Save key"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
