
INSERT INTO public.platform_plans (slug, name, description, client_limit_min, client_limit_max, price_cents, price_per_client_cents, currency, interval, is_active, is_free, sort_order, features)
VALUES
  ('puppy',  'Puppy',       'Free trial tier — up to 3 active clients.',                    0,   3,   0,     NULL, 'usd', 'month', true, true,  10, '["Unlimited staff","All core CRM features"]'::jsonb),
  ('fetch',  'Fetch',       'Solo scoopers just getting rolling. 4–25 active clients.',     4,   25,  5900,  NULL, 'usd', 'month', true, false, 20, '["Unlimited staff","All core CRM features"]'::jsonb),
  ('scoop',  'Scoop',       'Growing route. 26–75 active clients.',                          26,  75,  9900,  NULL, 'usd', 'month', true, false, 30, '["Unlimited staff","All core CRM features"]'::jsonb),
  ('haul',   'Haul',        'Multi-tech operation. 76–125 active clients.',                  76,  125, 14900, NULL, 'usd', 'month', true, false, 40, '["Unlimited staff","All core CRM features"]'::jsonb),
  ('pack',   'Pack Leader', 'Serious pack. 126–200 active clients, billed per client.',      126, 200, NULL,  200,  'usd', 'month', true, false, 50, '["Unlimited staff","All core CRM features","Per-active-client pricing"]'::jsonb),
  ('kennel', 'Kennel',      'Full kennel. 201+ active clients, billed per client.',          201, NULL, NULL, 150,  'usd', 'month', true, false, 60, '["Unlimited staff","All core CRM features","Volume per-client pricing"]'::jsonb)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  client_limit_min = EXCLUDED.client_limit_min,
  client_limit_max = EXCLUDED.client_limit_max,
  price_cents = EXCLUDED.price_cents,
  price_per_client_cents = EXCLUDED.price_per_client_cents,
  currency = EXCLUDED.currency,
  interval = EXCLUDED.interval,
  is_active = EXCLUDED.is_active,
  is_free = EXCLUDED.is_free,
  sort_order = EXCLUDED.sort_order,
  features = EXCLUDED.features,
  updated_at = now();
