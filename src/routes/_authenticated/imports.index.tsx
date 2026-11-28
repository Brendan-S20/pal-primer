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
  detectImportEntity,
  IMPORT_SOURCE_LABELS,
  isVerifiedSource,
  fieldNamesForEntity,
  type ImportEntity,
} from "@/lib/imports.functions";
import { suggestFields } from "@/lib/import-column-map";
import { reportNotForImport, tableFromCsv, type SkippedLine } from "@/lib/import-file-table";
import { planVisitFile, VISITS_COLUMNS, visitFileColumns } from "@/lib/import-visit-plans";
import { ImportFileNotes } from "@/components/imports/ImportFileNotes";
import { ColumnMappingTable } from "@/components/imports/ColumnMappingTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { importStatusLabel } from "@/lib/import-status";
import { titleHead } from "@/lib/page-title";
import { useServiceLines } from "@/components/CommercialOnly";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { JobberVisitsFile } from "@/components/imports/JobberVisitsFile";
import {
  JOBBER_LAST_VISIT_COLUMN,
  JOBBER_NEXT_VISIT_COLUMN,
  JOBBER_AFTER_NEXT_COLUMN,
  mergeJobberVisits,
  withVisitMapping,
} from "@/lib/import-jobber-visits";

export const Route = createFileRoute("/_authenticated/imports/")({
  head: () => titleHead("Import data"),
  component: ImportsPage,
});

const SOURCE_LABELS: Record<string, string> = IMPORT_SOURCE_LABELS;

// Where each vendor's export lives, in the vendor's own words. Upload the
// file as it came: nothing needs renaming, splitting or adding (#857).
const SOURCE_HINTS: Record<string, string> = {
  sweepgo: "In Sweep&Go, go to Clients > Residential Clients, open the three dots menu and choose Client List CSV. Upload it as it came: the name, cell phone (or home phone), email, status, referral source and the address all come through. For recurring services, open Billing > Residential Subscriptions, add Canceled to the status filter if you like, and choose CSV: the plan, its dogs and how often (\"2d-1xW\"), the price per cleanup and the start and end dates come through, and canceled plans are refused with the reason. Or export Reports > Completed Jobs: each plan is read from its visits, so how often, the price per cleanup (an Initial cleanup's price is not the plan's) and the last and next visit come from the visit dates, and a plan code a plan here cannot repeat (\"1d-3xW\") is listed for you to add by hand. The Referral Sources report has only names: a client already here by that name is skipped, and the Client List CSV carries the referral source. Sweep&Go's exports have no dogs' names or gate codes, so add those by hand. Every plan comes in paused for you to check and turn on. Import clients first, then recurring services.",
  jobber: "In Jobber, go to Clients > More Actions > Export Clients and choose CSV. Jobber emails the file (up to 1,500 clients per file, admin users only). Upload it as it came: the service address, tags, internal notes and account balance all come through. For recurring services, export Insights > Reports > Recurring jobs with All Columns: how often, the price per visit and the start date come through. Add the Visits report too and each plan also gets its last and next visit. Plans billed as a fixed price are refused, since Jobber's total for them is per billing period, not per visit. Every plan comes in paused for you to check and turn on. Import clients first, then recurring services.",
  housecall_pro: "In Housecall Pro, go to Customers > Actions > Export and choose Send file; the CSV is emailed to you. Upload it as it came: the name, phones, email, tags, notes, lead source and the service address all come through. For recurring services, open Jobs, remove the Completed between filter, choose Add all columns and Export: each recurring job is read from its visits, so how often, the price per visit, and the last and next visit come from the visit dates. For balances, open Invoices, choose Table columns > Excel > Download CSV. Import clients first, then recurring services.",
  time_to_pet: "In Time To Pet, open the Client List and choose Export Client Data (one Full Name column, with Address, City, State and Zip Code). For pets, choose Export Pet Data and tick Include Client Fields so each pet names its owner; pets that are not dogs, or are marked deceased, are left out with the reason. For recurring services, export Reporting > Schedule > Visits: each client's service is read from its visits, so how often, the price per visit, and the last and next visit come from the visit dates. For balances, export Reporting > Financial > Sales. Import clients first, then pets and recurring services.",
  gorilla_desk: "In GorillaDesk, open the Customers tab and choose Action > Export. HoundStack has not seen a real GorillaDesk file yet, so check every column below before you preview.",
  quoteiq_family: "QuoteIQ, Flowcarve, and DoTimely share a similar shape, so the generic mapping usually works.",
  gingr: "In Gingr, go to Owners and Pets > View All Owners and choose Export to CSV. Pets named in the Animals column become that owner's pets. HoundStack has not seen a real Gingr file yet, so check every column below before you preview.",
  moego: "In MoeGo, go to Client & Pets > Options > Export Clients. Pets named on a client's row become that client's pets. HoundStack has not seen a real MoeGo file yet, so check every column below before you preview.",
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
  dogs: "One row per dog. Import clients first; each dog is matched to a client by ID, or by the client's email, phone or exact name if the file has no ID, and goes on that client's first address.",
  services:
    "One row per plan. Import clients first; each plan is matched to a client by ID, by email, or by exact name if the file has neither, and goes on that client's first address. Every imported plan starts paused: turn each one on from the client's page when you are ready, and its visits are scheduled then.",
  balances:
    "One row per amount owed. Each becomes an open invoice marked as an opening balance. Nothing is emailed; imported clients stay on a communications hold until you contact them.",
};

