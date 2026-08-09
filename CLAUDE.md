# Working agreements

## Every screen is responsive. All of them, at every size.

Phones, tablets, and desktops from small laptops to very wide monitors. This is
not a phase, a follow-up ticket, or something the mobile routes get and the
office routes do not. A view is not finished until it works at every width.

**Why this is stated as a rule rather than left to taste:** the people using
this product are a one-or-two-truck business. The owner does the office work on
a laptop in the evening and the field work on a phone in a driveway, often on
the same day, often on the same screen. "Desktop app with a mobile version" is
the wrong model — there is one product and it is used from whatever is in the
person's hand.

### What "works" means, concretely

- **No horizontal page scroll, ever.** Wide content — tables, calendars, code,
  diagrams, wide toolbars — scrolls inside its own `overflow-x: auto` container.
  The page body does not.
- **Touch targets are at least 44px.** Not the icon: the button. See
  `ui/dialog.tsx` and `ui/sheet.tsx` for the pattern — a 16px glyph centred in a
  44px box, so nothing looks different and everything is hittable.
- **Nothing important is hover-only.** Hover does not exist on touch. A control
  that appears on `group-hover` is a control a phone user cannot reach.
- **Dense grids reflow, they do not shrink.** A seven-column week or a
  six-row month laid out as one grid does not become usable by getting smaller;
  below the breakpoint it needs a different shape, not a scaled one.
- **Text truncates instead of widening its row.** A flex item is never laid out
  narrower than its own content unless it is allowed to be — `min-w-0` on the
  item, or an overflow other than `visible`. Without that the row grows to fit
  the text, the control beside it goes over the edge, and the `truncate` that
  was meant to prevent all this never engages.
- **Test the narrow end properly.** 320–360px is a real phone, not an edge
  case. A fixed `w-80` popover overflows a 360px viewport.
- **Landscape and tablet are their own sizes.** A layout that only has "phone"
  and "desktop" branches usually fails between 640 and 1024, which is every
  tablet and every split-screen window.

### Before calling any UI work done

Check it at roughly 360px, 768px, 1280px and 1920px. If a view genuinely cannot
work at one of those widths, say so and say why — do not ship it silently broken
and do not quietly narrow the scope to the widths that happened to work.

### Some of this is enforced, so you find out before review

Four of the rules above are checked by tests that scan the whole of `src/`
and name the offending file and line rather than counting violations:

- `tests/hover-does-not-exist-on-a-touchscreen.test.ts` — a `group-hover:`
  that reveals a control must have a `max-md:` escape. Decoration
  (`group-hover:scale-105`) is deliberately not caught.
- `tests/wide-things-that-set-the-width-of-the-page.test.ts` — every raw
  `<table>` with four or more columns needs a horizontal scroll container,
  and must not be inside `overflow-hidden`, which clips the right-hand
  columns away with no scrollbar and no way to reach them. Anything built on
  `<Table>` from `ui/table.tsx` already scrolls and is exempt.
- The same file pins the touch sizing on `ui/tabs.tsx`.
- `tests/a-flex-row-as-wide-as-its-longest-word.test.ts` — every element that
  truncates is traced up through the flex rows it sits in, and each item on
  that chain has to be able to shrink. It parses the JSX rather than matching
  it, because the question is about nesting. Note which end it names: an
  element that carries `truncate` is exempt, because `truncate` includes
  `overflow-hidden` and that is exactly what `min-w-0` would have bought. What
  fails is the wrapper in between — the `flex-1` div with nothing else on it —
  and that is what the failure message points at. Deliberately silent on
  `whitespace-nowrap` alone, on `flex-col`, on grids, and on `shrink-0`.

What is NOT enforced, and still has to be looked at: whether a thing is
centred, whether a layout is merely cramped rather than broken, and whether a
value with no space in it — an address, a link, an id — has somewhere to
break. That last one is the same fault as the truncation rule with a different
trigger, and it cannot be checked mechanically: telling a 40-character signup
URL from an eight-character promo code means knowing the value. A green test
run is not a substitute for opening the page at 360px.

Prior art worth reading rather than rediscovering: `docs/mobile-ux-audit.md`
(2026-07-23) audited the staff app against this standard and its findings are
still the best map of where the weak points are.
