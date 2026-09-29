import type { ComponentType } from "react";

import { template as welcomeTemplate } from "./welcome";
import { template as invoiceSentTemplate } from "./invoice-sent";
import { template as paymentReceivedTemplate } from "./payment-received";
import { template as visitCompletedTemplate } from "./visit-completed";
import { template as weatherRescheduleTemplate } from "./weather-reschedule";
import { template as overdueReminderTemplate } from "./overdue-reminder";
import { template as winBackTemplate } from "./win-back";
import { template as weeklyDigestTemplate } from "./weekly-digest";
import { template as reviewRequestTemplate } from "./review-request";
import { template as visitReminderTemplate } from "./visit-reminder";
import { template as onMyWayTemplate } from "./on-my-way";
import { template as quoteSentTemplate } from "./quote-sent";

export interface TemplateEntry {
  component: ComponentType<any>;
  subject: string | ((data: Record<string, any>) => string);
  displayName?: string;
  previewData?: Record<string, any>;
  /** Fixed recipient — overrides caller-provided recipientEmail when set. */
  to?: string;
}

export const TEMPLATES: Record<string, TemplateEntry> = {
  welcome: welcomeTemplate,
  "invoice-sent": invoiceSentTemplate,
  "payment-received": paymentReceivedTemplate,
  "visit-completed": visitCompletedTemplate,
  "weather-reschedule": weatherRescheduleTemplate,
  "overdue-reminder": overdueReminderTemplate,
  "win-back": winBackTemplate,
  "weekly-digest": weeklyDigestTemplate,
  "review-request": reviewRequestTemplate,
  "visit-reminder": visitReminderTemplate,
  "on-my-way": onMyWayTemplate,
  "quote-sent": quoteSentTemplate,
};
