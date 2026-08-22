# The iPad was never measured

2026-08-21. A responsiveness pass across every iPhone and iPad size, prompted by
"I'm navigating through and notice quite a few things that are questionable."

They were right, and the reason nothing had caught it is more interesting than
the faults themselves.

## The hole in the net

Three separate mechanisms all stopped at the same place, and the gap between
them was exactly the shape of an iPad.

**1. The sweep measured four widths.** `WIDTHS` in `tests/viewports/rules.ts`
is 360 / 768 / 1280 / 1920 — the four named in CLAUDE.md. That is a good
contract and a poor census: one phone width, one tablet width. The app ships to
a 402pt phone, and the 640-1024 band the working agreement explicitly warns
about ("usually fails between 640 and 1024, which is every tablet") was
represented by a single point at 768.

**2. Touch sizing keyed on WIDTH.** 107 controls across 32 files were spelled
`max-md:min-h-11` — grow the target below 768px. Every iPad is 744px or wider
in portrait and up to 1366 in landscape, all of it touch, and at every one of
those sizes the sizing switched off. Apple's floor is 44pt regardless of how
big the screen is.

**3. The browser had a mouse.** This is the one that made the other two
invisible. Playwright ran desktop Chromium, which reports `pointer: fine` and
`hover: hover`. So:

  * Tailwind 4 compiles every `hover:` and `group-hover:` rule inside
    `@media (hover:hover)` — verified by reading the built stylesheet, not
    assumed. With a mouse those rules apply, so a control that is invisible on
    a real iPad was visible to the sweep.
  * The 44px rule only ran `if (w <= TOUCH_WIDTH)`, and `TOUCH_WIDTH` was 360.
    It never ran at 375, 390, 402 or 430 — every modern iPhone — let alone on a
    tablet.

Turning on `hasTouch` for the Apple pass changed the result from **382 passed /
0 failed** to **277 passed / 105 failed, 2365 findings**. Nothing about the
product changed between those two runs. The first one was measuring a mouse.

## What was actually broken

Every failure was at **820px and up**. 744 passes because `touch:` still
carries the old `max-width: 767px` clause — the boundary is the `md`
breakpoint, exactly as predicted.

| fault | size | where |
|---|---|---|
| **The entire left navigation was a 32px target** | 32.0px | `ui/sidebar.tsx` — `sidebarMenuButtonVariants` size `default: "h-8"` |
| The account avatar button | 32.0px | `AccountMenu.tsx` |
| Delete on a notification row — **invisible, not merely small** | — | `/notifications` |
| Leaflet's own +/- zoom buttons | 30.0px | `RouteMap.tsx` |
| "Complete" — the field tech's primary action | 25.0px | `VisitDetailDrawer.tsx` |
| Bare `<input type=checkbox>` in unpadded labels | 13.0px | client + property drawers |
| A date input | 40.0px | `AiPanels.tsx` |

The sidebar is worth dwelling on. It is the app's primary navigation, it was
under the touch floor on **every touch device that can see it**, and no
width-based rule could ever have caught it — the sidebar is `hidden` below
`md`, so it does not exist at the widths a phone-width sweep measures, and
`max-md:` sizing could not reach it either. It was in a blind spot created by
the very mechanism meant to guarantee it.

## The fix, and why it is one line rather than 107

`src/styles.css` now defines a variant:

```css
@custom-variant touch {
  @media (pointer: coarse), (max-width: 767px) { @slot; }
}
```

Coarse pointer OR narrow viewport. It is a strict SUPERSET of `max-md:`, so
nothing below 768px changed and iPads simply stopped being excluded. The width
clause is kept deliberately: a narrow window on a desktop is still narrow,
mouse or not, and the layouts that reflow there should keep reflowing.

`tests/hover-does-not-exist-on-a-touchscreen.test.ts` now requires `touch:`
rather than accepting `max-md:`. That rule had been checking the wrong
condition since it was written — it asked about width when the thing that is
missing is hover.

**A trap worth knowing about.** The shorthand form

```css
@custom-variant touch (@media (pointer: coarse), (max-width: 767px));
```

compiles to a bare `@media (pointer:coarse)` and **silently drops the width
clause**. Caught by reading the compiled stylesheet. Had it shipped, every
narrow desktop window would have quietly lost the sizing it used to have — a
regression introduced by the fix for a regression, invisible to every test in
this repo. The block form emits both clauses.

## Result

