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
  type ImportEntity,
} from "@/lib/imports.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

const ENTITY_LABELS: Record<ImportEntity, string> = {
  clients: "Clients",
  properties: "Properties (addresses)",
  dogs: "Dogs",
};

const REQUIRED_FIELDS: Record<ImportEntity, string[]> = {
  clients: ["display_name"],
  properties: ["client_external_id", "street"],
  dogs: ["client_external_id", "name"],
};

function ImportsPage() {
  const listFn = useServerFn(listImportBatches);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["import-batches"],
    queryFn: () => listFn(),
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Import data</h1>
        <p className="text-sm text-muted-foreground">
          Migrate clients from Sweep&amp;Go, Jobber, Housecall Pro, or any CSV. Nothing is written
          until you review a dry-run preview.
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
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
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
                      {new Date(b.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">{SOURCE_LABELS[b.source] ?? b.source}</td>
                    <td className="px-4 py-3 text-muted-foreground">{b.filename ?? "—"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={b.status === "committed" ? "default" : "secondary"}>
                        {b.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {b.stats ? JSON.stringify(b.stats) : "—"}
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
    </div>
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
        setMapping(autoMap(source, hs, entity));
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
      if (!mapping[req]) return toast.error(`Map the ${req} column.`);
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
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
        </label>
      </div>

      {entity !== "clients" && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          Import <strong>clients first</strong>. Properties and dogs link back to a client by its
          external id from the original system.
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
                  {field}
                  {required.includes(field) && <span className="text-red-500"> *</span>}
                </span>
                <select
                  value={mapping[field] ?? ""}
                  onChange={(e) =>
                    setMapping((prev) => ({ ...prev, [field]: e.target.value || null }))
                  }
                  className="block w-full rounded border bg-background px-3 py-2 text-sm"
                >
                  <option value="">— skip —</option>
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
