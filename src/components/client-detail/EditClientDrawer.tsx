// Edit Client drawer (small): contact, status, type, tags, preferred
// contact channel, referral source, communication preferences. Billing
// addresses live in Stripe and are intentionally absent.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateClient } from "@/lib/clients.functions";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { useCommercialAccounts, useServiceLines } from "@/components/CommercialOnly";
import { runsPetSitting } from "@/lib/pets";
import { centsToDollarInput, parseDollarsToCents } from "@/lib/services";
import { useClientTexting } from "@/hooks/useClientTexting";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";
import { clientNameFormDefaults } from "@/lib/client-name";

export function EditClientDrawer({
  open,
  onClose,
  client,
  clientId,
}: {
  open: boolean;
  onClose: () => void;
  client: any;
  clientId: string;
}) {
  const qc = useQueryClient();
  const updateFn = useServerFn(updateClient);

  const initial = useMemo(() => {
    const name = clientNameFormDefaults(client);
    return {
      firstName: name.firstName,
      lastName: name.lastName,
      company: name.company,
      primaryPhone: client?.primary_phone ?? "",
      primaryEmail: client?.primary_email ?? "",
      accountType: (client?.account_type ?? "residential") as "residential" | "commercial",
      active: client?.active !== false,
      tags: ((client?.tags ?? []) as string[]).join(", "),
      preferredContact: (client?.preferred_contact ?? "") as "" | "sms" | "email" | "phone",
      referralSource: client?.referral_source ?? "",
      smsOptOut: !!client?.sms_opt_out,
      emailOptOut: !!client?.email_opt_out,
      billingFrequency: (client?.billing_frequency ?? "monthly") as
        "after_each_visit" | "weekly" | "monthly" | "quarterly" | "yearly",
      taxExempt: !!client?.tax_exempt,
      emergencyName: (client?.emergency_contact_name ?? "") as string,
      emergencyPhone: (client?.emergency_contact_phone ?? "") as string,
      emergencyMayApproveVet: !!client?.emergency_contact_may_approve_vet,
      vetLimit:
        client?.vet_treatment_limit_cents != null
          ? centsToDollarInput(client.vet_treatment_limit_cents)
          : "",
    };
  }, [client]);
  const [form, setForm] = useState(initial);
  // The client's texting preference is kept and saved exactly as stored; it
  // just cannot be switched while the business cannot text anyone.
  const texting = useClientTexting();
  const wasOpen = useRef(false);
  const seededClientId = useRef<string | null>(null);
  const edited = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      seededClientId.current = null;
      edited.current = false;
      return;
    }

    const loadedClientId = client?.id ?? null;
    const shouldSeed =
      !wasOpen.current ||
      (!!loadedClientId && seededClientId.current !== loadedClientId && !edited.current);

    if (shouldSeed) {
      setForm(initial);
      seededClientId.current = loadedClientId;
      edited.current = false;
    }

    wasOpen.current = open;
  }, [open, initial, client?.id]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const { enabled: commercialEnabled } = useCommercialAccounts();
  // Pet sitting (#411): who the sitter calls and what they may spend at the
  // vet. Shown to a sitting business, or when something is already saved.
  const { lines, known: linesKnown } = useServiceLines();
  const emergency =
    (linesKnown && runsPetSitting(lines)) ||
    !!(initial.emergencyName || initial.emergencyPhone || initial.vetLimit);
  const vetLimitCents = form.vetLimit.trim() ? parseDollarsToCents(form.vetLimit) : null;
  const vetLimitInvalid =
    vetLimitCents != null && (Number.isNaN(vetLimitCents) || vetLimitCents > 10_000_000);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    edited.current = true;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const saveMut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          clientId,
          firstName: form.firstName.trim() || null,
          lastName: form.lastName.trim() || null,
          company: form.company.trim() || null,
          primaryPhone: form.primaryPhone,
          primaryEmail: form.primaryEmail as string,
          // Omitted, not defaulted, when the picker is hidden.
          //
          // `form.accountType` initialises to `client?.account_type ??
          // "residential"`. If the input is hidden for a residential-only org
          // but the field keeps riding along in the payload, then saving any
          // unrelated edit to an existing COMMERCIAL client rewrites it to
          // residential — while its subscription keeps account_type
          // 'commercial' and a unit_count, so the two disagree and the
          // services tab starts rendering "Dogs: —". The server writes this
          // column unconditionally when present, so the only safe hiding is
          // not sending it.
          ...(commercialEnabled ? { accountType: form.accountType } : {}),
          active: form.active,
          tags: form.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 30),
          preferredContact: form.preferredContact === "" ? null : form.preferredContact,
          referralSource: form.referralSource || null,
          smsOptOut: form.smsOptOut,
          emailOptOut: form.emailOptOut,
          billingFrequency: form.billingFrequency,
          // Sent only when changed: it takes the billing permission, and an
          // unrelated edit should not need it on its account.
          ...(form.taxExempt !== initial.taxExempt ? { taxExempt: form.taxExempt } : {}),
          // Each sent only when changed, so an unrelated edit logs nothing here.
          ...(form.emergencyName !== initial.emergencyName
            ? { emergencyContactName: form.emergencyName.trim() || null }
            : {}),
          ...(form.emergencyPhone !== initial.emergencyPhone
            ? { emergencyContactPhone: form.emergencyPhone.trim() || null }
            : {}),
          ...(form.emergencyMayApproveVet !== initial.emergencyMayApproveVet
            ? { emergencyContactMayApproveVet: form.emergencyMayApproveVet }
            : {}),
          ...(form.vetLimit !== initial.vetLimit ? { vetTreatmentLimitCents: vetLimitCents } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Client saved");
      qc.invalidateQueries({ queryKey: ["client", clientId] });
      qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <EditDrawer open={open} onClose={onClose} title="Edit client" size="sm" dirty={dirty}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          saveMut.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ec-first">First name</Label>
            <Input
              id="ec-first"
              value={form.firstName}
              onChange={(e) => set("firstName", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ec-last">Last name</Label>
            <Input
              id="ec-last"
              value={form.lastName}
              onChange={(e) => set("lastName", e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="ec-company">Company (optional)</Label>
          <Input
            id="ec-company"
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
            placeholder="Shown when there is no person name"
          />
          <p className="mt-1 text-xs text-foreground/60">
            Displays as:{" "}
            <span className="font-medium text-foreground">
              {[form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(" ") ||
                form.company.trim() ||
                client?.display_name}
            </span>
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ec-phone">Phone</Label>
            <Input
              id="ec-phone"
              type="tel"
              value={form.primaryPhone}
              onChange={(e) => set("primaryPhone", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ec-email">Email</Label>
            <Input
              id="ec-email"
              type="email"
              value={form.primaryEmail}
              onChange={(e) => set("primaryEmail", e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {commercialEnabled && (
            <div>
              <Label htmlFor="ec-type">Client type</Label>
              <select
                id="ec-type"
                value={form.accountType}
                onChange={(e) => set("accountType", e.target.value as "residential" | "commercial")}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="residential">Residential</option>
                <option value="commercial">Commercial / HOA</option>
              </select>
            </div>
          )}
          <div>
            <Label htmlFor="ec-status">Status</Label>
            <select
              id="ec-status"
              value={form.active ? "active" : "inactive"}
              onChange={(e) => set("active", e.target.value === "active")}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
        <div>
          <Label htmlFor="ec-tags">Tags</Label>
          <Input
            id="ec-tags"
            value={form.tags}
            onChange={(e) => set("tags", e.target.value)}
            placeholder="VIP, gate code changes, senior discount"
          />
          <p className="mt-1 text-xs text-muted-foreground">Separate tags with commas.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ec-pref">Preferred contact</Label>
            <select
              id="ec-pref"
              value={form.preferredContact}
              onChange={(e) =>
                set("preferredContact", e.target.value as typeof form.preferredContact)
              }
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">No preference</option>
              <option value="sms">Text message</option>
              <option value="email">Email</option>
              <option value="phone">Phone call</option>
            </select>
          </div>
          <div>
            <Label htmlFor="ec-ref">Referral source</Label>
            <Input
              id="ec-ref"
              value={form.referralSource}
              onChange={(e) => set("referralSource", e.target.value)}
              placeholder="Google, neighbor, truck wrap"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="ec-billfreq">Billing cadence</Label>
          <select
            id="ec-billfreq"
            value={form.billingFrequency}
            onChange={(e) =>
              set("billingFrequency", e.target.value as typeof form.billingFrequency)
            }
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="after_each_visit">After each visit</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Invoice a visit when it is done, from the visit. Completed visits not yet invoiced are
            billed at the end of each cycle, then sent after your grace period in{" "}
            <Link to="/settings/invoicing" className="text-primary underline">
              Settings &gt; Invoicing
            </Link>
            .
          </p>
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm touch:min-h-11">
            <input
              type="checkbox"
              checked={form.taxExempt}
              onChange={(e) => set("taxExempt", e.target.checked)}
            />
            <span>Tax-exempt: no sales tax on this client's invoices</span>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Only matters if you charge sales tax in{" "}
            <Link to="/settings/invoicing" className="text-primary underline">
              Settings &gt; Invoicing
            </Link>
            . Applies to invoices made after you save; ones already issued keep their tax.
          </p>
        </div>
        {emergency && (
          <fieldset className="min-w-0 space-y-3 rounded-md border bg-muted/20 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Emergency contact and vet care
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <Label htmlFor="ec-emergency-name">Emergency contact</Label>
                <Input
                  id="ec-emergency-name"
                  value={form.emergencyName}
                  maxLength={200}
                  onChange={(e) => set("emergencyName", e.target.value)}
                  placeholder="Who to call if the client can't be reached"
                />
              </div>
              <div className="min-w-0">
                <Label htmlFor="ec-emergency-phone">Their phone</Label>
                <Input
                  id="ec-emergency-phone"
                  type="tel"
                  value={form.emergencyPhone}
                  maxLength={40}
                  onChange={(e) => set("emergencyPhone", e.target.value)}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm touch:min-h-11">
              <input
                type="checkbox"
                checked={form.emergencyMayApproveVet}
                onChange={(e) => set("emergencyMayApproveVet", e.target.checked)}
              />
              <span>They may approve vet care</span>
            </label>
            <div className="min-w-0">
              <Label htmlFor="ec-vet-limit">Vet treatment limit ($)</Label>
              <Input
                id="ec-vet-limit"
                className="sm:w-48"
                inputMode="decimal"
                placeholder="0.00"
                value={form.vetLimit}
                onChange={(e) => set("vetLimit", e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                What a sitter may spend on treatment without asking. Each pet's vet is on the
                Properties tab.
              </p>
              {vetLimitInvalid && (
                <p className="mt-1 text-xs text-destructive">
                  Enter an amount in dollars and cents.
                </p>
              )}
            </div>
          </fieldset>
        )}
        <fieldset className="rounded-md border bg-muted/20 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Communication preferences
          </legend>
          <label className="flex flex-wrap items-center gap-2 text-sm touch:min-h-11">
            <input
              type="checkbox"
              checked={texting ? !form.smsOptOut : false}
              disabled={!texting}
              onChange={(e) => set("smsOptOut", !e.target.checked)}
            />
            <span className={texting ? "" : "text-muted-foreground"}>Send text notifications</span>
            {!texting && <ComingSoonBadge />}
          </label>
          {!texting && (
            <p className="ml-6 text-xs text-muted-foreground">
              Texting your clients is coming soon. Until then, notifications go by email.
            </p>
          )}
          {texting && !form.smsOptOut && !form.primaryPhone.trim() && (
            <p className="ml-6 text-xs text-amber-700 dark:text-amber-400">
              SMS is on but there's no phone number on file. Add one above or texts won't send.
            </p>
          )}
          <label className="mt-1 flex items-center gap-2 text-sm touch:min-h-11">
            <input
              type="checkbox"
              checked={!form.emailOptOut}
              onChange={(e) => set("emailOptOut", !e.target.checked)}
            />
            <span>Send email notifications</span>
          </label>
          {!form.emailOptOut && !form.primaryEmail.trim() && (
            <p className="ml-6 text-xs text-amber-700 dark:text-amber-400">
              Email is on but there's no email address on file. Add one above or emails won't send.
            </p>
          )}
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Billing addresses are managed by Stripe and don't need to be entered here.
        </p>
        <DrawerFooter>
          <Button type="submit" disabled={saveMut.isPending || !dirty || vetLimitInvalid}>
            {saveMut.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}
