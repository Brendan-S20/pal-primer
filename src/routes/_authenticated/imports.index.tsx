import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import Papa from "papaparse";
import { toast } from "sonner";
import {
  listImportBatches,
  previewImport,
  IMPORT_SOURCES,
  IMPORT_ENTITIES,
  TARGET_FIELDS_BY_ENTITY,
  autoMap,
  detectImportSource,
  type ImportEntity,
} from "@/lib/imports.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/imports/")({
  component: ImportsPage,
});

const SOURCE_LABELS: Record<string, string> = {
  generic_csv: "Generic CSV",
  sweepgo: "Sweep&Go",
  jobber: "Jobber",
  housecall_pro: "Housecall Pro",
  time_to_pet: "Time To Pet",
  gorilla_desk: "GorillaDesk",
  quoteiq_family: "QuoteIQ / Flowcarve / DoTimely",
};

const SOURCE_HINTS: Record<string, string> = {
  sweepgo: "Export from Sweep&Go → Settings → Data Export. Use the Customers, Locations, and Pets CSVs (one at a time).",
  jobber: "Export from Jobber → Gear icon → Imports & Exports → Export Data. Import clients first, then their recurring services (plans and prices), then opening balances.",
  housecall_pro: "Housecall Pro Customers CSV uses separate First Name / Last Name columns. We'll combine them automatically.",
  time_to_pet: "Time To Pet → Admin → Data → Export Clients / Pets. Pets link back to a Client ID.",
  gorilla_desk: "GorillaDesk → Reports → Customers → Export CSV. Import Customers first, then Locations, then Pets.",
  quoteiq_family: "QuoteIQ, Flowcarve, and DoTimely share a similar shape, so the generic mapping usually works.",
  generic_csv: "",
};

const ENTITY_LABELS: Record<ImportEntity, string> = {
  clients: "Clients",
  properties: "Properties (addresses)",
  dogs: "Dogs",
  services: "Recurring services (plans and prices)",
  balances: "Opening balances (money owed)",
};

const ENTITY_HINTS: Partial<Record<ImportEntity, string>> = {
  services:
    "One row per plan. Import clients first; each plan is matched to a client by ID, or by exact name if the file has no ID, and goes on that client's first address. Visits are scheduled as soon as you commit.",
  balances:
    "One row per amount owed. Each becomes an open invoice marked as an opening balance. Nothing is emailed; imported clients stay on a communications hold until you contact them.",
};

const REQUIRED_FIELDS: Record<ImportEntity, string[]> = {
  clients: ["display_name"],
  properties: ["client_external_id", "street"],
  dogs: ["client_external_id", "name"],
  services: ["price_per_visit"],
  balances: ["amount"],
};

/** Import kinds that find their client by ID OR by name: one of the two. */
const CLIENT_BY_ID_OR_NAME: ImportEntity[] = ["services", "balances"];

/** What a person calls each field. The mapping step showed the column names
 *  the code uses ("display_name", "client_external_id"), which the Jobber
 *  switcher review read as the product not being finished. */
const FIELD_LABELS: Record<string, string> = {
  display_name: "Client name",
  account_type: "Residential or commercial",
  primary_email: "Email",
  primary_phone: "Phone",
  external_id: "Client ID in your old system",
  client_external_id: "Client ID in your old system",
  client_name: "Client name",
  notes: "Notes",
  tags: "Tags",
  street: "Street",
  city: "City",
  region: "State",
  postal_code: "ZIP",
  gate_code: "Gate code",
  label: "Property name",
  name: "Dog name",
  breed: "Breed",
  weight_class: "Weight",
  frequency: "How often",
  price_per_visit: "Price per visit",
  service_day: "Service day",
  start_date: "Start date",
  dog_count: "Number of dogs",
  billing: "Billing (prepaid or after each visit)",
  amount: "Amount owed",
  due_date: "Due date",
  note: "Note",
};

