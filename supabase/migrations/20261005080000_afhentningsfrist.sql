-- Afhentningsfrist (ROADMAP-BESLUTNINGER afsnit 2, "Afhentningsfrist" og
-- "Graenser", Filip 5. oktober 2026):
--   - koeberen har 7 dage fra betalingen (betalinger.betalt_kl) til at hente
--     varen. Fristen vises paa handelssiden for begge, og begge faar en
--     paamindelse paa dag 5 (2 doegn foer fristen).
--   - saelgeren kan forlaenge fristen, hoejst til 14 dage efter betalingen.
--   - er varen ikke hentet inden fristen, faar staff besked og afgoer handlen.
--   - har staff ikke gjort noget 14 dage efter betalingen - og mindst 7 dage
--     efter en forlaenget frist - faar koeberen automatisk ALLE pengene
--     tilbage (total_oere), og saelgeren beholder varen.
--
-- Koeres EFTER 20261003030000/031000 (afhentning), 20261004020000
-- (afsendelsesfrist) og 20261005031000 (admin_haengende_handler).
--
-- Indhold:
--   1. Kolonner:
--        afhentninger.frist_kl            null = standardfristen (betalt_kl + 7 d).
--                                         Saettes kun af afhentning_forlaeng_frist.
--        afhentninger.frist_forlaenget_kl seneste forlaengelse (til paamindelsen).
--        betalinger.afhentningsfrist_annulleret_kl
--                                         automatisk annulleret + fuld refusion.
--   2. afhentningsfrist_forlaengelser: historik (kun service_role, slettes
--      aldrig). Notifikations-cron giver koeberen besked ud fra tabellen, saa
--      det ogsaa virker, naar appen kalder RPC'en direkte.
--   3. afhentning_frist / afhentning_tilbagebetal_kl: een definition af
--      fristen og af tidspunktet for den automatiske tilbagebetaling.
--      Timer i stedet for dage, saa resultatet ikke afhaenger af sessionens
--      tidszone (sommertid) og er det samme som i TypeScript (7 * 24 t).
--   4. afhentning_info: som 20261003031000 + frist, maks_frist, forlaengelser.
--   5. afhentning_forlaeng_frist(p_trade, p_ny_frist) - authenticated, kun
--      saelgeren (auth.uid()).
--   6. afhentning_marker_ikke_hentet: staff faar besked, naar FRISTEN er
--      overskredet (foer: fast 7 dage). Ellers som 20261003031000.
--   7. afhentning_paamind_kandidater() - service_role. Aabne afhentninger,
--      hvor fristen er under 48 timer vaek (paamindelsen paa dag 5).
--   8. afhentningsfrist_annuller() - service_role (cron). Claimer en FULD
--      refusion og annullerer handlen atomisk. Selve refusionen laves bagefter
--      af serveren (refunderBetaling - idempotency key pr. betaling).
--   9. admin_haengende_handler: afhentning haenger, naar fristen er
--      overskredet (foer: fast 7 dage). Ellers som 20261005031000.
--
-- Hvad taeller som "staff har gjort noget" (8): frigivelse (frigivet_kl),
-- refusion (refusion_anmodet_kl), overfoersel, en sag (ogsaa en lukket - en
-- sag paa en afhentningshandel kan kun vaere oprettet af staff), en frysning
-- (trades.sag_aaben), en blokerende indsigelse hos koeberens bank, eller at
-- handlen ikke laengere er 'betaling_modtaget' (fx annulleret af staff).
-- At staff markerer betalingen "loest" (kraever_opmaerksomhed = false) uden at
-- flytte penge taeller IKKE - ellers ville en klik paa "loest" stoppe
-- tilbagebetalingen for altid, og koeberens penge ville haenge.
-- Vil staff stoppe den automatiske tilbagebetaling uden at flytte penge, kan
-- handlen fryses (Marker sag paa /admin/handler).
--
-- Kodelaasen: hverken den midlertidige (5 forkerte pr. time) eller den
-- permanente (15 i alt) blokerer den automatiske tilbagebetaling. Den
-- permanente laas giver stadig staff besked som foer (afhentning_bekraeft er
-- uaendret), og fristen kan ikke forlaenges, naar koden er laast permanent.
--
-- Laaseraekkefoelge overalt: betaling -> handel -> afhentning (som
-- afhentning_bekraeft, afhentning_marker_ikke_hentet og
-- afsendelsesfrist_annuller), saa cron, saelgerens kode og forlaengelsen
-- koeres i serie uden deadlock.
--
-- moderation_log: den eksisterende handling 'handel_refunderet' med
-- BidHamr-systembrugeren (ingen aendring af CHECK).
--
-- Idempotent: if not exists / create or replace / drop ... if exists.
-- Handelsdata slettes aldrig.

