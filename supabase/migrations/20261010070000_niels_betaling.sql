-- Niels' gennemgang af betalingsdelen (Ankerdigital, 7.-8. okt. 2026):
-- F04, F05, F06, F07 og M04. (F01 og F03 laves i ombygningen af
-- betalingsmodellen; M02/M03 i en anden migration.)
--
--  1. F04 Tabt indsigelse (dispute 'lost') er en fast sluttilstand.
--     betalinger.indsigelse_lukket_kl/-_af: staff har lukket handlen.
--     betaling_indsigelse_tabt_luk: kun når indsigelsen er TABT. Pengene
--     flyttes ikke (ingen frigivelse, ingen refusion - køberens bank har
--     allerede givet køberen pengene). Er intet overført til sælger, annulleres
--     handlen; er der overført, bærer BidHamr tabet (ROADMAP-BESLUTNINGER), og
--     handlen røres ikke. Markeringen fjernes og logges som 'betaling_loest'.
--     admin_advarsel_betaling må nu også bruges ved en TABT indsigelse (falsk
--     indsigelse -> advarsel til køberen); åbne indsigelser blokerer stadig.
--     betaling_indsigelse_blokerer er uændret: 'lost' blokerer stadig
--     frigivelse, overførsel og refusion.
--  2. F05 Alle lovede refusioner samles op. refusion_anmodet_kl ER markeringen
--     "refusion lovet" (sat af betaling_paabegynd_refusion, sag_claim_refusion,
--     sen betaling, afsendelses-/afhentningsfrist). Cron genkører ALLE (uanset
--     refusion_aarsag, undtagen 'delvis_refusion_stripe'), med backoff:
--       refusion_naeste_forsoeg_kl - næste forsøg tidligst (5 min * 2^forsøg,
--                                    højst 6 timer)
--       betaling_refusion_fejl     - Stripe-kaldet fejlede: nyt forsøg (ny
--                                    idempotency key) og backoff (under låsen)
--       betaling_refusion_udskyd   - refusionen fejlede hos Stripe bagefter
--                                    (refund failed/canceled): backoff
--  3. F06 kald_betalings_cron springer ikke længere stille over, når
--     cron_url/cron_secret mangler i Vault: drift_fejl (kilde 'cron').
--  4. F07 stripe_tilstand: hvilken Stripe-tilstand (test/live) databasens
--     Stripe-id'er stammer fra. Serveren nægter at kalde Stripe, når nøglen
--     ikke passer (src/lib/stripe.ts). Sættes til 'live' i go-live-tjeklisten
--     (docs/GO-LIVE-STRIPE.md), EFTER test-id'erne er ryddet.
--  5. M04
--     - Mindste bud er 3 kr. (naeste_bud_minimum), så en vundet afhentnings-
--       auktion altid er over Stripes mindstebeløb (2,50 kr.).
--     - Gemt kort: gemt_kort_kl / kort_fjernet_kl, så et forsinket Stripe-svar
--       (setup_intent.succeeded) ikke genskaber et fjernet eller ældre kort.
--     - Samtykke til automatisk betaling: tidspunkt + tekstversion (trigger,
--       så også appen registreres).
--
-- Kun service role (ingen nye rettigheder til anon/authenticated). Idempotent.

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. F04 Tabt indsigelse
-- ===========================================================================
alter table public.betalinger add column if not exists indsigelse_lukket_kl timestamptz;
alter table public.betalinger add column if not exists indsigelse_lukket_af uuid references public.users(id);

comment on column public.betalinger.indsigelse_lukket_kl is
  'Tabt indsigelse (dispute lost) lukket af staff (betaling_indsigelse_tabt_luk). Sluttilstand: ingen frigivelse, ingen refusion.';

