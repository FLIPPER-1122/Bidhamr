-- Ny betalingsmodel, trin 4: refusioner og indsigelser (docs/BETALINGSMODEL-PLAN.md
-- afsnit 1.5, 1.6 og 6.4). ROADMAP-BESLUTNINGER.md "Indsigelse fra køberens bank
-- efter udbetaling", "Lovede refusioner (Niels F05)" og "Ny betalingsmodel –
-- Filips svar (8. okt. 2026)".
--
-- Destination charges: købers penge står på sælgerens Stripe Connect-konto,
-- BidHamrs gebyr (application fee) er trukket. Serveren (src/lib/betaling/
-- refusion.ts og indsigelse.ts) gør Stripe-delen; databasen låser planen og
-- spejler hvert trin.
--
--  1. Refusionsplan (låst i databasen, eksakte beløb, ingen afrunding):
--       R = refusionsbeløbet (refusion_oere, ellers total_oere)
--       S = fra sælgerens konto  = udbetaling_oere (sælgeren får intet, når
--           køberen får pengene tilbage - både ved annullering og sag)
--       G = gebyr-refusion       = R - S (0 <= G <= application_fee_oere)
--     Trin (hvert idempotent og spejlet): (a) application fee refunderes med
--     G til sælgerens konto, (b) transferen til sælgerens konto tilbageføres
--     med R, (c) køberen refunderes R fra platformen. Rækkefølgen gør, at
--     sælgerens saldo aldrig bliver negativ (U + G - R = U - S >= 0).
--     Fuld refusion: R = total, G = hele gebyret. Sag med medhold: R = total -
--     BidHamr Beskyttelse, G = gebyret - Beskyttelse (BidHamr beholder kun
--     Beskyttelsen).
--  2. Indsigelse (dispute, model A): på destination charges trækkes
--     indsigelsen fra platformen. FØR udbetaling fryses pengene (trin 3's
--     blokering); TABT -> BidHamr henter beløbet tilbage fra sælgerens konto
--     (transfer reversal, højst udbetaling_oere og højst det omstridte
--     beløb). EFTER udbetaling trækkes INTET fra sælgeren. Tilbageførslen
--     prøves igen med spredte forsøg (højst 5, derefter markering til staff).
--
-- Som trin 1-3: INTET ændres for 'separat'. Ingen eksisterende funktion
-- genoprettes. Idempotent. Ændrer ingen handelsdata. Nye funktioner:
-- security definer med search_path = '' og fuldt kvalificerede navne.

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. Kolonner
-- ===========================================================================
alter table public.betalinger
  add column if not exists refusion_tilbagefoersel_id            text,
  add column if not exists refusion_tilbagefoert_kl              timestamptz,
  add column if not exists indsigelse_tilbagefoert_oere          bigint,
  add column if not exists indsigelse_tilbagefoert_kl            timestamptz,
  add column if not exists indsigelse_tilbagefoersel_forsoeg     integer not null default 0,
  add column if not exists indsigelse_tilbagefoersel_naeste_kl   timestamptz,
  add column if not exists indsigelse_tilbagefoersel_laas_til    timestamptz,
  add column if not exists indsigelse_beviser_kl                 timestamptz;

comment on column public.betalinger.refusion_fra_saelger_oere is
  'Destination, refusionsplan (trin 4): det, sælgerens konto bidrager med (S = udbetaling_oere). Låst ved første refusionsforsøg.';
comment on column public.betalinger.refusion_gebyr_oere is
  'Destination, refusionsplan (trin 4): BidHamrs gebyr-refusion til sælgerens konto (G = R - S). Låst ved første refusionsforsøg.';
comment on column public.betalinger.stripe_fee_refund_id is
  'Destination: application fee-refusionen (fr_...) i refusionsplanen.';
comment on column public.betalinger.gebyr_refunderet_kl is
  'Destination: gebyr-refusionen (G) er gennemført hos Stripe.';
comment on column public.betalinger.refusion_tilbagefoersel_id is
  'Destination: tilbageførslen (trr_...) af R fra sælgerens konto i refusionsplanen.';
comment on column public.betalinger.refusion_tilbagefoert_kl is
  'Destination: R er tilbageført fra sælgerens konto til platformen (refusionen til køberen følger).';
comment on column public.betalinger.indsigelse_tilbagefoersel_id is
  'Destination: tabt indsigelse før udbetaling - tilbageførslen (trr_...) fra sælgerens konto.';
