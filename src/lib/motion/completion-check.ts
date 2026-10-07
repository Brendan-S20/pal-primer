import { prefersReducedMotion } from "./reduced-motion";

/**
 * The confirmation a technician sees when a visit is completed: a check that
 * pops in the middle of the screen, draws itself, and fades, with the success
 * haptic My Day already fires (haptic("success") -> hapticSuccess() in
 * src/lib/native.ts on the phone).
 *
 * Imperative and outside React on purpose. The stop card that was tapped is
 * about to re-render as completed, collapse, and possibly move when the day
 * refetches; a confirmation owned by the card would be torn down mid-flight.
 * This one belongs to the document and removes itself.
 *
 * It never blocks anything: pointer-events none, aria-hidden (the "Visit
 * completed" toast is what a screen reader announces), and gone in under a
 * second. Under reduced motion it appears already drawn and simply goes.
 */
export function showCompletionCheck() {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".hs-done").forEach((n) => n.remove());
  const host = document.createElement("div");
  host.className = "hs-done";
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("data-completion-check", "");
  host.innerHTML =
    '<div class="hs-done-badge"><svg viewBox="0 0 52 52" width="52" height="52">' +
    '<circle class="hs-done-ring" cx="26" cy="26" r="23" fill="none" stroke-width="3" />' +
    '<path class="hs-done-tick" d="M15 27.5l7.5 7.5L37.5 19" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />' +
    "</svg></div>";
  document.body.appendChild(host);
  const reduce = prefersReducedMotion();
  window.setTimeout(() => host.classList.add("hs-done-leaving"), reduce ? 500 : 720);
  window.setTimeout(() => host.remove(), reduce ? 600 : 1050);
}