create or replace function public.betaling_indsigelse_tabt_luk(
  p_medarbejder uuid, p_betaling uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b        record;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_handel text := 'uaendret';
begin
  if not exists (select 1 from public.users where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is null then return jsonb_build_object('kode', 'note_mangler'); end if;
  if char_length(v_note) > 2000 then return jsonb_build_object('kode', 'note_for_lang'); end if;

  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if coalesce(b.indsigelse_status, '') <> 'lost' then
    return jsonb_build_object('kode', 'ikke_tabt');
  end if;
  if b.indsigelse_lukket_kl is not null then
    return jsonb_build_object('kode', 'allerede_lukket');
  end if;

  update public.betalinger
     set indsigelse_lukket_kl = now(), indsigelse_lukket_af = p_medarbejder,
         kraever_opmaerksomhed = false,
         -- Cron skal ikke markere den igen som "ikke afsluttet".
         ikke_afsluttet_markeret_kl = coalesce(ikke_afsluttet_markeret_kl, now()),
         opdateret = now()
   where id = b.id;

  -- Intet overført til sælger: handlen annulleres (sælgeren får ikke
  -- udbetalt; køberens bank har givet køberen pengene). Er der overført,
  -- bærer BidHamr tabet, og handlen står, som den er.
  if b.stripe_transfer_id is null and b.overfoersel_paabegyndt_kl is null then
    update public.trades set status = 'annulleret', sag_aaben = false
     where id = b.trade_id and status <> 'annulleret';
    if found then v_handel := 'annulleret'; end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'betaling_loest', 'handel', b.trade_id, b.buyer_id,
          left('Tabt indsigelse lukket' ||
               case when v_handel = 'annulleret' then ' (handlen annulleret)' else '' end ||
               ': ' || v_note, 2000));

  return jsonb_build_object('kode', 'ok', 'handel', v_handel, 'trade_id', b.trade_id,
                            'overfoert', b.stripe_transfer_id is not null);
end $$;

revoke all on function public.betaling_indsigelse_tabt_luk(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tabt_luk(uuid, uuid, text) to service_role;

-- Advarsel må gives ved en TABT indsigelse (falsk indsigelse). Rettes på
-- stedet; afbryder, hvis teksten ikke findes.
do $do$
declare
  v_def text := pg_get_functiondef('public.admin_advarsel_betaling(uuid,uuid,text,text,text)'::regprocedure);
  v_gl constant text := replace($t$if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return jsonb_build_object('kode', 'indsigelse');$t$, chr(13), '');
  v_ny constant text := replace($t$if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     and coalesce(b.indsigelse_status, '') <> 'lost' then
    return jsonb_build_object('kode', 'indsigelse');$t$, chr(13), '');
begin
  if position($t$coalesce(b.indsigelse_status, '') <> 'lost' then$t$ in v_def) > 0 then
    return;
  end if;
  if position(v_gl in v_def) = 0 then
    raise exception 'admin_advarsel_betaling: forventet tekst blev ikke fundet';
  end if;
  execute replace(v_def, v_gl, v_ny);
end;
$do$;

-- ===========================================================================
-- 2. F05 Refusionsopsamling med backoff
-- ===========================================================================
alter table public.betalinger add column if not exists refusion_naeste_forsoeg_kl timestamptz;

comment on column public.betalinger.refusion_anmodet_kl is
  '"Refusion lovet": køberen skal have pengene tilbage (claimet - blokerer overførsel). Betalings-cron genkører alle lovede refusioner (refunderLoveteVentende), til de er gennemført eller forsøgene er brugt op.';
comment on column public.betalinger.refusion_naeste_forsoeg_kl is
  'Backoff: cron prøver tidligst refusionen igen på dette tidspunkt (5 min * 2^forsøg, højst 6 timer).';

create index if not exists betalinger_lovet_refusion_idx
  on public.betalinger (refusion_anmodet_kl)
  where status = 'betalt' and refusion_anmodet_kl is not null and stripe_transfer_id is null;

create or replace function public.betaling_refusion_backoff(p_forsoeg integer)
returns interval
language sql
immutable
set search_path = public
as $$
  select least(interval '5 minutes' * power(2, greatest(least(coalesce(p_forsoeg, 0), 10), 0)),
               interval '6 hours');
$$;

-- Stripe-kaldet (refunds.create) fejlede under låsen: nyt forsøg med ny
-- idempotency key næste gang (Stripe gemmer fejlsvar under nøglen i 24 t), og
-- backoff. Svarer med det nye forsøgsnummer, -1 hvis låsen ikke holdes.
create or replace function public.betaling_refusion_fejl(p_betaling uuid, p_noegle uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.betalinger
     set refusion_forsoeg = refusion_forsoeg + 1,
         refusion_naeste_forsoeg_kl = now() + public.betaling_refusion_backoff(refusion_forsoeg + 1),
         kraever_opmaerksomhed = true,
         opdateret = now()
   where id = p_betaling
     and status <> 'refunderet'
     and stripe_refund_id is null
     and refusion_laas_noegle = p_noegle
     and refusion_laas_til > now()
  returning refusion_forsoeg into n;
  return coalesce(n, -1);
end $$;

-- Refusionen fejlede hos Stripe bagefter (failed/canceled): næste forsøg
-- tidligst efter backoff (forsøget tælles op, når cron laver det nye).
create or replace function public.betaling_refusion_udskyd(p_betaling uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.betalinger
     set refusion_naeste_forsoeg_kl = now() + public.betaling_refusion_backoff(refusion_forsoeg + 1),
         opdateret = now()
   where id = p_betaling and status <> 'refunderet';
$$;

revoke all on function public.betaling_refusion_backoff(integer) from public, anon, authenticated;
grant execute on function public.betaling_refusion_backoff(integer) to service_role;
revoke all on function public.betaling_refusion_fejl(uuid, uuid) from public, anon, authenticated;
grant execute on function public.betaling_refusion_fejl(uuid, uuid) to service_role;
revoke all on function public.betaling_refusion_udskyd(uuid) from public, anon, authenticated;
grant execute on function public.betaling_refusion_udskyd(uuid) to service_role;

-- ===========================================================================
-- 3. F06 kald_betalings_cron: ingen stille overspringning
-- ===========================================================================
create or replace function public.kald_betalings_cron()
returns bigint
language plpgsql
security definer
set search_path = public
as $function$
declare v_url text; v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    perform public.drift_fejl_log('cron', 'betalings-cron',
      'kald_betalings_cron: Vault findes ikke - betalings-cron kaldes ikke', null, null);
    return null;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_url' limit 1$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1$q$ into v_secret;
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    perform public.drift_fejl_log('cron', 'betalings-cron',
      'kald_betalings_cron: ' ||
      case when coalesce(v_url, '') = '' and coalesce(v_secret, '') = '' then 'cron_url og cron_secret mangler'
           when coalesce(v_url, '') = '' then 'cron_url mangler'
           else 'cron_secret mangler' end ||
      ' i Vault - betalings-cron kaldes ikke', null, null);
    return null;
  end if;
  return net.http_post(
    url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 60000);
end;
$function$;

revoke all on function public.kald_betalings_cron() from public, anon, authenticated;

-- ===========================================================================
-- 4. F07 Stripe-tilstand
-- ===========================================================================
create table if not exists public.stripe_tilstand (
  id         boolean primary key default true check (id),
  tilstand   text not null default 'test' check (tilstand in ('test', 'live')),
  aendret_kl timestamptz not null default now(),
  note       text
);
alter table public.stripe_tilstand enable row level security;
revoke all on table public.stripe_tilstand from public, anon, authenticated;
grant select, insert, update on table public.stripe_tilstand to service_role;
insert into public.stripe_tilstand (id, tilstand, note)
values (true, 'test', 'Oprettet 8. okt. 2026: alle Stripe-id''er i databasen er fra testtilstand.')
on conflict (id) do nothing;

comment on table public.stripe_tilstand is
  'Hvilken Stripe-tilstand (test/live) databasens Stripe-id''er stammer fra. Serveren kalder kun Stripe, når nøglens tilstand passer (src/lib/stripe.ts). Sæt til live i docs/GO-LIVE-STRIPE.md - først når test-id''erne er ryddet.';

-- ===========================================================================
-- 5. M04
-- ===========================================================================
-- Mindste bud 3 kr. (Stripes mindstebeløb i DKK er 2,50 kr.; en afhentnings-
-- handel er bud + 5 % købergebyr uden fragt).
create or replace function public.naeste_bud_minimum(p_nuvaerende numeric, p_startpris numeric)
returns numeric
language sql
immutable
set search_path = public
as $fn$
  select case
    when p_nuvaerende is null then greatest(ceil(coalesce(p_startpris, 0)), 3)
    else greatest(p_nuvaerende + public.budstigning(p_nuvaerende), 3)
  end;
$fn$;

-- Gemt kort og samtykke til automatisk betaling.
alter table public.betalingsprofiler add column if not exists gemt_kort_kl timestamptz;
alter table public.betalingsprofiler add column if not exists kort_fjernet_kl timestamptz;
alter table public.betalingsprofiler add column if not exists autobetaling_samtykke_kl timestamptz;
alter table public.betalingsprofiler add column if not exists autobetaling_samtykke_version text;
alter table public.betalingsprofiler add column if not exists autobetaling_fravalgt_kl timestamptz;

comment on column public.betalingsprofiler.gemt_kort_kl is
  'Hvornår SetupIntenten for det gemte kort blev oprettet hos Stripe. Et ældre Stripe-svar erstatter ikke kortet.';
comment on column public.betalingsprofiler.kort_fjernet_kl is
  'Hvornår brugeren sidst fjernede sit gemte kort. Et Stripe-svar for en SetupIntent fra før genskaber ikke kortet.';
comment on column public.betalingsprofiler.autobetaling_samtykke_kl is
  'Hvornår brugeren sidst slog automatisk betaling til (samtykke). Sættes af triggeren.';
comment on column public.betalingsprofiler.autobetaling_samtykke_version is
  'Versionen af samtykketeksten (src/lib/betaling/samtykke.ts), brugeren så. ''ukendt'' hvis slået til uden version (fx fra en ældre app).';

create or replace function public.betalingsprofiler_samtykke()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.autobetaling, false) and not coalesce(old.autobetaling, false) then
    new.autobetaling_samtykke_kl := now();
    if new.autobetaling_samtykke_version is null
       or new.autobetaling_samtykke_version is not distinct from old.autobetaling_samtykke_version then
      new.autobetaling_samtykke_version := 'ukendt';
    end if;
    new.autobetaling_fravalgt_kl := null;
  elsif not coalesce(new.autobetaling, false) and coalesce(old.autobetaling, false) then
    new.autobetaling_fravalgt_kl := now();
    new.autobetaling_samtykke_version := null;
  end if;
  return new;
end $$;

drop trigger if exists betalingsprofiler_samtykke on public.betalingsprofiler;
create trigger betalingsprofiler_samtykke
  before update of autobetaling on public.betalingsprofiler
  for each row execute function public.betalingsprofiler_samtykke();
