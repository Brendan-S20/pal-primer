# Self-hosted routing

The planner reads real driving distances from OSRM. This directory runs it.

Point `OSRM_URL` at this and nothing else in the codebase changes; on a routing
failure `drive_minutes()` falls back to its straight-line estimate, so the
worst case is the behaviour we had before any of this existed.

```
cd infra/osrm
./build.sh new-york              # download + preprocess, once per region
REGION=new-york docker compose up -d
curl 'http://localhost:5000/route/v1/driving/-73.98,40.75;-73.96,40.78'
```

Then set `OSRM_URL=http://<host>:5000` wherever the app runs.

## Why self-hosted, and what it actually buys

`router.project-osrm.org` is a demo server. Its operators say plainly it is not
for production, there is no SLA, and it is rate limited. Running our own means:

- **No third-party dependency on the dispatch path.** A pet-waste business
  routing at 6am is not going to be told to wait for somebody else's demo box.
- **A matrix cap we choose.** The demo server allows 100 coordinates per Table
  request; `--max-table-size 200` here, and `OSRM_MAX_TABLE` in the app so the
  two agree.
- **No customer coordinates leaving our infrastructure.** Every stop we route
  is a customer's home address. Sending those to a public demo endpoint is a
  privacy question we would rather not have to answer, and it is the same
  question already open for Nominatim geocoding.
- **Map data we control the age of.** `osrm-customize` is minutes under MLD, so
  refreshing the map monthly is a cron job, not an event.

## Measured, on a 2026-vintage laptop, Docker limited to 8 GB

Two regions, both built and the small one served end to end.

| region | PBF | extract peak RAM | extract time |
|---|---|---|---|
| Delaware | 21 MB | 602 MB | ~2 min incl. image pull |
| **New York** | **480 MB** | **5.2 GB** | **4.5 min** |

Delaware's `osrm-partition` peaked at 214 MB and `osrm-customize` at 113 MB;
the finished graph was 172 MB on disk from a 21 MB extract. Serving it stayed
under 1 GB and answered a real Wilmington route with correct street names.

**Peak RAM is roughly 11x the PBF at state scale**, not the ~30x that Delaware
alone suggests. Small extracts carry a fixed overhead that stops mattering
almost immediately, and an early version of this file extrapolated Delaware's
ratio to New York, predicted 14 GB, and was wrong by nearly 3x. Measure the
region you actually intend to run.

On-disk graph is about **8x the PBF**.

**A whole state fits comfortably in 8 GB and builds in under five minutes.**
That is the number that matters, because it is the unit this product routes in.

## Do NOT start with the whole United States

`north-america/us` is roughly 11-13 GB of PBF. Even at the kinder 11x ratio
that is well over 100 GB of RAM for preprocessing, and a box that cannot do it
does not fail politely -- `osrm-extract` is killed by the OOM reaper deep into
the run, leaving a part-written graph.

**Start with the states you actually serve.** A pet-waste round is metro-local:
no technician is routed from Buffalo to San Diego, so a national graph buys
nothing for the shape of this business. One container per state is cheaper,
faster to refresh, and fails in one state at a time.

If national coverage is genuinely wanted later, preprocess **once** on a large
temporary instance and serve the finished graph from a small one. Serving needs
far less memory than building.

## The cache does almost all of the work

Measured on the demo organization over 28 days: **412 visits, 110 distinct
addresses.** The full pairwise matrix for those is 11,990 directed legs -- a
one-time cost, after which recurring customers mean nearly every leg is a cache
hit and the routing engine is barely consulted.

That is why this can be a small box, and why a paid API would also be cheap if
you ever preferred one: you pay for the first month and then for churn.

`road_legs` rows expire after 90 days, so the cache re-measures itself against
a refreshed map rather than answering with 2026's roads for ever, and
`prune_road_legs()` drops rows whose endpoint is no longer a live property --
because every row is a pair of coordinates where a customer lives, and a
distance cache is exactly the derived table that keeps holding an address after
the obvious places have been cleared.

## Operating it

- **Refresh monthly.** Re-run `./build.sh <region>`; Geofabrik publishes daily.
  Under MLD only `osrm-customize` must re-run for traffic-free updates, but a
  full rebuild is simplest and still cheap at state size.
- **The healthcheck asks for a route, not a port.** A container with no graph
  loaded is up and answers 400. "Up" is not the question.
- **Watch for `Ok` in the app logs.** `refreshRoadLegs` logs and returns 0 on
  every failure, so a misconfigured `OSRM_URL` shows up as routes quietly
  staying on estimates rather than as an error. If road_legs stops growing,
  that is the symptom.
