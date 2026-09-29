// Write a campaign, choose who gets it, see it, send it.
//
// Two columns from `lg` (the words on the left, who and what-it-looks-like on
// the right) and one column below it, in the order a person works: write,
// choose, check, send. Everything that stops Send is listed next to the
// button, in words, rather than leaving a greyed-out button to be puzzled
// over on a phone in a driveway.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Eye, Send, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { NoAddressWarning } from "@/components/campaigns/CampaignParts";
import {
  deleteCampaignDraft,
  getCampaignAudience,
  previewCampaignEmail,
  saveCampaignDraft,
  sendCampaign,
  type CampaignRow,
} from "@/lib/campaigns.functions";
import {
  AUDIENCE_LABELS,
  CAMPAIGN_LIMITS,
  CAMPAIGN_MAX_RECIPIENTS,
  LEADS_ARE_NOT_AN_AUDIENCE_YET,
  SEND_BLOCKER_TEXT,
  audienceLabel,
  campaignContentSchema,
  sendBlockers,
  type CampaignAudience,
  type CampaignAudienceKind,
  type CampaignContent,
} from "@/lib/campaigns";
import { cn } from "@/lib/utils";

type Props = {
  campaign: CampaignRow | null;
  contactAddress: string | null;
};

type FieldErrors = Partial<Record<keyof CampaignContent, string>>;

function fieldErrors(content: CampaignContent): FieldErrors {
  const parsed = campaignContentSchema.safeParse(content);
  if (parsed.success) return {};
  const out: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const k = issue.path[0] as keyof CampaignContent | undefined;
    if (k && !out[k]) out[k] = issue.message;
  }
  return out;
}

const AUDIENCE_KINDS: CampaignAudienceKind[] = ["active", "tagged", "inactive"];

