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

Delaware, as a pipeline check:

| stage | peak RAM | time |
|---|---|---|
| `osrm-extract` | 602 MB | ~2 min incl. image pull |
| `osrm-partition` | 214 MB | seconds |
| `osrm-customize` | 113 MB | seconds |
| graph on disk | 172 MB from a 21 MB extract | |

Serving Delaware sits comfortably under 1 GB and answered a real Wilmington
route with correct street names.

**The ratios worth carrying:** the on-disk graph runs about **8x the PBF**, and
peak preprocessing RAM about **30x the PBF**. Those are what to size a machine
with, and they are why the next section says what it says.

## Do NOT start with the whole United States

`north-america/us` is roughly 11-13 GB of PBF. At the ratios above that is a
preprocessing job wanting tens of GB of RAM and a good few hours, and a box
that cannot do it does not fail politely -- `osrm-extract` is killed by the OOM
reaper well into the run, leaving a part-written graph.

**Start with the states you actually serve.** A pet-waste round is metro-local:
no technician is routed from Buffalo to San Diego, so a national graph buys
nothing for the shape of this business. One container per state, or per metro,
is both cheaper and faster to refresh.

If national coverage is genuinely wanted later, preprocess **once** on a large
temporary instance and serve the finished graph from a small one. Serving needs
far less memory than building.

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
