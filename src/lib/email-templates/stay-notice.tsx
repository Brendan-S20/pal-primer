import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props extends OrgContact { clientName?: string; orgName?: string; serviceName?: string; dates?: string; portalUrl?: string; depositUrl?: string; ending?: boolean }

function StayNotice({ clientName = "there", orgName = "your sitter", serviceName = "Pet sitting", dates, portalUrl, depositUrl, ending = false, ...contact }: Props) {
  const title = ending ? "Your stay ends tomorrow" : "Your stay is confirmed";
  return <Html lang="en"><Head /><Preview>{title}</Preview><Body style={styles.main}><Container style={styles.container}>
    <Heading style={styles.h1}>{title}</Heading>
    <Text style={styles.text}>Hi {clientName}, {ending ? `your stay with ${orgName} ends tomorrow.` : `${orgName} confirmed your stay.`}</Text>
    <Text style={styles.text}><strong>{serviceName}</strong><br />{dates}</Text>
    {depositUrl && <><Text style={styles.text}>Your deposit is due now. It will be credited toward your stay invoice.</Text><Button href={depositUrl} style={styles.button}>Pay deposit</Button></>}
    {portalUrl && <Button href={portalUrl} style={styles.button}>View your stay</Button>}
    <Text style={styles.text}>Reply to this email if your plans have changed.</Text>
    <OrgFooter {...contact} orgName={orgName} />
  </Container></Body></Html>;
}

const previewData = { orgName: "Acme Pet Sitting", clientName: "Jane", serviceName: "Overnight stay", dates: "Check-in Oct 19, check-out Oct 24" };
export const confirmedTemplate = { component: StayNotice, subject: "Your stay is confirmed", displayName: "Stay confirmed", previewData } satisfies TemplateEntry;
export const endingTemplate = { component: (props: Props) => <StayNotice {...props} ending />, subject: "Your stay ends tomorrow", displayName: "Stay ends tomorrow", previewData } satisfies TemplateEntry;
