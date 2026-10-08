-- Ny betalingsmodel, trin 4: rettelser efter review (docs/BETALINGSMODEL-PLAN.md 6.4).
--
--  1. Tabt indsigelse: udfaldet afklares og gemmes (indsigelse_tabt_afklaret),
--     så en tabt indsigelse, mens en udbetaling var uafklaret (claimet/usikker),
--     behandles igen, når udbetalingen er afklaret - og beskederne til sælger og
--     køber først sendes, når det vides, om handlen var udbetalt:
--       tilbagefoert      - beløbet er hentet tilbage fra sælgerens konto
--       udbetalt          - handlen var udbetalt: BidHamr bærer tabet
--       stoppet           - til staff (fx for lidt på sælgerens konto)
--       udbetaling_fejlet - var 'udbetalt', men udbetalingen fejlede bagefter
--                           (pengene står igen på sælgerens konto) - til staff
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
  add column if not exists indsigelse_frist_varslet_12_kl  timestamptz;

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
end $do$;

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
     and (p_udfald <> 'udbetalt' or saelger_udbetaling_id is not null
          or overfoersel_paabegyndt_kl is not null)
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

create index if not exists betalinger_indsigelse_frist_idx
  on public.betalinger (indsigelse_frist_kl)
  where pengemodel = 'destination' and indsigelse_status in ('needs_response', 'warning_needs_response');
