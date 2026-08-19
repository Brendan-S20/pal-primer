import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FRANCHISE_CODE_MIN_LENGTH,
  getMyFranchiseMembership,
  getMyFranchiseAdjustments,
  getMyFranchiseSettlements,
  joinFranchise,
  normalizeFranchiseCode,
} from "@/lib/franchise-membership.functions";
import { FranchiseAdjustmentTrail } from "@/components/FranchiseAdjustmentTrail";
import { FranchiseSettlementStatements } from "@/components/FranchiseSettlementStatements";

// BUILD-6 — the CHILD's side, and deliberately in Settings rather than on
// /franchise.
//
// /franchise is Enterprise-gated because rollup and royalty billing are what
// the pricing page sells at that tier. A franchisee is not buying that: they
// are a location someone else recruited, most likely on Launch or Growth. If
// joining lived behind the same gate, linking would be impossible unless every
// location independently bought the most expensive plan — so the feature would
// be unusable exactly where it is meant to be used.
//
// Leaving is NOT offered here (owner decision). A franchisee is contractually
// bound to the franchise system; exit is governed by the franchise agreement,
// not by a button in software. The page says so plainly rather than hiding it,
// and names who to contact — including support, for the case where the
// franchise itself has gone quiet.

export const Route = createFileRoute("/_authenticated/settings/franchise")({
  head: () => ({ meta: [{ title: "Franchise · HoundStack" }] }),
  component: FranchiseSettings,
});

function FranchiseSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyFranchiseMembership);
  const joinFn = useServerFn(joinFranchise);
  const [code, setCode] = useState("");

  const q = useQuery({ queryKey: ["franchise", "membership"], queryFn: () => getFn() });

  const join = useMutation({
    mutationFn: () => joinFn({ data: { code } }),
    onSuccess: () => {
      toast.success("Joined the franchise");
      setCode("");
      qc.invalidateQueries({ queryKey: ["franchise"] });
      qc.invalidateQueries({ queryKey: ["org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const m = q.data;

  // Currently a location, OR was one: `hasFranchiseHistory` is the server's
  // answer to "is there anything on record from a link that has ended", asked
  // only for organizations that are not children now. An organization that has
  // never been in a franchise mounts neither panel, so a solo operator does not
  // meet an empty "Settlement statements" card on their settings page.
  const showLedgers = !!m && (m.isChild || m.hasFranchiseHistory);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Franchise</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          If your business operates as a location within a larger franchise, this is where you
          connect to it.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : m?.isChild ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" /> Part of {m.parentName ?? "a franchise"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Your franchise can see this location&apos;s totals — active clients, visits, revenue,
              and outstanding balances. They cannot see individual client records.
            </p>
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Royalty rate
              </div>
              {/* The franchisee can SEE what they owe even though only the
                  parent can set it (BUG-19 protects the column). Billing someone
                  a percentage they cannot look up would be indefensible. */}
              <div className="mt-0.5 text-lg font-medium tabular-nums">
                {m.royaltyPercent}% of collected revenue
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Set by your franchise. Ask them if this doesn&apos;t look right.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Being part of a franchise is set by your franchise agreement, so this connection is
              managed by <strong>{m.parentName ?? "them"}</strong> rather than from here. If you
              need to end it, speak to them first. If they&apos;re unreachable, contact HoundStack
              support and we can help.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* ── A LINK THAT HAS ENDED ──────────────────────────────────────────
          Removal clears parent_organization_id and preserves every statement
          and adjustment already raised — that is stated in
          unlink_franchise_child in as many words, because unlinking is not a
          way to erase what was owed. Both ledgers below used to be mounted
          behind `isChild`, so the moment a franchise removed a location the
          location lost sight of its own unpaid statements, while the franchise
          kept theirs. The two parties reconcile the same document; only one of
          them could still read it. */}
      {showLedgers && !m?.isChild ? (
        <Card>
          <CardContent className="p-4 text-sm">
            <p className="font-medium">This organization is no longer part of a franchise.</p>
            <p className="mt-1 text-muted-foreground">
              The statements and adjustments below are from a franchise link that has ended. They
              are kept exactly as they were — anything still unpaid is still owed, in whichever
              direction it was owed.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* The statements themselves. Until now the location could read its
          royalty RATE and the deduction trail, but never the document that
          bills it — RLS on franchise_royalty_invoices admits the parent's
          office and nobody else, and no server function existed for this side.
          "Issue" moved a status column on the parent's screen and delivered
          nothing to anyone. */}
      {showLedgers ? <MyStatements /> : null}

      {/* The deduction trail is the other half of "you can see what you owe".
          A royalty percentage explains the royalty line; it explains nothing
          about a chargeback that was taken off a statement months ago and — if
          the dispute was won — quietly given back on a later one. This is the
          franchisee's own copy of that trail, so querying a deduction does not
          require asking the party that raised it. */}
      {showLedgers ? <MyAdjustments /> : null}

      {/* ── THE JOIN FORM IS OWNER-ONLY, AND NOW LOOKS IT ──────────────────
          `redeem_franchise_link_code` requires `owner` in SQL. This page gated
          on `manage_settings`, which office_manager holds, so an office manager
          got the form below in full working order — label, code field, enabled
          button — and the only way to discover it was not for them was to type
          a real invitation code into it and be told "Only the owner can join a
          franchise."

          `canJoin` is the server's answer about THIS caller. It is not the
          authorization — joinFranchise re-checks it and the SQL re-checks it
          again — it is the difference between a product that says no and a
          product that never offered.

          Non-owners are told the capability exists and who has it, rather than
          being shown an empty page: a blank space where a colleague's screen
          has a card is a support call, and "ask an owner" is the actual
          answer. */}
      {q.isLoading || m?.isChild ? null : m?.isParent ? (
        <Card>
          <CardContent className="p-6 text-sm">
            <p className="font-medium">This organization is a franchise parent.</p>
            <p className="mt-1 text-muted-foreground">
              Manage your locations and royalty rates from the Franchise page. A parent can&apos;t
              also be a location within another franchise.
            </p>
          </CardContent>
        </Card>
      ) : !m?.canJoin ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Join a franchise</CardTitle>
          </CardHeader>
          <CardContent className="p-6 pt-0 text-sm text-muted-foreground">
            Joining a franchise changes who can see this organization&apos;s totals and lets them
            bill it a royalty, so only an owner can accept an invitation code. Ask an owner of this
            organization to do it from this page.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Join a franchise</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Enter the invitation code your franchise gave you. Nothing changes until you do — they
              can&apos;t link your business without this step.
            </p>
            <div>
              <Label htmlFor="franchise-code" className="text-xs">
                Invitation code
              </Label>
              <Input
                id="franchise-code"
                value={code}
                // Normalized as it is typed rather than on submit: a code
                // dictated over the phone gets written down with spaces in it,
                // and the SQL matches on upper(trim(...)), which trims the ends
                // only. Stripping here means the field shows the value that
                // will actually be looked up.
                onChange={(e) => setCode(normalizeFranchiseCode(e.target.value))}
                placeholder="e.g. 7K2ZQ9M4XB"
                className="font-mono tracking-widest"
                autoComplete="off"
              />
            </div>
            <Button
              onClick={() => join.mutate()}
              // Eight, not six: no shorter code can exist —
              // franchise_link_codes.code is CHECK'd BETWEEN 8 AND 24. Enabling
              // at six sent a half-typed code to a routine whose only possible
              // answer is "ask the franchise owner for a new one".
              disabled={join.isPending || code.length < FRANCHISE_CODE_MIN_LENGTH}
            >
              {join.isPending ? "Joining…" : "Join franchise"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Joining lets your franchise see this location&apos;s totals and bill you a royalty
              percentage. Once joined, ending the connection is handled by your franchise — check
              your agreement before you accept.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** The location's own settlement statements. Same reasoning as MyAdjustments
 *  below — its own query, so the membership card is not held up by it. */
function MyStatements() {
  const fn = useServerFn(getMyFranchiseSettlements);
  const q = useQuery({ queryKey: ["franchise", "my-settlements"], queryFn: () => fn() });
  return (
    <FranchiseSettlementStatements
      rows={q.data?.statements ?? []}
      audience="location"
      isLoading={q.isLoading}
      error={q.error ? (q.error as Error).message : null}
    />
  );
}

/** The location's own deduction trail. Its own query so the membership card
 *  renders immediately — a franchisee who opens this page to check their
 *  royalty rate should not wait on a ledger. */
function MyAdjustments() {
  const fn = useServerFn(getMyFranchiseAdjustments);
  const q = useQuery({ queryKey: ["franchise", "my-adjustments"], queryFn: () => fn() });
  return (
    <FranchiseAdjustmentTrail
      rows={q.data?.rows ?? []}
      audience="location"
      isLoading={q.isLoading}
      error={q.error ? (q.error as Error).message : null}
    />
  );
}
