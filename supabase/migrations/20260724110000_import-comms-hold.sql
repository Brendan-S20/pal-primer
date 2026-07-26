-- Import communications hold (Task: imported clients must not receive
-- automated communications until the org initiates contact).
--
-- Clients created by a bulk import (commitImport) get comms_paused = true.
-- While true, every AUTOMATED outbound path (invoice send + reminders,
-- overdue dunning SMS/email, visit lifecycle SMS + visit-completed email,
-- weather-reschedule email, review requests, payment-failed SMS,
-- payment-received email) skips the client. Manual, user-initiated sends
-- (reply to a concern, explicit "Send invoice", direct SMS, explicit
-- review request / win-back) still work — and a successful manual send
-- clears the hold, since contact is now initiated. Office staff can also
-- lift the hold from the client detail header.

alter table public.clients
  add column if not exists comms_paused boolean not null default false;

comment on column public.clients.comms_paused is
  'Communications hold. Set true for clients created via bulk import; automated outbound comms (invoice emails/reminders, visit SMS/emails, review requests, dunning) are skipped until the org initiates contact. Cleared by any explicit manual send or by an office toggle on the client page.';