-- ============================================================ 1. kolonner

alter table public.afhentninger
  add column if not exists frist_kl            timestamptz,
  add column if not exists frist_forlaenget_kl timestamptz;

comment on column public.afhentninger.frist_kl is
  'Afhentningsfristen, naar saelgeren har forlaenget den (afhentning_forlaeng_frist). '
  'null = standardfristen betalinger.betalt_kl + 7 dage. Brug afhentning_frist().';
comment on column public.afhentninger.frist_forlaenget_kl is
  'Hvornaar fristen sidst blev forlaenget.';

alter table public.betalinger
  add column if not exists afhentningsfrist_annulleret_kl timestamptz;

comment on column public.betalinger.afhentningsfrist_annulleret_kl is
  'Afhentningshandlen blev annulleret automatisk, fordi varen ikke blev hentet, '
  'og staff ikke havde afgjort handlen (14 dage efter betalingen og mindst 7 dage '
  'efter fristen). Koeberen refunderes fuldt; saelgeren beholder varen.';

-- ============================================================ 2. historik

create table if not exists public.afhentningsfrist_forlaengelser (
  id            uuid primary key default gen_random_uuid(),
  betaling_id   uuid not null references public.betalinger(id) on delete restrict,
  trade_id      uuid not null references public.trades(id) on delete restrict,
  seller_id     uuid not null references public.users(id) on delete restrict,
  buyer_id      uuid not null references public.users(id) on delete restrict,
  gammel_frist  timestamptz not null,
  ny_frist      timestamptz not null,
  oprettet      timestamptz not null default now(),
  constraint afhentningsfrist_forlaengelser_senere check (ny_frist > gammel_frist),
  constraint afhentningsfrist_forlaengelser_unik unique (trade_id, ny_frist)
);

create index if not exists afhentningsfrist_forlaengelser_oprettet_idx
  on public.afhentningsfrist_forlaengelser (oprettet desc);

comment on table public.afhentningsfrist_forlaengelser is
  'Saelgerens forlaengelser af afhentningsfristen (afhentning_forlaeng_frist). '
  'Notifikations-cron giver koeberen besked ud fra tabellen. Kun service-role. '
  'Slettes aldrig.';

alter table public.afhentningsfrist_forlaengelser enable row level security;
revoke all on public.afhentningsfrist_forlaengelser from public, anon, authenticated;
grant all on public.afhentningsfrist_forlaengelser to service_role;

drop trigger if exists afhentningsfrist_forlaengelser_forbyd_sletning_trg
  on public.afhentningsfrist_forlaengelser;
create trigger afhentningsfrist_forlaengelser_forbyd_sletning_trg
  before delete on public.afhentningsfrist_forlaengelser
  for each row execute function public.handelsdata_forbyd_sletning();

-- ============================================================ 3. frist

