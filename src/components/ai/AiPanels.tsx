// AI tool panels, extracted from the former standalone /ai-tools page so each
// tool can live inside the workflow it belongs to (punch list #11): review
// replies with Reviews settings, churn with Clients, dispatch with Routes,
// zone pricing with Zones, marketing + digest on the Dashboard. Configuration
// (API keys) stays in Settings -> AI.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownLite } from "@/components/MarkdownLite";
import {
  generateMarketingContent,
  draftReviewReply,
  scoreChurn,
  listChurnRisk,
  generateWeeklyDigest,
  suggestDispatch,
  applyDispatchSuggestions,
  suggestZonePricing,
  applyZonePricing,
} from "@/lib/ai-tools.functions";

/** Collapsed-by-default wrapper for embedding an AI tool in a workflow page.
 *  The panel (and its queries) only mounts when opened. */
export function AiSection({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Sparkles className="h-4 w-4 text-primary" />
        {title}
        {description && !open && (
          <span className="ml-1 truncate text-xs font-normal text-muted-foreground">{description}</span>
        )}
      </button>
      {open && <div className="border-t p-4">{children}</div>}
    </div>
  );
}

export function MarketingPanel() {
  const fn = useServerFn(generateMarketingContent);
  const [kind, setKind] = useState<"facebook_post" | "instagram_caption" | "email_blast" | "google_business_update" | "flyer_headline">("facebook_post");
  const [tone, setTone] = useState<"friendly" | "professional" | "playful" | "urgent">("friendly");
  const [topic, setTopic] = useState("");
  const [includeCta, setIncludeCta] = useState(true);
  const m = useMutation({
    mutationFn: () => fn({ data: { kind, tone, topic, includeCta } }),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <label className="block text-sm">
          <span className="font-medium">Content type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as any)} className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm">
            <option value="facebook_post">Facebook post</option>
            <option value="instagram_caption">Instagram caption</option>
            <option value="email_blast">Email blast</option>
            <option value="google_business_update">Google Business update</option>
            <option value="flyer_headline">Flyer headline</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Tone</span>
          <select value={tone} onChange={(e) => setTone(e.target.value as any)} className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm">
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="playful">Playful</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Topic / angle</span>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={4}
            placeholder="Spring cleanup promo: 20% off first month for new sign-ups this week"
            className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeCta} onChange={(e) => setIncludeCta(e.target.checked)} />
          Include a call to action
        </label>
        <Button disabled={m.isPending || topic.trim().length < 3} onClick={() => m.mutate()}>
          {m.isPending ? "Writing…" : "Generate"}
        </Button>
      </div>
      <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
        {!m.data ? (
          <p className="text-muted-foreground">Output appears here.</p>
        ) : (
          <>
            <div className="text-base font-semibold">{m.data.title}</div>
            <p className="whitespace-pre-wrap">{m.data.body}</p>
            {m.data.cta && <p className="font-medium text-primary">{m.data.cta}</p>}
            {m.data.hashtags?.length ? (
              <p className="text-xs text-muted-foreground">{m.data.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}</p>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const t = `${m.data!.title}\n\n${m.data!.body}${m.data!.cta ? `\n\n${m.data!.cta}` : ""}`;
                navigator.clipboard.writeText(t).then(() => toast.success("Copied"));
              }}
            >
              Copy
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function ReviewPanel() {
  const fn = useServerFn(draftReviewReply);
  const [reviewText, setReviewText] = useState("");
  const [rating, setRating] = useState(5);
  const [reviewerName, setReviewerName] = useState("");
  const m = useMutation({
    mutationFn: () => fn({ data: { reviewText, rating, reviewerName: reviewerName || undefined } }),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <label className="block text-sm">
          <span className="font-medium">Reviewer name (optional)</span>
          <input value={reviewerName} onChange={(e) => setReviewerName(e.target.value)} className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Rating</span>
          <select value={rating} onChange={(e) => setRating(Number(e.target.value))} className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm">
            {[5, 4, 3, 2, 1].map((r) => (
              <option key={r} value={r}>{r} star{r !== 1 ? "s" : ""}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Review text</span>
          <textarea value={reviewText} onChange={(e) => setReviewText(e.target.value)} rows={6} className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm" />
        </label>
        <Button disabled={m.isPending || reviewText.trim().length < 3} onClick={() => m.mutate()}>
          {m.isPending ? "Drafting…" : "Draft reply"}
        </Button>
      </div>
      <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
        {!m.data ? (
          <p className="text-muted-foreground">Draft appears here. Review before posting publicly.</p>
        ) : (
          <>
            <div className="font-medium">Suggested public reply</div>
            <p className="whitespace-pre-wrap rounded bg-muted p-2">{m.data.reply}</p>
            <div className="font-medium">Internal notes</div>
            <p className="whitespace-pre-wrap text-muted-foreground">{m.data.notes}</p>
            <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(m.data!.reply).then(() => toast.success("Copied"))}>
              Copy reply
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function ChurnPanel() {
  const listFn = useServerFn(listChurnRisk);
  const scoreFn = useServerFn(scoreChurn);
  const { data, refetch, isFetching } = useQuery({
    queryKey: ["churn-risk"],
    queryFn: () => listFn({ data: undefined as any }),
  });
  const m = useMutation({
    mutationFn: () => scoreFn({ data: {} }),
    onSuccess: (r) => {
      toast.success(`Scored ${r.scored} clients`);
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Scores active clients on skip rate, unpaid invoices, and days since last completed visit.
        </p>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending ? "Scoring…" : "Re-score all active clients"}
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Scored</th>
            </tr>
          </thead>
          <tbody>
            {isFetching && !data?.length ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            ) : !data?.length ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No scores yet. Click "Re-score" to run.</td></tr>
            ) : (
              data.map((c: any) => (
                <tr key={c.id} className="border-t">
                  <td className="px-3 py-2 font-medium">{c.display_name}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${c.churn_score >= 70 ? "bg-red-100 text-red-800" : c.churn_score >= 40 ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
                      {c.churn_score}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{c.churn_reason}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{c.churn_scored_at ? new Date(c.churn_scored_at).toLocaleDateString() : ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DigestPanel() {
  const fn = useServerFn(generateWeeklyDigest);
  const m = useMutation({
    mutationFn: () => fn({ data: undefined as any }),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Owner-focused summary of the last 7 days.</p>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending ? "Generating…" : "Generate this week's digest"}
        </Button>
      </div>
      {m.data && (
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="Visits completed" value={m.data.stats.completed} sub={`${m.data.stats.completion_rate}% completion`} />
          <StatCard label="Collected" value={fmt(m.data.stats.revenue_collected_cents)} sub={`${fmt(m.data.stats.revenue_invoiced_cents)} invoiced`} />
          <StatCard label="New clients / leads" value={`${m.data.stats.new_clients} / ${m.data.stats.new_leads}`} sub={`${m.data.stats.open_invoices} open invoices`} />
        </div>
      )}
      {m.data && (
        <div className="rounded-lg border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">{m.data.stats.org}: this week</div>
          <MarkdownLite text={m.data.summary} className="space-y-2" />
        </div>
      )}
      {m.data?.stats.at_risk?.length ? (
        <div className="rounded-lg border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">Watch list</div>
          <ul className="space-y-1">
            {m.data.stats.at_risk.map((c: any) => (
              <li key={c.id}><strong>{c.display_name}</strong>, score {c.churn_score}: <span className="text-muted-foreground">{c.churn_reason}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------- Dispatch panel ----------------

export function DispatchPanel() {
  const suggestFn = useServerFn(suggestDispatch);
  const applyFn = useServerFn(applyDispatchSuggestions);
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const m = useMutation({
    mutationFn: () => suggestFn({ data: { day } }),
    onSuccess: (r) => {
      const next: Record<string, boolean> = {};
      for (const s of r.suggestions) next[s.visit_id] = s.priority !== "low";
      setSelected(next);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const apply = useMutation({
    mutationFn: () => {
      const changes = (m.data?.suggestions ?? [])
        .filter((s: any) => selected[s.visit_id])
        .map((s: any) => ({ visit_id: s.visit_id, staff_id: s.suggested_staff_id }));
      return applyFn({ data: { changes } });
    },
    onSuccess: (r) => toast.success(`Applied ${r.applied} reassignments`),
    onError: (e: Error) => toast.error(e.message),
  });

  const suggestions = m.data?.suggestions ?? [];
  const chosen = suggestions.filter((s: any) => selected[s.visit_id]).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="text-sm">
          <span className="block font-medium">Day</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="mt-1 rounded border bg-background px-3 py-2 text-sm" />
        </label>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending ? "Analyzing…" : "Suggest reassignments"}
        </Button>
        <div className="flex-1" />
        <Button variant="secondary" disabled={!chosen || apply.isPending} onClick={() => apply.mutate()}>
          {apply.isPending ? "Applying…" : `Apply ${chosen} selected`}
        </Button>
      </div>

      {m.data && (
        <div className="rounded-lg border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">Dispatcher notes</div>
          <p className="whitespace-pre-wrap text-muted-foreground">{m.data.notes}</p>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 w-8"></th>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Zone</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Current → Suggested</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            {!suggestions.length ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                {m.isPending ? "Analyzing…" : "No suggestions yet. Choose a day and click Suggest."}
              </td></tr>
            ) : suggestions.map((s: any) => (
              <tr key={s.visit_id} className="border-t">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={!!selected[s.visit_id]} onChange={(e) => setSelected((p) => ({ ...p, [s.visit_id]: e.target.checked }))} />
                </td>
                <td className="px-3 py-2 font-medium">{s.client}</td>
                <td className="px-3 py-2 text-muted-foreground">{s.zone ?? "-"}</td>
                <td className="px-3 py-2">{fmt(s.price_cents)}</td>
                <td className="px-3 py-2 text-xs">
                  <span className="text-muted-foreground">{s.current_staff ?? "Unassigned"}</span>
                  {" → "}
                  <span className="font-medium">{s.suggested_staff ?? "Unassigned"}</span>
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.priority === "high" ? "bg-red-100 text-red-800" : s.priority === "medium" ? "bg-amber-100 text-amber-800" : "bg-muted text-muted-foreground"}`}>
                    {s.priority}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- Zone pricing panel ----------------

export function PricingPanel() {
  const suggestFn = useServerFn(suggestZonePricing);
  const applyFn = useServerFn(applyZonePricing);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const m = useMutation({
    mutationFn: () => suggestFn({ data: {} }),
    onSuccess: (r) => {
      const next: Record<string, boolean> = {};
      for (const s of r.suggestions) next[s.zone_id] = s.confidence !== "low";
      setSelected(next);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const apply = useMutation({
    mutationFn: () => {
      const changes = (m.data?.suggestions ?? [])
        .filter((s: any) => selected[s.zone_id])
        .map((s: any) => ({
          zone_id: s.zone_id,
          price_note: `AI: $${(s.suggested_price_cents / 100).toFixed(2)}/visit (${s.delta_pct >= 0 ? "+" : ""}${s.delta_pct}%), ${s.reason}`,
        }));
      return applyFn({ data: { changes } });
    },
    onSuccess: (r) => toast.success(`Updated ${r.applied} zone price notes`),
    onError: (e: Error) => toast.error(e.message),
  });

  const suggestions = m.data?.suggestions ?? [];
  const chosen = suggestions.filter((s: any) => selected[s.zone_id]).length;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 rounded-lg border bg-card p-4">
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending ? "Analyzing…" : "Suggest zone prices"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Based on the last 90 days of completed visits, skip rate, and current pricing. Applies to each zone's price note.
        </p>
        <div className="flex-1" />
        <Button variant="secondary" disabled={!chosen || apply.isPending} onClick={() => apply.mutate()}>
          {apply.isPending ? "Applying…" : `Apply ${chosen} selected`}
        </Button>
      </div>

      {m.data && (
        <div className="rounded-lg border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">Pricing analyst notes</div>
          <p className="whitespace-pre-wrap text-muted-foreground">{m.data.notes}</p>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 w-8"></th>
              <th className="px-3 py-2">Zone</th>
              <th className="px-3 py-2">Completed 90d</th>
              <th className="px-3 py-2">Skip rate</th>
              <th className="px-3 py-2">Current avg</th>
              <th className="px-3 py-2">Suggested</th>
              <th className="px-3 py-2">Δ</th>
              <th className="px-3 py-2">Confidence</th>
              <th className="px-3 py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            {!suggestions.length ? (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                {m.isPending ? "Analyzing…" : "No suggestions yet."}
              </td></tr>
            ) : suggestions.map((s: any) => (
              <tr key={s.zone_id} className="border-t">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={!!selected[s.zone_id]} onChange={(e) => setSelected((p) => ({ ...p, [s.zone_id]: e.target.checked }))} />
                </td>
                <td className="px-3 py-2 font-medium">{s.name}<div className="text-xs text-muted-foreground">{s.account_type ?? ""}</div></td>
                <td className="px-3 py-2">{s.completed_90d}</td>
                <td className="px-3 py-2">{s.skip_rate_pct}%</td>
                <td className="px-3 py-2">{fmt(s.avg_visit_price_cents)}</td>
                <td className="px-3 py-2 font-medium">{fmt(s.suggested_price_cents)}</td>
                <td className={`px-3 py-2 font-medium ${s.delta_pct > 0 ? "text-green-700" : s.delta_pct < 0 ? "text-red-700" : ""}`}>
                  {s.delta_pct > 0 ? "+" : ""}{s.delta_pct}%
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.confidence === "high" ? "bg-green-100 text-green-800" : s.confidence === "medium" ? "bg-amber-100 text-amber-800" : "bg-muted text-muted-foreground"}`}>
                    {s.confidence}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
