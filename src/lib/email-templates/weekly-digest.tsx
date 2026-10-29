import * as React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
  Section,
  Hr,
  Row,
  Column,
} from "@react-email/components";
import { styles } from "./_shared";
import { SystemFooter, TenantHeader, safeHexColor, BRAND } from "./_brand";
import type { TemplateEntry } from "./registry";

interface StatItem {
  label: string;
  value: string;
  delta?: string;
}

interface Props {
  orgName?: string;
  orgLogoUrl?: string | null;
  orgBrandColor?: string | null;
  weekLabel?: string;
  stats?: StatItem[];
  headline?: string;
  insights?: string[];
  recommendations?: string[];
  alerts?: string[];
}

const cell = {
  padding: "12px 8px",
  borderRadius: 8,
  backgroundColor: "#f6f7f9",
  textAlign: "center" as const,
};

const statLabel = { color: "#6b7280", fontSize: 12, margin: 0 };
const statValue = { color: "#111827", fontSize: 20, fontWeight: 700, margin: "4px 0 0" };
const statDelta = { color: "#059669", fontSize: 11, margin: "2px 0 0" };

const Digest = ({
  orgName = "your business",
  orgLogoUrl,
  orgBrandColor,
  weekLabel = "this past week",
  stats = [],
  headline = "Here's how the week went.",
  insights = [],
  recommendations = [],
  alerts = [],
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{`${orgName}: weekly business digest for ${weekLabel}`}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <TenantHeader orgName={orgName} orgLogoUrl={orgLogoUrl} orgBrandColor={orgBrandColor} />
        <Heading style={styles.h1}>Weekly digest</Heading>
        <Text style={styles.small}>
          {orgName} · {weekLabel}
        </Text>
        <Text style={styles.text}>{headline}</Text>

        {stats.length > 0 && (
          <Section style={{ marginTop: 16 }}>
            <Row>
              {stats.slice(0, 3).map((s, i) => (
                <Column key={i} style={{ padding: 4 }}>
                  <div
                    style={{
                      ...cell,
                      borderTop: `3px solid ${safeHexColor(orgBrandColor) ?? BRAND.green}`,
                    }}
                  >
                    <p style={statLabel}>{s.label}</p>
                    <p style={statValue}>{s.value}</p>
                    {s.delta && <p style={statDelta}>{s.delta}</p>}
                  </div>
                </Column>
              ))}
            </Row>
            {stats.length > 3 && (
              <Row style={{ marginTop: 8 }}>
                {stats.slice(3, 6).map((s, i) => (
                  <Column key={i} style={{ padding: 4 }}>
                    <div
                      style={{
                        ...cell,
                        borderTop: `3px solid ${safeHexColor(orgBrandColor) ?? BRAND.green}`,
                      }}
                    >
                      <p style={statLabel}>{s.label}</p>
                      <p style={statValue}>{s.value}</p>
                      {s.delta && <p style={statDelta}>{s.delta}</p>}
                    </div>
                  </Column>
                ))}
              </Row>
            )}
          </Section>
        )}

        {insights.length > 0 && (
          <>
            <Hr style={{ margin: "24px 0" }} />
            <Heading as="h2" style={{ ...styles.h1, fontSize: 18 }}>
              What stood out
            </Heading>
            {insights.map((line, i) => (
              <Text key={i} style={styles.text}>
                • {line}
              </Text>
            ))}
          </>
        )}

        {recommendations.length > 0 && (
          <>
            <Hr style={{ margin: "24px 0" }} />
            <Heading as="h2" style={{ ...styles.h1, fontSize: 18 }}>
              Suggested next steps
            </Heading>
            {recommendations.map((line, i) => (
              <Text key={i} style={styles.text}>
                {i + 1}. {line}
              </Text>
            ))}
          </>
        )}

        {alerts.length > 0 && (
          <>
            <Hr style={{ margin: "24px 0" }} />
            <Heading as="h2" style={{ ...styles.h1, fontSize: 18, color: "#b45309" }}>
              Needs attention
            </Heading>
            {alerts.map((line, i) => (
              <Text key={i} style={styles.text}>
                • {line}
              </Text>
            ))}
          </>
        )}

        <SystemFooter
          poweredBy
          note="Generated automatically each week. You can turn this off in HoundStack under Settings → Emails."
        />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: Digest,
  subject: (d: Record<string, any>) =>
    `${d.orgName ?? "Your business"}: weekly digest (${d.weekLabel ?? "this week"})`,
  displayName: "Weekly digest",
  previewData: {
    orgName: "Acme Scoop Co.",
    weekLabel: "Jun 27 - Jul 3",
    headline: "Revenue up 12% and you added 4 new clients.",
    stats: [
      { label: "Revenue", value: "$4,820", delta: "+12% WoW" },
      { label: "Visits done", value: "78", delta: "+6" },
      { label: "New clients", value: "4" },
      { label: "Open A/R", value: "$1,240" },
      { label: "At-risk", value: "3" },
      { label: "Complaints", value: "0" },
    ],
    insights: [
      "North zone drove 42% of new revenue this week.",
      "Skip rate dropped from 8% to 5% after last week's route changes.",
    ],
    recommendations: [
      "Follow up with 3 at-risk clients before the weekend.",
      "Confirm 2 overdue invoices totaling $640.",
    ],
    alerts: ["1 tech has 4 missed check-ins in the past 3 days."],
  },
} satisfies TemplateEntry;
