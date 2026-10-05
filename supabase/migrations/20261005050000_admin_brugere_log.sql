-- Fase 1B: "Brugere og sikkerhed" og "Medarbejder-log" i admin.
--
-- Kun LAESE-funktioner. Ingen tabeller, kolonner eller data aendres, og
-- moderation_log_handling_check roeres ikke.
--
-- Alle funktioner er security definer og kun for service_role: admin-panelet
-- kalder dem med service-role-klienten EFTER assertRole() paa serveren
-- (src/lib/adminAuth.ts). Rolle-reglerne (fx at en medarbejder kun ser sin
-- egen log) haandhaeves paa serveren, foer funktionen kaldes.
--
--   admin_brugere_soeg(p_q, p_filter, p_graense)
--       Soegning paa navn, e-mail, telefon og bruger-id + filtre
--       (suspenderet, lukket, advarsler, paamindelser, staff).
--   admin_bruger_historik(p_bruger)
--       Suspenderinger og kontolukning (forslag, afvisning, lukning) fra
--       moderation_log for én bruger.
--   admin_mistaenkelige_brugere()
--       Regler for mistaenkelig aktivitet samlet ét sted. Viser kun hvilke
--       regler der rammer og tallene - ingen automatiske handlinger.
--   admin_medarbejder_log(...)
--       moderation_log med filtre og paginering. Fritekst om
--       saldo-handlinger (gammel wallet, kan indeholde beloeb) skjules,
--       medmindre p_vis_saldo er sand (kun chef).
--   admin_medarbejder_log_personer()
--       Alle, der har en post i loggen, + nuvaerende staff (til filteret).
--
-- Idempotent: create or replace + revoke/grant. Kan koeres flere gange.

-- ============================================================ Hjaelper: LIKE-moenster

