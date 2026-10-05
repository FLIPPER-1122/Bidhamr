-- Admin: "Penge" - KUN for rollen chef (ROADMAP fase 1B; ROADMAP-BESLUTNINGER
-- "Admin-dashboard: Kun rollen chef maa se pengetal og indtjeningsstatistik").
--
-- To laesefunktioner, der kun kan kaldes med service_role. Serveren kalder dem
-- foerst EFTER at have tjekket, at den indloggede bruger er chef
-- (src/lib/admin/penge.ts -> assertRole("chef")). Ingen grants til anon eller
-- authenticated, saa en medarbejder/admin ikke kan kalde dem via API'et.
--
-- Funktionerne aendrer intet. Stripe er sandheden om penge - tallene her er
-- databasens spejl og afstemmes mod Stripe paa siden. Alle beloeb i oere.
--
--   admin_penge_tal(p_fra, p_til)  Tal for en periode (null = ingen graense).
--     Periodiseres efter haendelsens tidspunkt:
--       betalinger, omsaetning, indtjening, fragt -> betalinger.betalt_kl
--       udbetalinger til saelgere               -> betalinger.overfoert_kl
--       refusioner                               -> betalinger.refunderet_kl
--       indsigelser                              -> betalinger.indsigelse_kl
--       forkerte beloeb (betaling_afvigelser)    -> oprettet / refunderet_kl
--     "Aktive" handler (taeller i omsaetning og indtjening): status 'betalt',
--     ingen refusion claimet, ingen tabt indsigelse.
--     Delvis refusion (sag med medhold: alt undtagen BidHamr Beskyttelse):
--     det beholdte beloeb (total - refusion) fordeles i raekkefoelgen
--     BidHamr Beskyttelse, koebergebyr, fragt, oevrigt.
--     Refunderet EFTER overfoersel til saelger taeller ikke som indtjening, men
--     vises som tab.
--     Tabt indsigelse efter udbetaling = BidHamrs tab (beslutning 2. okt. 2026):
--     udbetalingen til saelgeren + fragten (Stripes indsigelsesgebyr kommer
--     oveni og ses kun hos Stripe).
--
--   admin_penge_holdes(p_graense)  Beloeb hos Stripe, der endnu ikke er
--     frigivet/overfoert/refunderet: betalinger med status 'betalt', uden
--     refusion, uden overfoersel og uden tabt indsigelse. Med grund og
--     forventet tidspunkt efter de eksisterende regler:
--       indsigelse            aaben indsigelse hos koeberens bank blokerer
--       refusion_i_gang       refusion claimet, venter paa Stripe
--       overfoersel_i_gang    overfoersel paabegyndt, venter paa Stripe
--       afventer_overfoersel  frigivet, overfoeres til saelgerens konto
--       afventer_anke         en anke behandles (sag_anker.status 'afventer')
--       afventer_sag          aaben sag
--       afventer_retur        medhold til koeber, venter paa returpakken
--                             (tidligst ved ankefristen)
--       ankefrist             afgjort; pengene flyttes ved
--                             sager.penge_flyttes_efter_kl (refunder/frigiv/ingen)
--       frosset               trades.sag_aaben uden sag (gammel admin-frysning)
--       afhentning            frigives, naar saelgeren indtaster koeberens kode
--       afventer_afsendelse   ikke sendt: fuld refusion 5 dage efter betaling
--       auto_frigivelse       'pakke_sendt': 14 dage efter afsendelse;
--                             'modtaget': 48 timer efter modtagelse
--       kraever_tjek          ingen af ovenstaaende (fx annulleret handel)
--     Samme regler som handel_auto_frigiv (20261003011000),
--     sag_holder_pengene (20261004050000) og afsendelsesfrist_annuller
--     (20261004020000). Plus forkerte beloeb, der endnu ikke er refunderet.
--
-- Idempotent: create or replace + revoke/grant. Ingen data aendres.

-- ============================================================ admin_penge_tal

