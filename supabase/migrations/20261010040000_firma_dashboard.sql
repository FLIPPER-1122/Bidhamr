-- Firma-dashboard (Filip, 8. oktober 2026) - ROADMAP-BESLUTNINGER.md,
-- "Firma-dashboard" og "Ingen beskeder med erhvervssælgere".
--
-- 1. firma_auktioner(p_gruppe): firmaets auktioner i fanerne Aktive / Solgte /
--    Usolgte / Annullerede med visninger (auction_views - auctions.visninger
--    findes ikke i produktionen) og antal pr. fane.
-- 2. firma_statistik(): visninger, bud og salg pr. måned (seneste 12) og pr.
--    auktion (seneste 100).
-- 3. firma_salg(): alle handler som sælger med status, retur (sag afventer
--    retur) og udbetaling fra betalinger (pr. handel).
-- 4. Ingen beskeder med erhvervssælgere: nye beskeder i en handel, hvor
--    sælgeren er en firmakonto (eller auktionen er en erhvervsauktion),
--    afvises - undtagen fællesbeskeder fra BidHamr (fra_bidhamr, som kun kan
--    sættes af service role/postgres - messages_beskyt_fra_bidhamr nulstiller
--    den for alle andre, og den trigger kører før denne, da triggere kører i
--    navneorden). Nye spørgsmål (auction_questions) på erhvervsauktioner
--    afvises også. Fejl: 'erhverv_ingen_beskeder: …' (errcode BHE05).
--
-- Alle tre RPC'er returnerer null, hvis brugeren ikke er en firmakonto, og
-- læser kun brugerens egne data (auth.uid()). Idempotent.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. firma_auktioner
-- ---------------------------------------------------------------------------
create or replace function public.firma_auktioner(p_gruppe text default 'aktive')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_gruppe text := coalesce(p_gruppe, 'aktive');
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.firmaer f where f.bruger_id = v_uid) then
    return null;
  end if;
  if v_gruppe not in ('aktive', 'solgte', 'usolgte', 'annullerede') then
    v_gruppe := 'aktive';
  end if;

  return (
    with egne as (
      select a.id, a.titel, a.billeder, a.status, a.slutter_kl, a.oprettet, a.startpris,
             a."nuværende_bud" as nuvaerende_bud, coalesce(a.antal_bud, 0) as antal_bud,
             coalesce(a.skjult, false) as skjult,
             (select t.id from public.trades t
               where t.auction_id = a.id and t.status <> 'annulleret'
               order by t.created_at desc limit 1) as trade_id,
             (select t.amount from public.trades t
               where t.auction_id = a.id and t.status <> 'annulleret'
               order by t.created_at desc limit 1) as solgt_for
        from public.auctions a
       where a.bruger_id = v_uid
    ),
    grupperet as (
      select e.*,
             case
               when e.status = 'aktiv' then 'aktive'
               when e.status = 'annulleret' then 'annullerede'
               when e.trade_id is not null then 'solgte'
               else 'usolgte'
             end as gruppe
        from egne e
    )
    select jsonb_build_object(
      'antal', jsonb_build_object(
        'aktive', count(*) filter (where g.gruppe = 'aktive'),
        'solgte', count(*) filter (where g.gruppe = 'solgte'),
        'usolgte', count(*) filter (where g.gruppe = 'usolgte'),
        'annullerede', count(*) filter (where g.gruppe = 'annullerede')),
      'gruppe', v_gruppe,
      'auktioner', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', x.id, 'titel', x.titel, 'billede', x.billeder[1], 'status', x.status,
                 'slutter_kl', x.slutter_kl, 'oprettet', x.oprettet, 'startpris', x.startpris,
                 'nuvaerende_bud', x.nuvaerende_bud, 'antal_bud', x.antal_bud,
                 'skjult', x.skjult, 'trade_id', x.trade_id, 'solgt_for', x.solgt_for,
                 'visninger', (select count(*) from public.auction_views v where v.auktion_id = x.id))
               order by case when v_gruppe = 'aktive' then extract(epoch from x.slutter_kl)
                             else -extract(epoch from x.slutter_kl) end)
          from (select * from grupperet g2 where g2.gruppe = v_gruppe
                 order by case when v_gruppe = 'aktive' then extract(epoch from g2.slutter_kl)
                               else -extract(epoch from g2.slutter_kl) end
                 limit 200) x), '[]'::jsonb))
      from grupperet g
  );
end;
$$;

