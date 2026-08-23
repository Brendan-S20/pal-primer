#!/bin/zsh
# Puts the guided tour back to "never seen" so TourWalk can run.
#
# Two records have to agree, because the tour reads both: a local one per user
# on the device (added so a failed network read can no longer restart the tour
# on every offline launch) and `user_metadata.tour_seen_at` on the server, which
# is the cross-device record.
#
#   ios/UITests/reset-tour.sh <SIMULATOR_UDID> <email> <password>
set -e
DEVICE="${1:?usage: reset-tour.sh <udid> <email> <password>}"
EMAIL="${2:?}"
PASSWORD="${3:?}"
BUNDLE=consulting.thenorth.houndstack
API=https://api.houndstack.com
ANON="$(node -e "const s=require('fs').readFileSync('src/integrations/supabase/client.ts','utf8');console.log(s.match(/SUPABASE_PUBLISHABLE_KEY = \"([^\"]+)\"/)[1])")"

echo "clearing the server record…"
TOKEN=$(curl -sS -X POST "$API/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
curl -sS -X PUT "$API/auth/v1/user" -H "apikey: $ANON" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"data":{"tour_seen_at":null}}' > /dev/null

echo "clearing the device record…"
xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
sleep 2
DATA=$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)
DB=$(find "$DATA/Library/WebKit" -name "localstorage.sqlite3" | head -1)
[ -n "$DB" ] && sqlite3 "$DB" "delete from ItemTable where key like 'hs:tour-seen:%';"
echo "done — the tour will run on the next launch."
