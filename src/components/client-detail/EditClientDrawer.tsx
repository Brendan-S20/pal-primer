// Edit Client drawer (small): contact, status, type, tags, preferred
// contact channel, referral source, communication preferences. Billing
// addresses live in Stripe and are intentionally absent.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateClient } from "@/lib/clients.functions";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";

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

  const initial = useMemo(
    () => ({
      displayName: client?.display_name ?? "",
      primaryPhone: client?.primary_phone ?? "",
      primaryEmail: client?.primary_email ?? "",
      accountType: (client?.account_type ?? "residential") as "residential" | "commercial",
      active: client?.active !== false,
      tags: ((client?.tags ?? []) as string[]).join(", "),
      preferredContact: (client?.preferred_contact ?? "") as "" | "sms" | "email" | "phone",
      referralSource: client?.referral_source ?? "",
      smsOptOut: !!client?.sms_opt_out,
      emailOptOut: !!client?.email_opt_out,
    }),
    [client],
  );
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          clientId,
          displayName: form.displayName.trim() || undefined,
          primaryPhone: form.primaryPhone,
          primaryEmail: form.primaryEmail as string,
          accountType: form.accountType,
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
        <div>
          <Label htmlFor="ec-name">Name</Label>
          <Input
            id="ec-name"
            value={form.displayName}
            onChange={(e) => set("displayName", e.target.value)}
            required
          />
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
              onChange={(e) => set("preferredContact", e.target.value as typeof form.preferredContact)}
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
        <fieldset className="rounded-md border bg-muted/20 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Communication preferences
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!form.smsOptOut}
              onChange={(e) => set("smsOptOut", !e.target.checked)}
            />
            <span>Send SMS notifications</span>
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!form.emailOptOut}
              onChange={(e) => set("emailOptOut", !e.target.checked)}
            />
            <span>Send email notifications</span>
          </label>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Billing addresses are managed by Stripe and don't need to be entered here.
        </p>
        <DrawerFooter onCancel={onClose}>
          <Button type="submit" disabled={saveMut.isPending || !dirty}>
            {saveMut.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}
