-- Sælger-rollen ser købers e-mail i klager over firmaer (Filip, 26. okt. 2026).
--
-- Før (20261016020000_erhverv_klager.sql): erhverv_klage_detalje viste kun
-- købers e-mail for chefen. Nu ser chef OG sælger-rollen den, så sælger-rollen
-- kan håndtere klagerne selv (GDPR: need to know).
--
--   1. erhverv_klage_detalje: 'koeber.email' udfyldes for alle med Erhverv-
--      adgang (erhverv_har_adgang = chef eller saelger) - men ikke, når staff
--      er inhabil (har handlet med firmaet eller er køberen). Så skjules
--      e-mailen ligesom beskrivelse og billeder.
--   2. Hver visning af købers e-mail logges i moderation_log (handling
--      'erhverv_klage_koeber_email_vist', maal_type 'erhverv_klage',
--      bruger_id = køberen, hvis persondata blev vist), så det kan
--      dokumenteres, hvem der har set den og hvornår. Funktionen er derfor
--      ikke længere 'stable' (den skriver), men volatile.
--
-- Uændret: firma_faktura_salg med p_firma (et andet firmas købsoplysninger)
-- er stadig kun for chefen. Almindelig admin og medarbejder har stadig ingen
-- adgang til Erhverv. Funktionen er stadig intern (kun service_role); p_staff
-- sættes af serveren efter rolletjek (src/app/actions/adminErhvervKlager.ts).
--
-- md5-drift-tjek (mønstret fra 20261031010000): funktionen erstattes kun, hvis
-- kroppen er repoets version fra 20261016020000 ("gammel") eller allerede
-- denne version ("ny"). Ellers afbrydes migrationen (intet ændres).
--
-- Idempotent (kan køres igen). Kør først på testdatabasen. KØRES IKKE i
-- produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælpere (kun i denne session)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Flet værdier ind i en eksisterende CHECK (som 20261016020000).
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek før noget ændres
-- ---------------------------------------------------------------------------
do $do$
declare
  h text := pg_temp.krop_md5('public.erhverv_klage_detalje(uuid,uuid)');
begin
  if h is null then
    raise exception 'erhverv_klage_detalje findes ikke - kør 20261016020000 først';
  end if;
  if h not in ('dab1f2a3744a1a5af3b559fc1ccbc086',   -- gammel (20261016020000)
               '3e2cd7ec24ba51a3754b2cbcca1b4abe') then -- ny (denne fil)
    raise exception 'erhverv_klage_detalje: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', h;
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- 2. Ny handling i moderation_log
-- ---------------------------------------------------------------------------
select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['erhverv_klage_koeber_email_vist']);

