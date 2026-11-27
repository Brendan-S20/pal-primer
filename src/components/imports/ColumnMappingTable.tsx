import { X } from "lucide-react";
import {
  assignColumn,
  dropField,
  fieldsByColumn,
  sampleValues,
  type ColumnMapping,
} from "@/lib/import-column-map";
import { helperRole, isOtherPhoneColumn } from "@/lib/import-leftovers";

/** Where a column no field reads ends up, per kind of import (#857). */
const KEPT_WHERE: Record<string, string> = {
  clients: "Kept on the client as a note",
  services: "Kept in an office note on the client",
};

/**
 * The mapping step, one row per column of the owner's file: its name, a few
 * of its values, and where it goes. Every column has a destination before
 * anything is saved: a field, or kept as a note on the record. The owner
 * changes any of them here; nothing is written until the preview's commit.
 */
export function ColumnMappingTable({
  entity,
  headers,
  rows,
  mapping,
  onChange,
  targetFields,
  required,
  labels,
  suggested,
}: {
  entity: string;
  headers: string[];
  rows: Record<string, unknown>[];
  mapping: ColumnMapping;
  onChange: (m: ColumnMapping) => void;
  targetFields: readonly string[];
  required: readonly string[];
  labels: Record<string, string>;
  suggested: ReadonlySet<string>;
}) {
  const byColumn = fieldsByColumn(mapping, headers, targetFields);
  const label = (f: string) => labels[f] ?? f;
  const keptWhere = KEPT_WHERE[entity] ?? "Kept in the record's notes";
  const unfilled = targetFields.filter((f) => !mapping[f]);
  const missingRequired = unfilled.filter((f) => required.includes(f));
  const optionalUnfilled = unfilled.filter((f) => !required.includes(f));
  const columns = headers.filter((h) => h.trim() !== "");
  const kept = columns.filter((h) => !byColumn.get(h)?.length && !helperRole(entity, h));

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {columns.length - kept.length} of {columns.length} columns go to a field; {kept.length}{" "}
        {kept.length === 1 ? "is" : "are"} kept as a note. Change where any column goes before you
        preview. Nothing is saved until you commit the preview.
      </p>
      <div className="relative overflow-x-auto rounded-md border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Column in your file</th>
              <th className="px-3 py-2 font-medium">Sample values</th>
              <th className="px-3 py-2 font-medium">Goes to</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((h) => {
              const fields = byColumn.get(h) ?? [];
              const helper = fields.length ? null : helperRole(entity, h);
              const samples = sampleValues(rows, h);
              return (
                <tr key={h} className="border-t align-top" data-column={h}>
                  <td className="px-3 py-2 font-mono text-xs">{h}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {samples.length ? samples.join(" · ") : <em>blank in every row</em>}
                  </td>
                  <td className="space-y-1 px-3 py-2">
                    <select
                      aria-label={`Where "${h}" goes`}
                      value={fields[0] ?? ""}
                      onChange={(e) =>
                        onChange(assignColumn(mapping, h, e.target.value || null, targetFields))
                      }
                      className="block w-full rounded border bg-background px-2 py-1.5 text-sm"
                    >
                      <option value="">{helper ?? keptWhere}</option>
                      {targetFields.map((f) => {
                        const from = mapping[f];
                        const elsewhere = from && from !== h ? ` (now from ${from})` : "";
                        return (
                          <option key={f} value={f}>
                            {label(f)}
                            {required.includes(f) ? " *" : ""}
                            {elsewhere}
                          </option>
                        );
                      })}
                    </select>
                    {!fields.length &&
                      entity === "clients" &&
                      mapping.primary_phone &&
                      isOtherPhoneColumn(h) && (
                        <span className="block text-xs text-muted-foreground">
                          Also the phone on rows where {mapping.primary_phone} is blank, when it is
                          a full number.
                        </span>
                      )}
                    {fields[0] && suggested.has(fields[0]) && (
                      <span className="text-xs text-amber-700 dark:text-amber-300">
                        Suggested from the column name: check it.
                      </span>
                    )}
                    {fields.slice(1).map((f) => (
                      <span
                        key={f}
                        className="mr-1 inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-0.5 text-xs"
                      >
                        Also: {label(f)}
                        <button
                          type="button"
                          aria-label={`Stop using "${h}" for ${label(f)}`}
                          onClick={() => onChange(dropField(mapping, f))}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3 w-3 shrink-0" />
                        </button>
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {missingRequired.length > 0 && (
        <p className="text-xs text-destructive">
          Still needed: {missingRequired.map(label).join(", ")}. Pick the column that holds it.
        </p>
      )}
      {optionalUnfilled.length > 0 && (
        <p className="text-xs text-muted-foreground">
          No column for: {optionalUnfilled.map(label).join(", ")}.
        </p>
      )}
    </div>
  );
}
