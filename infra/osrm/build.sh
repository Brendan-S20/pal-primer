#!/usr/bin/env bash
# Build an OSRM routing graph for one region.
#
#   ./build.sh new-york
#   ./build.sh delaware
#
# Region names are Geofabrik basenames under north-america/us. The whole US is
# `north-america/us` but read the README before trying it: preprocessing the
# full country is a different size of job from a state, and this script will
# happily start it and then be killed by the OOM reaper three hours in.
set -euo pipefail

REGION="${1:?usage: ./build.sh <geofabrik-region>, e.g. new-york}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/data"
IMAGE="ghcr.io/project-osrm/osrm-backend:latest"
URL="https://download.geofabrik.de/north-america/us/${REGION}-latest.osm.pbf"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f "${REGION}.osm.pbf" ]; then
  echo "==> downloading ${REGION}"
  curl -fL --progress-bar -o "${REGION}.osm.pbf" "$URL"
fi
echo "    pbf: $(du -h "${REGION}.osm.pbf" | cut -f1)"

# MLD rather than CH. Customisation is minutes instead of hours, which is what
# makes a monthly refresh of the map data a routine job rather than an event.
run() { docker run --rm -v "$DIR:/data" "$IMAGE" "$@"; }

echo "==> extract"
run osrm-extract -p /opt/car.lua "/data/${REGION}.osm.pbf"
echo "==> partition"
run osrm-partition "/data/${REGION}.osrm"
echo "==> customize"
run osrm-customize "/data/${REGION}.osrm"

echo "==> done: $(du -sh "$DIR" | cut -f1) on disk"
echo "    REGION=${REGION} docker compose up -d"
