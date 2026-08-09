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
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  reviewUrl?: string;
}

const ReviewRequest = ({
  orgName = "your service",
  clientName = "there",
  reviewUrl = "",
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>How did we do? Leave {orgName} a quick review</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>How did we do?</Heading>
        <Text style={styles.text}>
          Hi {clientName}, thanks for choosing {orgName}! If we did a great job, a quick review
          would mean the world to us.
        </Text>
        {reviewUrl ? (
          <Button href={reviewUrl} style={styles.button}>
            Leave a review
          </Button>
        ) : null}
        <Text style={styles.small}>Thanks for trusting us with the dirty work.</Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: ReviewRequest,
  subject: (d: Record<string, any>) => `How did we do? Leave ${d.orgName ?? "us"} a review`,
  displayName: "Review request",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    reviewUrl: "https://g.page/r/example/review",
  },
} satisfies TemplateEntry;
