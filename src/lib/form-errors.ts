// What a form does when Save is pressed with something missing.
//
// The owner, on the station form (2026-10-04): "It doesn't say or highlight
// which fields are required, so it's hard to tell when marking and clicking
// add station." On Add unit the button simply sat greyed out with no reason
// given. A disabled primary button is a question the form refuses to answer.
//
// So the forms that had one now keep Save enabled and, on a submit that finds
// a problem, mark each missing field (`aria-invalid` plus an error line under
// it, the house pattern from the service editor) and move focus to the first.
// This is the one shared piece: finding that first field after React has
// drawn the errors, focusing it and bringing it into view. Optional fields say
// "(optional)" in their label; a field without that word is required.

/** After a submit that found errors, focus the first field the form marked
 *  `aria-invalid="true"` and scroll it to the middle of the screen. Runs on
 *  the next frame, because the marks are drawn by the render the caller's
 *  state change has only just scheduled. */
export function focusFirstInvalid(form: HTMLFormElement | null | undefined): void {
  if (!form || typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() => {
    const el = form.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

/** A loose shape check for an optional email field in a `noValidate` form, so
 *  turning the browser's own validation off does not let "bob@" through. The
 *  server is the authority; this only catches a typo before the round trip. */
export function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** A loose shape check for an optional phone field: digits with the usual
 *  punctuation, at least seven of them, and an optional extension. It does not
 *  decide whether the number rings; it stops "abc" and "12" (#1010). */
export function looksLikePhone(v: string): boolean {
  const t = v.trim();
  if (!/^\+?[\d\s().\-]+(\s*(x|ext\.?)\s*\d+)?$/i.test(t)) return false;
  return t.replace(/(x|ext\.?)\s*\d+$/i, "").replace(/\D/g, "").length >= 7;
}

/** What is wrong with the contact fields, if anything: said next to the field
 *  that has it. Both are optional, so empty is fine. */
export function contactProblems(email: string, phone: string): { email?: string; phone?: string } {
  const out: { email?: string; phone?: string } = {};
  if (email.trim() && !looksLikeEmail(email)) {
    out.email = "Enter an email like name@example.com, or leave it empty.";
  }
  if (phone.trim() && !looksLikePhone(phone)) {
    out.phone = "Enter a phone number with at least 7 digits, or leave it empty.";
  }
  return out;
}
