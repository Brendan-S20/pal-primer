import { useEffect, useRef, useState, type RefObject } from "react";
import { createMapRenderer } from "./create";
import { googleRefused, onGoogleRefused } from "./google-loader";
import type { MapRenderer, MapSurfaceOptions } from "./types";

/** A map that scrolls INTO view waits this long before it is created, so one
 *  flung past on the way down the page is never paid for. A map that is on
 *  screen at first paint is created at once — making somebody wait 200ms for
 *  the map they opened the page to see would be the wrong trade. */
const SCROLL_IN_DWELL_MS = 200;

/**
 * One map for the lifetime of the component, created when — and only when —
 * its container is actually on screen.
 *
 * Returns `null` until then. Components draw their overlays in effects keyed
 * on the renderer AND their data, so a data change moves overlays on the map
 * that exists and never makes another one. That is the whole cost design in
 * one sentence: Google bills per map created, and pans, zooms and redraws are
 * free (see google-renderer.ts for the pool that also makes unmount/remount
 * free).
 *
 * "On screen" is an IntersectionObserver, which also answers "is it hidden":
 * a `display: none` container, a collapsed panel or a closed tab never
 * intersects, so it never loads. A dialog that has not been opened has no
 * container at all.
 *
 * Options are read when the map is created, not on every render: changing
 * them later does nothing, by design. Callers move the view with `setView` /
 * `fitBounds` and switch imagery with `setStyle`.
 */
export function useMapRenderer(
  containerRef: RefObject<HTMLElement | null>,
  options: MapSurfaceOptions,
): MapRenderer | null {
  const [renderer, setRenderer] = useState<MapRenderer | null>(null);
  // The LATEST options at the moment of creation, which can be well after
  // the first render (the map waits for the screen): a centre that arrived in
  // the meantime should be where the map opens.
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // A map is never mirrored. In Arabic the page around it reads right to
    // left (lib/i18n puts dir="rtl" on <html>), but west is still on the left
    // and the provider lays out its own controls and attribution for a
    // left-to-right box, so the container opts out of the page's direction.
    el.setAttribute("dir", "ltr");
    let disposed = false;
    let creating = false;
    let current: MapRenderer | null = null;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    let io: IntersectionObserver | null = null;

    const create = () => {
      if (disposed || creating || current) return;
      creating = true;
      io?.disconnect();
      void createMapRenderer(el, optsRef.current).then((r) => {
        creating = false;
        if (disposed) {
          r.destroy();
          return;
        }
        // Google refused the key while this map was being built: the refusal
        // found no map here to swap, so swap it now rather than keep a map
        // that will only ever show Google's error.
        if (r.provider === "google" && googleRefused()) {
          r.destroy();
          create();
          return;
        }
        current = r;
        setRenderer(r);
      });
    };

    // Google refused the key after this map was drawn: swap to the fallback in
    // place. Components redraw because the renderer they depend on changed.
    const unsubscribe = onGoogleRefused(() => {
      if (disposed || !current || current.provider !== "google") return;
      const refusedMap = current;
      current = null;
      // The swap must not depend on tearing down a map Google has already
      // torn down. This runs inside Google's own gm_authFailure call, where a
      // throw is swallowed without a word: that is how a refused key once left
      // a dead map on screen instead of the fallback.
      try {
        refusedMap.destroy();
      } catch {
        /* nothing left to tear down */
      }
      setRenderer(null);
      create();
    });

    if (typeof IntersectionObserver === "undefined") {
      create();
    } else {
      let first = true;
      io = new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (first) {
          first = false;
          if (visible) {
            create();
            return;
          }
        }
        clearTimeout(dwell);
        if (visible) dwell = setTimeout(create, SCROLL_IN_DWELL_MS);
      });
      io.observe(el);
    }

    return () => {
      disposed = true;
      io?.disconnect();
      clearTimeout(dwell);
      unsubscribe();
      current?.destroy();
      current = null;
    };
  }, [containerRef]);

  return renderer;
}
