// The two cards that make the customer's portal look like the business's.
//
// ── WHY THEY ARE NOT IN PREFERENCES ANY MORE ─────────────────────────────
//
// They were, along with Language, Time zone, Field tech app, Menus and top
// bar, Commercial accounts and Demo data -- eight cards on one page, 3,961px
// tall on a phone, under a heading that describes about half of them.
//
// The owner's own rule, given about Profile: a control that is a preference
// belongs under Preferences. The inverse is the same rule, and these two are
// the clearest case of it. A portal sign-in address and a customer-facing
// brand colour are not preferences; they are what a CUSTOMER sees, which is
// what the Client-facing group in the settings nav is for.
//
// Moved rather than duplicated: there is one place to change a brand colour.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { useMyRole } from "@/hooks/useMyRole";
import { isValidOrgName } from "@/lib/dna-linkage";
import { linkOrigin } from "@/lib/app-origin";
import {
  getOrgBranding,
  updateOrgBranding,
  getMyOrg,
  setPortalSlug,
  suggestPortalSlug,
} from "@/lib/org.functions";

export function PortalAddressCard() {
  const qc = useQueryClient();
  const orgFn = useServerFn(getMyOrg);
  const setFn = useServerFn(setPortalSlug);
  const suggestFn = useServerFn(suggestPortalSlug);
  const { role } = useMyRole();
  const canEdit = role === "owner" || role === "office_manager";

  const q = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn(), staleTime: 60_000 });
  const currentSlug = (q.data?.organization as any)?.portal_slug as string | undefined;
  const [slug, setSlug] = useState("");
  useEffect(() => {
    if (currentSlug) setSlug(currentSlug);
  }, [currentSlug]);

  const mut = useMutation({
    mutationFn: () => setFn({ data: { slug } }),
    onSuccess: (r) => {
      setSlug(r.slug);
      toast.success("Portal address saved");
      qc.invalidateQueries({ queryKey: ["my-org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const suggestMut = useMutation({
    mutationFn: () => suggestFn(),
    onSuccess: (r) => setSlug(r.slug),
  });

  if (!canEdit) return null;
  // THE ONE THE OWNER SAW. This card shows the company's permanent portal
  // address, to be put on a website and read to customers — and it rendered
  // `capacitor://localhost/portal/` in the iOS app.
  //
  // The ternary is backwards for the native build in exactly the way
  // onboarding.tsx was: it prefers the page origin whenever a browser exists,
  // and inside the binary a browser DOES exist with an origin no customer can
  // open. The fallback was already the right answer for every platform.
  const base = linkOrigin();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portal sign-in address</CardTitle>
        <CardDescription>
          Your company's permanent portal link. Put it on your website so clients can sign in
          anytime. They'll enter their phone or email and get a one-time code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <span className="text-muted-foreground">{base.replace(/^https?:\/\//, "")}/portal/</span>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            className="h-8 w-48"
            placeholder="your-company"
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={mut.isPending || !slug || slug === currentSlug}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Saving…" : "Save address"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={suggestMut.isPending}
            onClick={() => suggestMut.mutate()}
          >
            Suggest from name
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Letters, numbers, and hyphens only. Existing client links keep working automatically.
        </p>
      </CardContent>
    </Card>
  );
}

export function BrandingCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getOrgBranding);
  const setFn = useServerFn(updateOrgBranding);
  const q = useQuery({ queryKey: ["org-branding"], queryFn: () => getFn() });
  const { role } = useMyRole();
  const canEdit = role === "owner" || role === "office_manager";

  const [orgName, setOrgName] = useState("");
  const [brandColor, setBrandColor] = useState("#16a34a");
  const [logoUrl, setLogoUrl] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactAddress, setContactAddress] = useState("");
  const [cutoff, setCutoff] = useState(18);
  const [allowResched, setAllowResched] = useState(true);
  const [allowHold, setAllowHold] = useState(true);
  const [allowFreq, setAllowFreq] = useState(true);
  const [autoApply, setAutoApply] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setOrgName(q.data.name ?? "");
    setBrandColor(q.data.brand_color ?? "#16a34a");
    setLogoUrl(q.data.logo_url ?? "");
    setContactPhone(q.data.contact_phone ?? "");
    setContactEmail(q.data.contact_email ?? "");
    setContactAddress(q.data.contact_address ?? "");
    setCutoff(q.data.portal_reschedule_cutoff_hours ?? 18);
    setAllowResched(q.data.portal_allow_self_reschedule);
    setAllowHold(q.data.portal_allow_vacation_hold);
    setAllowFreq(q.data.portal_allow_frequency_change);
    setAutoApply(q.data.portal_auto_apply_changes);
  }, [q.data]);

  const mut = useMutation({
    mutationFn: () =>
      setFn({
        data: {
          name: orgName.trim(),
          brandColor: brandColor || null,
          logoUrl: logoUrl.trim() || null,
          contactPhone: contactPhone.trim() || null,
          contactEmail: contactEmail.trim() || null,
          contactAddress: contactAddress.trim() || null,
          portalRescheduleCutoffHours: cutoff,
          portalAllowSelfReschedule: allowResched,
          portalAllowVacationHold: allowHold,
          portalAllowFrequencyChange: allowFreq,
          portalAutoApplyChanges: autoApply,
        },
      }),
    onSuccess: () => {
      toast.success("Business details saved");
      qc.invalidateQueries({ queryKey: ["org-branding"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client portal branding & policy</CardTitle>
        <CardDescription>
          What your clients see on their portal: colors, logo, contact info, and what they can
          change themselves.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The business name, editable at last. It could previously only be set
            at signup, and only on the /get-started path: every other route into
            an organization derived one and left it. It is printed on invoices,
            the portal and outbound email, so a typo here used to need support.
            Full width and first because it is the one field a customer is
            certain to read. */}
        <div>
          <Label className="text-xs">Business name</Label>
          <Input
            className="mt-1"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Acme Pet Waste Removal"
          />
          {orgName.trim().length > 0 && !isValidOrgName(orgName) && (
            <p className="pt-1 text-xs text-destructive">
              Enter your real business name (not blank or a placeholder like "Test").
            </p>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Brand color</Label>
            <div className="mt-1 flex gap-2">
              <Input
                type="color"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                className="h-10 w-14 p-1"
              />
              <Input
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                placeholder="#16a34a"
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Logo URL</Label>
            <Input
              className="mt-1"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://…/logo.png"
            />
          </div>
          <div>
            <Label className="text-xs">Office phone (tap-to-call in the portal)</Label>
            <Input
              className="mt-1"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+1 555 123 4567"
            />
          </div>
          <div>
            <Label className="text-xs">Office email</Label>
            <Input
              className="mt-1"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="hello@your-company.com"
            />
            {/* BUILD-5: this is the reply-to on every email your customers get.
                Without it their replies go to a noreply address nobody reads —
                and they get no bounce, so they believe they reached you. Said
                here rather than left as a blank optional field, because the
                cost of leaving it empty is invisible from this screen. */}
            {contactEmail.trim() ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Replies to invoices and reminders come back to this address.
              </p>
            ) : (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Add one. Invoices and reminders are sent from a no-reply address, so any client who
                hits Reply today is writing to nobody.
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs">Business address</Label>
            {/* Autocomplete over ONE free-text line, which is a deliberate
                pair of decisions.
                  Autocomplete, because the claim in the note below that
                nothing geocodes this stopped being true: org.functions.ts
                geocodes it on save, and staff_start_point falls back to the
                business location when a technician has no start address of
                their own (migration 20260815180000). A matched address is a
                pin the planner can trust; a hand-typed one is whatever
                Nominatim makes of it.
                  Still one line, because a PO box is a legitimate value here
                and the provider only matches street_address/premise — that
                tenant types their box number and saves it exactly as today.
                Splitting into street/city/state would lock them out for a
                field that is mostly printed in an email footer. */}
            <AddressAutocomplete
              className="mt-1"
              value={contactAddress}
              onChangeText={setContactAddress}
              onResolved={(r) => setContactAddress(r.address.formatted.slice(0, 300))}
              placeholder="123 Main St, Springfield, IL 62704"
              maxLength={300}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {contactAddress.trim()
                ? "Shown in the footer of emails to your clients."
                : "Optional, but it goes in the footer of your client emails, and a service company with an address on it reads as a real local business."}
            </p>
          </div>
          <div>
            <Label className="text-xs">Change cutoff (hours before visit)</Label>
            <Input
              className="mt-1"
              type="number"
              min={0}
              max={168}
              value={cutoff}
              onChange={(e) => setCutoff(Math.max(0, Number(e.target.value) || 0))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Below this window clients can no longer self-serve reschedule or skip.
            </p>
          </div>
        </div>

        <div className="border-t pt-4 space-y-3">
          <p className="text-sm font-medium">Self-serve permissions</p>
          <div className="flex items-center justify-between">
            <div className="text-sm">Allow clients to reschedule visits</div>
            <Switch checked={allowResched} onCheckedChange={setAllowResched} />
          </div>
          <div className="flex items-center justify-between">
            <div className="text-sm">Allow clients to request vacation holds</div>
            <Switch checked={allowHold} onCheckedChange={setAllowHold} />
          </div>
          <div className="flex items-center justify-between">
            <div className="text-sm">Allow clients to change plan frequency</div>
            <Switch checked={allowFreq} onCheckedChange={setAllowFreq} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">Auto-apply requested changes</div>
              <div className="text-xs text-muted-foreground">
                Off (default): the office reviews every change. On: changes take effect immediately.
              </div>
            </div>
            <Switch checked={autoApply} onCheckedChange={setAutoApply} />
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !isValidOrgName(orgName)}>
            {mut.isPending ? "Saving…" : "Save portal settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
