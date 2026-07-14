-- Expand the platform add-on catalog (per Brendan, 2026-07-14): managed
-- texting, white-label portal link, white-label emails, priority support, and
-- a one-time done-for-you setup service. One-time services need a new
-- billing_interval value; they're charged as a Stripe invoice item on the
-- org's subscription rather than a recurring subscription item.

ALTER TABLE public.platform_addons
  DROP CONSTRAINT platform_addons_billing_interval_check;
ALTER TABLE public.platform_addons
  ADD CONSTRAINT platform_addons_billing_interval_check
  CHECK (billing_interval IN ('month', 'year', 'one_time'));

INSERT INTO public.platform_addons (slug, name, description, price_cents, billing_interval, sort_order)
VALUES
  (
    'managed-sms',
    'Managed texting',
    'Skip the Twilio setup entirely. Two-way client texting runs through a HoundStack-managed number, with consent and STOP compliance handled for you.',
    2900, 'month', 2
  ),
  (
    'white-label-portal',
    'White-label portal link',
    'Your client portal and lead form on your own domain (like portal.yourbusiness.com) instead of a HoundStack address. We handle the domain setup with you.',
    1900, 'month', 3
  ),
  (
    'white-label-emails',
    'White-label emails',
    'Invoices, reminders, and receipts sent from your own email domain instead of ours, including the DNS and DKIM setup to keep them out of spam.',
    1900, 'month', 4
  ),
  (
    'priority-support',
    'Priority support',
    'Front of the line: same-day responses, a direct support channel, and help by phone when something can''t wait.',
    2900, 'month', 5
  ),
  (
    'developer-setup',
    'Done-for-you setup',
    'We set the whole platform up for you: import your client list, configure zones, routes, add-ons, texting, and payments, then train your team on a live call.',
    49900, 'one_time', 6
  );