| run | passed | failed | findings | distinct |
|---|---|---|---|---|
| desktop pointer — **meaningless for iPad** | 382 | 0 | 0 | 0 |
| touch emulated, before fixes | 277 | 105 | 2365 | 59 |
| touch emulated, first round of fixes | 362 | 20 | 85 | 13 |
| touch emulated, **final** | **382** | **0** | **0** | **0** |

The first and last rows show the same numbers and mean completely different
things, which is the whole point of this document. The first was a browser with
a mouse agreeing that everything was fine. The last is a browser reporting
`pointer: coarse` and `hover: none` — an iPad — and finding nothing.

## Two fixes that did nothing, and looked like they had

Worth recording, because both would have been reported as done.

**The map zoom override lost to Leaflet on source order.** `RouteMap.tsx`
carried `touch:[&_.leaflet-control-zoom_a]:h-11`. The class was in the source,
it compiled into the stylesheet correctly, and the buttons measured 30.0px in
the browser. Leaflet adds its own `leaflet-touch` class on a touch device and
ships `.leaflet-touch .leaflet-bar a { width:30px; height:30px }` — the SAME
specificity, so the tie went to whichever stylesheet came last, and it was not
this one. The override was being beaten by the exact condition it exists to
handle. It needs `!`.

**"Complete" was in a different file.** The 25px button the sweep kept
reporting was the stop card in `routes.tsx`, not the `VisitDetailDrawer` that
was edited. Two components, same label.

Neither was visible from the source. Both were caught by re-running the sweep
and DIFFING the findings against the previous run — a fix that changes nothing
produces an identical list, which is a signal worth looking for deliberately.

## One exemption, stated rather than silent

Leaflet map pins. A route map draws one per stop, and on a busy day that is
thirty inside a few hundred pixels; at 44px each they overlap, so the pin you
land on is the wrong one and the map stops showing the shape of the route,
which is the only reason it is on the dashboard. Apple's own MapKit
annotations are ~30px for the same reason.

Scoped to `.leaflet-marker-pane` / `.leaflet-overlay-pane`, so it exempts pins
and nothing else — the zoom controls, the attribution links and every control
drawn over the map are still measured. That matters: one of them, Leaflet's
own +/- at 30px, was a real finding this sweep caught. If pins ever become the
primary way to open a stop, this is the thing to revisit.

## The second form of the same bug

Found in the last round, and worth its own heading because it is the exact
inverse and reads as correct:

```
min-h-[2.75rem] … md:min-h-0
```

Set a 44px minimum, then CANCEL it at `md` to get a compact desktop row. Same
substitution of width for input, failing on the same device — an iPad is
≥768px, so the cancel fires and the control drops back to 40px. The Routes day
picker, the Schedule calendar's day cells and two platform links all did this.

`src/styles.css` gained the companion variant:

```css
@custom-variant mouse { @media (pointer: fine) { @slot; } }
```

so `md:mouse:min-h-0` says what was meant: compact it on a wide screen THAT HAS
A MOUSE.

## The finding message had to say where

Half the first round's findings could not be located. A chip labelled
"Mon 17 · 8 visits" is composed at runtime, so grepping the source for the text
the sweep printed returns nothing — which is how two fixes went into the wrong
component and changed nothing while looking correct.

`findControlsUnder44px` now appends a CLASS FINGERPRINT: the padding, height
and type-size utilities, trimmed to six. Those are greppable, and they are what
a fix has to change anyway. Every remaining fault was located within minutes of
adding it:

```
<button type=submit> "All" is 18.0px tall [px-1.5 py-0.5 text-3xs text-muted-foreground]
<button type=button> "Today" is 40.0px tall [min-h-[2.75rem] gap-1.5 rounded-md px-2 text-left]
```

The second line is the `md:min-h-0` bug confessing: a 44px minimum in the class
list and a 40px measurement.

## What the last round fixed

| control | was | where |
|---|---|---|
| **Drag handle — no accessible name AND 16px** | 16.0px | stop card; it is how a stop gets reordered |
| Stop-card select checkbox | 13.0px | square kept small, `::before` takes the tap |
| "All" lane select — a bulk action | 18.0px | |
| "Today" / date-range picker | 40.0px | `md:min-h-0` |
| Week-view day chips, ×7 | 35.0px | `md:min-h-0` |
| My Day's date input | 40.0px | `max-md:hidden` only hides it below 768 |

## How to run it

```bash
npm run test:viewports:apple    # 11 Apple sizes, touch emulated
npm run test:viewports:auth     # the canonical four widths — the CI gate
```

The CI gate is deliberately unchanged: same four widths, same desktop pointer,
same runtime. The Apple pass is the wider net, and it is slower (~9 minutes)
because it is 11 sizes rather than 4.
