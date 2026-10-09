-- Ny betalingsmodel, trin 4: rettelser efter review (docs/BETALINGSMODEL-PLAN.md 6.4).
--
--  1. Tabt indsigelse: udfaldet afklares og gemmes (indsigelse_tabt_afklaret),
--     så en tabt indsigelse, mens en udbetaling var uafklaret, behandles igen,
--     når udbetalingen er afklaret - og beskederne til sælger og køber først
--     sendes, når det vides, om handlen var udbetalt:
--       tilbagefoert      - beløbet er hentet tilbage fra sælgerens konto
--       udbetalt          - udbetalingen er PAID (pengene har forladt Stripe):
--                           BidHamr bærer tabet
--       stoppet           - til staff (fx for lidt på sælgerens konto)
--       udbetaling_fejlet - var 'udbetalt', men udbetalingen fejlede/blev
--                           annulleret bagefter (pengene står igen på sælgerens
--                           konto). Chefens valg: behandles som ikke udbetalt -
--                           beløbet hentes tilbage (-> 'tilbagefoert'), sælger og
--                           køber får en rettelse.
--     betaling_indsigelse_tilbagefoersel_claim (20261011040000) genoprettes:
--     'udbetalt' kun ved status 'paid'; oprettet/claimet/usikker = vent.
--  3. Negativt beløb i saldo-afstemningen: højst én alarm pr. handel
--     (saldo_negativ_alarm_kl).
--  2. Indsigelsens svarfrist (evidence_details.due_by) gemmes, og der varsles
--     staff 48 og 12 timer før fristen (én gang hver).
--
-- Som trin 1-4: INTET ændres for 'separat'. Ingen eksisterende funktion
-- genoprettes. Idempotent. Nye funktioner: security definer, search_path = ''.

set local lock_timeout = '5s';

alter table public.betalinger
  add column if not exists indsigelse_tabt_afklaret        text,
  add column if not exists indsigelse_tabt_afklaret_kl     timestamptz,
  add column if not exists indsigelse_frist_kl             timestamptz,
  add column if not exists indsigelse_frist_varslet_48_kl  timestamptz,
  add column if not exists indsigelse_frist_varslet_12_kl  timestamptz,
  add column if not exists saldo_negativ_alarm_kl          timestamptz;

comment on column public.betalinger.indsigelse_tabt_afklaret is
  'Destination: udfaldet af en tabt indsigelse - tilbagefoert (hentet fra sælgerens konto), udbetalt (BidHamr bærer tabet), stoppet (staff), udbetaling_fejlet (udbetalingen fejlede efter afklaringen - staff).';
comment on column public.betalinger.indsigelse_frist_kl is
  'Destination: indsigelsens svarfrist hos Stripe (evidence_details.due_by). Staff varsles 48 og 12 timer før.';

