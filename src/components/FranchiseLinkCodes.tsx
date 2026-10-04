import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Copy, Check, Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  createFranchiseLinkCode,
  listFranchiseLinkCodes,
  revokeFranchiseLinkCode,
  type FranchiseLinkCode,
} from "@/lib/franchise.functions";
import { formatDay } from "@/lib/format";

// BUILD-6 — the parent's side of recruiting a location.
//
// The parent issues a code and hands it over out of band; the FRANCHISEE
// redeems it on their own account. That ordering is the whole design: BUG-19
// existed because an organization could attach itself to another unilaterally,
// and locking the column would have been a half-fix if linking then had no
// consensual path at all. The code grants nothing until someone chooses to use
// it.

function StateBadge({ state }: { state: "active" | "used" | "expired" | "revoked" }) {
  if (state === "used") return <Badge variant="secondary">Redeemed</Badge>;
  if (state === "revoked") return <Badge variant="outline">Revoked</Badge>;
  if (state === "expired") return <Badge variant="outline">Expired</Badge>;
  return <Badge className="bg-emerald-600 hover:bg-emerald-600">Ready to share</Badge>;
}

export function FranchiseLinkCodes() {
  const qc = useQueryClient();
  const createFn = useServerFn(createFranchiseLinkCode);
  const listFn = useServerFn(listFranchiseLinkCodes);
  const revokeFn = useServerFn(revokeFranchiseLinkCode);
  const [copied, setCopied] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["franchise", "link-codes"], queryFn: () => listFn() });

  const create = useMutation({
    mutationFn: () => createFn(),
    onSuccess: () => {
      toast.success("Invitation code created");
      qc.invalidateQueries({ queryKey: ["franchise", "link-codes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (codeId: string) => revokeFn({ data: { codeId } }),
    onSuccess: (r) => {
      if (r?.alreadyClosed) toast.info("That code was already used or revoked.");
      else toast.success("Code revoked");
      qc.invalidateQueries({ queryKey: ["franchise", "link-codes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 2000);
    } catch {
      // Clipboard can be blocked; the code is on screen either way, so this is
      // a convenience failing, not the feature failing.
      toast.info("Copy blocked by the browser. Select the code manually.");
    }
  };

  const codes: FranchiseLinkCode[] = q.data?.codes ?? [];
  const active = codes.filter((c: FranchiseLinkCode) => c.state === "active");

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 shrink-0" /> Link a location already on HoundStack
          </CardTitle>
          {/* BUILD-6: this said "Add a location", which is now also the card
              above it. The two do different things — that one creates an
              organization, this one attaches an existing one — and a franchise
              picking the wrong one either loses an operator's client history or
              ends up with an empty duplicate of their business. */}
          <p className="mt-1 text-xs text-muted-foreground">
            For an operator who already runs their business on HoundStack: their clients, visits and
            history come with them. Create a code and send it to their owner, who enters it in
            their own account, so nothing is linked until they agree.
          </p>
        </div>
        <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? "Creating…" : "New code"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : codes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No invitation codes yet.
          </p>
        ) : (
          <ul className="divide-y">
            {codes.map((c: FranchiseLinkCode) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex items-center gap-3">
                  <code
                    className={`rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest ${
                      c.state === "active" ? "" : "text-muted-foreground line-through"
                    }`}
                  >
                    {c.code}
                  </code>
                  <StateBadge state={c.state} />
                  {c.usedByName && (
                    <span className="text-xs text-muted-foreground">by {c.usedByName}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {c.state === "active" && (
                    <>
                      <span className="text-xs text-muted-foreground">
                        expires {formatDay(c.expiresAt)}
                      </span>
                      <Button variant="outline" size="sm" onClick={() => copy(c.code)}>
                        {copied === c.code ? (
                          <>
                            <Check className="mr-1 h-3 w-3 shrink-0" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="mr-1 h-3 w-3 shrink-0" /> Copy
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => revoke.mutate(c.id)}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {active.length > 1 && (
          <p className="text-xs text-muted-foreground">
            {active.length} codes are currently valid. Each one links a single location. Revoke any
            you didn&apos;t mean to leave open.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
