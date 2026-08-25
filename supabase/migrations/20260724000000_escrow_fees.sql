-- Escrow-gebyrer: 5% købergebyr (oveni buddet) og 10% sælgergebyr (fratrækkes
-- udbetalingen). udbetaling_beløb/udbetalt_kl er den databaseførte ledger for
-- "skyldig til sælger", indtil Stripe Connect-udbetalinger bygges.
-- 'annulleret' status bruges når en payment intent annulleres eller et
-- checkout-forsøg opgives.

alter table public.transactions
  add column køber_gebyr numeric(12,2) not null default 0,
  add column sælger_gebyr numeric(12,2) not null default 0,
  add column udbetaling_beløb numeric(12,2),
  add column udbetalt_kl timestamptz;

alter table public.transactions drop constraint transactions_status_check;
alter table public.transactions add constraint transactions_status_check
  check (status in ('afventer', 'betalt', 'frigivet', 'refunderet', 'annulleret'));