-- '%tekst%' med \, % og _ escapet, saa brugerens tekst matches bogstaveligt.
create or replace function public.admin_like_moenster(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select '%' || replace(replace(replace(p_tekst, '\', '\\'), '%', '\%'), '_', '\_') || '%';
$fn$;

revoke all on function public.admin_like_moenster(text) from public, anon, authenticated;
grant execute on function public.admin_like_moenster(text) to service_role;

-- ============================================================ 1. Brugersoegning

-- p_filter: null/'' = alle, 'suspenderet' (aktiv suspension, ikke lukket),
-- 'lukket' (konto lukket permanent), 'advarsler', 'paamindelser', 'staff'.
-- Ukendt filter = intet filter. Systembrugeren (BidHamr) er aldrig med.
create or replace function public.admin_brugere_soeg(
  p_q       text    default null,
  p_filter  text    default null,
  p_graense integer default 50)
returns table (
  id                 uuid,
  navn               text,
  email              text,
  telefon            text,
  avatar_url         text,
  rating             numeric,
  rolle              text,
  oprettet           timestamptz,
  suspenderet        boolean,
  suspenderet_til    timestamptz,
  konto_lukket_kl    timestamptz,
  advarsler_antal    integer,
  paamindelser_antal integer)
language sql
stable
security definer
set search_path = public
as $fn$
  with s as (
    select nullif(btrim(coalesce(p_q, '')), '') as tekst
  ), m as (
    select s.tekst,
           case when s.tekst is null then null else public.admin_like_moenster(s.tekst) end as moenster,
           -- Ren telefonsoegning ("12 34 56 78" finder "12345678" og omvendt).
           case when s.tekst ~ '^[0-9 +()-]+$'
                 and length(regexp_replace(s.tekst, '\D', '', 'g')) >= 4
                then regexp_replace(s.tekst, '\D', '', 'g') end as cifre
      from s
  ), a as (
    select bruger_id, count(*)::int as n from public.advarsler group by bruger_id
  ), p as (
    select bruger_id, count(*)::int as n from public.paamindelser group by bruger_id
  )
  select u.id, u.navn, u.email, u.telefon, u.avatar_url, u.rating, u.rolle,
         u.oprettet, u.suspenderet, u.suspenderet_til, u.konto_lukket_kl,
         coalesce(a.n, 0), coalesce(p.n, 0)
    from public.users u
    cross join m
    left join a on a.bruger_id = u.id
    left join p on p.bruger_id = u.id
   where u.id <> '00000000-0000-4000-8000-0000000b1d00'::uuid
     and (m.tekst is null
          or u.navn ilike m.moenster
          or u.email ilike m.moenster
          or coalesce(u.telefon, '') ilike m.moenster
          or (coalesce(u.fornavn, '') || ' ' || coalesce(u.efternavn, '')) ilike m.moenster
          or u.id::text ilike m.moenster
          or (m.cifre is not null
              and regexp_replace(coalesce(u.telefon, ''), '\D', '', 'g') like '%' || m.cifre || '%'))
     and (case coalesce(p_filter, '')
            when 'suspenderet' then
              u.suspenderet
              and (u.suspenderet_til is null or u.suspenderet_til > now())
              and u.konto_lukket_kl is null
            when 'lukket' then u.konto_lukket_kl is not null
            when 'advarsler' then coalesce(a.n, 0) > 0
            when 'paamindelser' then coalesce(p.n, 0) > 0
            when 'staff' then u.rolle in ('medarbejder', 'admin', 'chef')
            else true
          end)
   order by u.oprettet desc, u.id
   limit least(greatest(coalesce(p_graense, 50), 1), 200);
$fn$;

revoke all on function public.admin_brugere_soeg(text, text, integer) from public, anon, authenticated;
grant execute on function public.admin_brugere_soeg(text, text, integer) to service_role;

-- ============================================================ 2. Suspenderinger og kontolukning

-- Historik for én bruger fra moderation_log (nyeste foerst).
-- er_system: posten er skrevet af systembrugeren (fx forslag om lukning
-- efter 3 advarsler).
create or replace function public.admin_bruger_historik(p_bruger uuid)
returns table (
  id               uuid,
  handling         text,
  medarbejder_id   uuid,
  medarbejder_navn text,
  er_system        boolean,
  aarsag           text,
  oprettet_kl      timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select l.id, l.handling, l.medarbejder_id, m.navn,
         l.medarbejder_id = '00000000-0000-4000-8000-0000000b1d00'::uuid,
         l.aarsag, l.oprettet_kl
    from public.moderation_log l
    left join public.users m on m.id = l.medarbejder_id
   where (l.bruger_id = p_bruger or (l.maal_type = 'bruger' and l.maal_id = p_bruger))
     and l.handling in ('suspender', 'ophaev_suspension', 'konto_lukket',
                        'konto_lukning_foreslaaet', 'konto_lukning_afvist')
   order by l.oprettet_kl desc, l.id desc
   limit 200;
$fn$;

revoke all on function public.admin_bruger_historik(uuid) from public, anon, authenticated;
grant execute on function public.admin_bruger_historik(uuid) to service_role;

-- ============================================================ 3. Mistaenkelig aktivitet

-- Alle regler samlet her. Graenser og perioder aendres KUN i denne funktion
-- (UI'et viser blot regel-koden, antal og graense).
--
--   ubetalte_vindere     >= 2 ubetalte vindersager som koeber (ikke afviste), 90 dage
--   sager_koeber         >= 3 sager oprettet paa handler som koeber, 90 dage
--   sager_tabt_saelger   >= 2 sager afgjort til koeberen paa handler som saelger, 90 dage
--   afsendelsesfrist     >= 2 handler annulleret, fordi saelgeren ikke sendte, 90 dage
--   indsigelser          >= 2 indsigelser fra koeberens bank, 90 dage
--   rapporter            >= 3 forskellige brugere har rapporteret brugerens auktioner, 90 dage
--                        (aktive og arkiverede rapporter)
--   ny_konto_mange_bud   konto under 7 dage gammel med >= 20 bud
--
-- Lukkede konti og systembrugeren er ikke med. Ingen automatiske handlinger.
create or replace function public.admin_mistaenkelige_brugere()
returns table (
  bruger_id         uuid,
  navn              text,
  email             text,
  rolle             text,
  oprettet          timestamptz,
  suspenderet_aktiv boolean,
  regler            jsonb,
  antal_regler      integer)
language sql
stable
security definer
set search_path = public
as $fn$
  with g as (
    select now() - interval '90 days' as fra,
           now() - interval '7 days'  as ny_konto
  ),
  ubetalt as (
    select uv.buyer_id as bruger_id, count(*)::int as n
      from public.ubetalte_vindere uv, g
     where uv.oprettet >= g.fra and uv.status <> 'afvist'
     group by uv.buyer_id
  ),
  sager_k as (
    select t.buyer_id as bruger_id, count(*)::int as n
      from public.sager s
      join public.trades t on t.id = s.trade_id
      cross join g
     where s.oprettet_kl >= g.fra
     group by t.buyer_id
  ),
  sager_tabt as (
    select t.seller_id as bruger_id, count(*)::int as n
      from public.sager s
      join public.trades t on t.id = s.trade_id
      cross join g
     where s.status = 'afgjort_koeber' and s.afgjort_kl >= g.fra
     group by t.seller_id
  ),
  afsend as (
    select b.seller_id as bruger_id, count(*)::int as n
      from public.betalinger b, g
     where b.afsendelsesfrist_annulleret_kl >= g.fra
     group by b.seller_id
  ),
  indsig as (
    select b.buyer_id as bruger_id, count(*)::int as n
      from public.betalinger b, g
     where b.indsigelse_kl >= g.fra
     group by b.buyer_id
  ),
  rapp as (
    select a.bruger_id, count(distinct r.reporter_id)::int as n
      from (select auction_id, reporter_id, created_at from public.reports
            union all
            select auction_id, reporter_id, created_at from public.rapporter_arkiv) r
      join public.auctions a on a.id = r.auction_id
      cross join g
     where r.created_at >= g.fra and r.reporter_id <> a.bruger_id
     group by a.bruger_id
  ),
  nye as (
    select u.id as bruger_id, count(b.id)::int as n
      from public.users u
      join public.bids b on b.bruger_id = u.id
      cross join g
     where u.oprettet >= g.ny_konto
     group by u.id
  ),
  ramt as (
              select bruger_id, 'ubetalte_vindere'   as regel, n, 2  as graense from ubetalt    where n >= 2
    union all select bruger_id, 'sager_koeber',                n, 3             from sager_k    where n >= 3
    union all select bruger_id, 'sager_tabt_saelger',          n, 2             from sager_tabt where n >= 2
    union all select bruger_id, 'afsendelsesfrist',            n, 2             from afsend     where n >= 2
    union all select bruger_id, 'indsigelser',                 n, 2             from indsig     where n >= 2
    union all select bruger_id, 'rapporter',                   n, 3             from rapp       where n >= 3
    union all select bruger_id, 'ny_konto_mange_bud',          n, 20            from nye        where n >= 20
  )
  select u.id, u.navn, u.email, u.rolle, u.oprettet,
         (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now())),
         jsonb_agg(jsonb_build_object('regel', r.regel, 'antal', r.n, 'graense', r.graense)
                   order by r.regel),
         count(*)::int
    from ramt r
    join public.users u on u.id = r.bruger_id
   where u.id <> '00000000-0000-4000-8000-0000000b1d00'::uuid
     and u.konto_lukket_kl is null
   group by u.id
   order by count(*) desc, sum(r.n::numeric / r.graense) desc, u.oprettet desc
   limit 200;
$fn$;

revoke all on function public.admin_mistaenkelige_brugere() from public, anon, authenticated;
grant execute on function public.admin_mistaenkelige_brugere() to service_role;

-- ============================================================ 4. Medarbejder-log

-- p_bruger: bruger-id (eksakt, matcher bruger_id eller maal_id) eller fritekst
-- paa den beroerte brugers navn/e-mail. p_til er eksklusiv.
-- total_antal: antal poster i alt med filtrene (samme i alle raekker).
-- p_vis_saldo: fritekst for saldo_*-handlinger (gammel wallet; kan indeholde
-- beloeb) vises kun, naar den er sand (chef).
create or replace function public.admin_medarbejder_log(
  p_medarbejder uuid        default null,
  p_handling    text        default null,
  p_fra         timestamptz default null,
  p_til         timestamptz default null,
  p_bruger      text        default null,
  p_graense     integer     default 50,
  p_offset      integer     default 0,
  p_vis_saldo   boolean     default false)
returns table (
  id               uuid,
  oprettet_kl      timestamptz,
  medarbejder_id   uuid,
  medarbejder_navn text,
  er_system        boolean,
  handling         text,
  maal_type        text,
  maal_id          uuid,
  bruger_id        uuid,
  bruger_navn      text,
  bruger_email     text,
  aarsag           text,
  total_antal      bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  with s as (
    select nullif(btrim(coalesce(p_bruger, '')), '') as tekst
  ), b as (
    select s.tekst,
           case when s.tekst is null then null else public.admin_like_moenster(s.tekst) end as moenster,
           case when s.tekst ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then s.tekst::uuid end as uid
      from s
  )
  select l.id, l.oprettet_kl, l.medarbejder_id, m.navn,
         l.medarbejder_id = '00000000-0000-4000-8000-0000000b1d00'::uuid,
         l.handling, l.maal_type, l.maal_id, l.bruger_id, u.navn, u.email,
         case when l.handling like 'saldo\_%' and not coalesce(p_vis_saldo, false)
              then null else l.aarsag end,
         count(*) over ()
    from public.moderation_log l
    cross join b
    left join public.users m on m.id = l.medarbejder_id
    left join public.users u on u.id = l.bruger_id
   where (p_medarbejder is null or l.medarbejder_id = p_medarbejder)
     and (p_handling is null or l.handling = p_handling)
     and (p_fra is null or l.oprettet_kl >= p_fra)
     and (p_til is null or l.oprettet_kl < p_til)
     and (b.tekst is null
          or (b.uid is not null and (l.bruger_id = b.uid or l.maal_id = b.uid))
          or (b.uid is null and (u.navn ilike b.moenster or u.email ilike b.moenster)))
   order by l.oprettet_kl desc, l.id desc
   limit least(greatest(coalesce(p_graense, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$fn$;

revoke all on function public.admin_medarbejder_log(uuid, text, timestamptz, timestamptz, text, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_medarbejder_log(uuid, text, timestamptz, timestamptz, text, integer, integer, boolean)
  to service_role;

-- Personer til medarbejder-filteret: alle med poster i loggen (ogsaa
-- tidligere staff) + nuvaerende staff. Systembrugeren markeres.
create or replace function public.admin_medarbejder_log_personer()
returns table (
  id        uuid,
  navn      text,
  rolle     text,
  er_system boolean)
language sql
stable
security definer
set search_path = public
as $fn$
  select u.id, u.navn, u.rolle,
         u.id = '00000000-0000-4000-8000-0000000b1d00'::uuid
    from public.users u
   where u.rolle in ('medarbejder', 'admin', 'chef')
      or u.id = '00000000-0000-4000-8000-0000000b1d00'::uuid
      or exists (select 1 from public.moderation_log l where l.medarbejder_id = u.id)
   order by (u.id = '00000000-0000-4000-8000-0000000b1d00'::uuid) desc, u.navn;
$fn$;

revoke all on function public.admin_medarbejder_log_personer() from public, anon, authenticated;
grant execute on function public.admin_medarbejder_log_personer() to service_role;

-- Indeks til filtrene (medarbejder + periode, nyeste foerst).
create index if not exists moderation_log_medarbejder_kl_idx
  on public.moderation_log (medarbejder_id, oprettet_kl desc);
create index if not exists moderation_log_kl_idx
  on public.moderation_log (oprettet_kl desc);
