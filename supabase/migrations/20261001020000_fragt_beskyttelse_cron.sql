-- Fragt, BidHamr Beskyttelse ved bud, cron hvert 5. minut og reviewer-fund.
--
--   A. BidHamr Beskyttelse = 5% af buddet, min 25 kr, maks 250 kr
--      (2500 / 25000 oere). Valget traeffes, naar man byder (bids.beskyttelse);
--      vinderens seneste bud afgoer det. afslut_udloebne_auktioner saetter
--      beskyttelse paa betalingen fra start, saa total og PaymentIntent (og
--      autobetaling) inkluderer den. Valget er LAAST ved buddet og kan ikke
--      aendres paa betalingssiden (F: betaling_saet_beskyttelse fjernes).
--   B. Fragt: fast 3500 oere pr. handel, betalt af koeber, naar auktionen
--      tilbyder forsendelse (auctions.forsendelse_mulig). Kun afhentning
--      (forsendelse_mulig = false) -> fragt 0. Fragten udbetales til saelger:
--      udbetaling_oere = bud - saelgergebyr + fragt.
--   C. pg_cron-job hvert 5. minut, der kalder /api/cron/afslut-auktioner via
--      pg_net. URL og hemmelighed laeses fra Supabase Vault ('cron_url' og
--      'cron_secret'); mangler de, springes kaldet stille over.
--   D. handel_godkend laaser betalingen (for update) foer handlen opdateres.
--      Nye taellere til nye idempotency keys ved endeligt fejlede
--      overfoersler/refusioner + RPC'er til at registrere fejlen atomisk.
--   E. Afvigende beloeb: refunderes automatisk, men handlen fortsaetter med
--      en ny PaymentIntent (betaling_afvigelser).
--   F. betaling_registrer_betalt sammenligner med lagret total_oere.
--
-- Alle beloeb i oere (heltal).

-- ============================================================ A. beskyttelse

create or replace function public.beregn_beskyttelse_oere(p_bud_oere bigint)
returns bigint language sql immutable as $fn$
  select least(greatest(round(p_bud_oere * 5 / 100.0)::bigint, 2500), 25000);
$fn$;

-- Valget gemmes sammen med buddet. Indsaettes af klienten via den
-- eksisterende insert-policy (bids_insert_own); det er kun et oenske - beloebet
-- beregnes altid i databasen.
alter table public.bids
  add column if not exists beskyttelse boolean not null default false;

comment on column public.bids.beskyttelse is
  'Byderen oensker BidHamr Beskyttelse, hvis buddet vinder. Vinderens seneste bud gaelder.';

-- ============================================================ B. fragt + udbetaling

alter table public.betalinger drop constraint if exists betalinger_udbetaling_stemmer;

-- Ikke-paabegyndte betalinger (ingen PaymentIntent endnu) faar fragt og ny
-- beskyttelsespris. Betalte/igangvaerende roeres ikke.
update public.betalinger p
   set fragt_oere = case when a.forsendelse_mulig then 3500 else 0 end,
       beskyttelse_oere = case when p.beskyttelse
                               then public.beregn_beskyttelse_oere(p.bud_oere) else 0 end,
       total_oere = p.bud_oere + p.koebergebyr_oere
                    + case when a.forsendelse_mulig then 3500 else 0 end
                    + case when p.beskyttelse
                           then public.beregn_beskyttelse_oere(p.bud_oere) else 0 end,
       udbetaling_oere = p.bud_oere - p.saelgergebyr_oere
                         + case when a.forsendelse_mulig then 3500 else 0 end,
       opdateret = now()
  from public.auctions a
 where a.id = p.auction_id
   and p.status = 'afventer'
   and p.stripe_payment_intent_id is null;

alter table public.betalinger add constraint betalinger_udbetaling_stemmer check (
  udbetaling_oere = bud_oere - saelgergebyr_oere + fragt_oere);

create or replace function public.afslut_udloebne_auktioner()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  antal integer;
  r     record;
  bud   bigint;
  koeb  bigint;
  saelg bigint;
  fragt bigint;
  besk_valg boolean;
  besk  bigint;
  t_id  uuid;