export function CampaignEditor({ campaign, contactAddress }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();

  const [subject, setSubject] = useState(campaign?.subject ?? "");
  const [heading, setHeading] = useState(campaign?.heading ?? "");
  const [body, setBody] = useState(campaign?.body ?? "");
  const [buttonLabel, setButtonLabel] = useState(campaign?.buttonLabel ?? "");
  const [buttonUrl, setButtonUrl] = useState(campaign?.buttonUrl ?? "");
  const [kind, setKind] = useState<CampaignAudienceKind>(campaign?.audience.kind ?? "active");
  const [tag, setTag] = useState(campaign?.audience.kind === "tagged" ? campaign.audience.tag : "");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const content: CampaignContent = {
    subject,
    heading,
    body,
    buttonLabel: buttonLabel.trim() ? buttonLabel : null,
    buttonUrl: buttonUrl.trim() ? buttonUrl : null,
  };
  const audience: CampaignAudience | null =
    kind === "tagged" ? (tag.trim() ? { kind, tag: tag.trim() } : null) : { kind };
  const stateKey = JSON.stringify({ content, kind, tag });
  // What was last saved, so Send knows whether to save first. A campaign
  // loaded from the server starts saved.
  useEffect(() => {
    if (campaign) setSavedKey(stateKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.id]);
  const dirty = savedKey !== stateKey;

  const errors = useMemo(() => fieldErrors(content), [stateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Who it reaches, recounted as the audience changes. A tag audience with no
  // tag chosen yet still asks, for the tag list, and shows no count.
  const audienceFn = useServerFn(getCampaignAudience);
  const audienceQ = useQuery({
    queryKey: ["campaign-audience", audience ?? { kind: "active" }],
    queryFn: () => audienceFn({ data: { audience: audience ?? { kind: "active" } } }),
    staleTime: 30_000,
  });
  const counted = audience ? audienceQ.data : undefined;
  const recipientCount = counted?.recipients ?? 0;

  const blockers = sendBlockers({ contactAddress, content, recipientCount });
  if (!audience) blockers.push("no_recipients");
  const canSend = blockers.length === 0 && !!counted;

  const saveFn = useServerFn(saveCampaignDraft);
  const saveM = useMutation({
    mutationFn: async () => {
      if (!audience) throw new Error("Choose a tag for this audience.");
      const parsed = campaignContentSchema.safeParse(content);
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Check the highlighted fields.");
      return saveFn({ data: { id: campaign?.id, content, audience } });
    },
    onSuccess: (r) => {
      setSavedKey(stateKey);
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      if (!campaign) {
        navigate({ to: "/campaigns/$campaignId", params: { campaignId: r.id }, replace: true });
      } else {
        qc.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      }
    },
  });

  const previewFn = useServerFn(previewCampaignEmail);
  const previewM = useMutation({
    mutationFn: () => previewFn({ data: { content } }),
    onSuccess: (r) => setPreviewHtml(r.html),
    onError: (e) => toast.error((e as Error).message),
  });

  const sendFn = useServerFn(sendCampaign);
  const sendM = useMutation({
    mutationFn: (id: string) => sendFn({ data: { id } }),
    onSuccess: (r, id) => {
      if (r.outcome === "started") {
        toast.success(
          `Sending to ${(r as { recipients?: number }).recipients ?? recipientCount} clients. ${r.queued} on their way now; the rest go out a batch a minute.`,
        );
      } else {
        toast.message(r.message);
      }
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["campaign", id] });
      if (!campaign)
        navigate({ to: "/campaigns/$campaignId", params: { campaignId: id }, replace: true });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const deleteFn = useServerFn(deleteCampaignDraft);
  const deleteM = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success("Draft deleted");
      navigate({ to: "/campaigns" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  async function onSend() {
    if (!audience || !counted) return;
    let id = campaign?.id ?? null;
    if (dirty || !id) {
      try {
        const saved = await saveM.mutateAsync();
        id = saved.id;
      } catch (e) {
        toast.error((e as Error).message);
        return;
      }
    }
    const ok = await confirm({
      title: `Send to ${recipientCount.toLocaleString()} ${recipientCount === 1 ? "client" : "clients"}?`,
      description: (
        <span className="block space-y-2">
          <span className="block break-words">
            "{subject.trim()}" goes to {audienceLabel(audience).toLowerCase()}. Once it starts it
            cannot be stopped or edited.
          </span>
          <span className="block">
            It goes out a batch a minute, after invoices and reminders, so a large list takes a
            while.
          </span>
        </span>
      ),
      confirmLabel: "Send campaign",
    });
    if (ok && id) sendM.mutate(id);
  }

  async function onDelete() {
    if (!campaign) return;
    const ok = await confirm({
      title: "Delete this draft?",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) deleteM.mutate(campaign.id);
  }

  const tags = audienceQ.data?.tags ?? [];
  const busy = saveM.isPending || sendM.isPending;

  return (
    <div className="space-y-5">
      {dialog}
      {!contactAddress && <NoAddressWarning />}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── The words ───────────────────────────────────────────── */}
        <section
          aria-labelledby="campaign-message"
          className="min-w-0 space-y-4 lg:self-start rounded-lg border bg-card p-4"
        >
          <h2 id="campaign-message" className="font-semibold">
            Message
          </h2>
          <Field
            id="campaign-subject"
            label="Subject"
            count={subject.length}
            max={CAMPAIGN_LIMITS.subject}
            error={errors.subject}
          >
            <Input
              id="campaign-subject"
              value={subject}
              maxLength={CAMPAIGN_LIMITS.subject}
              placeholder="Spring deep clean: $20 off through April"
              onChange={(e) => setSubject(e.target.value.replace(/[\r\n]+/g, " "))}
            />
          </Field>
          <Field
            id="campaign-heading"
            label="Heading"
            hint="The first thing they read, in large type. Optional."
            count={heading.length}
            max={CAMPAIGN_LIMITS.heading}
            error={errors.heading}
          >
            <Input
              id="campaign-heading"
              value={heading}
              maxLength={CAMPAIGN_LIMITS.heading}
              placeholder="Spring is here"
              onChange={(e) => setHeading(e.target.value)}
            />
          </Field>
          <Field
            id="campaign-body"
            label="Message"
            hint="Plain text. Leave a blank line between paragraphs."
            count={body.length}
            max={CAMPAIGN_LIMITS.body}
            error={errors.body}
          >
            <Textarea
              id="campaign-body"
              value={body}
              rows={9}
              maxLength={CAMPAIGN_LIMITS.body}
              placeholder={
                "Book a one-time spring deep clean before April 30 and we'll take $20 off.\n\nJust reply to this email."
              }
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Button (optional)</legend>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <Field id="campaign-button-label" label="Label" error={errors.buttonLabel}>
                <Input
                  id="campaign-button-label"
                  value={buttonLabel}
                  maxLength={CAMPAIGN_LIMITS.buttonLabel}
                  placeholder="Book a deep clean"
                  onChange={(e) => setButtonLabel(e.target.value)}
                />
              </Field>
              <Field id="campaign-button-url" label="Link" error={errors.buttonUrl}>
                <Input
                  id="campaign-button-url"
                  type="url"
                  inputMode="url"
                  value={buttonUrl}
                  maxLength={CAMPAIGN_LIMITS.buttonUrl}
                  placeholder="https://"
                  onChange={(e) => setButtonUrl(e.target.value)}
                />
              </Field>
            </div>
          </fieldset>
        </section>

        <div className="min-w-0 space-y-5">
          {/* ── Who ─────────────────────────────────────────────────── */}
          <section
            aria-labelledby="campaign-audience"
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <h2 id="campaign-audience" className="font-semibold">
              Who gets it
            </h2>
            <div role="radiogroup" aria-labelledby="campaign-audience" className="space-y-2">
              {AUDIENCE_KINDS.map((k) => (
                <label
                  key={k}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm",
                    kind === k && "border-primary bg-primary/5",
                  )}
                >
                  <input
                    type="radio"
                    name="campaign-audience"
                    className="mt-0.5 h-4 w-4 shrink-0"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{AUDIENCE_LABELS[k]}</span>
                    {k === "active" && audienceQ.data && (
                      <span className="block text-xs text-muted-foreground">
                        {audienceQ.data.activeCount.toLocaleString()} active clients
                      </span>
                    )}
                    {k === "inactive" && audienceQ.data && (
                      <span className="block text-xs text-muted-foreground">
                        {audienceQ.data.inactiveCount.toLocaleString()} inactive or former clients
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <label
                aria-disabled="true"
                className="flex min-h-11 cursor-not-allowed items-start gap-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground"
              >
                <input
                  type="radio"
                  name="campaign-audience"
                  className="mt-0.5 h-4 w-4 shrink-0"
                  disabled
                />
                <span className="min-w-0">
                  <span className="block font-medium">Leads not converted</span>
                  <span className="block text-xs">{LEADS_ARE_NOT_AN_AUDIENCE_YET}</span>
                </span>
              </label>
            </div>

            {kind === "tagged" && (
              <label className="block space-y-1 text-sm">
                <span className="font-medium">Tag</span>
                <select
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:min-h-11"
                >
                  <option value="">
                    {tags.length ? "Choose a tag…" : "No client has a tag yet"}
                  </option>
                  {/* A saved tag nobody carries any more still shows, so the
                      draft does not silently change audience. */}
                  {tag && !tags.some((t) => t.tag.toLowerCase() === tag.toLowerCase()) && (
                    <option value={tag}>{tag} (0)</option>
                  )}
                  {tags.map((t) => (
                    <option key={t.tag} value={t.tag}>
                      {t.tag} ({t.count})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <AudienceCount
              loading={audienceQ.isLoading}
              error={audienceQ.error as Error | null}
              needsTag={!audience}
              data={counted}
            />
          </section>

          {/* ── What it looks like ─────────────────────────────────── */}
          <section
            aria-labelledby="campaign-preview"
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="campaign-preview" className="font-semibold">
                Preview
              </h2>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => previewM.mutate()}
                disabled={previewM.isPending || Object.keys(errors).length > 0}
              >
                <Eye className="h-4 w-4 shrink-0" />
                {previewHtml ? "Refresh preview" : "Show preview"}
              </Button>
            </div>
            {previewHtml ? (
              <>
                <p className="break-words text-sm">
                  <span className="text-muted-foreground">Subject: </span>
                  {subject.trim() || "(no subject)"}
                </p>
                {/* sandbox with no allowances: the email's own markup, with no
                    script and no way to navigate this page. */}
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={previewHtml}
                  className="h-[560px] w-full rounded-md border bg-white"
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                The email exactly as your clients will get it, with your business details and the
                unsubscribe link at the foot.
              </p>
            )}
          </section>
        </div>
      </div>

      {/* ── Save and send ───────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border bg-card p-4">
        {blockers.length > 0 && counted !== undefined && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {[...new Set(blockers)]
              .filter((b) => b !== "invalid_content" || Object.keys(errors).length > 0)
              .map((b) => (
                <li key={b}>{SEND_BLOCKER_TEXT[b]}</li>
              ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onSend} disabled={!canSend || busy}>
            <Send className="h-4 w-4 shrink-0" />
            {sendM.isPending
              ? "Sending…"
              : canSend
                ? `Send to ${recipientCount.toLocaleString()}`
                : "Send"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => saveM.mutate()}
            disabled={busy || (!dirty && !!campaign)}
          >
            {saveM.isPending ? "Saving…" : dirty || !campaign ? "Save draft" : "Saved"}
          </Button>
          {campaign && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive"
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete draft
            </Button>
          )}
        </div>
        {saveM.error && (
          <p role="alert" className="text-sm text-destructive">
            {(saveM.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  count,
  max,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  count?: number;
  max?: number;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <Label htmlFor={id}>{label}</Label>
        {max !== undefined && count !== undefined && count > max * 0.8 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {count}/{max}
          </span>
        )}
      </div>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function AudienceCount({
  loading,
  error,
  needsTag,
  data,
}: {
  loading: boolean;
  error: Error | null;
  needsTag: boolean;
  data:
    | {
        recipients: number;
        matched: number;
        excluded: { optedOut: number; commsPaused: number; noEmail: number; duplicate: number };
        overCap: boolean;
      }
    | undefined;
}) {
  if (needsTag)
    return <p className="text-sm text-muted-foreground">Choose a tag to see who that reaches.</p>;
  if (loading) return <p className="text-sm text-muted-foreground">Counting…</p>;
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  if (!data) return null;
  const left: string[] = [];
  if (data.excluded.optedOut) left.push(`${data.excluded.optedOut} unsubscribed`);
  if (data.excluded.commsPaused)
    left.push(`${data.excluded.commsPaused} imported and not contacted yet`);
  if (data.excluded.noEmail) left.push(`${data.excluded.noEmail} with no email address`);
  if (data.excluded.duplicate)
    left.push(`${data.excluded.duplicate} sharing an address with another client`);
  return (
    <div className="flex gap-3 rounded-md bg-muted/50 p-3 text-sm" aria-live="polite">
      <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-1">
        <p>
          <span className="font-semibold tabular-nums">{data.recipients.toLocaleString()}</span>{" "}
          {data.recipients === 1 ? "client" : "clients"} will get this.
        </p>
        {left.length > 0 && (
          <p className="text-xs text-muted-foreground">Left out: {left.join(", ")}.</p>
        )}
        {data.overCap && (
          <p className="text-xs text-destructive">
            That is more than the {CAMPAIGN_MAX_RECIPIENTS.toLocaleString()} a campaign can go to.
          </p>
        )}
      </div>
    </div>
  );
}
