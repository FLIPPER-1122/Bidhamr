-- Admin: "Markér som løst" paa betalinger, der kraever opmaerksomhed.
-- Udvider moderation_log med handlingen 'betaling_loest' (maal_type 'handel',
-- maal_id = trade_id).

alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest'));
