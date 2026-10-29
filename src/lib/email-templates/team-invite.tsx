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
import { styles } from "./_shared";
import { BRAND, SystemFooter, SystemHeader } from "./_brand";

interface Props {
  orgName: string;
  email: string;
  /** "office manager", not "office_manager". */
  roleLabel: string;
  link: string;
}

/**
 * The teammate invitation (invite-email.server.ts). System mail: HoundStack
 * sends it on the business's behalf, so it wears HoundStack chrome and names
 * the business in the body. It used to be two hand-written HTML paragraphs
 * with the business name pasted in unescaped (#577).
 */
export const TeamInviteEmail = ({ orgName, email, roleLabel, link }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{`You've been invited to join ${orgName} on HoundStack`}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <SystemHeader />
        <Heading style={styles.h1}>Join {orgName}</Heading>
        <Text style={styles.text}>
          You've been invited to join <strong>{orgName}</strong> on HoundStack as {roleLabel}.
        </Text>
        <Text style={styles.text}>
          Create your account, or sign in, with <strong>{email}</strong>. Your role is assigned
          automatically on first sign-in.
        </Text>
        <Button style={{ ...styles.button, backgroundColor: BRAND.ink }} href={link}>
          Accept invitation
        </Button>
        <Text style={styles.small}>If the button does not work, open this link: {link}</Text>
        <SystemFooter note="If you weren't expecting this invitation, you can ignore this email." />
      </Container>
    </Body>
  </Html>
);

export default TeamInviteEmail;