begin
  update public.auctions a
     set status = 'afsluttet',
         vinder_id = (
           select b.bruger_id
             from public.bids b
            where b.auktion_id = a.id
            order by b.beløb desc, b.oprettet asc
            limit 1
         )
   where a.status = 'aktiv'
     and a.slutter_kl <= now();

  get diagnostics antal = row_count;

  -- Handel + betaling for afsluttede auktioner med vinder og uden handel.
  -- Begraenset til de seneste 7 dage, saa gamle auktioner ikke backfilles.
  for r in
    select a.id, a.bruger_id, a.vinder_id, a.forsendelse_mulig
      from public.auctions a
     where a.status = 'afsluttet'
       and a.vinder_id is not null
       and a.slutter_kl >= now() - interval '7 days'
       and not exists (select 1 from public.trades t where t.auction_id = a.id)
  loop
    begin
      t_id := null;
      select round(max(b.beløb) * 100)::bigint into bud
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id;

      if bud is null or bud <= 0 then
        raise warning 'ingen gyldigt vinderbud for auktion %', r.id;
        continue;
      end if;

      -- Vinderens seneste bud afgoer, om han oensker BidHamr Beskyttelse.
      select coalesce(b.beskyttelse, false) into besk_valg
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id
       order by b.oprettet desc, b.beløb desc
       limit 1;
      besk_valg := coalesce(besk_valg, false);

      koeb  := round(bud * 5 / 100.0)::bigint;
      saelg := round(bud * 5 / 100.0)::bigint;
      fragt := case when coalesce(r.forsendelse_mulig, false) then 3500 else 0 end;
      besk  := case when besk_valg then public.beregn_beskyttelse_oere(bud) else 0 end;

      insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
      values (r.id, r.bruger_id, r.vinder_id, bud / 100.0, 'afventer_betaling')
      on conflict (auction_id) do nothing
      returning id into t_id;

      if t_id is null then continue; end if;

      insert into public.betalinger (
        trade_id, auction_id, buyer_id, seller_id,
        bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
        total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
      values (
        t_id, r.id, r.vinder_id, r.bruger_id,
        bud, koeb, fragt, besk_valg, besk,
        bud + koeb + fragt + besk, saelg, bud - saelg + fragt,
        now() + interval '48 hours')
      on conflict (trade_id) do nothing;
    exception when others then
      raise warning 'handel/betaling fejlede for auktion %: %', r.id, sqlerrm;
    end;
  end loop;

  -- Gamle reservationer fra saldo-modellen maa ikke holde paa penge.
  if to_regclass('public.bid_reservations') is not null then
    for r in
      select br.auction_id as id
        from public.bid_reservations br
        join public.auctions a on a.id = br.auction_id
       where a.status <> 'aktiv'
    loop
      begin
        perform public.wallet_frigiv(r.id);
      exception when others then
        raise warning 'wallet_frigiv fejlede for auktion %: %', r.id, sqlerrm;
      end;
    end loop;
  end if;

  return antal;
end;
$fn$;

revoke all on function public.afslut_udloebne_auktioner() from public, anon, authenticated;
grant execute on function public.afslut_udloebne_auktioner() to service_role;

-- ============================================================ D1. godkend

create or replace function public.handel_godkend(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  kalder uuid := auth.uid();
  b      record;
  t      record;
begin
  if kalder is null then return false; end if;

  -- Laas betalingen FOER handlen, i samme raekkefoelge som
  -- betaling_claim_overfoersel og refusions-claimet, saa en samtidig
  -- admin-refusion venter (eller vinder) i stedet for at give blandet status.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null then
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

-- ============================================================ D2/D3. forsoeg

alter table public.betalinger
  add column if not exists overfoersel_forsoeg integer not null default 0,
  add column if not exists refusion_forsoeg    integer not null default 0;

comment on column public.betalinger.overfoersel_forsoeg is
  'Taeller endeligt fejlede overfoersler. Indgaar i idempotency key, saa et '
  'nyt forsoeg ikke faar Stripes gemte fejlsvar tilbage.';
comment on column public.betalinger.refusion_forsoeg is
  'Taeller refusioner, der endte failed/canceled hos Stripe. Indgaar i idempotency key.';

-- Overfoerslen til saelger fejlede endeligt hos Stripe (intet oprettet).
-- Frigiver claimet, saa handlen ikke haenger (admin kan refundere), taeller
-- forsoeget op og markerer betalingen til admin.
create or replace function public.betaling_overfoersel_fejlet(
  p_betaling uuid, p_fejl text)
returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  update public.betalinger
     set overfoersel_paabegyndt_kl = null,
         overfoersel_forsoeg = overfoersel_forsoeg + 1,
         kraever_opmaerksomhed = true,
         sidste_fejl = left(p_fejl, 500),
         opdateret = now()
   where id = p_betaling
     and stripe_transfer_id is null;
  return found;
end;
$fn$;

revoke all on function public.betaling_overfoersel_fejlet(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_overfoersel_fejlet(uuid, text) to service_role;

-- Forrige refusion endte failed/canceled hos Stripe. Nulstiller refund-id'et
-- og taeller op, saa naeste forsoeg faar en ny idempotency key. Kun hvis
-- refund-id'et stadig er det forventede (ingen samtidig aendring).
-- Returnerer det nye forsoegsnummer, eller -1.
create or replace function public.betaling_refusion_nyt_forsoeg(
  p_betaling uuid, p_gammel_refund text)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  n integer;
begin
  update public.betalinger
     set stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         opdateret = now()
   where id = p_betaling
     and stripe_refund_id = p_gammel_refund
     and status <> 'refunderet'
  returning refusion_forsoeg into n;
  return coalesce(n, -1);
end;
$fn$;

revoke all on function public.betaling_refusion_nyt_forsoeg(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_refusion_nyt_forsoeg(uuid, text) to service_role;

-- ============================================================ C. cron

-- Kalder betalings-cronruten (autobetaling, mails, paamindelser,
-- overfoersler). Selve auktionslukningen koerer fortsat hvert minut i SQL
-- (job 'afslut-udloebne-auktioner'). Ruten er idempotent: alt claimes atomisk
-- i databasen, og Stripe-kald har idempotency keys.
--
-- URL og hemmelighed staar i Supabase Vault - ALDRIG i denne fil:
--   cron_url    fx https://bidhamr.dk/api/cron/afslut-auktioner
--   cron_secret samme vaerdi som CRON_SECRET i Vercel
create extension if not exists pg_net;

create or replace function public.kald_betalings_cron()
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  v_url    text;
  v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;

  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_url' limit 1$q$
     into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1$q$
     into v_secret;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    return null; -- ikke konfigureret: spring stille over
  end if;

  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 60000);
end;
$fn$;

revoke all on function public.kald_betalings_cron() from public, anon, authenticated;

select cron.unschedule('betalings-cron')
 where exists (select 1 from cron.job where jobname = 'betalings-cron');

select cron.schedule(
  'betalings-cron',
  '*/5 * * * *',
  $$select public.kald_betalings_cron();$$
);

-- ============================================================ F. beskyttelse laast

-- Valget af BidHamr Beskyttelse laases, naar man byder (Filip). Det kan ikke
-- aendres paa betalingssiden. PaymentIntenten oprettes med det fulde beloeb
-- (total_oere) een gang. Funktionen til at skifte valget fjernes.
drop function if exists public.betaling_saet_beskyttelse(uuid, boolean);

-- ============================================================ E. beloeb afviger

-- Koeberen indtaster aldrig selv et beloeb - han betaler en fast regning. Et
-- afvigende beloeb skyldes derfor en fejl hos os eller et kapploeb. Saa:
--   * den afvigende betaling refunderes automatisk og markeres til admin,
--   * handlen annulleres IKKE (bliver i 'afventer_betaling', samme frist),
--   * betalingen saettes tilbage til 'afventer' uden PaymentIntent, saa
--     serveren opretter en ny (ny idempotency key via pi_forsoeg), og
--     koeberen blot trykker "Betal" igen.
-- Den gamle PaymentIntent flyttes til betaling_afvigelser. Dermed kan
-- webhooks for den gamle PaymentIntent (refusion, gentaget succeeded) aldrig
-- ramme den nye betaling - de slaas op i afvigelsestabellen.

alter table public.betalinger
  add column if not exists pi_forsoeg integer not null default 0;

comment on column public.betalinger.pi_forsoeg is
  'Antal PaymentIntents, der er kasseret pga. afvigende beloeb. Indgaar i '
  'idempotency key, saa en ny PaymentIntent faktisk oprettes.';

create table if not exists public.betaling_afvigelser (
  id                        uuid primary key default gen_random_uuid(),
  betaling_id               uuid not null references public.betalinger(id) on delete restrict,
  trade_id                  uuid not null references public.trades(id) on delete restrict,
  stripe_payment_intent_id  text not null unique,
  stripe_charge_id          text,
  modtaget_oere             bigint not null,
  forventet_oere            bigint not null,
  stripe_refund_id          text,
  refusion_forsoeg          integer not null default 0,
  refunderet_kl             timestamptz,
  sidste_fejl               text,
  oprettet                  timestamptz not null default now(),
  opdateret                 timestamptz not null default now()
);

comment on table public.betaling_afvigelser is
  'Betalinger modtaget med forkert beloeb. Refunderes automatisk; handlen '
  'fortsaetter med en ny PaymentIntent. Slettes aldrig.';

create index if not exists betaling_afvigelser_aaben_idx
  on public.betaling_afvigelser (oprettet) where refunderet_kl is null;

alter table public.betaling_afvigelser enable row level security;
revoke all on public.betaling_afvigelser from anon, authenticated;
grant select on public.betaling_afvigelser to authenticated;
grant all on public.betaling_afvigelser to service_role;

drop policy if exists betaling_afvigelser_select_staff on public.betaling_afvigelser;
create policy betaling_afvigelser_select_staff on public.betaling_afvigelser
  for select to authenticated using (public.er_staff());

drop trigger if exists betaling_afvigelser_forbyd_sletning_trg on public.betaling_afvigelser;
create trigger betaling_afvigelser_forbyd_sletning_trg
  before delete on public.betaling_afvigelser
  for each row execute function public.betalinger_forbyd_sletning();

-- Webhook/spejling: payment_intent.succeeded. Beloebet sammenlignes med den
-- lagrede total_oere. p_beskyttelse (metadata fra Stripe) ignoreres - valget
-- er laast ved buddet og staar i betalingsraekken. Parameteren bevares, saa
-- signaturen er uaendret.
create or replace function public.betaling_registrer_betalt(
  p_payment_intent text,
  p_charge         text,
  p_beloeb_oere    bigint,
  p_beskyttelse    boolean)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then
    -- En kasseret PaymentIntent (afvigende beloeb): serveren refunderer den
    -- (idempotent). Roerer aldrig den nye betaling.
    update public.betaling_afvigelser
       set stripe_charge_id = coalesce(stripe_charge_id, p_charge), opdateret = now()
     where stripe_payment_intent_id = p_payment_intent;
    if found then return 'beloeb_afviger'; end if;
    return 'ukendt';
  end if;
  if b.status = 'betalt' then return 'allerede_betalt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  -- Betalingen er annulleret (fx frist overskredet), eller en refusion er
  -- allerede sat i gang: pengene maa ikke bogfoeres som betaling. Serveren
  -- refunderer automatisk.
  if b.status not in ('afventer', 'behandles') or b.refusion_anmodet_kl is not null then
    update public.betalinger
       set stripe_charge_id = coalesce(stripe_charge_id, p_charge),
           refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
           refusion_aarsag = coalesce(refusion_aarsag, 'sen_betaling'),
           sidste_fejl = 'Betaling modtaget efter annullering - refunderes automatisk',
           kraever_opmaerksomhed = true,
           opdateret = now()
     where id = b.id;
    return 'sen_betaling';
  end if;

  if p_beloeb_oere <> b.total_oere then
    insert into public.betaling_afvigelser (
      betaling_id, trade_id, stripe_payment_intent_id, stripe_charge_id,
      modtaget_oere, forventet_oere)
    values (
      b.id, b.trade_id, p_payment_intent, p_charge, p_beloeb_oere, b.total_oere)
    on conflict (stripe_payment_intent_id) do nothing;

    -- Tilbage til 'afventer' uden PaymentIntent. Handlen og fristen roeres ikke.
    update public.betalinger
       set stripe_payment_intent_id = null,
           stripe_charge_id = null,
           status = 'afventer',
           pi_forsoeg = pi_forsoeg + 1,
           sidste_fejl = 'Beloeb fra Stripe (' || p_beloeb_oere || ' oere) stemmer ikke '
                         || 'med handlen - refunderes automatisk, koeber betaler igen',
           kraever_opmaerksomhed = true,
           opdateret = now()
     where id = b.id;
    return 'beloeb_afviger';
  end if;

  update public.betalinger
     set status = 'betalt',
         stripe_charge_id = p_charge,
         betalt_kl = now(),
         sidste_fejl = null,
         opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'betaling_modtaget'
   where id = b.trade_id and status = 'afventer_betaling';

  return 'betalt';
end;
$fn$;

revoke all on function public.betaling_registrer_betalt(text, text, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_betalt(text, text, bigint, boolean)
  to service_role;

-- charge.refunded. En kasseret PaymentIntent (afvigelse) registreres kun i
-- afvigelsestabellen - handlen annulleres ikke. Ellers som foer, men en
-- refusion med aarsag 'beloeb_afviger' (aeldre raekker) annullerer heller ikke.
create or replace function public.betaling_registrer_refunderet(
  p_payment_intent text,
  p_refund         text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  update public.betaling_afvigelser
     set refunderet_kl = coalesce(refunderet_kl, now()),
         stripe_refund_id = coalesce(p_refund, stripe_refund_id),
         sidste_fejl = null,
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
  if found then return 'afvigelse_refunderet'; end if;

  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then return 'ukendt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  update public.betalinger
     set status = 'refunderet',
         refunderet_kl = now(),
         stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, 'stripe'),
         kraever_opmaerksomhed = kraever_opmaerksomhed
                                 or stripe_transfer_id is not null
                                 or overfoersel_paabegyndt_kl is not null,
         sidste_fejl = case
           when stripe_transfer_id is not null or overfoersel_paabegyndt_kl is not null
             then 'Refunderet EFTER overfoersel til saelger - kontroller hos Stripe'
           else sidste_fejl end,
         opdateret = now()
   where id = b.id;

  if coalesce(b.refusion_aarsag, '') <> 'beloeb_afviger' then
    update public.trades
       set status = 'annulleret', sag_aaben = false
     where id = b.trade_id
       and status in ('afventer_betaling','betaling_modtaget','pakke_sendt','modtaget');
  end if;

  return 'refunderet';
end;
$fn$;

revoke all on function public.betaling_registrer_refunderet(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_refunderet(text, text) to service_role;

-- Nyt refusionsforsoeg for en afvigelse, hvis forrige refusion endte
-- failed/canceled. Returnerer nyt forsoegsnummer, eller -1.
create or replace function public.afvigelse_refusion_nyt_forsoeg(
  p_payment_intent text, p_gammel_refund text)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  n integer;
begin
  update public.betaling_afvigelser
     set stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent
     and stripe_refund_id = p_gammel_refund
     and refunderet_kl is null
  returning refusion_forsoeg into n;
  return coalesce(n, -1);
end;
$fn$;

revoke all on function public.afvigelse_refusion_nyt_forsoeg(text, text) from public, anon, authenticated;
grant execute on function public.afvigelse_refusion_nyt_forsoeg(text, text) to service_role;
