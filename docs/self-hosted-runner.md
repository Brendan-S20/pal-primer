# Running CI on your own machine

On 2026-08-10 GitHub's hosted runners stopped being allocated to this
repository. Every run from 13:42Z onward reported `runner_id: 0`, an empty
runner name, no steps, no logs and **zero billable milliseconds**, finishing in
about ten seconds. The last healthy run was 13:18:53Z, with a real runner and
real billable time, on a workflow file byte-identical to the failing one. Three
different trigger types behaved the same way, so it was neither the commit nor
the config.

This document is what to do when that happens: point CI at a machine you
control, and — the part that matters more — point it back.

## The switch

`.github/workflows/ci.yml` reads a repository variable:

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
```

| `CI_RUNNER` | where `verify` runs |
| --- | --- |
| unset (default) | GitHub's hosted runners |
| `self-hosted` | your registered runner |

Set it at **Settings → Secrets and variables → Actions → Variables**. It takes
effect on the next run; there is no commit and no PR.

The `migrations` job deliberately ignores this and always uses a hosted runner.
It shells out to `psql`, which comes with `ubuntu-latest` and almost certainly
is not on your laptop, and it is the job that holds `SUPABASE_DB_URL` and
`STRIPE_SECRET_KEY`. It runs only on main and on manual dispatch.

## Why it is a variable and not just `self-hosted`

Because of what Actions does when no matching runner is online. The job does
not fail. It **queues**, and it goes on queueing for **24 hours** before GitHub
terminates it.

So hardcoding `self-hosted` means that every time your machine is asleep, every
push — and every merge to main, which is the hard migration gate — produces a
check that is neither red nor green for a day and then fails for a reason that
has nothing to do with the code. A red X gets fixed. A check that sits pending
overnight teaches people to stop looking at checks.

Deleting one repository variable puts everything back on hosted runners in a
single click. That is the whole reason for the indirection.

## Setting the runner up

You need repo admin for this; a scoped token cannot do it, which is why this is
a runbook and not a script.

1. **Settings → Actions → Runners → New self-hosted runner**, and pick your OS.
2. GitHub shows a download block and a `./config.sh` line containing a
   registration token. **That token expires in one hour** — if you come back to
   it later, reload the page for a fresh one.
3. Run the commands it gives you. When it asks for labels, the defaults are
   fine; `self-hosted` is applied automatically and is what the workflow asks
   for.
4. Start it. `./run.sh` runs it in the foreground, which is the honest way to
   try it the first time — you will see the job arrive. To have it survive a
   reboot, install it as a service instead:
   - macOS / Linux: `sudo ./svc.sh install && sudo ./svc.sh start`
   - Windows: the config script offers to run it as a service.
5. Set `CI_RUNNER` to `self-hosted` as above.

Then push anything, or re-run a failed job, and watch it land locally.

## What the machine needs

The `verify` job installs its own Node — `actions/setup-node@v4` downloads
Node 22 into the runner's tool cache — so a clean machine mostly works. What it
does need:

- **git**, **curl** and **tar**, which the runner installer itself requires.
- About **2 GB** of free disk for `node_modules` plus build output, and more if
  you keep several workspaces.
- **RAM, and this line used to understate it badly.** It said "enough RAM for
  the Vite build, it peaks around 1.5 GB", which is true of the build's own
  footprint and close to useless as a requirement. What matters is 1.5 GB
  **free at the moment the build runs**, on a machine that is also holding
  Docker, a browser sweep and whatever you have open. On 2026-09-15 this
  machine had 16 GB of RAM, a swap file **94% full**, 277 million swapouts and
  a load average of 59-73 on 8 cores — and the builds died. See
  `docs/owner-actions-before-submission.md` §12, and the sixth entry under
  "Reading a failure" below.

The whole job is roughly three minutes: `npm ci` 17s, typecheck 47s, tests 33s,
build 37s, dead-machinery 2s, lint 34s.

## What is different about a self-hosted runner

Worth knowing before the first surprising result.

- **The workspace persists between runs.** A hosted runner is destroyed after
  every job; yours is not. `npm ci` deletes `node_modules` before installing so
  dependencies stay honest, but stray files a build leaves behind will still be
  there next time. If a run fails in a way that makes no sense, delete
  `_work/` in the runner directory and run it again.
- **Jobs can wedge**, and a wedged job holds the machine rather than being
  reaped with a disposable VM. Hence `timeout-minutes: 20` on the job — about
  seven times its normal length.
- **Anything a workflow runs, runs as you.** That is safe here because this
  repository is private and not a fork, so nobody outside the repo can open a
  pull request that executes code on your machine. It would NOT be safe on a
  public repo, and GitHub's own documentation says so — if this repository is
  ever made public, delete `CI_RUNNER` and remove the runner first.

## Reading a failure

Six things that look alike on the Actions page and are not. Written on
2026-09-09 after a day of hitting four of them, including two I diagnosed
wrongly first; a sixth was added on 2026-09-15 after a day of hitting only that
one, eight times. The discriminator is given for each, because guessing costs a
ten-minute run.

**Never picked up.** The job sits `queued` with no `runner_id`, no steps and no
logs, and finishes in about two seconds with zero billable milliseconds. That
is a job that never received a machine. On hosted runners this was the failure
that moved `verify` here in the first place.

**Killed mid-run.** Steps recorded, tests streaming green, then:

```
##[error]Process completed with exit code 130.
##[error]The runner has received a shutdown signal.
```

Exit 130 is SIGINT. Somebody stopped or restarted the runner service, or the
machine slept, while a job was running. **Not a code failure**, and the log
proves it: every test above the error reports a pass. Re-run it.

**Slow, not stuck.** `setup-node` on this machine takes about six and a half
minutes against roughly two on a hosted runner, and a whole run lands near ten.
That is normal here. I called it wedged at four minutes and was wrong; the same
step then completed successfully at 6m39s. Before concluding a step has hung,
compare it against a step that completed on the same machine rather than
against a hosted baseline.

**The machine is out of memory.** The newest of these and the hardest to see,
because it does not present as a resource problem — it presents as your code
being broken, in three different disguises:

```
✓ built in 9.24s
sh: line 1: 93391 Bus error: 10           vite build
##[error]Process completed with exit code 138.
```

Exit 138 is SIGBUS. Vite, esbuild and rolldown all read through `mmap`, and when
the kernel cannot back a memory-mapped page the access raises SIGBUS rather than
ENOMEM. Read those two lines together: **the build reported success and was then
killed.** Nothing about a diff does that.

The same pressure also produces Playwright specs failing on `toBeVisible()` or
`page.goto` after 90 seconds, and viewport specs failing on assertions about
geometric *stability* — the first thing to break when frames arrive late. On
2026-09-15 this machine produced **eight such failures in one day**: three
SIGBUS builds and five viewport flakes. Every one passed on a re-run. One of
them cost an afternoon chasing a search bar that was never involved.

**The discriminator** is two commands, and it is worth running them before
reading anything else:

```
sysctl vm.swapusage        # swap above ~50% used is the tell
uptime                     # load far above your core count
```

Both `ci.yml` and `sandboxes.yml` now run this automatically and emit a
`::warning::` with the numbers, so recent runs carry their own answer. If you
see that warning above a failure, **re-run once before believing the failure**.
`retries: 0` in `playwright.config.ts` means a single flake fails a whole run
and is indistinguishable from a real finding until somebody does.

**Queued behind another workflow.** `ci.yml` shows nothing in progress and
three runs queued, which reads exactly like a dead runner. It is one runner and
`sandboxes.yml` was using it: the database job and the four-width browser sweep
together run about twenty minutes. Check for in-progress runs **across all
workflows** before deciding the runner is stuck. Filtering to `ci.yml` is what
nearly sent me to ask for a restart that was not needed.

**A native panic in a build dependency.** Typecheck and the full suite pass,
then the build dies:

```
thread '<unnamed>' panicked at lightningcss/src/printer.rs:350:30:
byte index 2 is out of bounds of ``
sh: line 1: 72429 Abort trap: 6           vite build
##[error]Process completed with exit code 134.
```

Exit 134 is SIGABRT. This is nondeterministic: the same commit was built twice
locally and passed both times, and passed in CI on the next run. It is not the
runner and not the diff. Re-run once; if it recurs often, pin or replace the CSS
minifier rather than living with it.

### Before blaming the machine

A rule that would have saved two of the above. **A job that recorded steps did
not fail to start**, and **a job whose tests all passed did not fail on the
code** -- so read the last step and the exit code before forming a theory. Exit
130 and exit 134 are both "something killed the process", and neither is a
reason to look at the branch.

## Turning it off

Delete the `CI_RUNNER` variable. That is enough — the next run goes to hosted
runners whether or not the runner is still registered.

To remove the runner as well: **Settings → Actions → Runners**, select it,
Remove; or run `./config.sh remove --token <a fresh removal token>` on the
machine. If you installed it as a service, `sudo ./svc.sh stop && sudo ./svc.sh
uninstall` first.

## If you would rather not do any of this

`scripts/ci-local.sh` runs the same gates in the same order as the `verify`
job — typecheck, the full test suite, the build with its service-worker check,
and dead-machinery — on whatever machine you are on. It is what has been
gating this branch while hosted runners were unavailable. It produces no green
check on GitHub, which is its only real shortcoming.