const REQUIRED_FIELDS: Record<ImportEntity, string[]> = {
  clients: ["display_name"],
  properties: ["client_external_id", "street"],
  dogs: ["name"],
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
  client_email: "Client email",
  client_phone: "Client phone",
  notes: "Notes",
  tags: "Tags",
  archived: "Archived or inactive",
  do_not_text: "Do not text",
  pets: "Pets (names in one column)",
  balance: "Amount owed (opening balance)",
  company: "Company name",
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
  last_visit: "Last visit",
  next_visit: "Next visit",
  visit_after_next: "Visit after next",
  end_date: "End date (the plan stops)",
  closed_date: "Closed date (a closed job is not imported)",
  plan_status: "Plan status (a cancelled plan is not imported)",
  price_basis: "What the price is per (only a price per visit is imported)",
  dog_count: "Number of dogs",
  billing: "Billing (prepaid or after each visit)",
  service: "Service (which of your services the plan is for)",
  amount: "Amount owed",
  due_date: "Due date",
  note: "Note",
  service_street: "Service address (also tells apart two clients with one name)",
};

const TEMPLATE_HEADERS: Record<ImportEntity, Record<string, string[]>> = {
  clients: {
    generic_csv: ["name", "email", "phone", "type", "external_id", "notes"],
    sweepgo: ["First Name", "Last Name", "Email", "Status", "Cell Phone Number", "Address", "City", "State", "Zip Code"],
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
    generic_csv: [
      "client_id",
      "client_email",
      "client_phone",
      "client_name",
      "dog_name",
      "breed",
      "weight",
      "notes",
    ],
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
    sweepgo: ["Status", "Revenue", "Revenue Type", "Client Name", "Start Date", "End Date", "Subs. Name", "Address"],
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
    // After a commit, "skipped" already includes the preview's skips (#656).
    (stats.skipped !== undefined ? n("skipped") : n("skip")) > 0 &&
      `${stats.skipped !== undefined ? n("skipped") : n("skip")} skipped`,
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
    failed: "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/10",
    cancelled: "text-muted-foreground",
  };
  return (
    <Badge variant={status === "cancelled" ? "outline" : "secondary"} className={cls[status] ?? ""}>
      {importStatusLabel(status)}
    </Badge>
  );
}

