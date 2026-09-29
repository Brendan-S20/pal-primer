import * as React from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Text,
} from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";
import { bodyParagraphs, isSafeButtonUrl } from "@/lib/campaigns";

interface Props extends OrgContact {
  orgName?: string;
  subject?: string;
  heading?: string;
  /** Plain text from the office. Split into paragraphs and lines by
   *  bodyParagraphs and rendered as React text children, so every `<`, `>`
   *  and `&` in it arrives in the inbox as the character that was typed. */
  body?: string;
  buttonLabel?: string | null;
  buttonUrl?: string | null;
  /** Minted by enqueueAppEmail (clientUnsubscribe: true), never by a caller.
   *  Redeeming it opts THIS client out of email from THIS business. */
  unsubscribeUrl?: string;
}

const Campaign = ({
  orgName = "",
  heading,
  body = "",
  buttonLabel,
  buttonUrl,
  unsubscribeUrl,
  ...orgContact
}: Props) => {
  const paragraphs = bodyParagraphs(body);
  // Checked again here, not only on save: this is the last place the link
  // passes through before somebody's inbox.
  const button = buttonLabel && buttonUrl && isSafeButtonUrl(buttonUrl) ? buttonUrl.trim() : null;
  const preview = paragraphs[0]?.join(" ") ?? heading ?? "";
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview.slice(0, 140)}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          {heading ? <Heading style={styles.h1}>{heading}</Heading> : null}
          {paragraphs.map((lines, i) => (
            <Text key={i} style={styles.text}>
              {lines.map((line, j) => (
                <React.Fragment key={j}>
                  {j > 0 ? <br /> : null}
                  {line}
                </React.Fragment>
              ))}
            </Text>
          ))}
          {button ? (
            <Button style={styles.button} href={button}>
              {buttonLabel}
            </Button>
          ) : null}
          <Text style={styles.small}>
            You are getting this because you are a customer of {orgName || "this business"}.{" "}
            {unsubscribeUrl ? (
              <Link href={unsubscribeUrl} style={{ color: "#64748b", textDecoration: "underline" }}>
                Unsubscribe from these emails
              </Link>
            ) : (
              "Reply to this email to stop receiving them."
            )}
            .
          </Text>
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: Campaign,
  // The owner's own words. campaignContentSchema has already refused a line
  // break, which is the one thing a subject must not contain.
  subject: (d: Record<string, any>) =>
    String(d.subject ?? "").trim() || `News from ${d.orgName ?? "us"}`,
  displayName: "Campaign",
  previewData: {
    orgName: "Acme Scoop Co.",
    orgPhone: "(555) 010-0199",
    orgEmail: "hello@acmescoop.example.com",
    orgAddress: "1200 W Wilson Ave, Chicago, IL 60640",
    subject: "Spring deep clean: $20 off through April",
    heading: "Spring is here, and so is everything the snow was hiding",
    body: "Book a one-time spring deep clean before April 30 and we'll take $20 off.\n\nReply to this email or use the button below.",
    buttonLabel: "Book a deep clean",
    buttonUrl: "https://example.com/spring",
    unsubscribeUrl: "https://example.com/unsubscribe?token=preview",
  },
} satisfies TemplateEntry;