do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_indsigelse_tabt_afklaret_check'
                    and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_indsigelse_tabt_afklaret_check
      check (indsigelse_tabt_afklaret is null
             or indsigelse_tabt_afklaret in ('tilbagefoert', 'udbetalt', 'stoppet', 'udbetaling_fejlet'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_separat_uden_trin4_rettelser'
                    and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_separat_uden_trin4_rettelser
      check (pengemodel <> 'separat' or (
        indsigelse_tabt_afklaret is null and indsigelse_tabt_afklaret_kl is null
        and indsigelse_frist_kl is null and indsigelse_frist_varslet_48_kl is null
        and indsigelse_frist_varslet_12_kl is null));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_separat_uden_saldo_alarm'
                    and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_separat_uden_saldo_alarm
      check (pengemodel <> 'separat' or saldo_negativ_alarm_kl is null);
  end if;
end $do$;

comment on column public.betalinger.saldo_negativ_alarm_kl is
  'Destination: saldo-afstemningen har set et negativt beløb for handlen (mere taget fra sælgerens konto end handlen gav) - alarm givet (højst én gang).';

-- Gemmer udfaldet af en tabt indsigelse. true = udfaldet er ændret nu (så
-- beskeder/markeringer kun gives én gang pr. udfald). 'tilbagefoert' kræver,
-- at tilbageførslen er registreret; 'udbetalt' at en udbetaling findes.
create or replace function public.betaling_indsigelse_tabt_afklar(p_betaling uuid, p_udfald text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_udfald not in ('tilbagefoert', 'udbetalt', 'stoppet', 'udbetaling_fejlet') then return false; end if;
  update public.betalinger
     set indsigelse_tabt_afklaret = p_udfald,
         indsigelse_tabt_afklaret_kl = now(),
         opdateret = now()
   where id = p_betaling
     and pengemodel = 'destination'
     and indsigelse_status = 'lost'
     and indsigelse_tabt_afklaret is distinct from p_udfald
     and (p_udfald <> 'tilbagefoert' or indsigelse_tilbagefoersel_id is not null)
     and (p_udfald <> 'udbetalt' or exists (
            select 1 from public.saelger_udbetalinger u
             where u.id = saelger_udbetaling_id and u.status = 'paid'))
     and (p_udfald <> 'udbetaling_fejlet'
          or (indsigelse_tabt_afklaret = 'udbetalt' and saelger_udbetaling_id is null
              and overfoersel_paabegyndt_kl is null));
  return found;
end;
$fn$;

revoke all on function public.betaling_indsigelse_tabt_afklar(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tabt_afklar(uuid, text) to service_role;

-- Varsel om indsigelsens svarfrist: claimer 48- eller 12-timersvarslet (én
-- gang hver) for en åben indsigelse, hvor fristen er inden for vinduet.
create or replace function public.betaling_indsigelse_frist_varsel(p_betaling uuid, p_timer integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_timer = 48 then
    update public.betalinger
       set indsigelse_frist_varslet_48_kl = now(), opdateret = now()
     where id = p_betaling and pengemodel = 'destination'
       and indsigelse_status in ('needs_response', 'warning_needs_response')
       and indsigelse_frist_kl is not null and indsigelse_frist_kl <= now() + interval '48 hours'
       and indsigelse_frist_varslet_48_kl is null;
  elsif p_timer = 12 then
    update public.betalinger
       set indsigelse_frist_varslet_12_kl = now(), opdateret = now()
     where id = p_betaling and pengemodel = 'destination'
       and indsigelse_status in ('needs_response', 'warning_needs_response')
       and indsigelse_frist_kl is not null and indsigelse_frist_kl <= now() + interval '12 hours'
       and indsigelse_frist_varslet_12_kl is null;
  else
    return false;
  end if;
  return found;
end;
$fn$;

revoke all on function public.betaling_indsigelse_frist_varsel(uuid, integer) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_frist_varsel(uuid, integer) to service_role;

-- ===========================================================================
-- betaling_indsigelse_tilbagefoersel_claim: 'udbetalt' kun ved paid
-- ===========================================================================
-- Genoprettes helt: md5 af den normaliserede krop skal være versionen fra
-- 20261011040000 eller denne migrations version.
do $do$
declare
  h text;
begin
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    into h
    from pg_proc p where p.oid = 'public.betaling_indsigelse_tilbagefoersel_claim(uuid,bigint)'::regprocedure;
  if h = 'b7c0d9a5a129808ceb45388b88bd91df' then
    raise notice 'betaling_indsigelse_tilbagefoersel_claim: allerede rettet';
  elsif h is distinct from '5b80987f6d04b16919f5a62e5778f3d6' then
    raise exception 'betaling_indsigelse_tilbagefoersel_claim: kroppen afviger fra 20261011040000 (md5 %) - kontrollér funktionen, før migrationen køres', h;
  end if;
end $do$;

-- Kode som i 20261011040000, men:
--   udbetalt              -> kun når udbetalingen er PAID (pengene har forladt
--                            Stripe): BidHamr bærer tabet
--   udbetaling_uafklaret  -> udbetalingen er claimet/usikker/oprettet (på vej) -
--                            vent, til den er paid eller fejlet
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
  if b.stripe_transfer_id is not null then return jsonb_build_object('kode', 'ikke_destination'); end if;
  if b.saelger_udbetaling_id is not null then
    select u.status into us from public.saelger_udbetalinger u where u.id = b.saelger_udbetaling_id;
    if us = 'paid' then
      return jsonb_build_object('kode', 'udbetalt');
    end if;
    return jsonb_build_object('kode', 'udbetaling_uafklaret');
  end if;
  if b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetaling_uafklaret');
  end if;
  if b.status = 'refunderet' or b.gebyr_refunderet_kl is not null or b.refusion_tilbagefoert_kl is not null
     or b.stripe_refund_id is not null then
    return jsonb_build_object('kode', 'refusion');
  end if;
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

-- Saldo-afstemningen: claimer alarmen for et negativt beløb (én gang pr. handel).
create or replace function public.betaling_saldo_negativ_alarm(p_betaling uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.betalinger
     set saldo_negativ_alarm_kl = now(), opdateret = now()
   where id = p_betaling and pengemodel = 'destination' and saldo_negativ_alarm_kl is null;
  return found;
end;
$fn$;

revoke all on function public.betaling_saldo_negativ_alarm(uuid) from public, anon, authenticated;
grant execute on function public.betaling_saldo_negativ_alarm(uuid) to service_role;

create index if not exists betalinger_indsigelse_frist_idx
  on public.betalinger (indsigelse_frist_kl)
  where pengemodel = 'destination' and indsigelse_status in ('needs_response', 'warning_needs_response');
