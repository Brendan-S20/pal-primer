# Competitor export fixtures (#857)

Each file carries the column headers a vendor's own documentation or sample
file lists, with invented rows: no real customer data. A fixture exists only
where the vendor published the headers; a vendor with a documented export
path and no column list gets no fixture until a real file is in hand
(`tests/an-import-comes-in-as-it-was-exported.test.ts` lists those as
sample-needed).

| File | Source of the headers |
| --- | --- |
| `jobber-official-sample.csv` | Jobber help center, "Export client information", sample file `jobber-clients-sample-file.csv` |
| `jobber-live-export.csv` | Jobber "How to make mass updates to clients" plus a real Clients and properties export (the header list pinned in `tests/jobber-import.test.ts`) |
| `jobber-recurring-jobs.csv` | A real export, unedited: Jobber trial, Insights > Reports > Recurring jobs, All Columns (2026-11-27). Three per-visit jobs for invented clients |
| `jobber-visits.csv` | A real export, unedited: the same trial's Insights > Reports > Visits, All Columns, Aug 2026 to Mar 2027. Joined to the jobs by Job # for last and next visit |
| `jobber-clients-export.csv` | A real export, unedited: the same trial's Clients > More Actions > Export Clients, CSV |
| `time-to-pet-clients.csv` | Time To Pet, "Exporting client data & mapping locations": Full Name, Address, City, State, Zip Code |
| `time-to-pet-keys.csv` | Time To Pet, "Exporting data from Time To Pet", the Client Keys export |
| `gingr-view-all-owners.csv` | Gingr, "View All Owners Page Reference", the default report fields. The CSV's exact spelling is unverified; this is a best guess at those labels |
