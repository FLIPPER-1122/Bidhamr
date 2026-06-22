-- Tilføjer 'betalt' status (escrow: betaling modtaget, ikke frigivet til sælger)
-- og Stripe-referencer til transactions, så webhooken kan finde og opdatere
-- den rigtige række.

alter table public.transactions
  drop constraint transactions_status_check;

alter table public.transactions
  add constraint transactions_status_check
  check (status in ('afventer', 'betalt', 'frigivet', 'refunderet'));

alter table public.transactions
  add column stripe_checkout_session_id text unique,
  add column stripe_payment_intent_id text unique;
