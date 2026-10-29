import * as React from "react";
import { Button, Heading, Text } from "@react-email/components";
import { SystemLayout, systemText } from "./_brand";

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
  <SystemLayout
    preview={`You've been invited to join ${orgName} on HoundStack`}
    note="If you weren't expecting this invitation, you can ignore this email."
  >
    <Heading style={systemText.h1}>Join {orgName}</Heading>
    <Text style={systemText.text}>
      You've been invited to join <strong>{orgName}</strong> on HoundStack as {roleLabel}.
    </Text>
    <Text style={systemText.text}>
      Create your account, or sign in, with <strong>{email}</strong>. Your role is assigned
      automatically on first sign-in.
    </Text>
    <Button style={systemText.button} href={link}>
      Accept invitation
    </Button>
    <Text style={systemText.aside}>If the button does not work, open this link: {link}</Text>
  </SystemLayout>
);

export default TeamInviteEmail;