-- Den gaeldende afhentningsfrist. Spejlet i src/lib/afhentningsfrist.ts
-- (AFHENTNINGSFRIST_DAGE = 7).
create or replace function public.afhentning_frist(
  p_frist_kl timestamptz, p_betalt_kl timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $fn$
  select coalesce(p_frist_kl, p_betalt_kl + interval '168 hours');
$fn$;

revoke all on function public.afhentning_frist(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.afhentning_frist(timestamptz, timestamptz) to service_role;

-- Hvornaar koeberen automatisk faar pengene tilbage: 14 dage efter
-- betalingen og mindst 7 dage efter fristen.
create or replace function public.afhentning_tilbagebetal_kl(
  p_frist_kl timestamptz, p_betalt_kl timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $fn$
  select greatest(p_betalt_kl + interval '336 hours',
                  public.afhentning_frist(p_frist_kl, p_betalt_kl) + interval '168 hours');
$fn$;

revoke all on function public.afhentning_tilbagebetal_kl(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.afhentning_tilbagebetal_kl(timestamptz, timestamptz) to service_role;

-- ============================================================ 4. info

-- Som 20261003031000. Nyt:
--   frist          gaeldende afhentningsfrist (null, hvis betalingen mangler)
--   maks_frist     seneste frist, saelgeren kan forlaenge til (betalt + 14 d)
--   forlaengelser  antal forlaengelser indtil nu (hoejst 3)
create or replace function public.afhentning_info(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  kalder  uuid := auth.uid();
  t       record;
  a       record;
  v_betalt timestamptz;
  v_antal integer;
begin
  if kalder is null then return null; end if;

  select * into t from public.trades
   where id = p_trade and afhentning and kalder in (buyer_id, seller_id);
  if not found then return null; end if;

  select * into a from public.afhentninger where trade_id = p_trade;
  select b.betalt_kl into v_betalt
    from public.betalinger b
   where b.trade_id = p_trade and b.status in ('betalt', 'refunderet');
  select count(*) into v_antal
    from public.afhentningsfrist_forlaengelser where trade_id = p_trade;

  return jsonb_build_object(
    'vist',       a.vist_kl is not null,
    'bekraeftet', a.bekraeftet_kl is not null,
    'laast',      a.laast_kl is not null,
    'laast_til',  case when a.laast_til_kl > now() then a.laast_til_kl end,
    'kode',       case when kalder = t.buyer_id
                        and a.vist_kl is not null
                        and a.annulleret_kl is null
                        and t.status = 'betaling_modtaget'
                       then a.kode end,
    'frist',      case when v_betalt is not null
                       then public.afhentning_frist(a.frist_kl, v_betalt) end,
    'maks_frist', case when v_betalt is not null
                       then date_trunc('second', v_betalt + interval '336 hours') end,
    'forlaengelser', v_antal);
end;
$fn$;

revoke all on function public.afhentning_info(uuid) from public, anon;
grant execute on function public.afhentning_info(uuid) to authenticated;

-- ============================================================ 5. forlaeng

-- Saelgeren forlaenger afhentningsfristen (hjemmeside og app). Brugeren
-- udledes af auth.uid(). Ingen penge flyttes.
-- Returnerer { kode, frist?, maks_frist? }. Koder:
--   ok               fristen er forlaenget (frist = ny frist)
--   ikke_logget_ind
--   ikke_fundet      handlen findes ikke, kalderen er ikke saelgeren, eller
--                    handlen er ikke en afhentningshandel
--   ikke_mulig       afhentningen er gennemfoert/annulleret, handlen er ikke
--                    'betaling_modtaget', betalingen er ikke betalt, eller
--                    pengene er frigivet/refunderet, der er en sag eller en
--                    blokerende indsigelse
--   laast            koden er laast permanent (15 forkerte forsoeg) - staff
--                    har overtaget
--   frist_udloebet   den nuvaerende frist er allerede udloebet (staff har
--                    faaet besked og afgoer handlen)
--   for_mange        fristen er allerede forlaenget 3 gange
--   ugyldig_frist    ny frist mangler, er ikke senere end den nuvaerende, eller
--                    er under 24 timer senere (og ikke lig maks-fristen)
--   for_sent         ny frist er senere end 14 dage efter betalingen
create or replace function public.afhentning_forlaeng_frist(
  p_trade uuid, p_ny_frist timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder  uuid := auth.uid();
  v_ny    timestamptz := date_trunc('second', p_ny_frist);
  v_nuv   timestamptz;
  v_maks  timestamptz;
  v_min   timestamptz;
  v_antal integer;
  b       record;
  t       record;
  a       record;
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if p_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Ikke saelgeren: samme svar som en ukendt handel. Tjekkes foer laasene, saa
  -- uvedkommende ikke kan laase fremmede raekker.
  if not exists (select 1 from public.trades
                  where id = p_trade and seller_id = kalder and afhentning) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laaseraekkefoelge: betaling, handel, afhentning.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found or b.seller_id is distinct from kalder then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  select * into t from public.trades where id = p_trade for update;
  if not found or t.seller_id is distinct from kalder or not t.afhentning then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if b.status <> 'betalt'
     or b.betalt_kl is null
     or b.refusion_anmodet_kl is not null
     or b.frigivet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or public.sag_holder_pengene(p_trade)
     or t.status <> 'betaling_modtaget'
     or coalesce(t.sag_aaben, false) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  perform public.afhentning_sikr_kode(p_trade);
  select * into a from public.afhentninger where trade_id = p_trade for update;
  if not found or a.bekraeftet_kl is not null or a.annulleret_kl is not null then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;
  if a.laast_kl is not null then
    return jsonb_build_object('kode', 'laast');
  end if;

  v_nuv  := public.afhentning_frist(a.frist_kl, b.betalt_kl);
  v_maks := date_trunc('second', b.betalt_kl + interval '336 hours');

  if v_nuv <= now() then
    return jsonb_build_object('kode', 'frist_udloebet', 'frist', v_nuv, 'maks_frist', v_maks);
  end if;

  -- Hoejst 3 forlaengelser. Betalingen er laast, saa taellingen er sikker.
  select count(*) into v_antal
    from public.afhentningsfrist_forlaengelser where trade_id = p_trade;
  if v_antal >= 3 then
    return jsonb_build_object('kode', 'for_mange', 'frist', v_nuv, 'maks_frist', v_maks);
  end if;

  if v_ny is null or v_ny <= v_nuv then
    return jsonb_build_object('kode', 'ugyldig_frist', 'frist', v_nuv, 'maks_frist', v_maks);
  end if;
  if v_ny > v_maks then
    return jsonb_build_object('kode', 'for_sent', 'frist', v_nuv, 'maks_frist', v_maks);
  end if;
  -- Mindst 24 timer laengere end den nuvaerende frist - medmindre den nye
  -- frist er maks-fristen (under 24 timer tilbage til graensen). Hele
  -- sekunder, som v_ny.
  v_min := date_trunc('second', v_nuv + interval '24 hours');
  if v_ny < v_min and v_ny <> v_maks then
    return jsonb_build_object('kode', 'ugyldig_frist', 'frist', v_nuv, 'maks_frist', v_maks);
  end if;

  update public.afhentninger
     set frist_kl = v_ny,
         frist_forlaenget_kl = now()
   where trade_id = p_trade;

  insert into public.afhentningsfrist_forlaengelser (
    betaling_id, trade_id, seller_id, buyer_id, gammel_frist, ny_frist)
  values (b.id, t.id, t.seller_id, t.buyer_id, v_nuv, v_ny)
  on conflict (trade_id, ny_frist) do nothing;

  return jsonb_build_object('kode', 'ok', 'frist', v_ny, 'maks_frist', v_maks);
end;
$fn$;

revoke all on function public.afhentning_forlaeng_frist(uuid, timestamptz) from public, anon;
grant execute on function public.afhentning_forlaeng_frist(uuid, timestamptz)
  to authenticated, service_role;

-- ============================================================ 6. ikke hentet

-- Som 20261003031000, men handlen markeres til staff, naar afhentnings-
-- FRISTEN er overskredet (standard 7 dage, evt. forlaenget af saelgeren).
-- Een gang pr. handel (afhentninger.ikke_hentet_markeret_kl). Fristen kan
-- ikke forlaenges, efter den er udloebet, saa markeringen er endelig.
create or replace function public.afhentning_marker_ikke_hentet()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  antal integer := 0;
  tekst constant text := 'Afhentning ikke gennemført inden fristen';
  r     record;
  b     record;
  t     record;
  a     record;
begin
  -- Sikkerhedsnet: alle betalte afhentningshandler har en raekke.
  insert into public.afhentninger (trade_id, kode)
  select t2.id, public.afhentning_ny_kode()
    from public.trades t2
   where t2.afhentning and t2.status = 'betaling_modtaget'
     and not exists (select 1 from public.afhentninger x where x.trade_id = t2.id)
  on conflict (trade_id) do nothing;

  -- Kandidater (uden laase). Tjekkes igen under laas nedenfor.
  for r in
    select af.trade_id
      from public.afhentninger af
      join public.trades t2 on t2.id = af.trade_id
      join public.betalinger b2 on b2.trade_id = af.trade_id
     where t2.afhentning
       and t2.status = 'betaling_modtaget'
       and af.bekraeftet_kl is null
       and af.ikke_hentet_markeret_kl is null
       and af.annulleret_kl is null
       and b2.status = 'betalt'
       and b2.frigivet_kl is null
       and b2.refusion_anmodet_kl is null
       and b2.betalt_kl is not null
       and public.afhentning_frist(af.frist_kl, b2.betalt_kl) < now()
  loop
    begin
      select * into b from public.betalinger where trade_id = r.trade_id for update;
      if not found
         or b.status <> 'betalt'
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.betalt_kl is null then
        continue;
      end if;

      select * into t from public.trades where id = r.trade_id for update;
      if not found or not t.afhentning or t.status <> 'betaling_modtaget' then
        continue;
      end if;

      select * into a from public.afhentninger where trade_id = r.trade_id for update;
      if not found
         or a.bekraeftet_kl is not null
         or a.ikke_hentet_markeret_kl is not null
         or a.annulleret_kl is not null
         or not (public.afhentning_frist(a.frist_kl, b.betalt_kl) < now()) then
        continue;
      end if;

      update public.afhentninger
         set ikke_hentet_markeret_kl = now()
       where trade_id = r.trade_id and ikke_hentet_markeret_kl is null;
      if not found then continue; end if;

      update public.betalinger
         set kraever_opmaerksomhed = true,
             sidste_fejl = left(case
               when kraever_opmaerksomhed and sidste_fejl is not null
                    and position(tekst in sidste_fejl) = 0
                 then sidste_fejl || ' · ' || tekst
               when kraever_opmaerksomhed and sidste_fejl is not null
                 then sidste_fejl
               else tekst end, 500),
             opdateret = now()
       where id = b.id;

      antal := antal + 1;
    exception when others then
      raise warning 'afhentning_marker_ikke_hentet fejlede for handel %: %', r.trade_id, sqlerrm;
    end;
  end loop;

  return antal;
end;
$fn$;

revoke all on function public.afhentning_marker_ikke_hentet() from public, anon, authenticated;
grant execute on function public.afhentning_marker_ikke_hentet() to service_role;

-- ============================================================ 7. paamindelse

-- Aabne afhentninger, hvor fristen er under 48 timer vaek og endnu ikke
-- udloebet (dag 5 ved standardfristen). Serveren sender paamindelsen til
-- koeber og saelger med en noegle, der indeholder fristen, saa en
-- forlaengelse giver en ny paamindelse. Kun laesning.
create or replace function public.afhentning_paamind_kandidater()
returns table (
  trade_id            uuid,
  buyer_id            uuid,
  seller_id           uuid,
  auction_id          uuid,
  frist               timestamptz,
  frist_forlaenget_kl timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select t.id, t.buyer_id, t.seller_id, t.auction_id,
         public.afhentning_frist(af.frist_kl, b.betalt_kl),
         af.frist_forlaenget_kl
    from public.afhentninger af
    join public.trades t on t.id = af.trade_id
    join public.betalinger b on b.trade_id = af.trade_id
   where t.afhentning
     and t.status = 'betaling_modtaget'
     and not coalesce(t.sag_aaben, false)
     and af.bekraeftet_kl is null
     and af.annulleret_kl is null
     and b.status = 'betalt'
     and b.betalt_kl is not null
     and b.frigivet_kl is null
     and b.refusion_anmodet_kl is null
     and b.overfoersel_paabegyndt_kl is null
     and b.stripe_transfer_id is null
     and public.afhentning_frist(af.frist_kl, b.betalt_kl) > now()
     and public.afhentning_frist(af.frist_kl, b.betalt_kl) <= now() + interval '48 hours'
     and not public.sag_holder_pengene(t.id)
   limit 500;
$fn$;

revoke all on function public.afhentning_paamind_kandidater() from public, anon, authenticated;
grant execute on function public.afhentning_paamind_kandidater() to service_role;

-- ============================================================ 8. tilbagebetaling

-- Cron. Returnerer en jsonb-liste med de handler, der blev annulleret i denne
-- koersel: [{betaling_id, trade_id, buyer_id, seller_id, auction_id, total_oere}].
--
-- Annullerer kun, naar ALT dette gaelder (tjekkes igen under laas):
--   - afhentningshandel i 'betaling_modtaget', ingen frysning (sag_aaben),
--     ingen sag (heller ikke en lukket) og ingen ventende anke,
--   - afhentningen er ikke bekraeftet og ikke annulleret,
--   - betalingen er 'betalt' med PaymentIntent, ikke frigivet, ingen
--     refusion claimet, ingen overfoersel, ingen blokerende indsigelse,
--   - now() > greatest(betalt_kl + 14 d, frist + 7 d).
-- Kodelaasen (midlertidig og permanent) tjekkes IKKE.
--
-- Claimer en FULD refusion (refusion_oere null = total_oere: bud + koeber-
-- gebyr + fragt + BidHamr Beskyttelse) og annullerer handlen i samme
-- undertransaktion. Claimet blokerer enhver frigivelse (alle pengeveje
-- kraever refusion_anmodet_kl tom) og afhentning_bekraeft/vis_kode (samme
-- krav). Betalingen markeres til staff (staff faar besked igen efter 14 dage).
create or replace function public.afhentningsfrist_annuller()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  k      record;
  b      record;
  t      record;
  a      record;
  v_ud   jsonb := '[]'::jsonb;
  tekst  constant text :=
    'Afhentning: varen blev ikke hentet, og staff havde ikke afgjort handlen. '
    || 'Handlen er annulleret automatisk, og køberen refunderes fuldt.';
begin
  -- Sikkerhedsnet: alle betalte afhentningshandler har en raekke.
  insert into public.afhentninger (trade_id, kode)
  select t2.id, public.afhentning_ny_kode()
    from public.trades t2
   where t2.afhentning and t2.status = 'betaling_modtaget'
     and not exists (select 1 from public.afhentninger x where x.trade_id = t2.id)
  on conflict (trade_id) do nothing;

  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.betalinger bt
      join public.trades tr on tr.id = bt.trade_id
      join public.afhentninger af on af.trade_id = tr.id
     where bt.status = 'betalt'
       and bt.betalt_kl is not null
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null
       and bt.stripe_payment_intent_id is not null
       and bt.afhentningsfrist_annulleret_kl is null
       and tr.status = 'betaling_modtaget'
       and tr.afhentning
       and not coalesce(tr.sag_aaben, false)
       and af.bekraeftet_kl is null
       and af.annulleret_kl is null
       and public.afhentning_tilbagebetal_kl(af.frist_kl, bt.betalt_kl) < now()
       and not public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
       and not exists (select 1 from public.sager s where s.trade_id = tr.id)
       and not public.sag_holder_pengene(tr.id)
     order by bt.betalt_kl
     limit 200
  loop
    -- Hver handel i sin egen undertransaktion: een fejl ruller kun den
    -- handel tilbage og stopper ikke resten.
    begin
      select * into b from public.betalinger where id = k.betaling_id for update;
      if not found then continue; end if;
      select * into t from public.trades where id = k.trade_id for update;
      if not found then continue; end if;
      select * into a from public.afhentninger where trade_id = k.trade_id for update;
      if not found then continue; end if;

      if b.status <> 'betalt'
         or b.betalt_kl is null
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null
         or b.stripe_payment_intent_id is null
         or b.afhentningsfrist_annulleret_kl is not null
         or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
         or t.status <> 'betaling_modtaget'
         or not t.afhentning
         or coalesce(t.sag_aaben, false)
         or exists (select 1 from public.sager s where s.trade_id = t.id)
         or public.sag_holder_pengene(t.id)
         or a.bekraeftet_kl is not null
         or a.annulleret_kl is not null
         or not (public.afhentning_tilbagebetal_kl(a.frist_kl, b.betalt_kl) < now()) then
        continue;
      end if;

      update public.betalinger
         set refusion_anmodet_kl = now(),
             refusion_aarsag = 'afhentningsfrist',
             refusion_oere = null,
             afhentningsfrist_annulleret_kl = now(),
             kraever_opmaerksomhed = true,
             sidste_fejl = left(case
               when kraever_opmaerksomhed and sidste_fejl is not null
                 then sidste_fejl || ' · ' || tekst
               else tekst end, 500),
             opdateret = now()
       where id = b.id
         and refusion_anmodet_kl is null
         and afhentningsfrist_annulleret_kl is null;
      if not found then continue; end if;

      update public.trades
         set status = 'annulleret', sag_aaben = false
       where id = t.id
         and status = 'betaling_modtaget';
      if not found then
        -- Kan ikke ske under laas, men saa rulles claimet tilbage.
        raise exception 'status aendret under laas';
      end if;

      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (public.bidhamr_system_id(), 'handel_refunderet', 'handel', t.id, t.buyer_id,
              'Automatisk annulleret: varen blev ikke hentet, og staff havde ikke afgjort handlen '
              || '14 dage efter betalingen. Fuld refusion til køberen via Stripe. Sælgeren beholder varen.');

      v_ud := v_ud || jsonb_build_array(jsonb_build_object(
        'betaling_id', b.id, 'trade_id', t.id, 'buyer_id', t.buyer_id,
        'seller_id', t.seller_id, 'auction_id', t.auction_id,
        'total_oere', b.total_oere));
    exception when others then
      raise warning 'afhentningsfrist_annuller: handel % fejlede: %', k.trade_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.afhentningsfrist_annuller() from public, anon, authenticated;
grant execute on function public.afhentningsfrist_annuller() to service_role;

-- ============================================================ 9. haenger

-- Som 20261005031000, men afhentning haenger, naar afhentningsFRISTEN er
-- overskredet (foer: fast 7 dage efter betalingen), og 'siden' er fristen.
-- Graenserne SKAL holdes ens med HAENGER_GRAENSER_DAGE i src/lib/adminGraenser.ts.
create or replace function public.admin_haengende_handler()
returns table (trade_id uuid, grund text, siden timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select t.id,
         case
           when t.status = 'betaling_modtaget' and not t.afhentning then 'ikke_sendt'
           when t.status = 'pakke_sendt' then 'ikke_modtaget'
           else 'afhentning'
         end,
         case
           when t.status = 'pakke_sendt' then coalesce(t.sendt_kl, b.betalt_kl)
           when t.afhentning then public.afhentning_frist(af.frist_kl, b.betalt_kl)
           else b.betalt_kl
         end
    from public.trades t
    join public.betalinger b on b.trade_id = t.id
    left join public.afhentninger af on af.trade_id = t.id
   where not coalesce(t.sag_aaben, false)
     and b.status = 'betalt'
     and b.refusion_anmodet_kl is null
     and (
           -- Grænse: HAENGER_GRAENSER_DAGE.ikke_sendt
           (t.status = 'betaling_modtaget' and not t.afhentning
             and b.betalt_kl < now() - interval '3 days')
           -- Grænse: HAENGER_GRAENSER_DAGE.ikke_modtaget
        or (t.status = 'pakke_sendt'
             and coalesce(t.sendt_kl, b.betalt_kl) < now() - interval '10 days')
           -- Grænse: HAENGER_GRAENSER_DAGE.afhentning (dage efter fristen)
        or (t.status = 'betaling_modtaget' and t.afhentning
             and af.bekraeftet_kl is null
             and af.ikke_hentet_markeret_kl is null
             and af.annulleret_kl is null
             and public.afhentning_frist(af.frist_kl, b.betalt_kl) < now())
         );
$fn$;

comment on function public.admin_haengende_handler() is
  'Handler der haenger (faelles for admin-forsiden og /admin/handler). '
  'Grænser skal holdes ens med src/lib/adminGraenser.ts. Kun service_role.';

revoke all on function public.admin_haengende_handler() from public, anon, authenticated;
grant execute on function public.admin_haengende_handler() to service_role;