-- ---------------------------------------------------------------------------
-- 3. erhverv_klage_detalje: chef og saelger ser købers e-mail (ikke inhabil)
-- ---------------------------------------------------------------------------
create or replace function public.erhverv_klage_detalje(p_staff uuid, p_klage uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_chef    boolean;
  v_inhabil boolean;
  v_email   text;
  v_rolle   text;
  k         record;
  fm        record;
  fs        record;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  v_chef := public.erhverv_har_adgang(p_staff, true);

  select * into k from public.erhverv_klager where id = p_klage;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select * into fm from public.firmaer where id = k.firma_id;
  select * into fs from public.erhverv_advarsel_forslag
   where firma_id = k.firma_id and status = 'afventer';
  -- Inhabil (har handlet med firmaet eller er køberen): beskrivelse,
  -- billeder og købers e-mail vises ikke.
  v_inhabil := public.erhverv_klage_inhabil(p_staff, k.firma_bruger_id) or p_staff = k.koeber_id;

  -- Købers e-mail: chef og saelger (Filip, 26. okt. 2026) - ikke ved inhabilitet.
  if not v_inhabil then
    select coalesce(nullif(btrim(u.email), ''),
                    (select au.email::text from auth.users au where au.id = u.id))
      into v_email
      from public.users u where u.id = k.koeber_id;
  end if;

  -- Visningen logges (GDPR: dokumentation af, hvem der har set købers e-mail).
  if v_email is not null then
    select u.rolle into v_rolle from public.users u where u.id = p_staff;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_staff, 'erhverv_klage_koeber_email_vist', 'erhverv_klage', k.id, k.koeber_id,
            left('Købers e-mail vist i klage nr. ' || k.nummer
                 || ' (rolle: ' || coalesce(v_rolle, '?') || ')', 1000));
  end if;

  return jsonb_build_object(
    'kode', 'ok',
    'er_chef', v_chef,
    'inhabil', v_inhabil,
    'klage', jsonb_build_object(
      'id', k.id, 'nummer', k.nummer, 'trade_id', k.trade_id, 'kategori', k.kategori,
      'beskrivelse', case when v_inhabil then null else k.beskrivelse end,
      'status', k.status, 'afgoerelse', k.afgoerelse,
      'begrundelse', k.begrundelse, 'oprettet_kl', k.oprettet_kl, 'afgjort_kl', k.afgjort_kl,
      'afgjort_af_navn', (select u.navn from public.users u where u.id = k.afgjort_af),
      'behandles_af_navn', (select u.navn from public.users u where u.id = k.behandles_af),
      'behandling_startet_kl', k.behandling_startet_kl,
      'forslag_id', k.forslag_id),
    'billeder', case when v_inhabil then '[]'::jsonb else
                coalesce((select jsonb_agg(b.sti order by b.oprettet_kl)
                            from public.erhverv_klage_billeder b where b.klage_id = k.id), '[]'::jsonb) end,
    'noter', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'type', n.type, 'kanal', n.kanal, 'tekst', n.tekst,
               'oprettet_kl', n.oprettet_kl, 'staff_navn', u.navn)
             order by n.oprettet_kl)
        from public.erhverv_klage_noter n
        left join public.users u on u.id = n.staff_id
       where n.klage_id = k.id), '[]'::jsonb),
    'handel', (
      select jsonb_build_object(
               'id', t.id, 'titel', a.titel, 'beloeb', t.amount, 'status', t.status,
               'oprettet_kl', t.created_at, 'afhentning', coalesce(t.afhentning, false),
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl,
               'sendt_kl', t.sendt_kl, 'modtaget_kl', t.received_at)
        from public.trades t
        left join public.auctions a on a.id = t.auction_id
        left join public.betalinger b on b.trade_id = t.id
       where t.id = k.trade_id),
    'firma', jsonb_build_object(
      'id', fm.id, 'bruger_id', fm.bruger_id, 'firmanavn', fm.firmanavn, 'cvr', fm.cvr,
      'kontaktperson', fm.kontaktperson, 'telefon', fm.telefon, 'kontakt_email', fm.kontakt_email,
      'adresse', fm.adresse, 'postnummer', fm.postnummer, 'bynavn', fm.bynavn,
      'abonnement_status', fm.abonnement_status,
      'konto_lukket', exists (select 1 from public.users u where u.id = fm.bruger_id and u.konto_lukket_kl is not null)),
    'koeber', (
      select jsonb_build_object('id', u.id, 'navn', u.navn, 'email', v_email)
        from public.users u where u.id = k.koeber_id),
    'statistik', jsonb_build_object(
      'klager_i_alt', (select count(*) from public.erhverv_klager x where x.firma_id = k.firma_id),
      'berettigede_12_mdr', (select count(*) from public.erhverv_klager x
                              where x.firma_id = k.firma_id and x.afgoerelse = 'berettiget'
                                and x.afgjort_kl > now() - interval '12 months'),
      'advarsler_antal', (select count(*) from public.advarsler a where a.bruger_id = k.firma_bruger_id),
      'afventende_forslag', case when fs.id is null then null else jsonb_build_object(
                              'id', fs.id, 'grundlag', fs.grundlag, 'antal_klager', fs.antal_klager,
                              'oprettet_kl', fs.oprettet_kl) end,
      'lukning_foreslaaet', exists (select 1 from public.konto_lukning_forslag l
                                     where l.bruger_id = k.firma_bruger_id and l.status = 'afventer')));
end;
$$;
revoke all on function public.erhverv_klage_detalje(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_klage_detalje(uuid, uuid) to service_role;

comment on function public.erhverv_klage_detalje(uuid, uuid) is
  'Én klage over et firma til admin (chef og saelger). Købers e-mail vises for chef og saelger, men ikke ved inhabilitet; hver visning logges i moderation_log (erhverv_klage_koeber_email_vist). Kun service_role - p_staff sættes af serveren efter rolletjek.';

-- ---------------------------------------------------------------------------
-- 4. Efter-tjek
-- ---------------------------------------------------------------------------
do $do$
declare
  h text := pg_temp.krop_md5('public.erhverv_klage_detalje(uuid,uuid)');
begin
  if h is distinct from '3e2cd7ec24ba51a3754b2cbcca1b4abe' then
    raise exception 'erhverv_klage_detalje: efter rettelsen er md5 % (forventet 3e2cd7ec24ba51a3754b2cbcca1b4abe)', h;
  end if;
end $do$;

drop function pg_temp.krop_md5(text);
drop function pg_temp.flet_check(regclass, text, text, text[]);
