import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Img } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";
import { walkReportSubject, type WalkReportEmail } from "@/lib/walk-report";

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
  /** Set only for a dog-walking visit (#410): the email is then a walk report.
   *  Absent for every other visit, which renders exactly as it always has. */
  walk?: WalkReportEmail;
}

const VisitCompleted = (props: Props) =>
  props.walk ? <WalkReport {...props} walk={props.walk} /> : <CleanupComplete {...props} />;

const CleanupComplete = ({
  orgName = "your service",
  clientName = "there",
  visitDate = "",
  address = "",
  photoUrls = [],
  gatePhotoUrl,
  checklist = [],
  walk: _walk,
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

/** The walk report: who walked whom, when, for how long, and what happened. */
const WalkReport = ({
  orgName = "your service",
  clientName = "there",
  visitDate = "",
  photoUrls = [],
  gatePhotoUrl,
  checklist = [],
  walk,
  address: _address,
  ...orgContact
}: Props & { walk: WalkReportEmail }) => {
  const who = walk.walkerFirstName ? `${walk.walkerFirstName} from ${orgName}` : orgName;
  const minutes =
    walk.durationMin != null
      ? `${walk.durationMin} ${walk.durationMin === 1 ? "minute" : "minutes"}`
      : "";
  const times =
    walk.startTime && walk.endTime
      ? `Out from ${walk.startTime} to ${walk.endTime}${minutes ? `, ${minutes}` : ""}.`
      : walk.endTime
        ? `Back home at ${walk.endTime}.`
        : "";
  const doneLines = [walk.peeLine, walk.pooLine].filter((l): l is string => !!l);
  // Whole sentences as one string each, so a mail client's text view reads
  // them as written.
  const greeting = `Hi ${clientName}, ${who} walked ${walk.dogs}${visitDate ? ` on ${visitDate}` : ""}.`;
  const noteHeading = walk.walkerFirstName
    ? `A note from ${walk.walkerFirstName}:`
    : "A note from your walker:";
  return (
    <Html lang="en">
      <Head />
      <Preview>{walkReportSubject(orgName, walk.dogs)}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Heading style={styles.h1}>Walk complete</Heading>
          <Text style={styles.text}>{greeting}</Text>
          {times ? <Text style={styles.text}>{times}</Text> : null}
          {doneLines.map((line, i) => (
            <Text key={i} style={{ ...styles.text, margin: "2px 0" }}>
              {line}
            </Text>
          ))}
          {walk.reportNote ? (
            <>
              <Text style={styles.text}>{noteHeading}</Text>
              <Text style={{ ...styles.text, whiteSpace: "pre-line" }}>{walk.reportNote}</Text>
            </>
          ) : null}
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
              alt="Walk photo"
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
          <Text style={styles.small}>{`Thanks for trusting us with ${walk.dogs}.`}</Text>
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: VisitCompleted,
  subject: (d: Record<string, any>) =>
    d.walk
      ? walkReportSubject(d.orgName, d.walk.dogs ?? "your dog")
      : `${d.orgName ?? "Your service"} completed today's visit`,
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
