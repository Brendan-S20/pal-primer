// What the owner typed during Get started and Setup, on the page they open
// to find it (#766).
//
// Business name, phone, address and contact email were saved (into
// organizations, by bootstrapOrganization and setup step 1), but the only
// screen that showed them was Settings > Client portal > "Client portal
// branding & policy" -- not where an owner looks for their own business. At
// Detroit Doo Disposal that read as "onboarding didn't save". The dump site
// from setup had no Settings entry at all; it was only on the Waste log.
//
// Same server functions and the same query keys as the Client portal card and
// the Waste log, so a save here shows there and the other way round: one row,
// two doors, never two copies of the value.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { getOrgBranding, updateOrgBranding } from "@/lib/org.functions";
import { listFacilities } from "@/lib/stations.functions";
import { isValidOrgName } from "@/lib/dna-linkage";

export function BusinessDetailsCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getOrgBranding);
  const setFn = useServerFn(updateOrgBranding);
  const q = useQuery({ queryKey: ["org-branding"], queryFn: () => getFn() });

  // null until touched: the fields show what is stored, the same pattern as
  // setup step 1, so a refetch after a save elsewhere is never hidden behind
  // a copy taken when the card mounted.
  const [nameEdit, setName] = useState<string | null>(null);
  const [phoneEdit, setPhone] = useState<string | null>(null);
  const [emailEdit, setEmail] = useState<string | null>(null);
  const [addressEdit, setAddress] = useState<string | null>(null);
  const name = nameEdit ?? q.data?.name ?? "";
  const phone = phoneEdit ?? q.data?.contact_phone ?? "";
  const email = emailEdit ?? q.data?.contact_email ?? "";
  const address = addressEdit ?? q.data?.contact_address ?? "";

  const m = useMutation({
    mutationFn: () =>
      setFn({
        data: {
          name: name.trim(),
          contactPhone: phone.trim() || null,
          contactEmail: email.trim() || null,
          contactAddress: address.trim() || null,
        },
      }),
    onSuccess: (res) => {
      toast.success("Business details saved");
      // The office phone saved; only its copy to the owner's Profile did not (#787).
      if (res?.profilePhoneWarning) toast.warning(res.profilePhoneWarning);
      // A first office phone may also have filled the owner's Profile phone.
      qc.invalidateQueries({ queryKey: ["my-profile"] });
      // What was just saved, until the refetch below replaces it, so the
      // fields do not flash the old values in between.
      qc.setQueryData(["org-branding"], (old: typeof q.data) =>
        old
          ? {
              ...old,
              name: name.trim(),
              contact_phone: phone.trim() || null,
              contact_email: email.trim() || null,
              contact_address: address.trim() || null,
            }
          : old,
      );
      setName(null);
      setPhone(null);
      setEmail(null);
      setAddress(null);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["org-branding"] });
      qc.invalidateQueries({ queryKey: ["my-org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const nameOk = isValidOrgName(name);

  return (
    <Card data-settings-card="business-details">
      <CardHeader>
        <CardTitle>Business details</CardTitle>
        <CardDescription>
          Your business name, phone, address and email, as entered when you set up. Clients see them
          on invoices, email and the portal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <p className="text-sm text-destructive">
            We could not load your business details. Reload the page to try again.
          </p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk) m.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="business-name">Business name</Label>
              <Input
                id="business-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                autoComplete="organization"
                disabled={!canEdit || !q.data}
              />
              {name.trim().length > 0 && !nameOk && (
                <p className="text-xs text-destructive">
                  Enter your real business name (not blank or a placeholder like "Test").
                </p>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="business-phone">Business phone</Label>
                <Input
                  id="business-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={30}
                  autoComplete="tel"
                  disabled={!canEdit || !q.data}
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="business-email">Contact email</Label>
                <Input
                  id="business-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={255}
                  autoComplete="email"
                  disabled={!canEdit || !q.data}
                />
                <p className="text-xs text-muted-foreground">
                  Client replies to your email go here.
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="business-address">Business address</Label>
              <AddressAutocomplete
                id="business-address"
                value={address}
                onChangeText={setAddress}
                onResolved={(r) => setAddress(r.address.formatted)}
                placeholder="123 Main St, Austin, TX 78701"
                maxLength={300}
                disabled={!canEdit || !q.data}
              />
              <p className="text-xs text-muted-foreground">
                Where your trucks start the day, unless a tech has a start address of their own.
              </p>
            </div>
            {canEdit && (
              <Button type="submit" disabled={!q.data || !nameOk || m.isPending}>
                {m.isPending ? "Saving…" : "Save business details"}
              </Button>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

type Facility = { id: string; name: string; address: string | null; active: boolean | null };

/** The dump sites, where an owner looks for them. Edited on the Waste log. */
export function DumpSitesCard() {
  const listFn = useServerFn(listFacilities);
  const q = useQuery({ queryKey: ["waste-facilities"], queryFn: () => listFn() });
  const sites = ((q.data?.facilities ?? []) as Facility[]).filter((f) => f.active !== false);

  return (
    <Card data-settings-card="dump-sites">
      <CardHeader>
        <CardTitle>Dump sites</CardTitle>
        <CardDescription>
          Where routes end when a tech has no end point of their own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : q.isError ? (
          <p className="text-sm text-destructive">We could not load your dump sites.</p>
        ) : sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dump site yet.</p>
        ) : (
          <ul className="divide-y rounded-md border" data-dump-sites>
            {sites.map((f) => (
              <li key={f.id} className="min-w-0 p-3">
                <p className="text-sm font-medium break-words">
                  <bdi>{f.name}</bdi>
                </p>
                {f.address && (
                  <p className="text-sm text-muted-foreground break-words">
                    <bdi>{f.address}</bdi>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <Button asChild variant="outline">
          <Link to="/waste-log">{sites.length ? "Manage dump sites" : "Add a dump site"}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
