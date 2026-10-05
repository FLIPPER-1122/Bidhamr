-- Betalingsfrist 48 timer, saelger kan forlaenge, passiv saelger i 14 dage
-- (ROADMAP-BESLUTNINGER.md, "Betalingsfrist" og "Saelger goer intet",
-- Filip 5. oktober 2026).
--
--   1. afslut_udloebne_auktioner: ny handel faar betal_senest = now() + 48
--      timer (foer 24). Ellers ordret som i 20261002010000_ubetalt_vinder.sql
--      (seneste definition).
--   2. andenchance_svar: siger naeste byder ja, faar den nye handel 48 timers
--      betalingsfrist. Ellers ordret som i 20261002030000_ubetalt_vinder_
--      rettelser.sql (seneste definition). Byderens svarfrist paa 24 timer
--      (andenchance_opret) er IKKE en betalingsfrist og er uaendret.
--   3. betalingsfrist_forlaengelser: historik over saelgerens forlaengelser
--      (kun service-role; slettes aldrig). Notifikations-cron'en sender
--      koeberen besked ud fra tabellen, saa det ogsaa virker, naar appen
--      kalder RPC'en direkte.
--   4. handel_forlaeng_betalingsfrist(p_trade, p_ny_frist): saelgeren
--      forlaenger fristen. Hoejst 7 dage efter, at 48-timersfristen startede
--      (betalinger.oprettet = auktionens afslutning for vinderen, eller
--      naeste byders ja ved et tilbud til naeste byder).
--      Laaser betalinger og derefter trades - samme raekkefoelge som
--      ubetalt_vinder_annuller/betaling_annuller - saa en forlaengelse og
--      cron'ens annullering koeres i serie: den, der kommer sidst, ser den
--      andens resultat (annulleret -> afvist; ny frist -> ikke annulleret).
--      Paamindelserne nulstilles, saa koeberen paamindes igen foer den nye
--      frist. moderation_log bruges ikke (kun staff-handlinger; CHECK roeres
--      ikke) - historikken ligger i betalingsfrist_forlaengelser.
--   5. auktion_afsluttet_kl: en ubetalt vinder, hvor saelgeren ikke har valgt
--      naeste skridt, holder kun arkiveringen tilbage i 14 dage efter
--      annulleringen (ubetalte_vindere.oprettet - raekken oprettes i samme
--      transaktion som annulleringen, baade ved ubetalt vinder og ved admins
--      annullering, og er altid sat). Derefter regnes auktionen som afsluttet
--      12 dage efter annulleringen, saa oprydningen (afsluttet + 48 timer)
--      arkiverer den praecis 14 dage efter annulleringen.
--      genopsaet_auktion afviser ikke arkiverede auktioner (tjekker kun
--      status, skjult, sag, solgt og tidligere genopsaetning), saa "Saet
--      varen op igen" virker fortsat - den er ikke aendret.
--
-- Eksisterende betalinger beholder deres betal_senest (ingen UPDATE).
-- Idempotent: kan koeres flere gange.

-- ============================================================ 1. afslut_udloebne_auktioner

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
      on conflict (auction_id) where status <> 'annulleret' do nothing
      returning id into t_id;

      if t_id is null then continue; end if;

      insert into public.betalinger (
        trade_id, auction_id, buyer_id, seller_id,
        bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
        total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
      values (
        t_id, r.id, r.vinder_id, r.bruger_id,
        bud, koeb, fragt, besk_valg, besk,
        bud + koeb + fragt + besk, saelg, bud - saelg,
        now() + interval '48 hours')
      on conflict (trade_id) do nothing;
    exception when others then
      raise warning 'handel/betaling fejlede for auktion %: %', r.id, sqlerrm;
    end;
  end loop;

  return antal;
end;
$fn$;

revoke all on function public.afslut_udloebne_auktioner() from public, anon, authenticated;
grant execute on function public.afslut_udloebne_auktioner() to service_role;

-- ============================================================ 2. andenchance_svar

-- p_byder er den indloggede bruger. Returnerer { kode, trade_id? }.
-- Koder: ok, ikke_fundet, ikke_byder, besvaret, udloebet, solgt, genopsat,
--        suspenderet.
create or replace function public.andenchance_svar(p_tilbud uuid, p_byder uuid, p_ja boolean)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  x     record;
  a     record;
  u     record;
  bud   bigint;
  koeb  bigint;
  saelg bigint;
  fragt bigint;
  besk  bigint;
  t_id  uuid;
begin
  select * into x from public.andenchance_tilbud where id = p_tilbud;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if x.byder_id is distinct from p_byder then
    return jsonb_build_object('kode', 'ikke_byder');
  end if;

  -- Samme laaseraekkefoelge som andenchance_opret: auktion, derefter tilbud.
  select * into a from public.auctions where id = x.auction_id for update;
  select * into x from public.andenchance_tilbud where id = p_tilbud for update;

  if x.status <> 'afventer' then return jsonb_build_object('kode', 'besvaret'); end if;
  if x.udloeber <= now() then
    update public.andenchance_tilbud set status = 'udloebet'
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'udloebet');
  end if;

  if not p_ja then
    update public.andenchance_tilbud
       set status = 'afvist', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'ok');
  end if;

  if exists (select 1 from public.trades t
              where t.auction_id = x.auction_id and t.status <> 'annulleret') then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'solgt');
  end if;

  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = x.auction_id) then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'genopsat');
  end if;

  -- Suspenderet byder kan ikke koebe. Tilbuddet lukkes, saa saelgeren kan
  -- sende til naeste byder med det samme (serveren mailer saelgeren).
  select suspenderet, suspenderet_til into u from public.users where id = p_byder;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  -- Samme beloebslogik som afslut_udloebne_auktioner.
  bud   := x.bud_oere;
  koeb  := round(bud * 5 / 100.0)::bigint;
  saelg := round(bud * 5 / 100.0)::bigint;
  fragt := case when coalesce(a.forsendelse_mulig, false) then 3500 else 0 end;
  besk  := case when x.beskyttelse then public.beregn_beskyttelse_oere(bud) else 0 end;

  insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
  values (x.auction_id, x.seller_id, x.byder_id, bud / 100.0, 'afventer_betaling')
  returning id into t_id;

  insert into public.betalinger (
    trade_id, auction_id, buyer_id, seller_id,
    bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
    total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
  values (
    t_id, x.auction_id, x.byder_id, x.seller_id,
    bud, koeb, fragt, x.beskyttelse, besk,
    bud + koeb + fragt + besk, saelg, bud - saelg,
    now() + interval '48 hours');

  update public.auctions set vinder_id = x.byder_id where id = x.auction_id;

  update public.andenchance_tilbud
     set status = 'accepteret', besvaret_kl = now(), ny_trade_id = t_id
   where id = x.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'trade_id', t_id);
