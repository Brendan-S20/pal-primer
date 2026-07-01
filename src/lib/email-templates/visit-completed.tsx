import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Img } from "@react-email/components";
import { styles } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props {
  orgName?: string;
  clientName?: string;
  visitDate?: string;
  address?: string;
  photoUrls?: string[];
}

const VisitCompleted = ({
  orgName = "your service",
  clientName = "there",
  visitDate = "",
  address = "",
  photoUrls = [],
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{orgName} completed today's visit</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>Visit complete</Heading>
        <Text style={styles.text}>
          Hi {clientName}, {orgName} completed your visit
          {visitDate ? ` on ${visitDate}` : ""}{address ? ` at ${address}` : ""}.
        </Text>
        {photoUrls.slice(0, 3).map((url, i) => (
          <Img key={i} src={url} alt="Visit photo" width="480" style={{ borderRadius: 8, margin: "8px 0" }} />
        ))}
        <Text style={styles.small}>Thanks for trusting us with the dirty work.</Text>
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
  },
} satisfies TemplateEntry;
