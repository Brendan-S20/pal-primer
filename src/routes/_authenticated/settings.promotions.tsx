import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  listPromoCodes,
  upsertPromoCode,
  deletePromoCode,
  listGiftCards,
  createGiftCard,
  voidGiftCard,
  redeemGiftCard,
} from "@/lib/promotions.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Ban, Copy } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/promotions")({
  component: PromotionsPage,
});

function fmtMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function PromotionsPage() {
  const [tab, setTab] = useState<"promos" | "gifts">("promos");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Promotions & gift cards</h2>
        <p className="text-sm text-muted-foreground">
          Create discount codes and sell gift cards that customers can redeem toward invoices.
        </p>
      </div>

      <div className="inline-flex rounded-md border p-0.5">
        <button
          onClick={() => setTab("promos")}
          className={`rounded px-3 py-1 text-sm ${tab === "promos" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
        >
          Promo codes
        </button>
        <button
          onClick={() => setTab("gifts")}
          className={`rounded px-3 py-1 text-sm ${tab === "gifts" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
        >
          Gift cards
        </button>
      </div>

      {tab === "promos" ? <PromoSection /> : <GiftSection />}
    </div>
  );
}

function PromoSection() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPromoCodes);
  const saveFn = useServerFn(upsertPromoCode);
  const delFn = useServerFn(deletePromoCode);
  const { data, isLoading } = useQuery({ queryKey: ["promo-codes"], queryFn: () => listFn() });

  const empty = {
    code: "",
    description: "",
    discountType: "percent" as "percent" | "fixed",
    discountPercent: 10,
    discountValueCents: 0,
    appliesTo: "first_visit" as "first_visit" | "recurring" | "one_time",
    recurringCycles: 3,
    maxRedemptions: undefined as number | undefined,
    expiresAt: "",
    active: true,
  };
  const [form, setForm] = useState(empty);

  const save = useMutation({
    mutationFn: (v: typeof empty) =>
      saveFn({
        data: {
          code: v.code,
          description: v.description || undefined,
          discountType: v.discountType,
          discountValueCents: v.discountType === "fixed" ? Math.round(v.discountValueCents) : undefined,
          discountPercent: v.discountType === "percent" ? v.discountPercent : undefined,
          appliesTo: v.appliesTo,
          recurringCycles: v.appliesTo === "recurring" ? v.recurringCycles : undefined,
          maxRedemptions: v.maxRedemptions,
          expiresAt: v.expiresAt || undefined,
          active: v.active,
        },
      }),
    onSuccess: () => {
      toast.success("Promo saved");
      setForm(empty);
      qc.invalidateQueries({ queryKey: ["promo-codes"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["promo-codes"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">New promo code</h3>
        <div className="grid gap-3">
          <div>
            <Label>Code</Label>
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="WELCOME10"
            />
          </div>
          <div>
            <Label>Description</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="10% off first visit"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Discount type</Label>
              <Select
                value={form.discountType}
                onValueChange={(v: any) => setForm({ ...form, discountType: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Percent</SelectItem>
                  <SelectItem value="fixed">Fixed amount</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.discountType === "percent" ? (
              <div>
                <Label>Percent off</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.discountPercent}
                  onChange={(e) => setForm({ ...form, discountPercent: Number(e.target.value) })}
                />
              </div>
            ) : (
              <div>
                <Label>Amount ($)</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.discountValueCents / 100}
                  onChange={(e) =>
                    setForm({ ...form, discountValueCents: Math.round(Number(e.target.value) * 100) })
                  }
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Applies to</Label>
              <Select
                value={form.appliesTo}
                onValueChange={(v: any) => setForm({ ...form, appliesTo: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="first_visit">First visit</SelectItem>
                  <SelectItem value="recurring">Recurring (N cycles)</SelectItem>
                  <SelectItem value="one_time">One-time invoice</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.appliesTo === "recurring" && (
              <div>
                <Label>Cycles</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={form.recurringCycles}
                  onChange={(e) => setForm({ ...form, recurringCycles: Number(e.target.value) })}
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Max redemptions</Label>
              <Input
                type="number"
                min={1}
                value={form.maxRedemptions ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    maxRedemptions: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder="No cap"
              />
            </div>
            <div>
              <Label>Expires</Label>
              <Input
                type="date"
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              />
            </div>
          </div>
          <Button
            onClick={() => save.mutate(form)}
            disabled={!form.code || save.isPending}
          >
            {save.isPending ? "Saving…" : "Create promo"}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Existing promos</h3>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.promos.length ? (
          <p className="text-sm text-muted-foreground">No promo codes yet.</p>
        ) : (
          <ul className="divide-y">
            {data.promos.map((p: any) => (
              <li key={p.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-sm">{p.code}</code>
                    {!p.active && <Badge variant="outline">inactive</Badge>}
                    {p.expires_at && new Date(p.expires_at) < new Date() && (
                      <Badge variant="destructive">expired</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {p.discount_type === "percent"
                      ? `${p.discount_percent}% off`
                      : fmtMoney(p.discount_value_cents ?? 0) + " off"}
                    {" · "}
                    {p.applies_to === "recurring"
                      ? `${p.recurring_cycles ?? "∞"} cycles`
                      : p.applies_to.replace("_", " ")}
                    {" · "}
                    used {p.redemption_count}
                    {p.max_redemptions ? ` / ${p.max_redemptions}` : ""}
                  </div>
                  {p.description && (
                    <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm(`Delete promo ${p.code}?`)) del.mutate(p.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GiftSection() {
  const qc = useQueryClient();
  const listFn = useServerFn(listGiftCards);
  const createFn = useServerFn(createGiftCard);
  const voidFn = useServerFn(voidGiftCard);
  const redeemFn = useServerFn(redeemGiftCard);
  const { data, isLoading } = useQuery({ queryKey: ["gift-cards"], queryFn: () => listFn() });

  const emptyC = {
    amount: 50,
    recipientName: "",
    recipientEmail: "",
    purchaserName: "",
    message: "",
  };
  const [form, setForm] = useState(emptyC);
  const [redeem, setRedeem] = useState({ code: "", amount: 0 });

  const create = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          initialBalanceCents: Math.round(form.amount * 100),
          recipientName: form.recipientName || undefined,
          recipientEmail: form.recipientEmail || undefined,
          purchaserName: form.purchaserName || undefined,
          message: form.message || undefined,
        },
      }),
    onSuccess: (r) => {
      toast.success(`Gift card ${r.code} created`);
      setForm(emptyC);
      qc.invalidateQueries({ queryKey: ["gift-cards"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const voidM = useMutation({
    mutationFn: (id: string) => voidFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Gift card voided");
      qc.invalidateQueries({ queryKey: ["gift-cards"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const redeemM = useMutation({
    mutationFn: () =>
      redeemFn({ data: { code: redeem.code, amountCents: Math.round(redeem.amount * 100) } }),
    onSuccess: (r) => {
      toast.success(
        `Redeemed ${fmtMoney(r.redeemedCents)}. Remaining: ${fmtMoney(r.remainingCents)}`,
      );
      setRedeem({ code: "", amount: 0 });
      qc.invalidateQueries({ queryKey: ["gift-cards"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">Issue gift card</h3>
          <div className="grid gap-3">
            <div>
              <Label>Amount ($)</Label>
              <Input
                type="number"
                min={5}
                step="1"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Recipient name</Label>
                <Input
                  value={form.recipientName}
                  onChange={(e) => setForm({ ...form, recipientName: e.target.value })}
                />
              </div>
              <div>
                <Label>Recipient email</Label>
                <Input
                  type="email"
                  value={form.recipientEmail}
                  onChange={(e) => setForm({ ...form, recipientEmail: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Purchaser name</Label>
              <Input
                value={form.purchaserName}
                onChange={(e) => setForm({ ...form, purchaserName: e.target.value })}
              />
            </div>
            <div>
              <Label>Message</Label>
              <Input
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder="Happy birthday!"
              />
            </div>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create gift card"}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">Redeem manually</h3>
          <div className="grid gap-3">
            <div>
              <Label>Code</Label>
              <Input
                value={redeem.code}
                onChange={(e) => setRedeem({ ...redeem, code: e.target.value.toUpperCase() })}
                placeholder="GC-XXXX-XXXX-XXXX"
              />
            </div>
            <div>
              <Label>Amount ($)</Label>
              <Input
                type="number"
                min={0.01}
                step="0.01"
                value={redeem.amount || ""}
                onChange={(e) => setRedeem({ ...redeem, amount: Number(e.target.value) })}
              />
            </div>
            <Button
              variant="outline"
              onClick={() => redeemM.mutate()}
              disabled={!redeem.code || redeem.amount <= 0 || redeemM.isPending}
            >
              {redeemM.isPending ? "Redeeming…" : "Apply redemption"}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Gift cards</h3>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.cards.length ? (
          <p className="text-sm text-muted-foreground">No gift cards yet.</p>
        ) : (
          <ul className="divide-y">
            {data.cards.map((c: any) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-sm">{c.code}</code>
                    <button
                      title="Copy code"
                      onClick={() => {
                        navigator.clipboard.writeText(c.code);
                        toast.success("Copied");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                    {c.status !== "active" && (
                      <Badge variant={c.status === "depleted" ? "outline" : "destructive"}>
                        {c.status}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {c.status === "void" ? (
                      <>Voided — no longer redeemable ({fmtMoney(c.initial_balance_cents)} card)</>
                    ) : (
                      <>
                        {fmtMoney(c.remaining_balance_cents)} of{" "}
                        {fmtMoney(c.initial_balance_cents)} remaining
                      </>
                    )}
                    {c.recipient_name ? ` · for ${c.recipient_name}` : ""}
                  </div>
                </div>
                {c.status === "active" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (confirm(`Void gift card ${c.code}?`)) voidM.mutate(c.id);
                    }}
                    title="Void"
                  >
                    <Ban className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
