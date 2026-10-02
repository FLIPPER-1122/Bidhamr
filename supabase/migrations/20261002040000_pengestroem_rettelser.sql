-- Pengestrøm: rettelser fra den samlede gennemgang (2. oktober 2026).
--
-- Idempotent og sikker at køre flere gange (add column if not exists,
-- create or replace, constraints kun ændret, hvis de stadig er cascade).
-- Ingen data slettes eller ændres ud over nye kolonner med standardværdier.
--
--   V1  Påmindelser til sælger uden udbetalingskonto (claim-kolonner) og
--       markering til admin efter 7 dage.
--   V2  Refusion tilladt for frigivne, ikke-overførte betalinger. Admin kan
--       give overførslen nye forsøg. Cron markerer, når forsøgene er brugt op.
--   V3  Indsigelser (chargebacks): spejles fra Stripe og blokerer overførsel
--       og frigivelse, til indsigelsen er vundet/lukket.
--   V4  Betalte handler, der ikke er afsluttet efter 14 dage, markeres.
--   M1  Delvis refusion hos Stripe blokerer overførsel (refusion_anmodet_kl).
--   M3  Ubetalte sager, hvor Stripe-annullering ikke er lykkedes efter 7 dage,
--       markeres (claim-kolonne).
--   M5  Admin-annullering af en ikke-betalt handel giver sælgeren samme
--       muligheder som ved ubetalt vinder (ubetalte_vindere.aarsag), uden
--       advarsel til køberen.
--   M6  View over afsluttede auktioner med vinder, men uden handel.
--   M7  bids, trades og transactions: on delete cascade -> restrict.

-- ============================================================ kolonner

alter table public.betalinger
  add column if not exists saelgerkonto_mail_1_kl    timestamptz,
  add column if not exists saelgerkonto_mail_2_kl    timestamptz,
  add column if not exists saelgerkonto_mail_3_kl    timestamptz,
  add column if not exists saelgerkonto_markeret_kl  timestamptz,
  add column if not exists overfoersel_graense       integer not null default 3,
  add column if not exists indsigelse_kl             timestamptz,
  add column if not exists indsigelse_status         text,
  add column if not exists stripe_dispute_id         text,
  add column if not exists ikke_afsluttet_markeret_kl timestamptz;

alter table public.betalinger
  add column if not exists overfoersel_opbrugt boolean
    generated always as (overfoersel_forsoeg >= overfoersel_graense) stored;

comment on column public.betalinger.overfoersel_graense is
  'Cron prøver overførslen, så længe overfoersel_forsoeg < overfoersel_graense. '
  'Admin giver nye forsøg ved at hæve grænsen (betaling_overfoersel_nulstil) - '
  'tælleren nulstilles aldrig, da den indgår i Stripes idempotency key.';
comment on column public.betalinger.indsigelse_kl is
  'Første gang en indsigelse (chargeback) blev registreret fra Stripe.';
comment on column public.betalinger.indsigelse_status is
  'Stripes dispute.status. Blokerer overførsel/frigivelse, medmindre '
  'won, warning_closed eller prevented.';

create index if not exists betalinger_kraever_opmaerksomhed_idx
  on public.betalinger (kraever_opmaerksomhed) where kraever_opmaerksomhed;
create index if not exists betalinger_stripe_charge_idx
  on public.betalinger (stripe_charge_id);

alter table public.ubetalte_vindere
  add column if not exists stripe_annullering_markeret_kl timestamptz,
  add column if not exists aarsag text not null default 'ubetalt';

do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'ubetalte_vindere_aarsag_check'
                    and conrelid = 'public.ubetalte_vindere'::regclass) then
    alter table public.ubetalte_vindere
      add constraint ubetalte_vindere_aarsag_check
      check (aarsag in ('ubetalt', 'admin_annulleret'));
  end if;
end;
$do$;

comment on column public.ubetalte_vindere.aarsag is
  'ubetalt: køberen betalte ikke inden fristen (sag til medarbejder). '
  'admin_annulleret: admin annullerede en ikke-betalt handel; oprettes som '
  'afvist (ingen advarsel), men giver sælgeren samme muligheder.';

-- Blokerer en indsigelse? (åben eller tabt)
create or replace function public.betaling_indsigelse_blokerer(
  p_kl timestamptz, p_status text)
returns boolean
language sql immutable set search_path = public as $fn$
  select p_kl is not null
     and coalesce(p_status, '') not in ('won', 'warning_closed', 'prevented');
$fn$;

