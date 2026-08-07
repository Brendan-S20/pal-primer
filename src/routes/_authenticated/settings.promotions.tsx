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
import { Trash2, Ban, Copy, Printer } from "lucide-react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { getMyOrg } from "@/lib/org.functions";
import { listClients } from "@/lib/clients.functions";

export const Route = createFileRoute("/_authenticated/settings/promotions")({
  component: PromotionsPage,
});

function fmtMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Print-ready gift card (punch list #20, v1): a clean physical voucher without
// a third-party print service. A Vistaprint/Canva integration remains a
// separately scoped follow-up.
function printGiftCard(card: any, orgName: string) {
  const w = window.open("", "_blank", "width=700,height=500");
  if (!w) {
    toast.error("Pop-up blocked. Allow pop-ups for this site to print");
    return;
  }
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const amount = fmtMoney(card.initial_balance_cents);
  const expires = card.expires_at
    ? `Expires ${new Date(card.expires_at).toLocaleDateString()}`
    : "";
  w.document.write(`<!doctype html><html><head><title>Gift card ${esc(card.code)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; margin: 0; min-height: 96vh;
         display: flex; align-items: center; justify-content: center; background: #fff; }
  .card { width: 5in; height: 3in; border: 1.5px solid #1f2937; border-radius: 14px;
          padding: 0.3in; display: flex; flex-direction: column; justify-content: space-between; }
  .org { font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: #374151; }
  .title { font-size: 26px; margin-top: 2px; }
  .amount { font-size: 34px; font-weight: bold; }
  .code { font-family: 'Courier New', monospace; font-size: 17px; letter-spacing: 0.12em;
          border: 1px dashed #6b7280; border-radius: 6px; padding: 6px 10px; display: inline-block; }
  .foot { font-size: 10.5px; color: #6b7280; }
  @media print { body { min-height: auto; } }
</style></head><body>
  <div class="card">
    <div>
      <div class="org">${esc(orgName)}</div>
      <div class="title">Gift Card</div>
    </div>
    <div class="amount">${esc(amount)}</div>
    <div>
      <div class="code">${esc(card.code)}</div>
      ${card.recipient_name ? `<div style="margin-top:6px;font-size:13px;">For ${esc(card.recipient_name)}</div>` : ""}
    </div>
    <div class="foot">Redeemable toward services. Present this code at checkout or share it with our office. ${esc(expires)}</div>
  </div>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`);
  w.document.close();
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
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listPromoCodes);
  const saveFn = useServerFn(upsertPromoCode);
  const delFn = useServerFn(deletePromoCode);
  const { data, isLoading } = useQuery({ queryKey: ["promo-codes"], queryFn: () => listFn() });

  // Percent codes work now (migration 20260807030000): redemption resolves the
  // percentage against the customer's per-visit plan price and credits the
  // result. Fixed stays the default because it is the one whose value the
  // office can state before the customer redeems it.
  //
  // "Recurring (N cycles)" is still gone, and stays gone. Redemption credits
  // the account once; a cycle count on a one-off credit was decoration. The
  // database still permits the value for legacy rows, and any that exist render
  // below with their label intact.
  const empty = {
    code: "",
    description: "",
    discountType: "fixed" as "fixed" | "percent",
    discountValueCents: 0,
    discountPercent: 10,
    appliesTo: "first_visit" as "first_visit" | "one_time",
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
          // Only the field the chosen type uses is sent. The server refuses a
          // percent code with no percent and a fixed code with no amount, so
          // sending both would just make one of them a lie on the row.
          ...(v.discountType === "percent"
            ? { discountPercent: v.discountPercent }
            : { discountValueCents: Math.round(v.discountValueCents) }),
          appliesTo: v.appliesTo,
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
      {dialog}
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
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Discount</Label>
              <Select
                value={form.discountType}
                onValueChange={(v: any) => setForm({ ...form, discountType: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed amount</SelectItem>
                  <SelectItem value="percent">Percentage</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              {form.discountType === "percent" ? (
                <>
                  <Label>Percent (%)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    step="0.5"
                    value={form.discountPercent}
                    onChange={(e) =>
                      setForm({ ...form, discountPercent: Number(e.target.value) })
                    }
                  />
                </>
              ) : (
                <>
                  <Label>Amount ($)</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.discountValueCents / 100}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        discountValueCents: Math.round(Number(e.target.value) * 100),
                      })
                    }
                  />
                </>
              )}
            </div>
            <div>
              <Label>What it's for</Label>
              <Select
                value={form.appliesTo}
                onValueChange={(v: any) => setForm({ ...form, appliesTo: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="first_visit">New customer</SelectItem>
                  <SelectItem value="one_time">One-off credit</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* The percentage line says what the percentage is OF, because that
              is the question the number does not answer on its own. */}
          <p className="text-xs text-muted-foreground">
            {form.discountType === "percent" ? (
              <>
                Redeeming takes {form.discountPercent || 0}% off one visit at the customer's own
                plan price and adds that as account credit, once. A customer with no active plan is
                told the code needs one — there is nothing to take a percentage of.
              </>
            ) : (
              <>
                Redeeming adds this amount to the customer's account credit, once, and it comes off
                their next invoice automatically.
              </>
            )}{" "}
            "What it's for" is your own label — it does not change what the code does.
          </p>
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
                    {/* Legacy rows only — the form has not offered "recurring"
                        since it was found to pay out once. Flagged here rather
                        than left to fail in the customer's hands. */}
                    {p.applies_to === "recurring" && (
                      <Badge variant="destructive">not redeemable</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {p.discount_type === "percent"
                      ? `${Number(p.discount_percent)}% off one visit`
                      : fmtMoney(p.discount_value_cents ?? 0) + " credit"}
                    {" · "}
                    {p.applies_to === "recurring" ? "recurring" : p.applies_to.replace("_", " ")}
                    {" · "}
                    used {p.redemption_count}
                    {p.max_redemptions ? ` / ${p.max_redemptions}` : ""}
                  </div>
                  {p.applies_to === "recurring" && (
                    <p className="mt-1 text-xs text-destructive">
                      Recurring codes are refused at redemption — one redemption posts one credit,
                      which is not a discount repeated every cycle. Replace it with a one-off code.
                    </p>
                  )}
                  {p.description && (
                    <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Delete promo ${p.code}?`,
                        destructive: true,
                        confirmLabel: "Delete promo",
                      })
                    )
                      del.mutate(p.id);
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
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listGiftCards);
  const createFn = useServerFn(createGiftCard);
  const voidFn = useServerFn(voidGiftCard);
  const redeemFn = useServerFn(redeemGiftCard);
  const orgFn = useServerFn(getMyOrg);
  const clientsFn = useServerFn(listClients);
  const { data, isLoading } = useQuery({ queryKey: ["gift-cards"], queryFn: () => listFn() });
  const orgQ = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn(), staleTime: 60_000 });
  const orgName: string = orgQ.data?.organization?.name ?? "Gift card";
  // Same picker data as the New-invoice dialog: a redemption credits a
  // specific client's account, so the form needs the client roster.
  const clientsQ = useQuery({
    queryKey: ["clients", "picker"],
    queryFn: () => clientsFn(),
    staleTime: 60_000,
  });
  const clientOptions: Array<{ id: string; display_name: string; active: boolean }> =
    (clientsQ.data as any)?.clients ?? [];

  const emptyC = {
    amount: 50,
    recipientName: "",
    recipientEmail: "",
    purchaserName: "",
    message: "",
  };
  const [form, setForm] = useState(emptyC);
  const [redeem, setRedeem] = useState({ code: "", amount: 0, clientId: "" });

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
      redeemFn({
        data: {
          code: redeem.code,
          amountCents: Math.round(redeem.amount * 100),
          clientId: redeem.clientId,
        },
      }),
    onSuccess: (r) => {
      const who =
        clientOptions.find((c) => c.id === redeem.clientId)?.display_name ?? "the client";
      toast.success(
        `Redeemed ${fmtMoney(r.redeemedCents)} to ${who}'s account credit. Remaining on card: ${fmtMoney(r.remainingCents)}`,
      );
      setRedeem({ code: "", amount: 0, clientId: "" });
      qc.invalidateQueries({ queryKey: ["gift-cards"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {dialog}
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
              <Label>Client</Label>
              <select
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={redeem.clientId}
                onChange={(e) => setRedeem({ ...redeem, clientId: e.target.value })}
              >
                <option value="">Select a client…</option>
                {clientOptions
                  .filter((c) => c.active !== false)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                    </option>
                  ))}
              </select>
              <p className="mt-1 text-2xs text-muted-foreground">
                The redeemed amount is added to this client's account credit.
              </p>
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
              disabled={!redeem.code || !redeem.clientId || redeem.amount <= 0 || redeemM.isPending}
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
                      <>Voided, no longer redeemable ({fmtMoney(c.initial_balance_cents)} card)</>
                    ) : (
                      <>
                        {fmtMoney(c.remaining_balance_cents)} of{" "}
                        {fmtMoney(c.initial_balance_cents)} remaining
                      </>
                    )}
                    {c.recipient_name ? ` · for ${c.recipient_name}` : ""}
                  </div>
                </div>
                <div className="flex items-center">
                  {c.status === "active" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => printGiftCard(c, orgName)}
                      title="Print gift card"
                    >
                      <Printer className="h-4 w-4" />
                    </Button>
                  )}
                  {c.status === "active" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Void gift card ${c.code}?`,
                            description: "A voided card can no longer be redeemed.",
                            destructive: true,
                            confirmLabel: "Void gift card",
                          })
                        )
                          voidM.mutate(c.id);
                      }}
                      title="Void"
                    >
                      <Ban className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
