// The text part of every email, rendered the same way everywhere.
//
// The footers are tables (Outlook), and html-to-text treats a table cell as
// inline, so the contact block came out as one run-together line:
// "Summit Paws Co.(303) 555-0142 tel:30355501421550 Blake St" (R2-50). Each
// cell is its own line here, and a tel:/mailto: link prints its text only,
// because the number or address is already the text.

import type * as React from "react";
import { render } from "react-email";

export const EMAIL_TEXT_OPTIONS = {
  plainText: true as const,
  htmlToTextOptions: {
    selectors: [
      { selector: "td", format: "block" },
      { selector: "th", format: "block" },
      { selector: 'a[href^="tel:"]', format: "anchor", options: { ignoreHref: true } },
      { selector: 'a[href^="mailto:"]', format: "anchor", options: { ignoreHref: true } },
    ],
  },
};

export function renderEmailText(element: React.ReactElement): Promise<string> {
  return render(element, EMAIL_TEXT_OPTIONS);
}
