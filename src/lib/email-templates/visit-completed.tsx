import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Img } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";
import { walkReportSubject, type WalkReportEmail } from "@/lib/walk-report";
import { sitReportSubject, sitTimesSentence, type SitReportEmail } from "@/lib/sit-report";

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
  /** Set only for a pet sitting visit (#411): the email is then a visit
   *  report. Absent for every other visit. */
  sit?: SitReportEmail;
  /** False for a groom, a lesson or any visit that is not pet waste (#560):
   *  the sign-off then says nothing about dirty work. */
  petWaste?: boolean;
}

const VisitCompleted = (props: Props) =>
  props.walk ? (
    <WalkReport {...props} walk={props.walk} />
  ) : props.sit ? (
    <SitReport {...props} sit={props.sit} />
  ) : (
    <CleanupComplete {...props} />
  );

const CleanupComplete = ({
  orgName = "your service",
  clientName = "there",
  visitDate = "",
  address = "",
  photoUrls = [],
  gatePhotoUrl,
  checklist = [],
  walk: _walk,
  sit: _sit,
  petWaste,
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
        <Text style={styles.small}>
          {petWaste === false
            ? "Thanks for trusting us with your pets."
            : "Thanks for trusting us with the dirty work."}
        </Text>
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
  sit: _sit,
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

/** The pet sitting visit report: who checked on whom, when, what each pet
 *  got, any medication missed with the reason, and the sitter's note. */
const SitReport = ({
  orgName = "your service",
  clientName = "there",
  visitDate = "",
  photoUrls = [],
  gatePhotoUrl,
  checklist = [],
  sit,
  walk: _walk,
  address: _address,
  ...orgContact
}: Props & { sit: SitReportEmail }) => {
  const who = sit.sitterFirstName ? `${sit.sitterFirstName} from ${orgName}` : orgName;
  const on = visitDate ? ` on ${visitDate}` : "";
  const greeting = sit.overnight
    ? `Hi ${clientName}, ${who} stayed overnight with ${sit.pets}${on}.`
    : `Hi ${clientName}, ${who} checked on ${sit.pets}${on}.`;
  const times = sitTimesSentence(sit);
  const noteHeading = sit.sitterFirstName
    ? `A note from ${sit.sitterFirstName}:`
    : "A note from your sitter:";
  return (
    <Html lang="en">
      <Head />
      <Preview>{sitReportSubject(orgName, sit.pets, sit.overnight)}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Heading style={styles.h1}>{sit.overnight ? "Overnight stay" : "Visit complete"}</Heading>
          <Text style={styles.text}>{greeting}</Text>
          {times ? <Text style={styles.text}>{times}</Text> : null}
          {sit.care.map((group) => (
            <React.Fragment key={group.pet}>
              <Text style={{ ...styles.text, margin: "12px 0 2px", fontWeight: 600 }}>
                {group.pet}
              </Text>
              {group.lines.map((line, i) => (
                <Text key={i} style={{ ...styles.text, margin: "2px 0" }}>
                  {line}
                </Text>
              ))}
            </React.Fragment>
          ))}
          {sit.missed.length > 0 ? (
            <Text style={styles.text}>
              {sit.missed.length === 1
                ? "One medication was not given. The reason is above, and the office has been told."
                : "Some medications were not given. The reasons are above, and the office has been told."}
            </Text>
          ) : null}
          {sit.reportNote ? (
            <>
              <Text style={styles.text}>{noteHeading}</Text>
              <Text style={{ ...styles.text, whiteSpace: "pre-line" }}>{sit.reportNote}</Text>
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
          <Text style={styles.small}>{`Thanks for trusting us with ${sit.pets}.`}</Text>
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
      : d.sit
        ? sitReportSubject(d.orgName, d.sit.pets ?? "your pets", !!d.sit.overnight)
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