revoke all on function public.betaling_indsigelse_blokerer(timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_blokerer(timestamptz, text)
  to service_role;

-- ============================================================ V2 refusion

-- Som før, men en frigivet betaling kan også refunderes, så længe intet er
-- overført eller sat i gang (stripe_transfer_id og overfoersel_paabegyndt_kl
-- er null). Rækkelåsen deles med betaling_claim_overfoersel, så de to aldrig
-- kan ske samtidig.
create or replace function public.betaling_paabegynd_refusion(
  p_trade uuid, p_aarsag text)
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then return null; end if;

  if b.status <> 'betalt'
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null then
    return null;
  end if;

  update public.betalinger
     set refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, p_aarsag),
         opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = p_trade
     and status in ('betaling_modtaget','pakke_sendt','modtaget','leveret','annulleret');

  return b.total_oere;
end;
$fn$;

revoke all on function public.betaling_paabegynd_refusion(uuid, text)
  from public, anon, authenticated;
grant execute on function public.betaling_paabegynd_refusion(uuid, text) to service_role;

-- ============================================================ overførsel

create or replace function public.betaling_claim_overfoersel(p_betaling uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
  t record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return false; end if;
  select * into t from public.trades where id = b.trade_id for update;

  if b.status <> 'betalt'
     or b.frigivet_kl is null
     or b.refusion_anmodet_kl is not null
     or b.stripe_charge_id is null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or t.sag_aaben
     or t.status = 'annulleret' then
    return false;
  end if;

  update public.betalinger
     set overfoersel_paabegyndt_kl = coalesce(overfoersel_paabegyndt_kl, now()),
         opdateret = now()
   where id = b.id;
  return true;
end;
$fn$;

revoke all on function public.betaling_claim_overfoersel(uuid) from public, anon, authenticated;
grant execute on function public.betaling_claim_overfoersel(uuid) to service_role;

-- Endelig afvist overførsel. Når forsøgene er brugt op, står det i sidste_fejl,
-- så admin kan se, at cron er stoppet.
create or replace function public.betaling_overfoersel_fejlet(
  p_betaling uuid, p_fejl text)
returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  update public.betalinger
     set overfoersel_paabegyndt_kl = null,
         overfoersel_forsoeg = overfoersel_forsoeg + 1,
         kraever_opmaerksomhed = true,
         sidste_fejl = left(
           case when overfoersel_forsoeg + 1 >= overfoersel_graense
                then 'Overførsel opgivet efter ' || (overfoersel_forsoeg + 1)
                     || ' forsøg - prøv igen eller refundér. ' || p_fejl
                else p_fejl end, 500),
         opdateret = now()
   where id = p_betaling
     and stripe_transfer_id is null;
  return found;
end;
$fn$;

revoke all on function public.betaling_overfoersel_fejlet(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_overfoersel_fejlet(uuid, text) to service_role;

-- Admin: giv overførslen 3 nye forsøg. Tælleren nulstilles ikke (den indgår
-- i idempotency key'en, og en genbrugt key ville give Stripes gemte fejlsvar
-- tilbage) - i stedet hæves grænsen. Afvises for alt, der ikke må overføres.
create or replace function public.betaling_overfoersel_nulstil(p_betaling uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  update public.betalinger
     set overfoersel_graense = overfoersel_forsoeg + 3,
         kraever_opmaerksomhed = false,
         sidste_fejl = null,
         opdateret = now()
   where id = p_betaling
     and status = 'betalt'
     and frigivet_kl is not null
     and stripe_transfer_id is null
     and refusion_anmodet_kl is null
     and not public.betaling_indsigelse_blokerer(indsigelse_kl, indsigelse_status);
  return found;
end;
$fn$;

revoke all on function public.betaling_overfoersel_nulstil(uuid) from public, anon, authenticated;
grant execute on function public.betaling_overfoersel_nulstil(uuid) to service_role;

-- ============================================================ godkend/frigiv

create or replace function public.handel_godkend(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  kalder uuid := auth.uid();
  b      record;
  t      record;
begin
  if kalder is null then return false; end if;

  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return false;
  end if;

  update public.trades
     set status = 'leveret'
   where id = p_trade
     and status = 'modtaget'
     and buyer_id = kalder
     and not coalesce(sag_aaben, false)
  returning * into t;

  if not found then return false; end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where id = b.id and frigivet_kl is null;

  return true;
end;
$fn$;

revoke all on function public.handel_godkend(uuid) from public, anon;
grant execute on function public.handel_godkend(uuid) to authenticated;

create or replace function public.admin_frigiv_handel(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;

  if not found then
    raise exception 'HANDEL_UDEN_BETALING'
      using hint = 'Handlen har ingen betaling og kan ikke frigives.';
  end if;

  if b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return false;
  end if;

  update public.trades
     set status = 'leveret',
         received_at = coalesce(received_at, now()),
         sag_aaben = false
   where id = p_trade
     and status in ('betaling_modtaget', 'pakke_sendt', 'modtaget');

  if not found then return false; end if;

  update public.betalinger
     set frigivet_kl = coalesce(frigivet_kl, now()), opdateret = now()
   where id = b.id;
  return true;
end;
$fn$;

revoke execute on function public.admin_frigiv_handel(uuid) from public, anon, authenticated;
grant execute on function public.admin_frigiv_handel(uuid) to service_role;

-- ============================================================ V3 indsigelse

-- Spejler en indsigelse fra Stripe (status hentet frisk fra Stripe, så events
-- i forkert rækkefølge ikke giver forkert status). Idempotent.
-- Returnerer 'ukendt' | 'blokeret' | 'tabt' | 'afsluttet'.
create or replace function public.betaling_registrer_indsigelse(
  p_payment_intent text, p_charge text, p_dispute text, p_status text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
  besked text;
begin
  select * into b from public.betalinger
   where (p_payment_intent is not null and stripe_payment_intent_id = p_payment_intent)
      or (p_charge is not null and stripe_charge_id = p_charge)
   limit 1
   for update;
  if not found then return 'ukendt'; end if;

  if p_status = 'lost' then
    besked := 'Indsigelse tabt hos Stripe - køberens bank har tilbageført betalingen';
  elsif public.betaling_indsigelse_blokerer(now(), p_status) then
    besked := 'Køberen har lavet en indsigelse hos sin bank (' || p_status || ')';
    if b.stripe_transfer_id is not null or b.overfoersel_paabegyndt_kl is not null then
      besked := besked || ' efter overførsel til sælger';
    end if;
  else
    besked := 'Indsigelse afsluttet til BidHamrs fordel (' || p_status || ')';
  end if;

  update public.betalinger
     set indsigelse_kl = coalesce(indsigelse_kl, now()),
         indsigelse_status = p_status,
         stripe_dispute_id = coalesce(p_dispute, stripe_dispute_id),
         kraever_opmaerksomhed = case
           when public.betaling_indsigelse_blokerer(now(), p_status) then true
           else kraever_opmaerksomhed end,
         sidste_fejl = left(besked, 500),
         opdateret = now()
   where id = b.id;

  if p_status = 'lost' then return 'tabt'; end if;
  if public.betaling_indsigelse_blokerer(now(), p_status) then return 'blokeret'; end if;
  return 'afsluttet';
end;
$fn$;

revoke all on function public.betaling_registrer_indsigelse(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_indsigelse(text, text, text, text)
  to service_role;

-- ============================================================ M1 delvis refusion

-- En delvis refusion (fx i Stripe Dashboard) markeres til admin og blokerer
-- overførsel: betaling_claim_overfoersel afviser, når refusion_anmodet_kl er sat.
create or replace function public.betaling_registrer_delvis_refusion(
  p_payment_intent text, p_besked text)
returns void
language sql security definer set search_path = public as $fn$
  update public.betalinger
     set kraever_opmaerksomhed = true,
         sidste_fejl = left(p_besked, 500),
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, 'delvis_refusion_stripe'),
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
$fn$;

revoke all on function public.betaling_registrer_delvis_refusion(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_delvis_refusion(text, text) to service_role;

-- ============================================================ V4 hængende handler

-- Betalt, men ikke frigivet eller refunderet 14 dage efter betalingen
-- (trades har ingen updated_at, så betalt_kl bruges). Markeres én gang.
create or replace function public.betaling_marker_ikke_afsluttet()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  antal integer;
  tekst constant text := 'Handlen er ikke afsluttet efter 14 dage';
begin
  update public.betalinger
     set kraever_opmaerksomhed = true,
         sidste_fejl = left(case
           when kraever_opmaerksomhed and sidste_fejl is not null
             then sidste_fejl || ' · ' || tekst
           else tekst end, 500),
         ikke_afsluttet_markeret_kl = now(),
         opdateret = now()
   where status = 'betalt'
     and frigivet_kl is null
     and refusion_anmodet_kl is null
     and ikke_afsluttet_markeret_kl is null
     and betalt_kl < now() - interval '14 days';
  get diagnostics antal = row_count;
  return antal;
end;
$fn$;

revoke all on function public.betaling_marker_ikke_afsluttet() from public, anon, authenticated;
grant execute on function public.betaling_marker_ikke_afsluttet() to service_role;

-- ============================================================ M5

-- Admin annullerer en IKKE-betalt handel. Betalingen annulleres, og der
-- oprettes en ubetalte_vindere-række med aarsag 'admin_annulleret' og status
-- 'afvist' (admin har taget stilling - ingen advarsel, tæller ikke som
-- afventende). Rækken giver sælgeren de samme muligheder som ved en ubetalt
-- vinder (andenchance_opret og genopsaet_auktion kræver blot rækken).
-- Returnerer { kode, payment_intent? }. Koder: ok, ingen_adgang,
-- begrundelse_mangler, ikke_fundet, ikke_annullerbar.
create or replace function public.admin_annuller_ikke_betalt(
  p_trade uuid, p_admin uuid, p_begrundelse text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b     record;
  grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  res   jsonb;
begin
  if not exists (select 1 from public.users
                  where id = p_admin and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;

  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  res := public.betaling_annuller(p_trade);
  if res is null then return jsonb_build_object('kode', 'ikke_annullerbar'); end if;

  insert into public.ubetalte_vindere (
    trade_id, auction_id, buyer_id, seller_id, aarsag,
    status, behandlet_af, behandlet_kl, begrundelse)
  values (
    p_trade, b.auction_id, b.buyer_id, b.seller_id, 'admin_annulleret',
    'afvist', p_admin, now(), left(grund, 1000))
  on conflict (trade_id) do nothing;

  return jsonb_build_object('kode', 'ok', 'payment_intent', res->>'payment_intent');
end;
$fn$;

revoke all on function public.admin_annuller_ikke_betalt(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_annuller_ikke_betalt(uuid, uuid, text) to service_role;

-- Ny log-handling: admin har prøvet en overførsel igen.
alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen'));

-- ============================================================ M6

-- afslut_udloebne_auktioner opretter kun handler for auktioner, der sluttede
-- inden for 7 dage. Grænsen beholdes: uden den ville gamle auktioner (fx fra
-- før betalingsmodellen) pludselig få en handel med 24 timers betalingsfrist
-- og "du vandt"-mail. I stedet kan admin se alle afsluttede auktioner med
-- vinder, men uden handel, her (også dem, hvor oprettelsen fejlede).
create or replace view public.auktioner_uden_handel
with (security_invoker = true) as
select a.id, a.titel, a.bruger_id as saelger_id, a.vinder_id, a.slutter_kl,
       a.slutter_kl < now() - interval '7 days' as for_gammel_til_automatik
  from public.auctions a
 where a.status = 'afsluttet'
   and a.vinder_id is not null
   and a.slutter_kl < now() - interval '10 minutes'
   and not exists (select 1 from public.trades t where t.auction_id = a.id);

revoke all on public.auktioner_uden_handel from public, anon, authenticated;
grant select on public.auktioner_uden_handel to service_role;

-- ============================================================ M7

-- Bud, handler og gamle transaktioner må aldrig forsvinde, fordi en bruger
-- eller auktion slettes (bogføringsloven/DAC7). Kun constraints, der stadig er
-- cascade mod users/auctions, ændres - så migrationen er idempotent.
-- NOT VALID + VALIDATE undgår en lang lås på tabellen.
do $do$
declare
  r record;
  def text;
begin
  for r in
    select c.conname, c.conrelid::regclass as tabel, c.conrelid
      from pg_constraint c
     where c.contype = 'f'
       and c.confdeltype = 'c'
       and c.conrelid in (to_regclass('public.bids'), to_regclass('public.trades'),
                          to_regclass('public.transactions'))
       and c.confrelid in (to_regclass('public.users'), to_regclass('public.auctions'))
  loop
    def := pg_get_constraintdef(
      (select oid from pg_constraint where conname = r.conname and conrelid = r.conrelid));
    if position('ON DELETE CASCADE' in def) = 0 then
      raise exception 'Uventet constraint-definition for %: %', r.conname, def;
    end if;
    def := replace(def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT');
    execute format('alter table %s drop constraint %I', r.tabel, r.conname);
    execute format('alter table %s add constraint %I %s not valid', r.tabel, r.conname, def);
    execute format('alter table %s validate constraint %I', r.tabel, r.conname);
  end loop;
end;
$do$;