revoke all on function public.firma_auktioner(text) from public, anon;
grant execute on function public.firma_auktioner(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. firma_statistik
-- ---------------------------------------------------------------------------
create or replace function public.firma_statistik()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz := (date_trunc('month', now() at time zone 'Europe/Copenhagen') - interval '11 months')
                         at time zone 'Europe/Copenhagen';
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.firmaer f where f.bruger_id = v_uid) then
    return null;
  end if;

  return jsonb_build_object(
    'maaneder', (
      select jsonb_agg(jsonb_build_object(
               'maaned', to_char(m.maaned, 'YYYY-MM'),
               'visninger', (select count(*) from public.auction_views v
                               join public.auctions a on a.id = v.auktion_id
                              where a.bruger_id = v_uid
                                and v.foerste_visning >= m.fra and v.foerste_visning < m.til),
               'bud', (select count(*) from public.bids b
                         join public.auctions a on a.id = b.auktion_id
                        where a.bruger_id = v_uid
                          and b.oprettet >= m.fra and b.oprettet < m.til),
               'solgte', (select count(*) from public.trades t
                           where t.seller_id = v_uid and t.status <> 'annulleret'
                             and t.created_at >= m.fra and t.created_at < m.til),
               'omsaetning', (select coalesce(sum(t.amount), 0) from public.trades t
                               where t.seller_id = v_uid and t.status <> 'annulleret'
                                 and t.created_at >= m.fra and t.created_at < m.til))
             order by m.maaned)
        from (select s.maaned,
                     s.maaned at time zone 'Europe/Copenhagen' as fra,
                     (s.maaned + interval '1 month') at time zone 'Europe/Copenhagen' as til
                from generate_series(v_start at time zone 'Europe/Copenhagen',
                                     date_trunc('month', now() at time zone 'Europe/Copenhagen'),
                                     interval '1 month') as s(maaned)) m),
    'auktioner', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'titel', a.titel, 'status', a.status, 'oprettet', a.oprettet,
               'slutter_kl', a.slutter_kl, 'bud', coalesce(a.antal_bud, 0),
               'visninger', (select count(*) from public.auction_views v where v.auktion_id = a.id),
               'solgt_for', (select t.amount from public.trades t
                              where t.auction_id = a.id and t.status <> 'annulleret'
                              order by t.created_at desc limit 1))
             order by a.oprettet desc)
        from (select * from public.auctions a0 where a0.bruger_id = v_uid
               order by a0.oprettet desc limit 100) a), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.firma_statistik() from public, anon;
grant execute on function public.firma_statistik() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. firma_salg
-- ---------------------------------------------------------------------------
create or replace function public.firma_salg()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.firmaer f where f.bruger_id = v_uid) then
    return null;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'trade_id', t.id, 'auktion_id', t.auction_id, 'titel', a.titel,
             'billede', a.billeder[1], 'beloeb', t.amount, 'status', t.status,
             'afhentning', coalesce(t.afhentning, false), 'oprettet', t.created_at,
             'sendt_kl', t.sendt_kl, 'modtaget_kl', t.received_at,
             'retur', exists (select 1 from public.sager s
                               where s.trade_id = t.id and s.status = 'afventer_retur'),
             'udbetaling_oere', b.udbetaling_oere,
             'betaling_status', b.status,
             'betalt_kl', b.betalt_kl,
             'overfoert_kl', b.overfoert_kl,
             'refunderet_kl', b.refunderet_kl)
           order by t.created_at desc)
      from (select * from public.trades t0 where t0.seller_id = v_uid
             order by t0.created_at desc limit 500) t
      left join public.auctions a on a.id = t.auction_id
      left join public.betalinger b on b.trade_id = t.id), '[]'::jsonb);
end;
$$;

revoke all on function public.firma_salg() from public, anon;
grant execute on function public.firma_salg() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Ingen beskeder med erhvervssælgere
-- ---------------------------------------------------------------------------
create or replace function public.erhverv_er_handel(p_trade uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.trades t
      left join public.auctions a on a.id = t.auction_id
      left join public.users u on u.id = t.seller_id
     where t.id = p_trade
       and (coalesce(a.erhverv, false) or u.konto_type = 'erhverv'));
$$;

revoke all on function public.erhverv_er_handel(uuid) from public, anon, authenticated;

create or replace function public.messages_erhverv_ingen_beskeder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Fællesbeskeder fra BidHamr (faellesbesked) må altid sendes.
  if new.fra_bidhamr is true or new.sender_id = public.bidhamr_system_id() then
    return new;
  end if;
  if public.erhverv_er_handel(new.trade_id) then
    raise exception 'erhverv_ingen_beskeder: Du kan ikke skrive til en erhvervssælger. Kontakt firmaet på mail eller telefon - se firmaets profil.'
      using errcode = 'BHE05';
  end if;
  return new;
end;
$$;

revoke all on function public.messages_erhverv_ingen_beskeder() from public, anon, authenticated;

-- Navnet sorterer efter messages_beskyt_fra_bidhamr, så fra_bidhamr allerede
-- er nulstillet for almindelige brugere, når denne trigger kører.
drop trigger if exists messages_erhverv_ingen_beskeder on public.messages;
create trigger messages_erhverv_ingen_beskeder
  before insert on public.messages
  for each row execute function public.messages_erhverv_ingen_beskeder();

create or replace function public.auction_questions_erhverv_ingen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.auctions a
              left join public.users u on u.id = a.bruger_id
             where a.id = new.auction_id
               and (coalesce(a.erhverv, false) or u.konto_type = 'erhverv')) then
    raise exception 'erhverv_ingen_beskeder: Du kan ikke stille spørgsmål til en erhvervssælger. Kontakt firmaet på mail eller telefon - se firmaets profil.'
      using errcode = 'BHE05';
  end if;
  return new;
end;
$$;

revoke all on function public.auction_questions_erhverv_ingen() from public, anon, authenticated;

drop trigger if exists auction_questions_erhverv_ingen on public.auction_questions;
create trigger auction_questions_erhverv_ingen
  before insert on public.auction_questions
  for each row execute function public.auction_questions_erhverv_ingen();
