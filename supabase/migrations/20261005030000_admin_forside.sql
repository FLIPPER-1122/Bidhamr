-- Admin-forsiden (ROADMAP fase 1B: "Forside med fokus på brugere" og
-- "Kræver handling nu").
--
-- admin_forside_tal() returnerer alle tal til /admin i eet kald (jsonb):
--   handling   - antal ting, der venter paa staff (sager, anker, rapporter,
--                handler der haenger, ubetalte vindere, betalinger,
--                udbetalingskonti, forslag om kontolukning)
--   brugere    - i alt, nye i dag / denne uge / denne maaned
--   tilvaekst  - nye brugere pr. dag de sidste 30 dage + kumulativt antal
--   aktivitet  - nye auktioner og solgte varer (betalte handler) i dag /
--                denne uge / denne maaned
-- Kun ANTAL - ingen beloeb (indtjening er kun for chef paa en anden side) og
-- ingen personoplysninger.
--
-- Dag/uge/maaned regnes i Europe/Copenhagen (uge = mandag-soendag).
-- Systembrugeren "BidHamr" (00000000-0000-4000-8000-0000000b1d00) taeller
-- ikke som bruger.
--
-- Adgang: KUN service_role. Serveren kalder den efter assertRole('medarbejder')
-- (src/app/admin/page.tsx). Ingen auth.uid() - funktionen handler ikke paa
-- nogens vegne og laeser kun taellinger.
--
-- "Haenger"-grænser (dage):
--   betalt, ikke sendt (forsendelse)        > 3  (auto-annullering ved 5)
--   sendt, ikke modtaget                    > 10 (auto-frigivelse ved 14)
--   afhentning, ikke gennemfoert            > 7  (cron markerer betalingen)
-- Handler, hvor en refusion er anmodet, eller hvor en sag holder pengene,
-- taeller ikke med her (de er dækket af sager/betalinger).
--
-- Ingen nye tabeller. Idempotent: create or replace.

create or replace function public.admin_forside_tal()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  c_system   constant uuid := '00000000-0000-4000-8000-0000000b1d00';
  c_tz       constant text := 'Europe/Copenhagen';
  v_lokal    timestamp := now() at time zone c_tz;
  v_dag      timestamptz := date_trunc('day', v_lokal) at time zone c_tz;
  v_uge      timestamptz := date_trunc('week', v_lokal) at time zone c_tz;
  v_maaned   timestamptz := date_trunc('month', v_lokal) at time zone c_tz;
  v_start30  date := (date_trunc('day', v_lokal) - interval '29 days')::date;
  v_handling jsonb;
  v_brugere  jsonb;
  v_tilvaekst jsonb;
  v_aktivitet jsonb;
