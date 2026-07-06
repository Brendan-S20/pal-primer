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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, Package, Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/inventory")({
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

function InventoryPage() {
  const itemsFn = useServerFn(listItems);
  const assignsFn = useServerFn(listAssignments);
  const movesFn = useServerFn(listRecentMovements);
  const staffFn = useServerFn(listStaff);

  const items = useQuery({ queryKey: ["inv-items"], queryFn: () => itemsFn() });
  const assigns = useQuery({ queryKey: ["inv-assigns"], queryFn: () => assignsFn() });
  const moves = useQuery({ queryKey: ["inv-moves"], queryFn: () => movesFn() });
  const staff = useQuery({ queryKey: ["staff-list"], queryFn: () => staffFn() });

  const lowStock = useMemo(
    () => (items.data ?? []).filter((i) => Number(i.on_hand) <= Number(i.reorder_threshold) && i.active),
    [items.data],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Package className="h-6 w-6"/> Inventory</h1>
          <p className="text-sm text-muted-foreground">Track supplies, per-tech assignments, and consumption.</p>
        </div>
        <ItemDialog />
      </div>

      {lowStock.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> {lowStock.length} item{lowStock.length === 1 ? "" : "s"} at or below reorder threshold
          </div>
          <ul className="mt-2 text-xs text-muted-foreground">
            {lowStock.slice(0, 5).map((i) => (
              <li key={i.id}>• {i.name} — {i.on_hand} {i.unit} on hand (threshold {i.reorder_threshold})</li>
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

        <TabsContent value="items" className="mt-4">
          <div className="rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
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
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
                ) : (items.data ?? []).length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No items yet. Add one to get started.</td></tr>
                ) : (
                  (items.data as Item[]).map((i) => {
                    const low = Number(i.on_hand) <= Number(i.reorder_threshold);
                    return (
                      <tr key={i.id} className="border-b last:border-0">
                        <td className="px-4 py-2 font-medium">
                          {i.name}
                          {!i.active && <Badge variant="secondary" className="ml-2">inactive</Badge>}
                          {i.category && <span className="ml-2 text-xs text-muted-foreground">{i.category}</span>}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{i.sku ?? "—"}</td>
                        <td className={`px-4 py-2 ${low ? "text-amber-600 font-medium" : ""}`}>
                          {Number(i.on_hand).toFixed(2)} {i.unit}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{Number(i.reorder_threshold).toFixed(2)}</td>
                        <td className="px-4 py-2">{fmtMoney(i.unit_cost_cents)}</td>
                        <td className="px-4 py-2 text-right">
                          <MovementDialog item={i} staffList={staff.data ?? []} />
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
          <div className="rounded-lg border bg-card">
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
                        <td className="px-4 py-2">{st?.display_name ?? "—"}</td>
                        <td className="px-4 py-2">{item?.name ?? "—"}</td>
                        <td className="px-4 py-2">{Number(a.quantity).toFixed(2)} {item?.unit ?? ""}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="movements" className="mt-4">
          <div className="rounded-lg border bg-card">
            <table className="w-full text-sm">
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
                        <td className="px-4 py-2 text-muted-foreground">{new Date(m.created_at).toLocaleString()}</td>
                        <td className="px-4 py-2"><Badge variant="outline">{m.kind}</Badge></td>
                        <td className="px-4 py-2">{item?.name ?? "—"}</td>
                        <td className="px-4 py-2">{Number(m.quantity).toFixed(2)} {item?.unit ?? ""}</td>
                        <td className="px-4 py-2">{st?.display_name ?? "—"}</td>
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
        <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add item</Button>
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
        <DialogHeader><DialogTitle>{item.name} — record activity</DialogTitle></DialogHeader>
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
            <label className="text-xs text-muted-foreground">Quantity ({item.unit}){kind === "adjust" ? " — use negative to decrement" : ""}</label>
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
