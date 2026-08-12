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
- Enough RAM for the Vite build. It peaks around 1.5 GB.

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
