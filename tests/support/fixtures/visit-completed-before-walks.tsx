// src/lib/email-templates/visit-completed.tsx exactly as it was before walk
// reports (#410), byte for byte apart from these lines and the two imports.
// tests/a-walk-report-is-not-a-cleanup-email.test.tsx renders it beside the
// current template with the same props: a pet-waste business's completion
// email must not change by one character. Do not edit to match the template.
import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Img } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "@/lib/email-templates/_shared";
import type { TemplateEntry } from "@/lib/email-templates/registry";

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  visitDate?: string;
  address?: string;
  photoUrls?: string[];
  /** The latched-gate photo, captioned on its own. */
  gatePhotoUrl?: string;
  /** The checklist items the tech checked, when the owner has chosen to tell
   *  the customer. Empty (and absent from the email) by default. */
  checklist?: string[];
}

const VisitCompleted = ({
  orgName = "your service",
  clientName = "there",
  visitDate = "",
  address = "",
  photoUrls = [],
  gatePhotoUrl,
  checklist = [],
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{orgName} completed today's visit</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>Visit complete</Heading>
        <Text style={styles.text}>
          Hi {clientName}, {orgName} completed your visit
          {visitDate ? ` on ${visitDate}` : ""}
          {address ? ` at ${address}` : ""}.
        </Text>
        {checklist.length > 0 ? (
          <>
            <Text style={styles.text}>What we checked:</Text>
            {checklist.map((label, i) => (
              <Text key={i} style={{ ...styles.text, margin: "2px 0" }}>
                &#10003; {label}
              </Text>
            ))}
          </>
        ) : null}
        {photoUrls.slice(0, 3).map((url, i) => (
          <Img
            key={i}
            src={url}
            alt="Visit photo"
            width="480"
            style={{ borderRadius: 8, margin: "8px 0" }}
          />
        ))}
        {gatePhotoUrl ? (
          <>
            <Text style={styles.text}>Your gate, latched behind us when we left:</Text>
            <Img
              src={gatePhotoUrl}
              alt="Gate latched"
              width="480"
              style={{ borderRadius: 8, margin: "8px 0" }}
            />
          </>
        ) : null}
        <Text style={styles.small}>Thanks for trusting us with the dirty work.</Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: VisitCompleted,
  subject: (d: Record<string, any>) => `${d.orgName ?? "Your service"} completed today's visit`,
  displayName: "Visit completed",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    visitDate: "Jul 1, 2026",
    address: "123 Main St",
    photoUrls: [],
    checklist: ["All areas walked", "Waste bagged and disposed", "Gate latched"],
  },
} satisfies TemplateEntry;
