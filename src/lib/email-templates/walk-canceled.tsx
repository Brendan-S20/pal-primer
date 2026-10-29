import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact, TenantHeader } from "./_shared";
import type { TemplateEntry } from "./registry";
import { walkCanceledSubject } from "@/lib/walk-notify";

// The office canceled a dog walk that was coming up (#410). One email per
// client per action, so a bulk cancel lists every walk it took. The office's
// typed reason is not sent: it was written for the office. Dog walking only
// (src/lib/walk-notify.server.ts).

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** "Bella", "Bella and Max", or "your dog". */
  dogs?: string;
  /** Each canceled walk, "Mon, Oct 19, 10 AM to 12 PM" (canceledWalkLabel). */
  walks?: string[];
  /** The first walk's day, "Mon, Oct 19", for the subject. */
  day?: string;
  /** Every walk the action canceled, listed or not. */
  count?: number;
}

const WalkCanceled = ({
  orgName = "your walker",
  clientName = "there",
  dogs = "your dog",
  walks = [],
  day = "",
  count,
  ...orgContact
}: Props) => {
  const total = Math.max(count ?? walks.length, walks.length, 1);
  const subject = walkCanceledSubject(total, day);
  const more = total - walks.length;
  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <TenantHeader {...orgContact} orgName={orgName} />
          <Heading style={styles.h1}>{subject}</Heading>
          {total === 1 ? (
            <Text style={styles.text}>
              Hi {clientName}, {orgName} canceled the walk for {dogs} on{" "}
              <strong>{walks[0] ?? day}</strong>.
            </Text>
          ) : (
            <>
              <Text style={styles.text}>
                Hi {clientName}, {orgName} canceled these walks for {dogs}:
              </Text>
              {walks.map((w, i) => (
                <Text key={i} style={styles.text}>
                  <strong>{w}</strong>
                </Text>
              ))}
              {more > 0 ? (
                <Text style={styles.small}>
                  {more === 1 ? "And one more." : `And ${more} more.`}
                </Text>
              ) : null}
            </>
          )}
          <Text style={styles.text}>
            If you have a question, or want to book another time, reply to this email.
          </Text>
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: WalkCanceled,
  subject: (d: Record<string, any>) =>
    walkCanceledSubject(
      Math.max(Number(d.count) || 0, Array.isArray(d.walks) ? d.walks.length : 0, 1),
      d.day ?? "",
    ),
  displayName: "Walk canceled",
  previewData: {
    orgName: "Acme Dog Walking",
    clientName: "Jane",
    dogs: "Bella",
    walks: ["Mon, Oct 19, 10 AM to 12 PM"],
    day: "Mon, Oct 19",
    count: 1,
  },
} satisfies TemplateEntry;