const TEMPLATE_HEADERS: Record<ImportEntity, Record<string, string[]>> = {
  clients: {
    generic_csv: ["name", "email", "phone", "type", "external_id", "notes"],
    sweepgo: ["Client ID", "Client Name", "Email", "Phone", "Account Type", "Notes"],
    jobber: ["Client ID", "Company/Client name", "Primary email", "Mobile phone number", "Client type", "Notes"],
    housecall_pro: ["Customer ID", "First Name", "Last Name", "Email", "Phone", "Type", "Notes"],
    time_to_pet: ["Client ID", "Client", "Email", "Phone", "Type", "Notes"],
    gorilla_desk: ["Customer ID", "Customer", "Email", "Phone", "Type", "Notes"],
    quoteiq_family: ["ID", "Name", "Email", "Phone", "Type", "Notes"],
  },
  properties: {
    generic_csv: ["client_id", "label", "street", "address_line_2", "city", "region", "postal_code", "gate_code", "notes"],
    sweepgo: ["Client ID", "Property Name", "Street", "City", "State", "Zip", "Gate Code", "Notes"],
    jobber: ["Client ID", "Property name", "Street 1", "Street 2", "City", "Province/State", "Postal/Zip Code", "Notes"],
    housecall_pro: ["Customer ID", "Address Name", "Street", "Address Line 2", "City", "State", "Zip", "Gate Code", "Notes"],
    time_to_pet: ["Client ID", "Location", "Street", "City", "State", "Zip", "Notes"],
    gorilla_desk: ["Customer ID", "Location", "Street", "City", "State", "Zip", "Notes"],
    quoteiq_family: ["Client ID", "Location", "Street", "City", "State", "Zip", "Notes"],
  },
  dogs: {
    generic_csv: ["client_id", "name", "breed", "weight", "notes"],
    sweepgo: ["Client ID", "Dog Name", "Breed", "Weight (lbs)", "Notes"],
    jobber: ["Client ID", "Pet name", "Breed", "Weight", "Notes"],
    housecall_pro: ["Customer ID", "Pet Name", "Breed", "Weight", "Notes"],
    time_to_pet: ["Client ID", "Pet Name", "Breed", "Weight", "Notes"],
    gorilla_desk: ["Customer ID", "Pet Name", "Breed", "Weight", "Notes"],
    quoteiq_family: ["Client ID", "Pet Name", "Breed", "Weight", "Notes"],
  },
  services: {
    generic_csv: ["client_id", "client_name", "frequency", "price", "day", "start_date", "dogs"],
    jobber: ["Client J-ID", "Client name", "Visit frequency", "Visit total", "Day", "Start date", "Number of dogs"],
    sweepgo: ["Client ID", "Client Name", "Frequency", "Price Per Cleanup", "Service Day", "Start Date", "Number of Dogs"],
  },
  balances: {
    generic_csv: ["client_id", "client_name", "balance", "due_date", "note"],
    jobber: ["Client J-ID", "Client name", "Balance", "Due date", "Notes"],
    sweepgo: ["Client ID", "Client Name", "Open Balance", "Due Date", "Memo"],
  },
};

/** "{"failed":2,"created":0}" is developer output — spell it out (P2). */
function humanizeStats(stats: Record<string, unknown>): string {
  const n = (k: string) => (typeof stats[k] === "number" ? (stats[k] as number) : 0);
  const parts = [
    n("created") > 0 && `${n("created")} created`,
    n("updated") > 0 && `${n("updated")} updated`,
    n("skip") + n("skipped") > 0 && `${n("skip") + n("skipped")} skipped`,
    n("failed") + n("errors") > 0 && `${n("failed") + n("errors")} failed`,
  ].filter(Boolean);
  if (!parts.length) {
    return typeof stats.total === "number" ? `${stats.total} rows` : "No rows processed";
  }
  return parts.join(" · ");
}

function downloadTemplate(source: string, entity: ImportEntity) {
  const headers = TEMPLATE_HEADERS[entity][source] ?? TEMPLATE_HEADERS[entity].generic_csv;
  const csv = headers.join(",") + "\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${source}-${entity}-template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function ImportStatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    committed: "border-transparent bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400",
    failed: "border-transparent bg-destructive/15 text-destructive hover:bg-destructive/15",
    cancelled: "text-muted-foreground",
  };
  return (
    <Badge variant={status === "cancelled" ? "outline" : "secondary"} className={cls[status] ?? ""}>
      {status}
    </Badge>
  );
}

