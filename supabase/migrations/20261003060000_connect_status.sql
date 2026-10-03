-- Udbetaling til saelgers bankkonto via Stripe Connect (ROADMAP fase 3,
-- ROADMAP-BESLUTNINGER afsnit "Udbetaling til saelger": Stripe udbetaler
-- automatisk fra saelgerens Connect-konto til banken - Stripes standard).
--
-- Stripe er sandheden. Kolonnerne her SPEJLER kun Stripes account- og
-- payout-events (webhook), saa hjemmesiden kan vise status og staff kan se,
-- hvilke udbetalingskonti der kraever opmaerksomhed.
--
--   1. betalingsprofiler faar:
--        connect_mangler_nu         - requirements.currently_due (feltnavne fra Stripe)
--        connect_mangler_forfaldne  - requirements.past_due
--        connect_spaerret_aarsag    - requirements.disabled_reason
--        connect_mangler_siden      - hvornaar Stripe begyndte at mangle oplysninger
--                                     (efter indsendelse). Bruges som noegle, saa
--                                     saelgeren faar een besked pr. gang.
--        connect_klar_kl            - foerste gang kontoen var klar til udbetaling
--                                     (besked "Din udbetalingskonto er klar" een gang)
--        connect_frakoblet_kl       - account.application.deauthorized: saelgeren har
--                                     lukket/frakoblet kontoen. Ingen overfoersler.
--        connect_kraever_opmaerksomhed, connect_opmaerksomhed_aarsag,
--        connect_opmaerksomhed_kl   - markering til admin (fx fejlet udbetaling til
--                                     bank, frakoblet konto, afvist af Stripe).
--                                     Teksten indeholder aldrig beloeb.
--   2. har_udbetalingskonto: en frakoblet konto taeller ikke (kan ikke saelge).
--   3. moderation_log: ny handling 'udbetalingskonto_loest'.
--   4. udbetalingskonto_loest(): admin markerer en udbetalingskonto som loest
--      (atomisk opdatering + log, inhabilitet). Kun service_role.
--
-- Idempotent: add column if not exists / create or replace / drop ... if exists.
-- Aendrer ingen handelsdata. connect_klar_kl udfyldes for konti, der allerede
-- er klar, saa de ikke faar beskeden "klar" igen.

-- ============================================================ 1. kolonner

alter table public.betalingsprofiler
  add column if not exists connect_mangler_nu            text[] not null default '{}',
  add column if not exists connect_mangler_forfaldne     text[] not null default '{}',
  add column if not exists connect_spaerret_aarsag       text,
  add column if not exists connect_mangler_siden         timestamptz,
  add column if not exists connect_klar_kl               timestamptz,
  add column if not exists connect_frakoblet_kl          timestamptz,
  add column if not exists connect_kraever_opmaerksomhed boolean not null default false,
  add column if not exists connect_opmaerksomhed_aarsag  text,
  add column if not exists connect_opmaerksomhed_kl      timestamptz;

comment on column public.betalingsprofiler.connect_mangler_nu is
  'Spejl af Stripe account.requirements.currently_due (kun feltnavne).';
comment on column public.betalingsprofiler.connect_mangler_forfaldne is
  'Spejl af Stripe account.requirements.past_due (kun feltnavne).';
comment on column public.betalingsprofiler.connect_spaerret_aarsag is
  'Spejl af Stripe account.requirements.disabled_reason.';
comment on column public.betalingsprofiler.connect_frakoblet_kl is
  'Saelgeren har frakoblet/lukket sin Connect-konto (account.application.deauthorized). Ingen overfoersler.';
comment on column public.betalingsprofiler.connect_kraever_opmaerksomhed is
  'Udbetalingskontoen kraever admin (fejlet udbetaling til bank, frakoblet, afvist). Ingen beloeb i aarsagen.';

-- Konti, der allerede er klar, skal ikke have beskeden "klar" igen.
update public.betalingsprofiler
   set connect_klar_kl = coalesce(opdateret, now())
 where connect_klar_kl is null
   and connect_overfoersler_aktiv
   and connect_udbetalinger_aktiv;

create index if not exists betalingsprofiler_connect_opmaerksomhed_idx
  on public.betalingsprofiler (connect_opmaerksomhed_kl)
  where connect_kraever_opmaerksomhed;

-- ============================================================ 2. har_udbetalingskonto

create or replace function public.har_udbetalingskonto(p_bruger uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.betalingsprofiler
     where user_id = p_bruger
       and stripe_account_id is not null
       and connect_detaljer_indsendt
       and connect_frakoblet_kl is null
  );
$fn$;

revoke all on function public.har_udbetalingskonto(uuid) from public, anon, authenticated;
grant execute on function public.har_udbetalingskonto(uuid) to service_role;

-- ============================================================ 3. moderation_log

alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest',
    'chat_aabnet','chat_lukket','faellesbesked',
    'sag_afgjort_koeber','sag_afgjort_saelger','sag_retur_afleveret',
    'sag_genaabnet','konto_lukket','sag_afviklet',
    'indpakning_paamindelse','konto_lukning_foreslaaet','konto_lukning_afvist',
    'udbetalingskonto_loest'));

-- ============================================================ 4. admin: markér løst

-- Returnerer 'ok' | 'ikke_fundet' | 'allerede_loest' | 'inhabil' |
-- 'note_mangler' | 'note_for_lang'. Rollen tjekkes i server-koden
-- (assertRole('admin')); funktionen kan kun kaldes med service_role.
create or replace function public.udbetalingskonto_loest(
  p_bruger      uuid,
  p_medarbejder uuid,
  p_note        text
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_note text := btrim(coalesce(p_note, ''));
  v_fundet boolean;
begin
  if v_note = '' then return 'note_mangler'; end if;
  if length(v_note) > 2000 then return 'note_for_lang'; end if;
  if p_bruger = p_medarbejder then return 'inhabil'; end if;

  select true into v_fundet from public.betalingsprofiler where user_id = p_bruger;
  if not coalesce(v_fundet, false) then return 'ikke_fundet'; end if;

  update public.betalingsprofiler
     set connect_kraever_opmaerksomhed = false,
         opdateret = now()
   where user_id = p_bruger
     and connect_kraever_opmaerksomhed;
  if not found then return 'allerede_loest'; end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'udbetalingskonto_loest', 'bruger', p_bruger, p_bruger, v_note);

  return 'ok';
end;
$fn$;

revoke all on function public.udbetalingskonto_loest(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.udbetalingskonto_loest(uuid, uuid, text) to service_role;