create or replace function public.admin_penge_tal(p_fra timestamptz, p_til timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with g as (
    select coalesce(p_fra, '-infinity'::timestamptz) as fra,
           coalesce(p_til, 'infinity'::timestamptz)  as til
  ),
  b as (
    select bt.*,
           coalesce(bt.refusion_oere, bt.total_oere) as ref_beloeb,
           (bt.refusion_oere is not null and bt.refusion_oere < bt.total_oere) as er_delvis
      from public.betalinger bt
  ),
  betalt as (
    select b.* from b, g
     where b.betalt_kl is not null and b.betalt_kl >= g.fra and b.betalt_kl < g.til
  ),
  aktive as (
    select * from betalt
     where status = 'betalt'
       and refusion_anmodet_kl is null
       and coalesce(indsigelse_status, '') <> 'lost'
  ),
  delvis as (
    select d.*, f.besk, f.kgeb, f.fragt, f.beholdt - f.besk - f.kgeb - f.fragt as oevrigt
      from betalt d
      cross join lateral (
        select x.beholdt, x.besk, x.kgeb,
               least(d.fragt_oere, x.beholdt - x.besk - x.kgeb) as fragt
          from (
            select y.beholdt, y.besk,
                   least(d.koebergebyr_oere, y.beholdt - y.besk) as kgeb
              from (
                select d.total_oere - d.refusion_oere as beholdt,
                       least(d.beskyttelse_oere, d.total_oere - d.refusion_oere) as besk
              ) y
          ) x
      ) f
     where d.status = 'refunderet'
       and d.er_delvis
       and d.stripe_transfer_id is null
       and d.overfoersel_paabegyndt_kl is null
  ),
  refunderet as (
    select b.* from b, g
     where b.status = 'refunderet'
       and b.refunderet_kl >= g.fra and b.refunderet_kl < g.til
  ),
  ref_i_gang as (
    select b.* from b, g
     where b.status = 'betalt'
       and b.refusion_anmodet_kl is not null
       and b.refusion_anmodet_kl >= g.fra and b.refusion_anmodet_kl < g.til
  ),
  overfoert as (
    select b.* from b, g
     where b.stripe_transfer_id is not null
       and b.overfoert_kl >= g.fra and b.overfoert_kl < g.til
  ),
  indsigelser as (
    select b.*,
           (b.stripe_transfer_id is not null or b.overfoersel_paabegyndt_kl is not null) as efter_udbetaling
      from b, g
     where b.indsigelse_kl is not null
       and b.indsigelse_kl >= g.fra and b.indsigelse_kl < g.til
  ),
  afv_modtaget as (
    select a.* from public.betaling_afvigelser a, g
     where a.oprettet >= g.fra and a.oprettet < g.til
  ),
  afv_refunderet as (
    select a.* from public.betaling_afvigelser a, g
     where a.refunderet_kl is not null
       and a.refunderet_kl >= g.fra and a.refunderet_kl < g.til
  )
  select jsonb_build_object(
    'betalinger_modtaget', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(total_oere), 0)) from betalt),
    'forkerte_beloeb_modtaget', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(modtaget_oere), 0)) from afv_modtaget),
    'omsaetning', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(bud_oere), 0)) from aktive),
    'indtjening', (
      select jsonb_build_object(
        'koebergebyr',  a.kgeb + d.kgeb,
        'saelgergebyr', a.sgeb,
        'beskyttelse',  a.besk + d.besk,
        'oevrigt',      d.oevrigt,
        'i_alt',        a.kgeb + d.kgeb + a.sgeb + a.besk + d.besk + d.oevrigt,
        'heraf_ikke_frigivet', a.ikke_frigivet,
        'antal_beskyttelse', a.antal_besk)
        from (select coalesce(sum(koebergebyr_oere), 0)  as kgeb,
                     coalesce(sum(saelgergebyr_oere), 0) as sgeb,
                     coalesce(sum(beskyttelse_oere), 0)  as besk,
                     count(*) filter (where beskyttelse)  as antal_besk,
                     coalesce(sum(koebergebyr_oere + saelgergebyr_oere + beskyttelse_oere)
                              filter (where stripe_transfer_id is null), 0) as ikke_frigivet
                from aktive) a,
             (select coalesce(sum(kgeb), 0) as kgeb,
                     coalesce(sum(besk), 0) as besk,
                     coalesce(sum(oevrigt), 0) as oevrigt
                from delvis) d),
    'fragt', (select jsonb_build_object(
        'beloeb', (select coalesce(sum(fragt_oere), 0) from aktive)
                  + (select coalesce(sum(fragt), 0) from delvis),
        'antal',  (select count(*) from aktive where fragt_oere > 0))),
    'udbetalinger', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(udbetaling_oere), 0)) from overfoert),
    'refusioner', jsonb_build_object(
        'fulde', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0))
            from refunderet where not er_delvis),
        'delvise', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0))
            from refunderet where er_delvis),
        'i_gang', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0)) from ref_i_gang),
        'forkerte_beloeb', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(modtaget_oere), 0)) from afv_refunderet),
        'efter_udbetaling', (select jsonb_build_object(
            'antal', count(*),
            'refunderet', coalesce(sum(ref_beloeb), 0),
            'udbetalt', coalesce(sum(udbetaling_oere), 0))
            from refunderet
           where stripe_transfer_id is not null or overfoersel_paabegyndt_kl is not null)),
    'indsigelser', (select jsonb_build_object(
        'antal',  count(*),
        'beloeb', coalesce(sum(total_oere), 0),
        'aabne',  count(*) filter (where public.betaling_indsigelse_blokerer(indsigelse_kl, indsigelse_status)
                                    and coalesce(indsigelse_status, '') <> 'lost'),
        'vundet', count(*) filter (where indsigelse_status = 'won'),
        'lukket', count(*) filter (where indsigelse_status in ('warning_closed', 'prevented')),
        'tabt_foer_udbetaling', jsonb_build_object(
            'antal',  count(*) filter (where indsigelse_status = 'lost' and not efter_udbetaling),
            'beloeb', coalesce(sum(total_oere) filter (
                        where indsigelse_status = 'lost' and not efter_udbetaling), 0)),
        'tabt_efter_udbetaling', jsonb_build_object(
            'antal',  count(*) filter (where indsigelse_status = 'lost' and efter_udbetaling),
            'beloeb', coalesce(sum(total_oere) filter (
                        where indsigelse_status = 'lost' and efter_udbetaling), 0),
            'tab',    coalesce(sum(udbetaling_oere + fragt_oere) filter (
                        where indsigelse_status = 'lost' and efter_udbetaling), 0)))
        from indsigelser)
  );
