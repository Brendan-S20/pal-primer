# Restore drill

A backup nobody has restored is a hope. This page covers how the nightly
encrypted backups are proved to bring the production database back: every
week on its own, and by hand when that is not enough. It also covers how to
record the result on #720.

`docs/backups-and-restore.md` is the wider runbook (what is in a backup,
where it is kept, how to restore into a new project or bring back one
tenant). This page covers only the drill.

## The weekly drill (the default)

The owner's decision, 2026-11-10: "Yes, run the weekly restore drill on a
GitHub runner."

`.github/workflows/restore-drill.yml` runs every Wednesday at 08:30 UTC, an
hour after that morning's backup, and on demand (Actions, Restore drill,
Run workflow). On a GitHub-hosted `ubuntu-latest` runner it:

1. checks `BACKUP_PASSPHRASE` is set, without reading its value. If it is
   not, the drill job is **skipped**, and the preflight job's warning says
   which secret to add;
2. finds the newest unexpired `db-backup` artifact from a Backup run on
   `main`, and **fails** if there is none (no backup in 30 days is a
   failure, not a skip);
3. downloads that archive and its summary, and runs
   `scripts/restore-drill.sh` on them. That restores into a throwaway
   Supabase stack inside the job, on a random local port range, and runs
   every check below. Any failed check fails the job, and GitHub emails a
   failed scheduled run;
4. writes the PASS/FAIL lines to the run's summary page.

The only secret it uses is `BACKUP_PASSPHRASE`, the one `backup.yml` already
seals with. It is given no database URL. The restore target is refused
unless it is 127.0.0.1, localhost or ::1, so the decrypted data can only go
into the database on that VM. GitHub destroys the VM when the job ends, and
the drill deletes the decrypted files before that, pass or fail. The log
holds counts, table names and PASS/FAIL only.

`backup.yml` still has its own Sunday `restore-drill` job, which restores
the backup it has just made and checks row counts and foreign keys. Its
first green run was Backup run #39 on 2026-11-08. The Wednesday drill adds
the deeper checks and tests a mid-week backup, so a backup that stops
restoring is found within four days.

## The migration ledger, and why older backups fail

No backup carried the migration ledger before this change. `supabase db
dump` leaves the `supabase_migrations` schema out, so a project restored from
a backup had every table and no record of which migrations made them. Its
first `supabase db push` would try to apply all of them on top.
`scripts/backup/dump.sh` now writes the ledger into `extension-state.sql`.

**Every backup made before this change is merged will FAIL the `ledger`
check**, in the weekly drill and by hand. That is a true finding about those
backups, not a fault in the drill. After merging, run Backup once by hand
(Actions, Backup, Run workflow, on `main`). Then run Restore drill by hand
and confirm it passes.

## The by-hand drill (the fallback)

Use this when the weekly drill cannot run: GitHub-hosted runners are not
being allocated to the repository (see the known risk in `backup.yml`), the
passphrase secret is gone, or you want to look at a restored copy yourself.

### Who runs it

The owner, or someone the owner trusts with every customer's data. The
backup holds every login, address, note and invoice. Whoever runs this
needs the backup passphrase, which lives in the owner's password manager.

### Where

On a machine you control: your own laptop or desktop, with full-disk
encryption on. Not a self-hosted runner and not a shared machine: the
drill decrypts the whole database onto that disk for a few minutes.

### What you need

- Docker running (Docker Desktop on a Mac).
- The Supabase CLI: `brew install supabase/tap/supabase`.
- `psql` (Postgres 17 client): `brew install libpq`, then put it on PATH.
- `gpg`: `brew install gnupg`.
- Node 20 or later.
- About 5 GB free disk, and a fast connection the first time (the CLI pulls
  its images once).

### The exact commands

#### 1. Make a fresh backup (only if the newest one predates this change)

GitHub, Actions, Backup, Run workflow, on `main`. Untick the drill box if
you like; it does not matter for this. Wait for it to go green (about two
minutes).

#### 2. Download the backup and its summary

From that run's page, download the two artifacts `db-backup` and
`db-backup-summary`. Unzip both into a folder only you can read:

```sh
mkdir -p ~/restore-drill && chmod 700 ~/restore-drill
cd ~/restore-drill
unzip ~/Downloads/db-backup.zip
unzip ~/Downloads/db-backup-summary.zip
ls   # houndstack-db-<stamp>.tar.gz.gpg  summary.json
```

#### 3. Run the drill

From a checkout of this repo, on current `main`:

```sh
cd ~/code/pal-primer
git pull
BACKUP_ARCHIVE=~/restore-drill/houndstack-db-<stamp>.tar.gz.gpg \
BACKUP_SUMMARY=~/restore-drill/summary.json \
  scripts/restore-drill.sh 2>&1 | tee ~/restore-drill/drill.log
```

gpg asks for the passphrase. Paste it from the password manager. Do not
put it in the command line or export it in your shell: if `BACKUP_PASSPHRASE`
is set, the drill uses it, but asking at the prompt keeps it out of shell
history and out of every child process's environment.