comment on column public.betalinger.indsigelse_tilbagefoert_oere is
  'Destination: beløbet, der tilbageføres ved tabt indsigelse (låst ved første forsøg: mindste af udbetaling_oere og det omstridte beløb).';
comment on column public.betalinger.indsigelse_beviser_kl is
  'Destination: beviser er lagt klar på indsigelsen hos Stripe (ikke indsendt - staff indsender).';

do $do$
begin
  -- En 'separat'-række har aldrig trin 4-kolonner (som betalinger_separat_uden_destination).
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_separat_uden_trin4'
                    and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_separat_uden_trin4
      check (pengemodel <> 'separat' or (
        refusion_tilbagefoersel_id is null and refusion_tilbagefoert_kl is null
        and indsigelse_tilbagefoert_oere is null and indsigelse_tilbagefoert_kl is null
        and indsigelse_tilbagefoersel_forsoeg = 0 and indsigelse_tilbagefoersel_naeste_kl is null
        and indsigelse_tilbagefoersel_laas_til is null and indsigelse_beviser_kl is null));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_indsigelse_tilbagefoert_check'
                    and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_indsigelse_tilbagefoert_check
      check (indsigelse_tilbagefoert_oere is null
             or indsigelse_tilbagefoert_oere between 0 and udbetaling_oere);
  end if;
  -- Et refusionstrin kan kun være gennemført med en låst plan.
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_refusionstrin_kraever_plan'
                    and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_refusionstrin_kraever_plan
      check ((gebyr_refunderet_kl is null and refusion_tilbagefoert_kl is null)
             or (refusion_fra_saelger_oere is not null and refusion_gebyr_oere is not null));
  end if;
end $do$;

-- Planen og gennemførte trin kan ikke ændres bagefter (kun service role
-- skriver, men også en fejl i koden må ikke flytte et låst beløb).
create or replace function public.betalinger_refusionsplan_laas()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if old.refusion_fra_saelger_oere is not null
     and (new.refusion_fra_saelger_oere is distinct from old.refusion_fra_saelger_oere
          or new.refusion_gebyr_oere is distinct from old.refusion_gebyr_oere) then
    raise exception 'betalinger_refusionsplan_laast: refusionsplanen kan ikke ændres';
  end if;
  if old.gebyr_refunderet_kl is not null
     and (new.gebyr_refunderet_kl is distinct from old.gebyr_refunderet_kl
          or new.stripe_fee_refund_id is distinct from old.stripe_fee_refund_id) then
    raise exception 'betalinger_refusionsplan_laast: gebyr-refusionen kan ikke ændres';
  end if;
  if old.refusion_tilbagefoert_kl is not null
     and (new.refusion_tilbagefoert_kl is distinct from old.refusion_tilbagefoert_kl
          or new.refusion_tilbagefoersel_id is distinct from old.refusion_tilbagefoersel_id) then
    raise exception 'betalinger_refusionsplan_laast: tilbageførslen kan ikke ændres';
  end if;
  if old.indsigelse_tilbagefoert_oere is not null
     and new.indsigelse_tilbagefoert_oere is distinct from old.indsigelse_tilbagefoert_oere then
    raise exception 'betalinger_refusionsplan_laast: beløbet for tilbageførsel ved indsigelse kan ikke ændres';
  end if;
  if old.indsigelse_tilbagefoersel_id is not null
     and (new.indsigelse_tilbagefoersel_id is distinct from old.indsigelse_tilbagefoersel_id
          or new.indsigelse_tilbagefoert_kl is distinct from old.indsigelse_tilbagefoert_kl) then
    raise exception 'betalinger_refusionsplan_laast: tilbageførslen ved indsigelse kan ikke ændres';
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_refusionsplan_laas() from public, anon, authenticated;

drop trigger if exists betalinger_refusionsplan_laas on public.betalinger;
create trigger betalinger_refusionsplan_laas
  before update on public.betalinger
  for each row execute function public.betalinger_refusionsplan_laas();