$fn$;

revoke all on function public.admin_penge_tal(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_penge_tal(timestamptz, timestamptz) to service_role;

comment on function public.admin_penge_tal(timestamptz, timestamptz) is
  'Pengetal for en periode til admin-siden /admin/penge (kun chef - tjekkes paa '
  'serveren foer kaldet). Kun service_role. Alle beloeb i oere.';

-- ============================================================ admin_penge_holdes

create or replace function public.admin_penge_holdes(p_graense integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with h as (
    select bt.id as betaling_id, bt.trade_id, bt.auction_id, bt.total_oere,
           bt.udbetaling_oere, bt.betalt_kl, bt.kraever_opmaerksomhed,
           t.status as handel_status, s.penge_fejl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then 'indsigelse'
             when bt.refusion_anmodet_kl is not null then 'refusion_i_gang'
             when bt.overfoersel_paabegyndt_kl is not null then 'overfoersel_i_gang'
             when bt.frigivet_kl is not null then 'afventer_overfoersel'
             when an.id is not null then 'afventer_anke'
             when s.status = 'aaben' then 'afventer_sag'
             when s.status = 'afventer_retur' then 'afventer_retur'
             when s.penge_handling is not null then 'ankefrist'
             when coalesce(t.sag_aaben, false) then 'frosset'
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'afhentning'
             when t.status = 'betaling_modtaget' then 'afventer_afsendelse'
             when t.status = 'pakke_sendt' then 'auto_frigivelse'
             when t.status = 'modtaget' and t.received_at is not null then 'auto_frigivelse'
             else 'kraever_tjek'
           end as grund,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
                  or bt.refusion_anmodet_kl is not null
                  or bt.overfoersel_paabegyndt_kl is not null
                  or bt.frigivet_kl is not null
                  or an.id is not null
                  or s.status = 'aaben'
               then null
             when s.status = 'afventer_retur' or s.penge_handling is not null
               then s.penge_flyttes_efter_kl
             when coalesce(t.sag_aaben, false) or coalesce(t.afhentning, false) then null
             when t.status = 'betaling_modtaget' then bt.betalt_kl + interval '5 days'
             when t.status = 'pakke_sendt'
               then coalesce(t.sendt_kl, bt.betalt_kl) + interval '14 days'
             when t.status = 'modtaget' then t.received_at + interval '48 hours'
           end as forventet_kl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then null
             when bt.refusion_anmodet_kl is not null then 'refunder'
             when bt.overfoersel_paabegyndt_kl is not null or bt.frigivet_kl is not null
               then 'frigiv'
             when an.id is not null or s.status = 'aaben' then null
             when s.status = 'afventer_retur' then 'refunder'
             when s.penge_handling is not null then s.penge_handling
             when coalesce(t.sag_aaben, false) then null
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'frigiv'
             when t.status = 'betaling_modtaget' then 'refunder'
             when t.status in ('pakke_sendt', 'modtaget') then 'frigiv'
           end as handling
      from public.betalinger bt
      join public.trades t on t.id = bt.trade_id
      left join lateral (
        select s1.status, s1.penge_handling, s1.penge_flyttes_efter_kl, s1.penge_fejl
          from public.sager s1
         where s1.trade_id = bt.trade_id
           and (s1.status in ('aaben', 'afventer_retur')
                or (s1.penge_handling is not null and s1.afviklet_kl is null))
         order by s1.oprettet_kl desc
         limit 1
      ) s on true
      left join lateral (
        select a1.id from public.sag_anker a1
         where a1.trade_id = bt.trade_id and a1.status = 'afventer'
         limit 1
      ) an on true
     where bt.status = 'betalt'
       and bt.refunderet_kl is null
       and bt.stripe_transfer_id is null
       and coalesce(bt.indsigelse_status, '') <> 'lost'
  ),
  afv as (
    select a.id, a.trade_id, a.modtaget_oere, a.oprettet, a.sidste_fejl
      from public.betaling_afvigelser a
     where a.refunderet_kl is null
  )
  select jsonb_build_object(
    'antal', (select count(*) from h),
    'beloeb', (select coalesce(sum(total_oere), 0) from h),
    'til_saelgere', (select coalesce(sum(udbetaling_oere), 0) from h),
    'efter_grund', coalesce((
      select jsonb_agg(jsonb_build_object('grund', grund, 'antal', antal, 'beloeb', beloeb)
                       order by beloeb desc)
        from (select grund, count(*) as antal, sum(total_oere) as beloeb
                from h group by grund) x), '[]'::jsonb),
    'forkerte_beloeb', jsonb_build_object(
        'antal',  (select count(*) from afv),
        'beloeb', (select coalesce(sum(modtaget_oere), 0) from afv)),
    'liste', coalesce((
      select jsonb_agg(jsonb_build_object(
               'betaling_id', l.betaling_id,
               'trade_id', l.trade_id,
               'auction_id', l.auction_id,
               'titel', au.titel,
               'total_oere', l.total_oere,
               'udbetaling_oere', l.udbetaling_oere,
               'betalt_kl', l.betalt_kl,
               'handel_status', l.handel_status,
               'grund', l.grund,
               'forventet_kl', l.forventet_kl,
               'handling', l.handling,
               'penge_fejl', l.penge_fejl,
               'kraever_opmaerksomhed', l.kraever_opmaerksomhed)
             order by l.forventet_kl asc nulls last, l.betalt_kl asc)
        from (select * from h
               order by forventet_kl asc nulls last, betalt_kl asc
               limit greatest(1, least(coalesce(p_graense, 200), 1000))) l
        left join public.auctions au on au.id = l.auction_id), '[]'::jsonb)
  );
$fn$;

revoke all on function public.admin_penge_holdes(integer) from public, anon, authenticated;
grant execute on function public.admin_penge_holdes(integer) to service_role;

comment on function public.admin_penge_holdes(integer) is
  'Beloeb hos Stripe, der endnu ikke er frigivet/overfoert/refunderet, med grund '
  'og forventet tidspunkt. Til /admin/penge (kun chef). Kun service_role. Oere.';
