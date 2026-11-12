# Issue 884: stored coordinates before paid geocoding

These Chromium screenshots use the real `/zones` page and zone drawer with the repository's signed-in backend fixtures. They are **fixture captures**, not screenshots of a live customer account.

| Viewport | Before review fix | After review fix | Existing zone |
| --- | --- | --- | --- |
| 390 × 1000 | [Before](before-390.png) | [After](after-390.png) | [Existing](existing-390.png) |
| 768 × 1000 | [Before](before-768.png) | [After](after-768.png) | [Existing](existing-768.png) |
| 1280 × 1000 | [Before](before-1280.png) | [After](after-1280.png) | [Existing](existing-1280.png) |

“Before” executes the pre-review lookup helper from PR commit `248fe0ed`, preserved in `tests/viewports/fixtures/issue-884-before-center.ts`. “After” executes the current helper. Both use the same Lansing org with a stored point at **42.73, -84.55** and a matching address. Before makes **one mocked geocoder call**; after makes **zero**. Their city-level views intentionally look the same: the fix removes the unnecessary paid call without moving the map. No real paid geocoder is called to generate this evidence.

The existing radius zone is centered at **42.33, -83.05** in Detroit. Opening its editor does not request the new-zone center. The browser checks that each map loads the tile containing its expected point at city zoom, and that opening a new map places no coverage center. Existing geometry remains visible.

## Basemap limitation

The managed environment denies access to `tile.openstreetmap.org` (HTTP 403), and the existing browser-fixture network fence also blocks external maps. To make centering inspectable instead of capturing a blank map, the screenshot test serves **explicitly labeled OFFLINE TEST TILE coordinate grids** at the actual tile URLs requested by Leaflet. These grids are diagnostic test imagery, not real street maps. They do not modify the app's map renderer or geographic viewport. Each capture has a JSON sidecar recording the requested tile URLs, expected center, viewport and mocked geocoder count.

## Reproduce

```sh
SWEEP_CHROMIUM=/usr/bin/chromium npx playwright test issue-884-zone-map-evidence --workers=1
```

The test uses the existing Playwright dev-server configuration. No environment files, feature flags, CI, migrations or setup routes were changed.