-- ===========================================================================
-- 2. Refusionsplan (destination) - under refusionslåsen
-- ===========================================================================
-- Låser planen ved første kald og returnerer den. Kræver, at kalderen holder
-- refusionslåsen (betaling_refusion_laas). Planen er altid eksakt:
-- fra_saelger + gebyr = refusion (CHECK betalinger_refusionsplan_stemmer).
create or replace function public.betaling_refusionsplan(p_betaling uuid, p_noegle uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b   record;
  v_r bigint;
  v_s bigint;
  v_g bigint;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_noegle is null or b.refusion_laas_noegle is distinct from p_noegle
     or b.refusion_laas_til is null or b.refusion_laas_til <= now() then
    return jsonb_build_object('kode', 'ikke_laast');
  end if;
  if b.pengemodel <> 'destination' then return jsonb_build_object('kode', 'ikke_destination'); end if;
  if b.status <> 'betalt' or b.refusion_anmodet_kl is null then
    return jsonb_build_object('kode', 'ikke_anmodet');
  end if;
  if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetalt');
  end if;
  -- En indsigelse afgøres af banken (og en tabt tager pengene fra sælgerens
  -- konto via betaling_indsigelse_tilbagefoersel_*): ingen refusionstrin.
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or b.indsigelse_tilbagefoert_oere is not null
     or (b.indsigelse_tilbagefoersel_laas_til is not null and b.indsigelse_tilbagefoersel_laas_til > now()) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if b.application_fee_oere is null or b.saelger_stripe_konto is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  v_r := coalesce(b.refusion_oere, b.total_oere);
  -- Sælgeren får intet, når køberen får pengene tilbage (annullering og sag
  -- med medhold): hele hans del tages tilbage. BidHamr giver sit gebyr
  -- tilbage, undtagen den del køberen ikke får (BidHamr Beskyttelse ved sag).
  v_s := b.udbetaling_oere;
  v_g := v_r - v_s;
  if v_r <= 0 or v_r > b.total_oere or v_s < 0 or v_g < 0 or v_g > b.application_fee_oere then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  if b.refusion_fra_saelger_oere is null then
    update public.betalinger
       set refusion_fra_saelger_oere = v_s, refusion_gebyr_oere = v_g, opdateret = now()
     where id = b.id;
  elsif b.refusion_fra_saelger_oere <> v_s or b.refusion_gebyr_oere <> v_g then
    return jsonb_build_object('kode', 'konflikt');
  end if;

  return jsonb_build_object(
    'kode', 'ok',
    'refusion_oere', v_r,
    'fra_saelger_oere', v_s,
    'gebyr_oere', v_g,
    'application_fee_oere', b.application_fee_oere,
    'saelger_stripe_konto', b.saelger_stripe_konto,
    'gebyr_refunderet', b.gebyr_refunderet_kl is not null,
    'tilbagefoert', b.refusion_tilbagefoert_kl is not null);
end;
$fn$;

revoke all on function public.betaling_refusionsplan(uuid, uuid) from public, anon, authenticated;
grant execute on function public.betaling_refusionsplan(uuid, uuid) to service_role;

-- Registrerer et gennemført trin i planen (under låsen). p_trin: 'gebyr' eller
-- 'tilbagefoersel'. Idempotent; et allerede registreret trin ændres ikke.
create or replace function public.betaling_refusion_trin(
  p_betaling uuid, p_noegle uuid, p_trin text, p_stripe_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_trin = 'gebyr' then
    update public.betalinger
       set stripe_fee_refund_id = coalesce(stripe_fee_refund_id, p_stripe_id),
           gebyr_refunderet_kl = now(), opdateret = now()
     where id = p_betaling and pengemodel = 'destination'
       and refusion_laas_noegle = p_noegle and refusion_laas_til > now()
       and refusion_fra_saelger_oere is not null and gebyr_refunderet_kl is null;
  elsif p_trin = 'tilbagefoersel' then
    update public.betalinger
       set refusion_tilbagefoersel_id = coalesce(refusion_tilbagefoersel_id, p_stripe_id),
           refusion_tilbagefoert_kl = now(), opdateret = now()
     where id = p_betaling and pengemodel = 'destination'
       and refusion_laas_noegle = p_noegle and refusion_laas_til > now()
       and refusion_fra_saelger_oere is not null and refusion_tilbagefoert_kl is null;
  else
    return false;
  end if;
  return found;
end;
$fn$;

revoke all on function public.betaling_refusion_trin(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.betaling_refusion_trin(uuid, uuid, text, text) to service_role;

-- ===========================================================================
-- 3. Tabt indsigelse før udbetaling: tilbageførsel fra sælgerens konto
-- ===========================================================================
-- Claim (lås i 15 min). p_omstridt = det omstridte beløb hos Stripe
-- (dispute.amount). Beløbet låses første gang: mindste af udbetaling_oere og
-- det omstridte beløb (chefens valg ved delvis indsigelse - resten afgør staff).
-- Kode:
--   ok                    -> tilbagefør 'beloeb' nu (nøgle med 'forsoeg')
--   udbetalt              -> handlen var helt færdig og udbetalt: BidHamr bærer
--                            tabet, intet trækkes fra sælgeren
--   udbetaling_uafklaret  -> en udbetaling er claimet/usikker - prøv igen senere
--   refusion              -> et refusionstrin er i gang/gennemført - staff
--   i_gang                -> denne tilbageførsel eller en refusion holder låsen
--   allerede, ikke_tabt, ikke_destination, venter, opgivet, ugyldig, ikke_fundet
create or replace function public.betaling_indsigelse_tilbagefoersel_claim(p_betaling uuid, p_omstridt bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b  record;
  us text;
  v_beloeb bigint;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if b.pengemodel <> 'destination' then return jsonb_build_object('kode', 'ikke_destination'); end if;
  if coalesce(b.indsigelse_status, '') <> 'lost' then return jsonb_build_object('kode', 'ikke_tabt'); end if;
  if b.indsigelse_tilbagefoersel_id is not null then return jsonb_build_object('kode', 'allerede'); end if;
  if b.saelger_udbetaling_id is not null then
    select u.status into us from public.saelger_udbetalinger u where u.id = b.saelger_udbetaling_id;
    if us in ('claimet', 'usikker') then
      return jsonb_build_object('kode', 'udbetaling_uafklaret');
    end if;
    return jsonb_build_object('kode', 'udbetalt');
  end if;
  if b.stripe_transfer_id is not null or b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetalt');
  end if;
  if b.status = 'refunderet' or b.gebyr_refunderet_kl is not null or b.refusion_tilbagefoert_kl is not null
     or b.stripe_refund_id is not null then
    return jsonb_build_object('kode', 'refusion');
  end if;
  -- En refusion holder låsen (kan være midt i sine Stripe-trin): vent.
  if b.refusion_laas_til is not null and b.refusion_laas_til > now() then
    return jsonb_build_object('kode', 'i_gang');
  end if;
  if b.stripe_destination_transfer_id is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  if b.indsigelse_tilbagefoersel_laas_til is not null and b.indsigelse_tilbagefoersel_laas_til > now() then
    return jsonb_build_object('kode', 'i_gang');
  end if;
  if b.indsigelse_tilbagefoersel_forsoeg >= 5 then return jsonb_build_object('kode', 'opgivet'); end if;
  if b.indsigelse_tilbagefoersel_naeste_kl is not null and b.indsigelse_tilbagefoersel_naeste_kl > now() then
    return jsonb_build_object('kode', 'venter');
  end if;

  v_beloeb := coalesce(b.indsigelse_tilbagefoert_oere,
                       least(b.udbetaling_oere, greatest(coalesce(p_omstridt, 0), 0)));
  if v_beloeb <= 0 then return jsonb_build_object('kode', 'ugyldig'); end if;

  update public.betalinger
     set indsigelse_tilbagefoert_oere = v_beloeb,
         indsigelse_tilbagefoersel_laas_til = now() + interval '15 minutes',
         opdateret = now()
   where id = b.id;

  return jsonb_build_object('kode', 'ok', 'beloeb', v_beloeb,
                            'forsoeg', b.indsigelse_tilbagefoersel_forsoeg,
                            'transfer', b.stripe_destination_transfer_id,
                            'konto', b.saelger_stripe_konto,
                            'delvis', v_beloeb < b.udbetaling_oere);
end;
$fn$;

revoke all on function public.betaling_indsigelse_tilbagefoersel_claim(uuid, bigint) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tilbagefoersel_claim(uuid, bigint) to service_role;

-- Tilbageførslen er gennemført hos Stripe.
create or replace function public.betaling_indsigelse_tilbagefoersel_registrer(p_betaling uuid, p_reversal text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found or b.pengemodel <> 'destination' or p_reversal is null then return false; end if;
  if b.indsigelse_tilbagefoersel_id is not null then return b.indsigelse_tilbagefoersel_id = p_reversal; end if;
  update public.betalinger
     set indsigelse_tilbagefoersel_id = p_reversal,
         indsigelse_tilbagefoert_kl = now(),
         indsigelse_tilbagefoersel_laas_til = null,
         indsigelse_tilbagefoersel_naeste_kl = null,
         opdateret = now()
   where id = b.id;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (public.bidhamr_system_id(), 'betaling_loest', 'handel', b.trade_id, b.seller_id,
          'Tabt indsigelse før udbetaling: beløbet er hentet tilbage fra sælgerens Stripe-konto (ingen udbetaling)');
  return true;
end;
$fn$;

revoke all on function public.betaling_indsigelse_tilbagefoersel_registrer(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tilbagefoersel_registrer(uuid, text) to service_role;

-- Tilbageførslen fejlede: nyt forsøg efter backoff (5 min, 10 min ... højst
-- 6 t). Efter 5 forsøg (eller p_stop) stopper det automatiske, og betalingen
-- markeres til staff. Returnerer {forsoeg, opgivet}.
create or replace function public.betaling_indsigelse_tilbagefoersel_fejl(
  p_betaling uuid, p_besked text, p_stop boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
  v_opgivet boolean;
begin
  update public.betalinger
     set indsigelse_tilbagefoersel_forsoeg = case when coalesce(p_stop, false) then greatest(indsigelse_tilbagefoersel_forsoeg + 1, 5)
                                                  else indsigelse_tilbagefoersel_forsoeg + 1 end,
         indsigelse_tilbagefoersel_naeste_kl = now() + public.betaling_refusion_backoff(indsigelse_tilbagefoersel_forsoeg + 1),
         indsigelse_tilbagefoersel_laas_til = null,
         opdateret = now()
   where id = p_betaling and pengemodel = 'destination' and indsigelse_tilbagefoersel_id is null
  returning indsigelse_tilbagefoersel_forsoeg into n;
  if n is null then return jsonb_build_object('forsoeg', null, 'opgivet', false); end if;
  v_opgivet := n >= 5;
  if v_opgivet or coalesce(p_stop, false) then
    update public.betalinger
       set kraever_opmaerksomhed = true,
           sidste_fejl = public.betaling_fejl_tilfoej(sidste_fejl,
             left('Tabt indsigelse: beløbet kunne ikke hentes tilbage fra sælgerens Stripe-konto - ' || coalesce(p_besked, 'ukendt fejl'), 400),
             kraever_opmaerksomhed)
     where id = p_betaling;
  end if;
  return jsonb_build_object('forsoeg', n, 'opgivet', v_opgivet);
end;
$fn$;

revoke all on function public.betaling_indsigelse_tilbagefoersel_fejl(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tilbagefoersel_fejl(uuid, text, boolean) to service_role;

-- Admin/chef: "Prøv igen" på en opgivet tilbageførsel ved tabt indsigelse
-- (inhabil = køber eller sælger på handlen). Giver 3 nye forsøg.
create or replace function public.betaling_indsigelse_tilbagefoersel_proev_igen(p_medarbejder uuid, p_betaling uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
begin
  if not exists (select 1 from public.users where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if b.pengemodel <> 'destination' or coalesce(b.indsigelse_status, '') <> 'lost' then
    return jsonb_build_object('kode', 'ikke_tabt');
  end if;
  if b.indsigelse_tilbagefoersel_id is not null then return jsonb_build_object('kode', 'allerede'); end if;
  if b.indsigelse_tilbagefoersel_laas_til is not null and b.indsigelse_tilbagefoersel_laas_til > now() then
    return jsonb_build_object('kode', 'i_gang');
  end if;
  update public.betalinger
     set indsigelse_tilbagefoersel_forsoeg = least(indsigelse_tilbagefoersel_forsoeg, 2),
         indsigelse_tilbagefoersel_naeste_kl = null,
         opdateret = now()
   where id = b.id;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'refusion_proevet_igen', 'handel', b.trade_id, b.seller_id,
          'Tilbageførsel fra sælgerens konto ved tabt indsigelse prøvet igen');
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.betaling_indsigelse_tilbagefoersel_proev_igen(uuid, uuid) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tilbagefoersel_proev_igen(uuid, uuid) to service_role;

-- Beviser er lagt klar på indsigelsen hos Stripe (registreres efter kaldet).
create or replace function public.betaling_indsigelse_beviser_registrer(p_betaling uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.betalinger
     set indsigelse_beviser_kl = now(), opdateret = now()
   where id = p_betaling and pengemodel = 'destination' and indsigelse_beviser_kl is null;
  return found;
end;
$fn$;

revoke all on function public.betaling_indsigelse_beviser_registrer(uuid) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_beviser_registrer(uuid) to service_role;

create index if not exists betalinger_indsigelse_tilbagefoersel_venter_idx
  on public.betalinger (indsigelse_tilbagefoersel_naeste_kl)
  where pengemodel = 'destination' and indsigelse_status = 'lost' and indsigelse_tilbagefoersel_id is null;