function ImportsPage() {
  const listFn = useServerFn(listImportBatches);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["import-batches"],
    queryFn: () => listFn(),
  });

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Import data</h1>
        <p className="text-sm text-muted-foreground">
          Migrate clients from Sweep&amp;Go, Jobber, Housecall Pro, or any CSV. Nothing is written
          until you review a dry-run preview. Imported clients won't receive automated messages
          until you resume communications or reach out first.
        </p>
      </div>

      <NewImportWizard onCreated={() => refetch()} />

      <section>
        <h2 className="mb-3 text-lg font-medium">Recent imports</h2>
        {isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !data?.batches.length ? (
          <p className="text-sm text-muted-foreground">No imports yet.</p>
        ) : (
          // Six columns clipped, not scrolled — see AiPanels for the same fix.
          <div className="relative overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm min-w-[540px]">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Stats</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.batches.map((b: any) => (
                  <tr key={b.id} className="border-t">
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(b.created_at)}
                    </td>
                    <td className="px-4 py-3">{SOURCE_LABELS[b.source] ?? b.source}</td>
                    <td className="px-4 py-3 text-muted-foreground">{b.filename ?? "-"}</td>
                    <td className="px-4 py-3">
                      <ImportStatusBadge status={b.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {b.stats ? humanizeStats(b.stats) : "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to="/imports/$batchId" params={{ batchId: b.id }}>
                        <Button size="sm" variant="outline">Open</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function NewImportWizard({ onCreated }: { onCreated: () => void }) {
  const navigate = useNavigate();
  const previewFn = useServerFn(previewImport);
  const [source, setSource] = useState<(typeof IMPORT_SOURCES)[number]>("generic_csv");
  const [entity, setEntity] = useState<ImportEntity>("clients");
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);

  const targetFields = TARGET_FIELDS_BY_ENTITY[entity];
  const required = REQUIRED_FIELDS[entity];

  const onFileChange = (f: File | null) => {
    setFile(f);
    if (!f) {
      setHeaders([]);
      setRows([]);
      return;
    }
    Papa.parse<Record<string, any>>(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const hs = res.meta.fields ?? [];
        setHeaders(hs);
        setRows(res.data);
        // Recognize which CRM the export came from and auto-map its fields —
        // switching systems shouldn't require knowing your old CRM's column
        // names. A weak/ambiguous signal keeps the user's manual selection.
        const detected = detectImportSource(hs);
        const effSource = detected ?? source;
        if (detected && detected !== source) {
          setSource(detected);
          toast.success(`Recognized a ${SOURCE_LABELS[detected] ?? detected} export, fields auto-mapped.`);
        }
        setMapping(autoMap(effSource, hs, entity));
      },
      error: (err) => toast.error(`CSV parse error: ${err.message}`),
    });
  };

  const onSourceChange = (s: (typeof IMPORT_SOURCES)[number]) => {
    setSource(s);
    if (headers.length) setMapping(autoMap(s, headers, entity));
  };

  const onEntityChange = (e: ImportEntity) => {
    setEntity(e);
    if (headers.length) setMapping(autoMap(source, headers, e));
  };

  const runPreview = async () => {
    if (!rows.length) return toast.error("Upload a CSV first.");
    for (const req of required) {
      if (!mapping[req]) return toast.error(`Choose a column for "${FIELD_LABELS[req] ?? req}".`);
    }
    if (CLIENT_BY_ID_OR_NAME.includes(entity) && !mapping.client_external_id && !mapping.client_name) {
      return toast.error("Choose a column for the client: their ID in your old system, or their name.");
    }
    setBusy(true);
    try {
      const { batchId } = await previewFn({
        data: { source, entity, filename: file?.name, mapping, rows },
      });
      toast.success("Preview ready");
      onCreated();
      navigate({ to: "/imports/$batchId", params: { batchId } });
    } catch (e: any) {
      toast.error(e?.message ?? "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-6">
      <h2 className="text-lg font-medium">New import</h2>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">What are you importing?</span>
          <select
            value={entity}
            onChange={(e) => onEntityChange(e.target.value as ImportEntity)}
            className="block w-full rounded border bg-background px-3 py-2 text-sm"
          >
            {IMPORT_ENTITIES.map((e) => (
              <option key={e} value={e}>{ENTITY_LABELS[e]}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Source system</span>
          <select
            value={source}
            onChange={(e) => onSourceChange(e.target.value as any)}
            className="block w-full rounded border bg-background px-3 py-2 text-sm"
          >
            {IMPORT_SOURCES.map((s) => (
              <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">CSV file</span>
          {/* The native file control rendered as barely-visible plain text;
              style the button half like a real primary button so it reads as
              clickable (Brendan, 2026-07-14). */}
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            className="block w-full cursor-pointer text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
          />
        </label>
      </div>

      {entity !== "clients" && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {ENTITY_HINTS[entity] ?? (
            <>
              Import <strong>clients first</strong>. Properties and dogs link back to a client by
              its ID in your original system.
            </>
          )}
        </div>
      )}

      {SOURCE_HINTS[source] && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3 text-xs">
          <span className="text-muted-foreground">{SOURCE_HINTS[source]}</span>
          <Button size="sm" variant="outline" onClick={() => downloadTemplate(source, entity)}>
            Download {SOURCE_LABELS[source]} {ENTITY_LABELS[entity].toLowerCase()} template
          </Button>
        </div>
      )}

      {headers.length > 0 && (
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            Detected <span className="font-medium text-foreground">{rows.length}</span> rows and{" "}
            <span className="font-medium text-foreground">{headers.length}</span> columns. Match each
            target field to a column (auto-mapped from the {SOURCE_LABELS[source]} preset).
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {targetFields.map((field) => (
              <label key={field} className="space-y-1 text-sm">
                <span className="font-medium">
                  {FIELD_LABELS[field] ?? field}
                  {required.includes(field) && <span className="text-red-500"> *</span>}
                </span>
                <select
                  value={mapping[field] ?? ""}
                  onChange={(e) =>
                    setMapping((prev) => ({ ...prev, [field]: e.target.value || null }))
                  }
                  className="block w-full rounded border bg-background px-3 py-2 text-sm"
                >
                  <option value="">(skip)</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <Button onClick={runPreview} disabled={busy}>
              {busy ? "Analyzing…" : "Dry-run preview"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
