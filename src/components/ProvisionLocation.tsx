import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Building2, Plus, X, Check, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { provisionFranchiseLocation, type ProvisionedInvite } from "@/lib/franchise-provision.functions";
import {
  LOCATION_MEMBER_ROLES,
  MAX_LOCATION_MEMBERS,
  ROLE_LABEL,
  filledMembers,
  locationProblem,
  type LocationMemberRole,
} from "@/lib/provision-location";

// BUILD-6 — the screen for provision_franchise_location.
//
// The SQL for this was written on 2026-07-30 and nothing has ever called it, so
// a franchise could not open a location from inside the product. The only
// linking path was the invitation code, which assumes the franchisee ALREADY
// runs a HoundStack organization — backwards for the case the owner described,
// where the franchise opens the location and hands the operator a login.
//
// Both paths are kept, and they sit next to each other saying which is which:
// this one creates a new organization, the code links an existing one. Picking
// the wrong one is the difference between a fresh location and an acquisition
// whose client records must survive, so the distinction is on the screen rather
// than in a help article.
//
// WHY AN OWNER ROW IS FIXED IN PLACE. The SQL refuses a location with no owner,
// because the parent is not a member of its own child and an ownerless location
// is an organization nobody in the product can reach. Rather than let someone
// fill in five techs and read a paragraph about why that failed, the first row
// is an owner and cannot be removed or re-roled.

type Row = { email: string; role: LocationMemberRole };

export function ProvisionLocation() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const provisionFn = useServerFn(provisionFranchiseLocation);

  const [name, setName] = useState("");
  const [rows, setRows] = useState<Row[]>([{ email: "", role: "owner" }]);
  const [done, setDone] = useState<{ name: string; invited: ProvisionedInvite[] } | null>(null);

  const provision = useMutation({
    mutationFn: (v: { name: string; members: Row[] }) => provisionFn({ data: v }),
    onSuccess: (r) => {
      setDone({ name: r.name, invited: r.invited });
      setName("");
      setRows([{ email: "", role: "owner" }]);
      // The location shows up in the rollup, the trend and the royalty-rate
      // list, and it just became a franchise parent if it wasn't one — refetch
      // the lot rather than leave a page that disagrees with itself.
      qc.invalidateQueries({ queryKey: ["franchise"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit() {
    // Checks from the shared module, phrased for this form — NOT the rule. The
    // SQL is the rule and re-runs every one of them; this only saves a round
    // trip on a mistake that is visible from here.
    const problem = locationProblem(name, rows);
    if (problem) {
      toast.error(problem);
      return;
    }
    const members = filledMembers(rows);
    const ok = await confirm({
      title: `Open ${name.trim()}?`,
      description: (
        <>
          <p>
            This creates a new organization for {name.trim()}, linked to your franchise, and emails
            an invitation to {members.length} {members.length === 1 ? "person" : "people"}.
          </p>
          <p>
            It starts a 14-day free trial like any other new account. Its clients, visits and
            payments are its own. You see its totals on this page, not its customers.
          </p>
          <p>
            There is no way to remove a location from inside the product yet, so check the name and
            the addresses.
          </p>
        </>
      ),
      confirmLabel: "Open location",
    });
    if (!ok) return;
    provision.mutate({ name: name.trim(), members });
  }

  if (done) {
    const failed = done.invited.filter((i) => !i.emailed);
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Check className="h-4 w-4 text-emerald-600" /> {done.name} is open
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="divide-y">
            {done.invited.map((i) => (
              <li key={i.email} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 break-words">
                  {i.email}{" "}
                  <span className="text-muted-foreground">— {ROLE_LABEL[i.role]}</span>
                </span>
                {/* "Email not sent" is the whole point of the row — it must not
                    be the part that gets pushed off the edge by a long
                    address. */}
                <span
                  className={`shrink-0 ${i.emailed ? "text-muted-foreground" : "text-amber-600"}`}
                >
                  {i.emailed ? "Invited" : "Email not sent"}
                </span>
              </li>
            ))}
          </ul>
          {failed.length > 0 && (
            <div className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                {/* Worth saying plainly: the invitation is a database row, not a
                    link. Someone who never receives the mail still gets into the
                    right organization by signing up with the invited address. */}
                <p className="font-medium">
                  We couldn&apos;t email {failed.length === 1 ? "one address" : "some addresses"}.
                </p>
                <p className="text-muted-foreground">
                  Their invitation is still active. Tell them to sign up at the HoundStack app with
                  that exact address and they&apos;ll join {done.name} with the role you gave them.
                </p>
              </div>
            </div>
          )}
          <p className="text-muted-foreground">
            They set their own password when they sign up. Nothing else is needed from you. The
            location appears in the table above once they start working.
          </p>
          <Button variant="outline" size="sm" onClick={() => setDone(null)}>
            Open another location
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {dialog}
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4" /> Open a new location
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          For a location you&apos;re starting. We create the organization, link it to your
          franchise, and email everyone you name, and they sign themselves in and start working. If
          the location already runs on HoundStack, use an invitation code below instead so their
          existing clients and history come with them.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium uppercase text-muted-foreground" htmlFor="loc-name">
            Location name
          </label>
          <Input
            id="loc-name"
            value={name}
            maxLength={120}
            placeholder="Scoop Troop North Austin"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium uppercase text-muted-foreground">Who works here</div>
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="email"
                value={r.email}
                placeholder={i === 0 ? "operator@example.com" : "teammate@example.com"}
                onChange={(e) => setRow(i, { email: e.target.value })}
                className="flex-1"
              />
              {i === 0 ? (
                // Fixed. See the header: the SQL refuses an ownerless location,
                // and a form that lets you build one just to be told no is a
                // worse way to say the same thing.
                <div className="flex h-10 w-40 items-center rounded-md border border-dashed px-3 text-sm text-muted-foreground">
                  Owner
                </div>
              ) : (
                <Select
                  value={r.role}
                  onValueChange={(v) => setRow(i, { role: v as LocationMemberRole })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_MEMBER_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABEL[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove"
                className={i === 0 ? "invisible" : ""}
                disabled={i === 0}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            The first person is the location&apos;s owner, and they can invite the rest of the staff
            themselves, so you only need to name whoever is there on day one.
          </p>
          {rows.length < MAX_LOCATION_MEMBERS && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRows((rs) => [...rs, { email: "", role: "tech" }])}
            >
              <Plus className="mr-1 h-3 w-3" /> Add someone
            </Button>
          )}
        </div>

        <Button onClick={submit} disabled={provision.isPending}>
          {provision.isPending ? "Opening…" : "Open location"}
        </Button>
      </CardContent>
    </Card>
  );
}