function ImportsPage() {
  // The business's clock, like every other time on a staff screen (#654).
  const tz = useOrgTimezone();
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
          Upload the export your old software made, as it came: Jobber, Time To Pet, Sweep&amp;Go,
          Housecall Pro, Gingr, MoeGo or any CSV. Every column is either matched to a field or kept
          on the client as a note; nothing is dropped. Nothing is written until you review a
          dry-run preview, imported plans start paused, and imported clients won't receive
          automated messages until you resume communications or reach out first.
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
                      {formatDateTime(b.created_at, tz)}
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
  const [fileHeaders, setHeaders] = useState<string[]>([]);
  const [fileRows, setRows] = useState<Record<string, any>[]>([]);
  // Lines of the file that are not rows of data (a group-label row, a
  // report's date range or totals), shown to the owner with the reason.
  const [skipped, setSkipped] = useState<SkippedLine[]>([]);
  // Jobber's Visits report, when added on a plans import: its last and next
  // visit per Job # become two columns on each plan row.
  const [visitRows, setVisitRows] = useState<Record<string, unknown>[] | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  // Fields set from a column's name alone, on a file no real export backs.
  const [suggested, setSuggested] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const today = useOrgToday();
  const tz = useOrgTimezone();
  const joinsVisits = (s: string, e: ImportEntity, v: unknown[] | null) =>
    s === "jobber" && e === "services" && !!v;
  // A Housecall Pro Jobs or Time To Pet Visits file on a plans import is
  // read as one plan per client and service (src/lib/import-visit-plans.ts).
  const visitsFile = (s: string, e: ImportEntity, hs: string[]) =>
    e === "services" ? visitFileColumns(s, hs) : null;
  const withVisitColumns = (hs: string[], s: string, e: ImportEntity, v: unknown[] | null) =>
    joinsVisits(s, e, v) && hs.length
      ? [...hs, JOBBER_LAST_VISIT_COLUMN, JOBBER_NEXT_VISIT_COLUMN, JOBBER_AFTER_NEXT_COLUMN]
      : visitsFile(s, e, hs)
        ? [...hs, ...VISITS_COLUMNS]
        : hs;
  const headers = withVisitColumns(fileHeaders, source, entity, visitRows);
  const planColumns = visitsFile(source, entity, fileHeaders);
  // Visits and plans left out of a visits file, each with the reason.
  const visitPlans = planColumns ? planVisitFile(fileRows, planColumns, today, tz) : null;
  const rows = joinsVisits(source, entity, visitRows)
    ? mergeJobberVisits(fileRows, visitRows!, today)
    : (visitPlans?.rows ?? fileRows);
  // A report with nothing to import in it, and which file to export instead.
  const refused = fileHeaders.length ? reportNotForImport(fileHeaders, fileRows) : null;

  // A Service column is offered to a business that runs more than pet waste.
  // A scooper's import has one service, the default, and the mapping step
  // reads exactly as it did.
  const { lines } = useServiceLines();
  const offersServiceColumn = lines.some((l) => l !== "pet_waste");
  const targetFields = TARGET_FIELDS_BY_ENTITY[entity].filter(
    (f) => f !== "service" || offersServiceColumn,
  );
  const required = REQUIRED_FIELDS[entity];

  // A known export is mapped from its real file's column names. A file
  // HoundStack has no real export of (any CSV, or a vendor not yet seen)
  // also gets a suggested field for each column whose name says it.
  const remap = (s: string, hs: string[], e: ImportEntity) => {
    const base = autoMap(s, hs, e);
    if (s !== "generic_csv" && isVerifiedSource(s)) {
      setMapping(base);
      setSuggested(new Set());
      return;
    }
    const out = suggestFields(base, hs, TARGET_FIELDS_BY_ENTITY[e], fieldNamesForEntity(e));
    setMapping(out.mapping);
    setSuggested(new Set(out.suggested));
  };

  const onFileChange = (f: File | null) => {
    setFile(f);
    if (!f) {
      setHeaders([]);
      setRows([]);
      setSkipped([]);
      return;
    }
    Papa.parse<string[]>(f, {
      skipEmptyLines: true,
      complete: (res) => {
        const table = tableFromCsv(res.data);
        const hs = table.headers;
        setHeaders(hs);
        setRows(table.rows);
        setSkipped(table.skipped);
        // Recognize which CRM the export came from and auto-map its fields —
        // switching systems shouldn't require knowing your old CRM's column
        // names. A weak/ambiguous signal keeps the user's manual selection.
        const detected = detectImportSource(hs);
        const effSource = detected ?? source;
        if (detected && detected !== source) {
          setSource(detected);
          toast.success(`Recognized a ${SOURCE_LABELS[detected] ?? detected} export, fields auto-mapped.`);
        }
        // A vendor's plans, visits, invoices or pets file sets what is being
        // imported too; the owner can still change it.
        const kind = detectImportEntity(hs) ?? entity;
        if (kind !== entity) {
          setEntity(kind);
          toast.info(`Importing ${ENTITY_LABELS[kind].toLowerCase()}, from the file's columns.`);
        }
        remap(effSource, withVisitColumns(hs, effSource, kind, visitRows), kind);
      },
      error: (err) => toast.error(`CSV parse error: ${err.message}`),
    });
  };

  // Adding or removing the Visits report keeps every column the owner has
  // already placed; only the two visit columns come and go.
  const onVisitRows = (v: Record<string, unknown>[] | null) => {
    setVisitRows(v);
    if (fileHeaders.length) setMapping((m) => withVisitMapping(m, joinsVisits(source, entity, v)));
  };

  const onSourceChange = (s: (typeof IMPORT_SOURCES)[number]) => {
    setSource(s);
    if (fileHeaders.length)
      remap(s, withVisitColumns(fileHeaders, s, entity, visitRows), entity);
  };

  const onEntityChange = (e: ImportEntity) => {
    setEntity(e);
    if (fileHeaders.length)
      remap(source, withVisitColumns(fileHeaders, source, e, visitRows), e);
  };

  const runPreview = async () => {
    if (!rows.length) return toast.error("Upload a CSV first.");
    if (refused) return toast.error(refused);
    for (const req of required) {
      if (!mapping[req]) return toast.error(`Choose a column for "${FIELD_LABELS[req] ?? req}".`);
    }
    if (CLIENT_BY_ID_OR_NAME.includes(entity) && !mapping.client_external_id && !mapping.client_name) {
      return toast.error("Choose a column for the client: their ID in your old system, or their name.");
    }
    if (
      entity === "dogs" &&
      !mapping.client_external_id &&
      !mapping.client_email &&
      !mapping.client_phone &&
      !mapping.client_name
    ) {
      return toast.error(
        "Choose a column for the client: their ID in your old system, email, phone or name.",
      );
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
    <section className="space-y-4 rounded-lg border bg-card p-(--card-pad)">
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
          {entity === "services" && offersServiceColumn && (
            <>
              {" "}
              A Service column says which of your services each plan is for (a walk, a sit, a
              groom). A name you don&apos;t have yet is added to Settings → Services with no price,
              for you to fill in. Days named on a weekly walk (&quot;Mon/Wed/Fri&quot;,
              &quot;weekdays&quot;) become the days it runs.
            </>
          )}
        </div>
      )}

      {source === "jobber" && entity === "services" && (
        <JobberVisitsFile count={visitRows?.length ?? null} onRows={onVisitRows} />
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
            <span className="font-medium text-foreground">{headers.length}</span> columns. Each
            column is set from the {SOURCE_LABELS[source]} export; check where each one goes.
          </div>
          <ImportFileNotes
            skipped={skipped}
            visitRows={planColumns ? fileRows.length : null}
            plans={rows.length}
            left={visitPlans?.left ?? []}
          />
          {refused && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive"
            >
              {refused}
            </div>
          )}
          {!isVerifiedSource(source) && (
            <div
              role="status"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
            >
              HoundStack has not seen a real {SOURCE_LABELS[source]} export yet, so this mapping is
              a best guess from its column names. Check where every column goes before you preview;
              every column is still shown on the preview before anything is saved.
            </div>
          )}
          <ColumnMappingTable
            entity={entity}
            headers={headers}
            rows={rows}
            mapping={mapping}
            onChange={(m) => {
              setMapping(m);
              setSuggested((prev) => new Set([...prev].filter((f) => m[f] === mapping[f])));
            }}
            targetFields={targetFields}
            required={required}
            labels={FIELD_LABELS}
            suggested={suggested}
          />
          <div className="flex justify-end">
            <Button onClick={runPreview} disabled={busy || !!refused}>
              {busy ? "Analyzing…" : "Dry-run preview"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