begin
  -- ---------------------------------------------------------- Kræver handling
  select jsonb_build_object(
    -- Samme taelling som antal_aabne_sager() (uden anker - de har eget kort).
    'aabne_sager',
      (select count(*) from public.sager where status = 'aaben'),
    -- Afventer retur, hvor koeberens 7 dages frist er udloebet, og returen
    -- ikke er registreret: staff skal tage stilling. Samme beregning som
    -- sag_afgoer / sag_genaabn (20261005021000).
    'retur_udloebet',
      (select count(*)
         from public.sager s
         left join public.sag_anker a on a.sag_id = s.id
        where s.status = 'afventer_retur'
          and s.retur_afleveret_kl is null
          and (a.id is null or a.status <> 'afventer')
          and greatest(coalesce(s.penge_flyttes_efter_kl, s.afgjort_kl + interval '4 days'),
                       coalesce(a.behandlet_kl, '-infinity'::timestamptz))
              + interval '7 days' <= now()),
    'anker',
      (select count(*) from public.sag_anker where status = 'afventer'),
    'rapporter',
      (select count(*) from public.reports where status = 'pending'),
    'ikke_sendt',
      (select count(*)
         from public.trades t
         join public.betalinger b on b.trade_id = t.id
        where t.status = 'betaling_modtaget'
          and not t.afhentning
          and not coalesce(t.sag_aaben, false)
          and b.status = 'betalt'
          and b.refusion_anmodet_kl is null
          and b.betalt_kl < now() - interval '3 days'),
    'ikke_modtaget',
      (select count(*)
         from public.trades t
         join public.betalinger b on b.trade_id = t.id
        where t.status = 'pakke_sendt'
          and not coalesce(t.sag_aaben, false)
          and b.status = 'betalt'
          and b.refusion_anmodet_kl is null
          and coalesce(t.sendt_kl, b.betalt_kl) < now() - interval '10 days'),
    'afhentning',
      (select count(*)
         from public.trades t
         join public.betalinger b on b.trade_id = t.id
        where t.status = 'betaling_modtaget'
          and t.afhentning
          and not coalesce(t.sag_aaben, false)
          and b.status = 'betalt'
          and b.refusion_anmodet_kl is null
          and b.betalt_kl < now() - interval '7 days'),
    'ubetalte',
      (select count(*) from public.ubetalte_vindere where status = 'afventer'),
    -- Alle betalinger, staff skal se paa (samme som menuens badge).
    'betalinger',
      (select count(*) from public.betalinger where kraever_opmaerksomhed),
    -- Delmaengder af 'betalinger' til visning.
    'overfoersel_fejlet',
      (select count(*) from public.betalinger
        where kraever_opmaerksomhed
          and overfoersel_forsoeg > 0
          and stripe_transfer_id is null),
    'refusion_fejlet',
      (select count(*) from public.betalinger
        where kraever_opmaerksomhed
          and refusion_forsoeg > 0
          and refunderet_kl is null),
    'afvigelser',
      (select count(*) from public.betaling_afvigelser where refunderet_kl is null),
    'udbetalingskonti',
      (select count(*) from public.betalingsprofiler where connect_kraever_opmaerksomhed),
    'kontolukninger',
      (select count(*) from public.konto_lukning_forslag where status = 'afventer')
  ) into v_handling;

  -- ---------------------------------------------------------- Brugere
  select jsonb_build_object(
    'i_alt',   count(*),
    'i_dag',   count(*) filter (where oprettet >= v_dag),
    'uge',     count(*) filter (where oprettet >= v_uge),
    'maaned',  count(*) filter (where oprettet >= v_maaned)
  ) into v_brugere
  from public.users
  where id <> c_system;

  -- Tilvaekst: een raekke pr. dag (lokal dato), nye + kumulativt i alt ved
  -- dagens udgang.
  with dage as (
    select d::date as dag
      from generate_series(v_start30, date_trunc('day', v_lokal)::date, interval '1 day') d
  ), nye as (
    select (oprettet at time zone c_tz)::date as dag, count(*) as antal
      from public.users
     where id <> c_system
       and oprettet >= (v_start30::timestamp at time zone c_tz)
     group by 1
  ), foer as (
    select count(*) as antal
      from public.users
     where id <> c_system
       and oprettet < (v_start30::timestamp at time zone c_tz)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'dag', to_char(x.dag, 'YYYY-MM-DD'),
           'nye', x.nye,
           'kumulativt', x.kumulativt) order by x.dag), '[]'::jsonb)
    into v_tilvaekst
    from (
      select dg.dag,
             coalesce(n.antal, 0) as nye,
             (select antal from foer)
               + sum(coalesce(n.antal, 0)) over (order by dg.dag) as kumulativt
        from dage dg
        left join nye n on n.dag = dg.dag
    ) x;

  -- ---------------------------------------------------------- Aktivitet
  select jsonb_build_object(
    'auktioner', (
      select jsonb_build_object(
        'i_dag',  count(*) filter (where oprettet >= v_dag),
        'uge',    count(*) filter (where oprettet >= v_uge),
        'maaned', count(*) filter (where oprettet >= v_maaned))
        from public.auctions
       where oprettet >= least(v_uge, v_maaned)),
    -- Solgte varer = handler, hvor betalingen er gennemfoert i perioden
    -- (ogsaa hvis den senere er refunderet - salget skete).
    'solgte', (
      select jsonb_build_object(
        'i_dag',  count(*) filter (where betalt_kl >= v_dag),
        'uge',    count(*) filter (where betalt_kl >= v_uge),
        'maaned', count(*) filter (where betalt_kl >= v_maaned))
        from public.betalinger
       where betalt_kl >= least(v_uge, v_maaned))
  ) into v_aktivitet;

  return jsonb_build_object(
    'handling',  v_handling,
    'brugere',   v_brugere,
    'tilvaekst', v_tilvaekst,
    'aktivitet', v_aktivitet,
    'beregnet_kl', now());
end;
$fn$;

comment on function public.admin_forside_tal() is
  'Tal til admin-forsiden (antal, ingen beloeb eller personoplysninger). '
  'Kun service_role - serveren kalder den efter assertRole(''medarbejder'').';

revoke all on function public.admin_forside_tal() from public, anon, authenticated;
grant execute on function public.admin_forside_tal() to service_role;
