// "Put my visits in my phone's calendar."
//
// One card, on Profile (your own links) and on Settings -> Scheduling (the
// same links, plus the owner's switch about access codes). The link is shown
// ONCE, right after it is made: only its hash is stored, so there is nothing
// to show again. "Get a new link" is the way back, and it is also how a link
// that was shared by mistake is killed, because it replaces the stored hash.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarDays, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmButton } from "@/components/ConfirmButton";
import {
  createCalendarFeedLink,
  getMyCalendarFeeds,
  revokeCalendarFeedLink,
  setCalendarFeedAccessCodes,
  type CalendarFeedLinkState,
} from "@/lib/calendar-feed.functions";
import { googleSubscribeUrl, webcalUrl, type FeedScope } from "@/lib/calendar-feed";
import { formatDateTime } from "@/lib/format";

const SCOPE_TITLE: Record<FeedScope, string> = {
  mine: "My visits",
  org: "Every visit in the business",
};

const SCOPE_BLURB: Record<FeedScope, string> = {
  mine: "The visits assigned to you, from a week ago to 60 days ahead.",
  org: "Every technician's visits, for whoever runs the schedule. Never includes gate codes.",
};

function NewLink({ url, onDone }: { url: string; onDone: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it by hand.");
    }
  };
  return (
    <div className="mt-3 space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
      <p className="text-xs font-medium">Your calendar link</p>
      <Input
        readOnly
        value={url}
        aria-label="Calendar link"
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={copy}>
          <Copy className="h-4 w-4 shrink-0" /> Copy link
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={googleSubscribeUrl(url)} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4 shrink-0" /> Add to Google Calendar
          </a>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={webcalUrl(url)}>
            <CalendarDays className="h-4 w-4 shrink-0" /> Apple or Outlook
          </a>
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This is the only time the link is shown. Anyone who has it can see these visits, so keep
        it to yourself. If it is ever shared by mistake, get a new one and this one stops working.
      </p>
    </div>
  );
}

function FeedRow({
  scope,
  state,
  onChanged,
}: {
  scope: FeedScope;
  state: CalendarFeedLinkState;
  onChanged: () => void;
}) {
  const createFn = useServerFn(createCalendarFeedLink);
  const revokeFn = useServerFn(revokeCalendarFeedLink);
  const [url, setUrl] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createFn({ data: { scope } }),
    onSuccess: (r) => {
      setUrl(r.url);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: () => revokeFn({ data: { scope } }),
    onSuccess: () => {
      setUrl(null);
      toast.success("Calendar link turned off");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium">{SCOPE_TITLE[scope]}</p>
          <p className="text-xs text-muted-foreground">{SCOPE_BLURB[scope]}</p>
          <p className="mt-1 text-xs">
            {state
              ? `Link made ${formatDateTime(state.createdAt)}. ${
                  state.lastFetchedAt
                    ? `Last read by a calendar ${formatDateTime(state.lastFetchedAt)}.`
                    : "No calendar has read it yet."
                }`
              : "No link yet."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {state ? (
            <>
              <ConfirmButton
                title="Get a new link?"
                description="The current link stops working. Any calendar subscribed to it will stop updating until you add the new one."
                confirmLabel="Get a new link"
                variant="default"
                onConfirm={() => create.mutate()}
                trigger={
                  <Button size="sm" variant="outline" disabled={create.isPending}>
                    {create.isPending ? "Making…" : "Get a new link"}
                  </Button>
                }
              />
              <ConfirmButton
                title="Turn this link off?"
                description="Calendars subscribed to it stop updating. The visits already in them stay until the calendar next checks."
                confirmLabel="Turn off"
                onConfirm={() => revoke.mutate()}
                trigger={
                  <Button size="sm" variant="ghost" disabled={revoke.isPending}>
                    Turn off
                  </Button>
                }
              />
            </>
          ) : (
            <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Making…" : "Create link"}
            </Button>
          )}
        </div>
      </div>
      {url && <NewLink url={url} onDone={() => setUrl(null)} />}
    </div>
  );
}

/** Why the codes themselves never go in a calendar. Said where the switch is,
 *  because the reason cannot be seen from this screen. */
function AccessCodesNote() {
  return (
    <p className="text-xs text-muted-foreground">
      Calendar providers keep copies that cannot be pulled back, so access codes never go in a
      calendar. With this on, a technician&apos;s own calendar says when a visit has access
      details, and they read them in the app.
    </p>
  );
}

export function CalendarFeedCard({ showOrgSetting = false }: { showOrgSetting?: boolean }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyCalendarFeeds);
  const setCodesFn = useServerFn(setCalendarFeedAccessCodes);
  const q = useQuery({ queryKey: ["calendar-feeds"], queryFn: () => getFn() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["calendar-feeds"] });
  const codes = useMutation({
    mutationFn: (enabled: boolean) => setCodesFn({ data: { enabled } }),
    onSuccess: (r) => {
      toast.success(
        r.accessCodesInFeed
          ? "Technicians' own calendars will say when a visit has access details"
          : "Calendars will not mention access details",
      );
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = q.data;
  const scopes: FeedScope[] = d ? ([d.canMine && "mine", d.canOrg && "org"].filter(Boolean) as FeedScope[]) : [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Calendar feed</CardTitle>
        <CardDescription>
          See your visits in Google Calendar, Apple Calendar or Outlook. The calendar checks for
          changes on its own, usually every few hours; skipped visits show as canceled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : q.error ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : !d ? null : (
          <>
            {scopes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There are no visits to put in a calendar for your account: you don&apos;t have an
                active staff record, and seeing every visit needs the owner, office manager or
                dispatcher role.
              </p>
            ) : (
              scopes.map((s) => (
                <FeedRow key={s} scope={s} state={s === "mine" ? d.mine : d.org} onChanged={refresh} />
              ))
            )}

            {showOrgSetting && d.canManageSettings ? (
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-start justify-between gap-3">
                  <label htmlFor="calendar-access-codes" className="min-w-0 flex-1 text-sm">
                    Say in technicians&apos; own calendars when a visit has access details
                  </label>
                  <Switch
                    id="calendar-access-codes"
                    checked={d.accessCodesInFeed}
                    disabled={codes.isPending}
                    onCheckedChange={(v) => codes.mutate(v)}
                  />
                </div>
                <AccessCodesNote />
              </div>
            ) : (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  {d.accessCodesInFeed
                    ? "Gate codes and lock-box codes never go in a calendar. Your technicians' own calendars say when a visit has access details in the app."
                    : "Gate codes and lock-box codes are left out of calendars."}
                  {d.canManageSettings && (
                    <>
                      {" "}
                      <Link to="/settings/scheduling" className="underline underline-offset-2">
                        Change this in Settings → Scheduling
                      </Link>
                      .
                    </>
                  )}
                </span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