end;
$fn$;

revoke all on function public.andenchance_svar(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.andenchance_svar(uuid, uuid, boolean) to service_role;

-- ============================================================ 3. betalingsfrist_forlaengelser

create table if not exists public.betalingsfrist_forlaengelser (
  id            uuid primary key default gen_random_uuid(),
  betaling_id   uuid not null references public.betalinger(id) on delete restrict,
  trade_id      uuid not null references public.trades(id) on delete restrict,
  seller_id     uuid not null references public.users(id) on delete restrict,
  buyer_id      uuid not null references public.users(id) on delete restrict,
  gammel_frist  timestamptz not null,
  ny_frist      timestamptz not null,
  oprettet      timestamptz not null default now(),
  constraint betalingsfrist_forlaengelser_senere check (ny_frist > gammel_frist),
  -- Samme frist kan ikke saettes to gange paa samme betaling.
  constraint betalingsfrist_forlaengelser_unik unique (betaling_id, ny_frist)
);

create index if not exists betalingsfrist_forlaengelser_oprettet_idx
  on public.betalingsfrist_forlaengelser (oprettet desc);
create index if not exists betalingsfrist_forlaengelser_trade_idx
  on public.betalingsfrist_forlaengelser (trade_id, oprettet desc);

comment on table public.betalingsfrist_forlaengelser is
  'Saelgerens forlaengelser af betalingsfristen (handel_forlaeng_betalingsfrist). '
  'Notifikations-cron giver koeberen besked ud fra tabellen. Kun service-role. '
  'Slettes aldrig.';

alter table public.betalingsfrist_forlaengelser enable row level security;
revoke all on public.betalingsfrist_forlaengelser from public, anon, authenticated;
grant all on public.betalingsfrist_forlaengelser to service_role;

drop trigger if exists betalingsfrist_forlaengelser_forbyd_sletning_trg
  on public.betalingsfrist_forlaengelser;
create trigger betalingsfrist_forlaengelser_forbyd_sletning_trg
  before delete on public.betalingsfrist_forlaengelser
  for each row execute function public.handelsdata_forbyd_sletning();

-- ============================================================ 4. handel_forlaeng_betalingsfrist

-- Kaldes af saelgeren (hjemmeside og app). Brugeren udledes af auth.uid().
-- Returnerer { kode, betal_senest?, maks_frist? }.
-- Koder:
--   ok              fristen er forlaenget (betal_senest = ny frist)
--   ikke_logget_ind
--   ikke_fundet     handlen findes ikke, eller kalderen er ikke saelgeren
--   ikke_afventer   handlen afventer ikke betaling (betalt, annulleret, ...)
--   frist_udloebet  den nuvaerende frist er allerede udloebet
--   ugyldig_frist   ny frist mangler eller er ikke senere end den nuvaerende
--   for_sent        ny frist er senere end 7 dage efter fristens start
--                   (maks_frist returneres)
create or replace function public.handel_forlaeng_betalingsfrist(
  p_trade uuid, p_ny_frist timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_bruger uuid := auth.uid();
  v_ny     timestamptz := date_trunc('second', p_ny_frist);
  v_maks   timestamptz;
  b        record;
  t        record;
begin
  if v_bruger is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_trade is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laaseraekkefoelge som ubetalt_vinder_annuller/betaling_annuller:
  -- betalinger foerst, derefter trades.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found or b.seller_id is distinct from v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  select * into t from public.trades where id = p_trade for update;
  if not found or t.seller_id is distinct from v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if t.status <> 'afventer_betaling' or b.status not in ('afventer', 'behandles') then
    return jsonb_build_object('kode', 'ikke_afventer');
  end if;
  if b.betal_senest <= now() then
    return jsonb_build_object('kode', 'frist_udloebet');
  end if;

  v_maks := date_trunc('second', b.oprettet + interval '7 days');
  if v_ny is null or v_ny <= b.betal_senest then
    return jsonb_build_object('kode', 'ugyldig_frist', 'maks_frist', v_maks);
  end if;
  if v_ny > v_maks then
    return jsonb_build_object('kode', 'for_sent', 'maks_frist', v_maks);
  end if;

  update public.betalinger
     set betal_senest            = v_ny,
         paamindelse_24_sendt_kl = null,
         paamindelse_40_sendt_kl = null,
         opdateret               = now()
   where id = b.id;

  insert into public.betalingsfrist_forlaengelser (
    betaling_id, trade_id, seller_id, buyer_id, gammel_frist, ny_frist)
  values (b.id, t.id, t.seller_id, t.buyer_id, b.betal_senest, v_ny)
  on conflict (betaling_id, ny_frist) do nothing;

  return jsonb_build_object('kode', 'ok', 'betal_senest', v_ny, 'maks_frist', v_maks);
end;
$fn$;

revoke all on function public.handel_forlaeng_betalingsfrist(uuid, timestamptz)
  from public, anon;
grant execute on function public.handel_forlaeng_betalingsfrist(uuid, timestamptz)
  to authenticated, service_role;

-- ============================================================ 5. auktion_afsluttet_kl

-- Ordret som i 20261004041000_oprydning_rettelser.sql bortset fra den
-- ubetalte vinder uden saelgers valg (se toppen).
create or replace function public.auktion_afsluttet_kl(p_auktion uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  a        record;
  v_t      record;
  v_handel timestamptz;
  v_slut   timestamptz;
  v_tilbud timestamptz;
  v_passiv timestamptz;
  v_antal  integer := 0;
begin
  select id, status, vinder_id, afsluttet_kl
    into a
    from public.auctions
   where id = p_auktion;
  if not found or a.status = 'aktiv' or a.afsluttet_kl is null then
    return null;
  end if;

  if exists (select 1 from public.andenchance_tilbud c
              where c.auction_id = p_auktion and c.status = 'afventer') then
    return null;
  end if;

  -- Ubetalt vinder (eller admin-annulleret handel), hvor saelgeren endnu ikke
  -- har valgt: intet tilbud til naeste byder paa netop den handel, ingen
  -- genopsaetning og ingen ny handel paa auktionen. Holder arkiveringen
  -- tilbage i 14 dage efter annulleringen.
  select max(u.oprettet)
    into v_passiv
    from public.ubetalte_vindere u
    join public.trades ut on ut.id = u.trade_id
   where u.auction_id = p_auktion
     and ut.status = 'annulleret'
     and not exists (select 1 from public.andenchance_tilbud c
                      where c.oprindelig_trade_id = u.trade_id)
     and not exists (select 1 from public.genopsaetninger g
                      where g.gammel_auction_id = p_auktion)
     and not exists (select 1 from public.trades x
                      where x.auction_id = p_auktion
                        and x.status <> 'annulleret');

  v_slut := a.afsluttet_kl;

  if v_passiv is not null then
    if v_passiv > now() - interval '14 days' then
      return null;
    end if;
    -- Oprydningen arkiverer 48 timer efter dette tidspunkt, dvs. 14 dage
    -- efter annulleringen.
    v_slut := greatest(v_slut, v_passiv + interval '12 days');
  end if;

  -- Seneste afsluttede tilbud til naeste byder: saelgeren har 48 timer derfra
  -- til at sende tilbuddet videre, foer auktionen arkiveres.
  select max(coalesce(c.besvaret_kl, c.udloeber))
    into v_tilbud
    from public.andenchance_tilbud c
   where c.auction_id = p_auktion;
  v_slut := greatest(v_slut, v_tilbud);

  for v_t in select id from public.trades where auction_id = p_auktion loop
    v_antal  := v_antal + 1;
    v_handel := public.handel_afsluttet_kl(v_t.id);
    if v_handel is null then return null; end if;
    v_slut := greatest(v_slut, v_handel);
  end loop;

  -- Afsluttet med vinder, men handlen er ikke oprettet endnu.
  if v_antal = 0 and a.status = 'afsluttet' and a.vinder_id is not null then
    return null;
  end if;

  return v_slut;
end;
$fn$;

revoke all on function public.auktion_afsluttet_kl(uuid) from public, anon, authenticated;
grant execute on function public.auktion_afsluttet_kl(uuid) to service_role;
