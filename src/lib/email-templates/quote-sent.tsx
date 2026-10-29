import * as React from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";
import { styles, fmtMoney, OrgFooter, type OrgContact, TenantHeader } from "./_shared";
import type { TemplateEntry } from "./registry";

// A quote, sent by the office pressing Send. The email is a cover note and a
// button: the quote itself, its lines and the Accept and Decline buttons live
// at the link, so what the customer signs is always the document on file and
// never a copy in an inbox.

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** "Q-1001". */
  quoteLabel?: string;
  title?: string | null;
  /** Charged once, together. 0 when the quote has no one-time line. */
  oneTimeCents?: number;
  /** Per visit, together. 0 when the quote has no recurring line. */
  recurringCents?: number;
  /** "October 28, 2026", already on the org's calendar, or null for none. */
  validUntilLabel?: string | null;
  /** The office's note to the customer, as typed. */
  message?: string | null;
  quoteUrl?: string;
  /** The nightly follow-up on a quote nobody has answered yet. */
  reminder?: boolean;
}

const QuoteSent = ({
  orgName = "your service",
  clientName = "there",
  quoteLabel = "Quote",
  title,
  oneTimeCents = 0,
  recurringCents = 0,
  validUntilLabel,
  message,
  quoteUrl,
  reminder = false,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>
      {reminder
        ? `A reminder about your quote from ${orgName}: ${quoteLabel}`
        : `${orgName} sent you a quote: ${quoteLabel}`}
    </Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <TenantHeader {...orgContact} orgName={orgName} />
        <Heading style={styles.h1}>
          {reminder ? "Still thinking it over?" : `Your quote from ${orgName}`}
        </Heading>
        <Text style={styles.text}>
          {reminder ? (
            <>
              Hi {clientName}, a reminder that your quote from {orgName}
              {title ? <> for {title}</> : null} ({quoteLabel}) is still waiting for an answer.
              Questions? Just reply to this email.
            </>
          ) : (
            <>
              Hi {clientName}, {orgName} has sent you {title ? <>a quote for {title}</> : "a quote"}{" "}
              ({quoteLabel}).
            </>
          )}
        </Text>
        {recurringCents > 0 ? (
          <Text style={styles.amount}>{fmtMoney(recurringCents)} per visit</Text>
        ) : null}
        {oneTimeCents > 0 ? (
          <Text style={recurringCents > 0 ? styles.text : styles.amount}>
            {recurringCents > 0
              ? `Plus ${fmtMoney(oneTimeCents)} one time.`
              : `${fmtMoney(oneTimeCents)}`}
          </Text>
        ) : null}
        {message ? <Text style={{ ...styles.text, whiteSpace: "pre-wrap" }}>{message}</Text> : null}
        {quoteUrl ? (
          <Button style={styles.button} href={quoteUrl}>
            View and accept quote
          </Button>
        ) : null}
        <Text style={styles.small}>
          {validUntilLabel
            ? `This quote is valid until ${validUntilLabel}. You can accept or decline it from the link; no account or password is needed.`
            : "You can accept or decline it from the link; no account or password is needed."}
        </Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: QuoteSent,
  subject: (d: Record<string, any>) =>
    `${d.reminder ? "Reminder: quote" : "Quote"} ${d.quoteLabel ?? ""} from ${d.orgName ?? "your service"}`.replace(
      /\s+/g,
      " ",
    ),
  displayName: "Quote sent",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    quoteLabel: "Q-1001",
    title: "Weekly yard service",
    oneTimeCents: 12000,
    recurringCents: 2400,
    validUntilLabel: "October 28, 2026",
    message: "Thanks for walking the yard with me today.",
    quoteUrl: "https://example.com/q/abc",
  },
} satisfies TemplateEntry;