The drill:

1. refuses to start if `DOCKER_HOST` points at another machine;
2. checks the archive's sha256 against the summary;
3. decrypts into a temp folder;
4. starts a brand-new Supabase stack from an empty folder, on a random free
   port range between 55000 and 64999, so it never touches this repo's own
   local stack (544xx) or CI's (545xx);
5. refuses to continue unless that stack's database URL is 127.0.0.1,
   localhost or ::1, before anything is loaded into it;
6. restores roles, schema and data in one transaction, with every cron job
   switched off;
7. checks every table's row count against the dump, and every foreign key;
8. runs the five checks below;
9. stops the stack and deletes the decrypted files, pass or fail.

It prints table names, counts and PASS/FAIL. It never prints a row, the
passphrase, or a connection string.

#### 4. Clean up

```sh
rm -rf ~/restore-drill
```

The archive is encrypted, but there is no reason to keep a copy outside
GitHub.

## What PASS looks like

The end of the output, from the self-test on seed data (your numbers will
be production's):

```
180 of 180 tables restored with exactly the rows the backup holds
  public.organizations   backup        1   restored        1
  ...
NOTICE:  all 343 foreign keys in public/reference hold
restore verified

checks on the restored database:
PASS  tables  140 of 140 public tables and views the migrations create are present (140 in the restored public schema)
PASS  rows    key tables present and organizations is not empty
        organizations           1
        clients                10
        visits                149
        invoices               34
        staff                   1
PASS  rls     140 of 140 public tables have row level security on
PASS  auth    auth schema present, auth.users has 1 row(s)
PASS  ledger  512 migration(s) recorded, newest 20261109200000 (this checkout's newest file: 20261109200000)

RESTORE DRILL: PASS in 22s
```

The last line is the verdict. Anything else ends in
`RESTORE DRILL: FAIL -- <reason>` and a non-zero exit.

| Check | Fails when |
|---|---|
| row counts | any table has a different count from the dump, or a key table is missing |
| foreign keys | any foreign key in `public` or `reference` does not hold |
| `tables` | a public table or view the migrations leave behind is missing (the list is printed) |
| `rows` | `organizations`, `clients`, `visits`, `invoices` or `staff` is missing, or `organizations` is empty |
| `rls` | any public table has row level security off (the list is printed) |
| `auth` | no `auth` schema, no `auth.users`, or no users in it |
| `ledger` | `supabase_migrations.schema_migrations` is absent or empty |

If `ledger` says the backup's newest migration is older than your
checkout's newest file, that is expected when migrations merged after the
backup was taken. It is not a failure.

## How long it takes

On the seed data, on a Linux cloud machine with the Supabase images already
pulled (2026-11-10):

- seed and backup: 9 to 10 seconds
- drill: 22 to 25 seconds
- self-test total: 34 to 37 seconds

The first run on a machine pulls the Supabase images, which takes several
minutes on top. Production is larger: the hosted weekly drill took about 60
seconds for its restore step on 2026-11-08. Allow ten minutes for a first
drill on a laptop.

## Recording the result on #720

For the weekly drill, post a link to the Restore drill run and paste the
PASS/FAIL block from its summary page as code. The first green run after
this merges is the evidence #720 is waiting for.

For a drill by hand, post a comment on #720 with:

- the date, who ran it, and the machine type (for example "MacBook Air M2,
  macOS 15"), not its name or IP;
- the backup's file name and the Backup run number it came from;
- the commit of this repo you ran it from (`git rev-parse --short HEAD`);
- the summary block from `drill.log`, from `checks on the restored
  database:` to the `RESTORE DRILL:` line, pasted as code;
- the total time.

Do not attach `drill.log` itself or paste anything above the summary block
without reading it first. It holds only names and counts, but the habit of
checking before posting from a run over customer data is the one worth
keeping.

A FAIL is worth recording too. Post it the same way, and open an issue for
whatever it found.

## The CI self-test

`scripts/restore-drill-selftest.sh` proves all of the above on data that
belongs to nobody. It seeds the local stack with one made-up business (every
address on `.invalid`), backs it up with the same `crypt.sh check`,
`dump.sh`, `crypt.sh seal` and `summarize.mjs` the nightly job runs, under a
passphrase generated for the run, and then runs `scripts/restore-drill.sh`
on that archive.

It runs in the `database` job of `.github/workflows/sandboxes.yml`, after
the E2E suite, on the stack that job builds from the migrations. That job
needs `gpg` on its runner.

To run it yourself:

```sh
supabase start                     # this checkout's stack
scripts/restore-drill-selftest.sh
```

`tests/a-backup-is-proved-by-bringing-it-back.test.ts` pins the parts that
must not drift: the localhost guard, each check failing on the restore it
exists to catch, the ledger in the backup, and that only `backup.yml` and
`restore-drill.yml` read a production backup. For the weekly workflow it
also pins hosted runners, read-only permissions, `BACKUP_PASSPHRASE` as the
only secret, and the skip when that secret is missing.
