import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { getOrgAiSettings, testOrgAiKey } from "@/lib/ai-settings.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// IMP-9: this page used to ask the customer for an Anthropic or OpenAI API key
// and tell them "You're billed by them directly." BYOK is retired — AI runs on
// HoundStack's key and the tenant buys an allowance with overages (Q-7) — so the
// page no longer asks for something we don't want and never used. No org had
// ever entered a key.
//
// What it does NOT do is show a usage meter. Allowance and overage reporting is
// BUILD-2; rendering a zero, or a bar with no number behind it, would look like
// a measurement rather than an absence.

export const Route = createFileRoute("/_authenticated/settings/ai")({
  component: AiSettings,
});

function AiSettings() {
  const getFn = useServerFn(getOrgAiSettings);
  const testFn = useServerFn(testOrgAiKey);

  const q = useQuery({ queryKey: ["org-ai-settings"], queryFn: () => getFn() });

  const testMut = useMutation({
    mutationFn: () => testFn(),
    onSuccess: (r) => {
      if (r?.ok) toast.success(`AI is responding · ${r.model}`);
      else toast.error(r?.error ?? "AI check failed");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">AI Tools</h1>
        <p className="text-sm text-muted-foreground">
          The AI features — marketing content, review replies, churn scoring, AI dispatch, and zone
          pricing — run on HoundStack&apos;s own models. There is no key to set up and no separate
          provider bill; your plan includes an AI allowance, and any usage beyond it appears on your
          HoundStack invoice.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4 text-sm">
            {q.data && !q.data.planAllowsAi ? (
              // BUILD-7: checked FIRST. This page used to read availability
              // from environment variables alone, so an organization whose plan
              // does not include AI was told "AI is enabled for this
              // organization" — and, if they pressed the check, that it was a
              // HoundStack configuration issue and to contact support. Support
              // cannot change someone's plan for them, and nothing on the page
              // hinted that the plan was the point.
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <div className="font-medium">AI isn&apos;t included on your plan</div>
                  <div className="text-xs text-muted-foreground">
                    {q.data.planReason ?? "AI features need a paid plan."}
                  </div>
                </div>
              </div>
            ) : q.data?.toolsAvailable && q.data?.assistantAvailable ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <div className="font-medium">AI is enabled for this organization</div>
                    <div className="text-xs text-muted-foreground">Model: {q.data.model}</div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => testMut.mutate()}
                  disabled={testMut.isPending}
                >
                  {testMut.isPending ? "Checking…" : "Run a check"}
                </Button>
              </div>
            ) : (
              // An operator problem, worded as one. Telling a tenant to fix this
              // would send them looking for a setting that no longer exists.
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">
                    {q.data?.toolsAvailable || q.data?.assistantAvailable
                      ? "Some AI features are unavailable"
                      : "AI is temporarily unavailable"}
                  </div>
                  <div className="text-xs">
                    {/* Named specifically. "AI is down" when only half of it is
                        down sends someone looking in the wrong place. */}
                    {!q.data?.toolsAvailable && !q.data?.assistantAvailable
                      ? "No AI features will run until this is resolved."
                      : !q.data?.toolsAvailable
                        ? "Marketing content, review replies, churn scoring, AI dispatch, and zone pricing are unavailable. The receptionist and business advisor are unaffected."
                        : "The AI receptionist and the business advisor are unavailable. The AI tools are unaffected."}{" "}
                    This is a HoundStack configuration issue, not something in your account — please
                    contact support.
                  </div>
                </div>
              </div>
            )}
          </div>

          {!q.data?.meteringAvailable && (
            <p className="text-xs text-muted-foreground">
              Usage and allowance reporting isn&apos;t available on this screen yet. It arrives with
              billing metering; until then this page reports whether AI is working, not how much
              you&apos;ve used.
            </p>
          )}
        </>
      )}
    </div>
  );
}
