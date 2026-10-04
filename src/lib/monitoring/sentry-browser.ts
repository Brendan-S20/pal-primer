// The Sentry browser SDK. Never import this file statically: ./client.ts
// reaches it through a dynamic import, after deciding monitoring is on, which
// keeps the SDK off the critical path and out of dev and test entirely.
//
// What is deliberately NOT here, and why:
//
//   * Session replay. It records the screen, which in this product is
//     customers' names, addresses and gate codes.
//   * Tracing. tracesSampleRate is 0 and no tracing integration is added; the
//     free tier's span quota is better left for when there is a question
//     tracing would answer.
//   * DOM and console breadcrumbs. A click breadcrumb names the element by its
//     attributes, and an aria-label here is often a customer's name; console
//     output includes whole records that were logged while debugging.
//   * Release-health sessions. A ping per page load is volume the free tier
//     does not need for what the owner asked for, which is errors.
//
// Everything that is sent goes through policy.scrubEvent first.

import * as Sentry from "@sentry/react";
import { Capacitor } from "@capacitor/core";
import { identityUser, isExpectedError, scrubEvent, type MonitoringIdentity } from "./policy";

let started = false;

function platformTag(): string {
  try {
    const p = Capacitor.getPlatform();
    return p === "ios" || p === "android" ? p : "web";
  } catch {
    return "web";
  }
}

/** A test event must survive isExpectedError, which drops a plain Error whose
 *  message reads like a sentence. Its own class name is what lets it through. */
class MonitoringTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitoringTestError";
  }
}

export function start(dsn: string): void {
  if (started) return;
  started = true;
  const release = import.meta.env.VITE_SENTRY_RELEASE;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE === "production" ? "production" : "development",
    ...(typeof release === "string" && release ? { release } : {}),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: (defaults) =>
      defaults
        .filter((i) => i.name !== "Breadcrumbs" && i.name !== "BrowserSession")
        .concat(Sentry.breadcrumbsIntegration({ console: false, dom: false })),
    beforeSend(event, hint) {
      if (isExpectedError(hint?.originalException)) return null;
      return scrubEvent(event);
    },
    beforeBreadcrumb(crumb) {
      if ((crumb.category ?? "").startsWith("ui.")) return null;
      return crumb;
    },
  });
  Sentry.setTag("platform", platformTag());
}

export function identify(identity: MonitoringIdentity | null): void {
  const user = identityUser(identity);
  Sentry.setUser(user);
  Sentry.setTag("org_id", user && identity?.orgId ? identity.orgId : undefined);
}

export function captureBoundary(error: unknown, boundary: string): void {
  Sentry.withScope((scope) => {
    scope.setTag("boundary", boundary);
    Sentry.captureException(error);
  });
}

export function captureTest(): void {
  Sentry.withScope((scope) => {
    scope.setTag("test_event", "yes");
    Sentry.captureException(
      new MonitoringTestError("HoundStack client test error, sent on purpose from /platform/health"),
    );
  });
}
