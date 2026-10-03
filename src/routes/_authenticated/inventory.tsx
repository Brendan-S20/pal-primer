import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listItems,
  listAssignments,
  listRecentMovements,
  upsertItem,
  recordMovement,
} from "@/lib/inventory.functions";
import { listStaff } from "@/lib/inventory.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useRowSelection } from "@/hooks/useRowSelection";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, Package, Plus } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/inventory")({
  head: () => titleHead("Inventory"),
  component: InventoryPage,
});

type Item = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  unit_cost_cents: number;
  reorder_threshold: number;
  on_hand: number;
  category: string | null;
  active: boolean;
  notes: string | null;
};

function fmtMoney(c: number) {
  return `$${((c ?? 0) / 100).toFixed(2)}`;
}

// Unit-counted items ("10 each") shouldn't render decimals; measured units
// (2.5 gallon) keep them. Show a whole number when the value is whole, else
// trim to at most two decimals (D polish).
function fmtQty(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(2)));
}

function InventoryPage() {
  const itemsFn = useServerFn(listItems);
  const assignsFn = useServerFn(listAssignments);
  const movesFn = useServerFn(listRecentMovements);
  const staffFn = useServerFn(listStaff);
  const saveFn = useServerFn(upsertItem);
  const qc = useQueryClient();
  const { confirm, dialog: bulkDialog } = useConfirmDialog();

  const items = useQuery({ queryKey: ["inv-items"], queryFn: () => itemsFn() });
  const assigns = useQuery({ queryKey: ["inv-assigns"], queryFn: () => assignsFn() });
  const moves = useQuery({ queryKey: ["inv-moves"], queryFn: () => movesFn() });
  const staff = useQuery({ queryKey: ["staff-list"], queryFn: () => staffFn() });

  const lowStock = useMemo(
    () => (items.data ?? []).filter((i) => Number(i.on_hand) <= Number(i.reorder_threshold) && i.active),
    [items.data],
  );

  // Multi-select on the Items tab (Invoices-page pattern). Bulk archive loops
  // the existing upsertItem fn with active:false — there is no delete server
  // fn for inventory items, so bulk delete is intentionally not offered.
  const activeItems = useMemo(
    () => ((items.data ?? []) as Item[]).filter((i) => i.active),
    [items.data],
  );
  const activeItemIds = useMemo(() => activeItems.map((i) => i.id), [activeItems]);
  const sel = useRowSelection(activeItemIds);

  const bulkArchiveM = useMutation({
    mutationFn: async (ids: string[]) => {
      const byId = new Map(((items.data ?? []) as Item[]).map((i) => [i.id, i]));
      const results = await Promise.allSettled(
        ids.map((id) => {
          const i = byId.get(id);
          if (!i) return Promise.reject(new Error("Item not found"));
          return saveFn({
            data: {
              id: i.id,
              name: i.name,
              sku: i.sku,
              unit: i.unit,
              unit_cost_cents: Number(i.unit_cost_cents ?? 0),
              reorder_threshold: Number(i.reorder_threshold ?? 0),
              category: i.category,
              notes: i.notes,
              active: false,
            },
          });
        }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Archived ${r.ok} of ${r.ok + r.failed} items, ${r.failed} failed`);
      else toast.success(`Archived ${r.ok} item${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["inv-items"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Archived items were unrecoverable (QA finding): per-row Restore reuses
  // the same upsertItem fn with active:true.
  const restoreM = useMutation({
    mutationFn: (i: Item) =>
      saveFn({
        data: {
          id: i.id,
          name: i.name,
          sku: i.sku,
          unit: i.unit,
          unit_cost_cents: Number(i.unit_cost_cents ?? 0),
          reorder_threshold: Number(i.reorder_threshold ?? 0),
          category: i.category,
          notes: i.notes,
          active: true,
        },
      }),
    onSuccess: () => {
      toast.success("Item restored");
      qc.invalidateQueries({ queryKey: ["inv-items"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      {bulkDialog}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Package className="h-6 w-6 shrink-0"/> Inventory</h1>
          <p className="text-sm text-muted-foreground">Track supplies, per-tech assignments, and consumption.</p>
        </div>
        <ItemDialog />
      </div>

      {lowStock.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {lowStock.length} item{lowStock.length === 1 ? "" : "s"} at or below reorder threshold
          </div>
          <ul className="mt-2 text-xs text-muted-foreground">
            {lowStock.slice(0, 5).map((i) => (
              <li key={i.id}>• {i.name}: {i.on_hand} {i.unit} on hand (threshold {i.reorder_threshold})</li>
            ))}
          </ul>
        </div>
      )}

      <Tabs defaultValue="items">
        <TabsList>
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="assignments">Assigned to techs</TabsTrigger>
          <TabsTrigger value="movements">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="items" className="mt-4 space-y-3">
          {/* Bulk action bar */}
          {sel.count > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
              <span className="font-medium">{sel.count} selected</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkArchiveM.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Archive ${sel.count} item${sel.count === 1 ? "" : "s"}?`,
                        description:
                          "Archived items are marked inactive and drop out of low-stock alerts and assignment pickers. Their movement history is kept.",
                        confirmLabel: "Archive items",
                      })
                    )
                      bulkArchiveM.mutate(sel.selectedIds);
                  }}
                >
                  {bulkArchiveM.isPending ? "Archiving…" : "Archive"}
                </Button>
                <Button size="sm" variant="ghost" onClick={sel.clear}>
                  Clear
                </Button>
              </div>
            </div>
          )}
          {/* Seven and six columns of stock figures. The card scrolls, not the
              page — the third table here is narrow enough that its scroller
              never engages, and it carries the class anyway so all three
              behave the same when a column is added. */}
          <div className="relative overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm min-w-[630px]">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2">
                    <Checkbox
                      checked={sel.allSelected}
                      onCheckedChange={sel.toggleAll}
                      aria-label="Select all active items"
                    />
                  </th>
                  <th className="px-4 py-2">Item</th>
                  <th className="px-4 py-2">SKU</th>
                  <th className="px-4 py-2">On hand</th>
                  <th className="px-4 py-2">Reorder at</th>
                  <th className="px-4 py-2">Unit cost</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.isLoading ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
                ) : (items.data ?? []).length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">No items yet. Add one to get started.</td></tr>
                ) : (
                  (items.data as Item[]).map((i) => {
                    const low = Number(i.on_hand) <= Number(i.reorder_threshold);
                    return (
                      <tr key={i.id} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          {i.active && (
                            <Checkbox
                              checked={sel.isSelected(i.id)}
                              onCheckedChange={(v) => sel.toggle(i.id, v === true)}
                              aria-label={`Select ${i.name}`}
                            />
                          )}
                        </td>
                        <td className="px-4 py-2 font-medium">
                          {i.name}
                          {!i.active && <Badge variant="secondary" className="ml-2">inactive</Badge>}
                          {i.category && <span className="ml-2 text-xs text-muted-foreground">{i.category}</span>}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{i.sku ?? "-"}</td>
                        <td className={`px-4 py-2 ${low ? "text-amber-600 font-medium" : ""}`}>
                          {fmtQty(i.on_hand)} {i.unit}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{fmtQty(i.reorder_threshold)}</td>
                        <td className="px-4 py-2">{fmtMoney(i.unit_cost_cents)}</td>
                        <td className="px-4 py-2 text-right">
                          {i.active ? (
                            <MovementDialog item={i} staffList={staff.data ?? []} />
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={restoreM.isPending}
                              onClick={() => restoreM.mutate(i)}
                            >
                              Restore
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="assignments" className="mt-4">
          <div className="mb-3 flex justify-end">
            <AssignDialog items={(items.data ?? []).filter((i) => i.active)} staffList={staff.data ?? []} />
          </div>
          {/* Seven and six columns of stock figures. The card scrolls, not the
              page — the third table here is narrow enough that its scroller
              never engages, and it carries the class anyway so all three
              behave the same when a column is added. */}
          <div className="relative overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Tech</th>
                  <th className="px-4 py-2">Item</th>
                  <th className="px-4 py-2">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {(assigns.data ?? []).length === 0 ? (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">Nothing assigned yet.</td></tr>
                ) : (
                  (assigns.data ?? []).map((a) => {
                    const item = Array.isArray(a.inventory_items) ? a.inventory_items[0] : a.inventory_items;
                    const st = Array.isArray(a.staff) ? a.staff[0] : a.staff;
                    return (
                      <tr key={a.id} className="border-b last:border-0">
                        <td className="px-4 py-2">{st?.display_name ?? "-"}</td>
                        <td className="px-4 py-2">{item?.name ?? "-"}</td>
                        <td className="px-4 py-2">{fmtQty(a.quantity)} {item?.unit ?? ""}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="movements" className="mt-4">
          {/* Seven and six columns of stock figures. The card scrolls, not the
              page — the third table here is narrow enough that its scroller
              never engages, and it carries the class anyway so all three
              behave the same when a column is added. */}
          <div className="relative overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm min-w-[540px]">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Kind</th>
                  <th className="px-4 py-2">Item</th>
                  <th className="px-4 py-2">Qty</th>
                  <th className="px-4 py-2">Tech</th>
                  <th className="px-4 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {(moves.data ?? []).length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No activity yet.</td></tr>
                ) : (
                  (moves.data ?? []).map((m) => {
                    const item = Array.isArray(m.inventory_items) ? m.inventory_items[0] : m.inventory_items;
                    const st = Array.isArray(m.staff) ? m.staff[0] : m.staff;
                    return (
                      <tr key={m.id} className="border-b last:border-0">
                        <td className="px-4 py-2 text-muted-foreground">{formatDateTime(m.created_at)}</td>
                        <td className="px-4 py-2"><Badge variant="outline">{m.kind}</Badge></td>
                        <td className="px-4 py-2">{item?.name ?? "-"}</td>
                        <td className="px-4 py-2">{fmtQty(m.quantity)} {item?.unit ?? ""}</td>
                        <td className="px-4 py-2">{st?.display_name ?? "-"}</td>
                        <td className="px-4 py-2 text-muted-foreground">{m.note ?? ""}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ItemDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    sku: "",
    unit: "each",
    unit_cost_cents: 0,
    reorder_threshold: 0,
    category: "",
  });
  const save = useServerFn(upsertItem);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => save({ data: { ...form, sku: form.sku || null, category: form.category || null } }),
    onSuccess: () => {
      toast.success("Item added");
      setOpen(false);
      setForm({ name: "", sku: "", unit: "each", unit_cost_cents: 0, reorder_threshold: 0, category: "" });
      qc.invalidateQueries({ queryKey: ["inv-items"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1 shrink-0" /> Add item</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New inventory item</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">SKU</label>
              <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Unit</label>
              <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Unit cost (¢)</label>
              <Input type="number" value={form.unit_cost_cents} onChange={(e) => setForm({ ...form, unit_cost_cents: Number(e.target.value) })} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Reorder at</label>
              <Input type="number" value={form.reorder_threshold} onChange={(e) => setForm({ ...form, reorder_threshold: Number(e.target.value) })} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">Category</label>
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!form.name || m.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementDialog({ item, staffList }: { item: Item; staffList: Array<{ id: string; display_name: string }> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"purchase" | "assign" | "unassign" | "consume" | "adjust">("purchase");
  const [qty, setQty] = useState(1);
  const [staffId, setStaffId] = useState<string>("");
  const [note, setNote] = useState("");
  const rec = useServerFn(recordMovement);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => rec({ data: {
      item_id: item.id,
      kind,
      quantity: qty,
      staff_id: staffId || null,
      note: note || null,
    } }),
    onSuccess: () => {
      toast.success("Recorded");
      setOpen(false);
      setQty(1); setNote(""); setStaffId("");
      qc.invalidateQueries({ queryKey: ["inv-items"] });
      qc.invalidateQueries({ queryKey: ["inv-assigns"] });
      qc.invalidateQueries({ queryKey: ["inv-moves"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const needsStaff = kind === "assign" || kind === "unassign";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Log</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{item.name}: record activity</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Kind</label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="purchase">Purchase (stock in)</SelectItem>
                <SelectItem value="assign">Assign to tech</SelectItem>
                <SelectItem value="unassign">Return from tech</SelectItem>
                <SelectItem value="consume">Consume (used up)</SelectItem>
                <SelectItem value="adjust">Adjust (± count)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Quantity ({item.unit}){kind === "adjust" ? ": use negative to decrement" : ""}</label>
            <Input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </div>
          {(needsStaff || kind === "consume") && (
            <div>
              <label className="text-xs text-muted-foreground">Tech{needsStaff ? "" : " (optional)"}</label>
              <Select value={staffId} onValueChange={setStaffId}>
                <SelectTrigger><SelectValue placeholder="Select tech" /></SelectTrigger>
                <SelectContent>
                  {staffList.map((s) => <SelectItem key={s.id} value={s.id}>{s.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground">Note</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={m.isPending || (needsStaff && !staffId)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ items, staffList }: { items: Item[]; staffList: Array<{ id: string; display_name: string }> }) {
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState<string>("");
  const [staffId, setStaffId] = useState<string>("");
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const rec = useServerFn(recordMovement);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => rec({ data: {
      item_id: itemId,
      kind: "assign" as const,
      quantity: qty,
      staff_id: staffId || null,
      note: note || null,
    } }),
    onSuccess: () => {
      toast.success("Assigned to tech");
      setOpen(false);
      setItemId(""); setStaffId(""); setQty(1); setNote("");
      qc.invalidateQueries({ queryKey: ["inv-items"] });
      qc.invalidateQueries({ queryKey: ["inv-assigns"] });
      qc.invalidateQueries({ queryKey: ["inv-moves"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const selected = items.find((i) => i.id === itemId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="mr-1 h-4 w-4 shrink-0" /> Assign to tech</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Assign inventory to a tech</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Item</label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
              <SelectContent>
                {items.map((i) => <SelectItem key={i.id} value={i.id}>{i.name} ({fmtQty(i.on_hand)} {i.unit} on hand)</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Tech</label>
            <Select value={staffId} onValueChange={setStaffId}>
              <SelectTrigger><SelectValue placeholder="Select tech" /></SelectTrigger>
              <SelectContent>
                {staffList.map((s) => <SelectItem key={s.id} value={s.id}>{s.display_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Quantity{selected ? ` (${selected.unit})` : ""}</label>
            <Input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Note</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !itemId || !staffId || qty <= 0}>Assign</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
