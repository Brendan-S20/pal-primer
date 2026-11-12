// Completing a visit from the client's Visits tab says "Visit marked
// completed", and the row has to say so too, straight away (#789).
//
// The tab's Complete invalidated ["client-visit-history", clientId] and
// nothing else, so between the toast and the refetch landing the row still
// read "scheduled" — and if that refetch was slow, failed, or came back from
// a read that had not seen the write yet, it stayed that way until a full page
// reload. On the "Complete without the tech's proof?" path the toast is the
// only sign the override worked, so a row that disagrees with it reads as the
// complete having failed.
//
// The fix writes the completed status into the list the row reads from at the
// moment the toast is shown, then refetches as before. This pins both halves:
// the cache write itself, against a real QueryClient with a subscribed
// observer (what the row is), and that the Visits tab's Complete uses it.
// It also pins the reason field: a real input, not a placeholder-styled box.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  clientVisitHistoryKey,
  markVisitCompletedInClientHistory,
} from "@/lib/client-visit-history-cache";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const scheduled = {
  id: "v-nov10",
  scheduled_on: "2026-11-10",
  status: "scheduled",
  completed_at: null,
};
const other = { id: "v-nov3", scheduled_on: "2026-11-03", status: "completed", completed_at: "x" };

describe("the Visits row matches the toast", () => {
  it("flips the completed visit in the list a subscribed row is reading, before any refetch", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A server that has not answered yet: the refetch the invalidation starts
    // is still pending when the row is read. Before the fix this is exactly
    // the window in which the row said "scheduled" next to the toast.
    let answer: (v: unknown) => void = () => {};
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ visits: [scheduled, other] })
      .mockImplementation(() => new Promise((r) => (answer = r)));
    const row = new QueryObserver(qc, { queryKey: clientVisitHistoryKey(CLIENT), queryFn });
    const seen: string[] = [];
    const unsubscribe = row.subscribe((r) => {
      const v = (r.data as any)?.visits?.find((x: any) => x.id === scheduled.id);
      if (v) seen.push(v.status);
    });
    await vi.waitFor(() => expect(seen.at(-1)).toBe("scheduled"));

    const now = new Date("2026-11-09T19:50:00.000Z");
    markVisitCompletedInClientHistory(qc, CLIENT, scheduled.id, now);
    void qc.invalidateQueries({ queryKey: clientVisitHistoryKey(CLIENT) });

    const rows = (row.getCurrentResult().data as any).visits;
    expect(rows.find((x: any) => x.id === scheduled.id)).toMatchObject({
      status: "completed",
      completed_at: now.toISOString(),
    });
    // The other rows are untouched, and not copied.
    expect(rows.find((x: any) => x.id === other.id)).toBe(other);
    expect(seen.at(-1)).toBe("completed");
    // ...and the refetch still happens, so the server has the last word.
    expect(queryFn).toHaveBeenCalledTimes(2);
    answer({ visits: [{ ...scheduled, status: "completed", completed_at: "server" }, other] });
    await vi.waitFor(() =>
      expect(
        (row.getCurrentResult().data as any).visits.find((x: any) => x.id === scheduled.id)
          .completed_at,
      ).toBe("server"),
    );
    unsubscribe();
    qc.clear();
  });

  it("keeps a completion time the visit already had", () => {
    const qc = new QueryClient();
    const withTime = { ...scheduled, status: "in_progress", completed_at: "2026-11-09T18:00:00Z" };
    qc.setQueryData(clientVisitHistoryKey(CLIENT), { visits: [withTime] });
    markVisitCompletedInClientHistory(qc, CLIENT, withTime.id, new Date());
    expect((qc.getQueryData(clientVisitHistoryKey(CLIENT)) as any).visits[0]).toMatchObject({
      status: "completed",
      completed_at: "2026-11-09T18:00:00Z",
    });
    qc.clear();
  });

  it("does nothing when the list was never loaded, or the visit is not in it", () => {
    const qc = new QueryClient();
    markVisitCompletedInClientHistory(qc, CLIENT, "nope", new Date());
    expect(qc.getQueryData(clientVisitHistoryKey(CLIENT))).toBeUndefined();
    const data = { visits: [other] };
    qc.setQueryData(clientVisitHistoryKey(CLIENT), data);
    markVisitCompletedInClientHistory(qc, CLIENT, "nope", new Date());
    expect(qc.getQueryData(clientVisitHistoryKey(CLIENT))).toBe(data);
    qc.clear();
  });

  it("uses the key the client page loads the list with", () => {
    expect(clientVisitHistoryKey(CLIENT)).toEqual(["client-visit-history", CLIENT]);
    expect(read("src/routes/_authenticated/clients.$clientId.tsx")).toContain(
      'queryKey: ["client-visit-history", clientId]',
    );
  });
});

describe("the Visits tab's Complete", () => {
  const tab = read("src/components/client-detail/VisitsTab.tsx");
  const complete = tab.slice(tab.indexOf("const completeMut = useMutation"));
  const onSuccess = complete.slice(0, complete.indexOf("onError"));

  it("writes the completed status before it says so, then refetches", () => {
    expect(onSuccess).toMatch(
      /markVisitCompletedInClientHistory\(qc, clientId, v\.id\)[\s\S]*afterAction\("Visit marked completed"\)/,
    );
    // afterAction is what invalidates the list, so the server still decides.
    const after = tab.slice(tab.indexOf("const afterAction"), tab.indexOf("const completeMut"));
    expect(after).toContain(
      'qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] })',
    );
  });

  it("only when the visit was completed, not when the reason was cancelled", () => {
    expect(onSuccess).toMatch(/if \(!done\) return;/);
  });
});

describe("the reason field reads as a field", () => {
  const own = read("src/components/OfficeCompleteOverride.tsx");
  const field = own.slice(own.indexOf("<Textarea"), own.indexOf("/>", own.indexOf("<Textarea")));

  it("has a solid background, not the transparent one that let it pass for text", () => {
    expect(field).toMatch(/className="[^"]*\bbg-background\b/);
  });

  it("says its placeholder is an example, so it is not mistaken for something already typed", () => {
    expect(field).toMatch(/placeholder="For example: /);
  });

  it("takes the focus, so the caret is in it when the question opens", () => {
    expect(field).toMatch(/\bautoFocus\b/);
  });
});
