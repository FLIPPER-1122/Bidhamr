-- Ugens butik: rettelser efter reviewerens fund og Filips regler (26. okt.
-- 2026 - ROADMAP-BESLUTNINGER "Regler for Ugens butik", "Sælger-rollen kan
-- lige så meget som chefen på firmasiden", "NYE pakker og priser").
-- Bygger på 20261101020000_ugens_butik.sql.
--
--   1. Den IGANGVÆRENDE uge kan også købes (af firmaet og af staff med
--      betaling). Prisen er den samme, uanset hvornår i ugen man køber, og
--      pladsen ophører mandag kl. 00 dansk tid (slut_kl). En reservation
--      holder aldrig ud over ugens slutning (reserveret_til <= slut_kl).
--      Er ugen taget af et andet firma, er den 'optaget' (som før).
--   2. Højst 4 uger i træk pr. firma, og efter 4 uger i træk skal der gå 2
--      hele uger, før firmaet kan få pladsen igen (ugens_butik_loft_brudt).
--      Tæller: firmaets uger i status betalt, manuel (staff), behandles og
--      reserveret (ikke udløbet) - købte og staff-bookede. Annullerede,
--      udløbne og refunderede tæller ikke. Reglen gælder mængden af uger, så
--      rækkefølgen af købene er ligegyldig: en stribe på højst 4, og en stribe
--      på 4 skal have mindst 2 tomme uger før den næste uge (begge veje).
--      Håndhæves under firmaets lås i koeb_start, staff_book og registrer
--      ('loft') og desuden af triggeren ugens_butik_loft_vagt (sidste værn -
--      fx samtidige køb, der omgår funktionerne), når en booking BLIVER en
--      uge, der holder pladsen (insert, eller udløbet -> betalt).
--      Staff kan omgå loftet ved en manuel booking (p_omgaa_loft): bookingen
--      markeres loft_omgaaet, og det logges med begrundelse
--      ('ugens_butik_loft_omgaaet').
--   3. Sælger-rollen kan annullere og refundere betalte uger ligesom chefen
--      (ugens_butik_staff_annuller - koden 'kun_chef' findes ikke længere).
--      Prisen (ugens_butik_saet_pris) er stadig kun for chefen - den er fælles.
--   4. En åben staff-reservation kan betales af firmaet, også for den
--      igangværende uge og mere end 12 uger frem: koeb_start slår firmaets
--      åbne reservation for ugen op, FØR uge-intervallet tjekkes. En
--      reservation for en uge, der er slut, kan ikke betales.
--   5. Rabat pr. firma: chef og sælger-rollen kan tilsidesætte pakkens rabat
--      på Ugens butik for ét firma (procent og antal pr. år) -
--      ugens_butik_firma_rabat + ugens_butik_saet_firma_rabat (logges,
--      'ugens_butik_rabat_firma'). null/null = følg pakken igen. Pakkens tal
--      sættes af chefen med erhverv_pakke_gem (nye parametre
--      p_ugens_butik_rabat_procent / p_ugens_butik_rabat_antal; null = uændret).
--      Standarden er stadig 0 (ingen rabat) - pakkernes tal sættes af den
--      agent, der bygger de nye pakker.
--   6. Rabat-tællingen (ugens_butik_rabat): en betalt booking, som staff
--      annullerer UDEN refusion, giver ikke rabatten tilbage (firmaet har
--      betalt). En udløbet booking med rabat, der betales senere og giver
--      ugen, er 'betalt' og tæller som brugt (også selvom firmaet dermed når
--      over antallet - prisen blev låst, da ugen blev reserveret). Refunderet
--      (eller ved at blive refunderet) giver rabatten tilbage.
--      ÅRET regnes fra ugens MANDAG (dansk kalender): uge 53/1, der starter
--      mandag 28. dec., hører til det år, mandagen ligger i.
--   7. ugens_butik_registrer: en betaling for en uge, der er slut
--      (slut_kl <= now()), eller fra et firma, der ikke er aktivt (pause,
--      suspenderet, lukket), giver ikke ugen: 'for_sent' (med 'grund'), hele
--      beløbet refunderes automatisk, og staff markeres (koden laver også en
--      drift-alarm). Ny parameter p_valuta: alt andet end 'dkk' behandles som
--      et forkert beløb ('beloeb_afviger' - refunderes). Standarden er 'dkk',
--      så kode, der endnu ikke sender valutaen, virker som før under en
--      udrulning (src/lib/betaling/ugensButik.ts sender altid pi.currency).
--      Suspension, pause eller lukning EFTER betalingen: pladsen skjules
--      (forside_ugens_butik), og der refunderes IKKE automatisk (uændret).
--   8. ugens_butik_staff_tjek: rolle, begrundelse, inhabilitet og status
--      tjekkes i databasen, FØR serveren annullerer en PaymentIntent hos
--      Stripe (src/lib/betaling/ugensButik.ts, staffAnnullerUgensButik).
--   9. ugens_butik_staff_book 'manuel' (uden betaling) virker også for et
--      firma, der ikke er aktivt (fx på pause eller midlertidigt
--      suspenderet) - admin skal kunne ændre alt manuelt. Feltet vises først
--      på forsiden, når firmaet er aktivt (forside_ugens_butik, uændret).
--      Lukkede og slettede konti kan stadig ikke bookes.
--
-- (Reviewerens fund 10 - "tilbud til næste byder" på en gammel
-- erhvervsauktion får 'erhverv2' - er til firmaets fordel og er bevidst
-- uændret.)
--
-- md5-drift-tjek (mønstret fra 20261031010000): hver funktion, der
-- erstattes, skal have kroppen fra 20261101020000 ("gammel") eller denne fil
-- ("ny"). Ellers afbrydes migrationen (intet ændres). Idempotent (kan køres
-- igen). Én transaktion: ingen egen begin;/commit; (repoets mønster). Kør
-- først på testdatabasen. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Hjælpere (kun i denne session) og drift-tjek
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

do $do$
declare
  r record;
  h text;
begin
  if to_regclass('public.ugens_butik_bookinger') is null or to_regclass('public.ugens_butik_indstillinger') is null then
    raise exception 'Forudsætning mangler: kør 20261101020000_ugens_butik.sql først';
  end if;
  -- fn, gammel md5 (20261101020000 / 20261010030000), ny md5 (denne fil).
  for r in
    select * from (values
      ('public.ugens_butik_koeb_start(uuid,date)',                 'b2e6ced52d7c8ef9fda7556e16917484', '3b2bb0d40412a4da538d642970e393af'),
      ('public.ugens_butik_staff_annuller(uuid,uuid,text,boolean)', '49eb4fe3e6e1149fee95e77cb4385873', '9ed8d90bd93431386f5d639c1b2b0fac'),
      ('public.ugens_butik_rabat(uuid,date)',                      '870509812aa9d57865c95319a5d91ec4', 'fe4a3367d6baa2f61f011b823cd102de'),
      ('public.firma_ugens_butik()',                               'c8ff72438a0007979c873ca6867bd602', '417979441b96ff457ae1bb3ff7e9c30b'),
      ('public.ugens_butik_admin(uuid)',                           '657752ad00e639dc96682ad5f3e0bc9f', 'afb4edec8b641521d573c71864e07d29'),
      -- Erstattes med en ny signatur (den gamle droppes): findes den gamle,
      -- skal den være repoets; findes den nye, skal den være denne fils.
      ('public.ugens_butik_registrer(text,text,text,bigint,text)',  '4ff3e1b6cadb4050a76ae1e0667983f4', null),
      ('public.ugens_butik_registrer(text,text,text,bigint,text,text)', null, 'a39b26bbc6bc68c74b32b7d9b7a6f70e'),
      ('public.ugens_butik_staff_book(uuid,uuid,date,boolean,text)', '352624735652472c8f29675fa7ff41e3', null),
      ('public.ugens_butik_staff_book(uuid,uuid,date,boolean,text,boolean)', null, '11b1efc7cd2d1d5b24fc41b911400393'),
      ('public.erhverv_pakke_gem(uuid,uuid,text,text,numeric,integer,boolean,integer)', 'c947e5cdd1975ece06a2cefb0b806f59', null),
      ('public.erhverv_pakke_gem(uuid,uuid,text,text,numeric,integer,boolean,integer,integer,integer)', null, '0da934ec3b8f2c3c80d8927d13f26110')
    ) as t(fn, gammel, ny)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      if r.gammel is not null and r.ny is not null then
        raise exception '% findes ikke - kør 20261101020000 først', r.fn;
      end if;
      continue;
    end if;
    if h is distinct from r.gammel and h is distinct from r.ny then
      raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', r.fn, h;
    end if;
  end loop;
  if to_regprocedure('public.erhverv_pakke_gem(uuid,uuid,text,text,numeric,integer,boolean,integer)') is null
     and to_regprocedure('public.erhverv_pakke_gem(uuid,uuid,text,text,numeric,integer,boolean,integer,integer,integer)') is null then
    raise exception 'erhverv_pakke_gem findes ikke - kør 20261010030000 først';
  end if;
end $do$;

-- ===========================================================================
-- 1. Nye kolonner, tabel og moderation_log-handlinger
-- ===========================================================================
-- Staff har omgået loftet (4 uger i træk) ved denne booking (logget).
alter table public.ugens_butik_bookinger add column if not exists loft_omgaaet boolean not null default false;
comment on column public.ugens_butik_bookinger.loft_omgaaet is
  'Staff har booket ugen, selvom firmaet dermed får mere end 4 uger i træk (eller under 2 ugers pause efter 4 i træk). Logget i moderation_log (ugens_butik_loft_omgaaet). 20261101060000.';

-- Rabat på Ugens butik for ét firma (tilsidesætter pakkens). Én række pr.
-- firma; procent og antal null = følg pakken. Ændringer logges i
-- moderation_log ('ugens_butik_rabat_firma') - rækken slettes aldrig.
create table if not exists public.ugens_butik_firma_rabat (
  firma_id      uuid primary key references public.firmaer(id) on delete restrict,
  rabat_procent integer,
  rabat_antal   integer,
  begrundelse   text not null,
  opdateret_af  uuid references public.users(id) on delete set null,
  opdateret_kl  timestamptz not null default now(),
  constraint ugens_butik_firma_rabat_tal check (
    (rabat_procent is null) = (rabat_antal is null)
    and (rabat_procent is null or (rabat_procent between 0 and 90 and rabat_antal between 0 and 52))),
  constraint ugens_butik_firma_rabat_begrundelse check (char_length(begrundelse) between 1 and 1000)
);
comment on table public.ugens_butik_firma_rabat is
  'Ugens butik: rabat for ét firma, der tilsidesætter pakkens (erhverv_pakker.ugens_butik_rabat_procent/_antal). Sættes af chef eller sælger-rollen med ugens_butik_saet_firma_rabat (logges). null/null = følg pakken. 20261101060000.';
alter table public.ugens_butik_firma_rabat enable row level security;
revoke all on public.ugens_butik_firma_rabat from public, anon, authenticated, service_role;
grant select on public.ugens_butik_firma_rabat to service_role;
drop trigger if exists ugens_butik_firma_rabat_forbyd_sletning on public.ugens_butik_firma_rabat;
create trigger ugens_butik_firma_rabat_forbyd_sletning before delete on public.ugens_butik_firma_rabat
  for each row execute function public.ugens_butik_forbyd_sletning();

do $do$
declare
  v_def  text;
  v_vals text[];
  v_nye  text[] := array['ugens_butik_rabat_firma', 'ugens_butik_loft_omgaaet'];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if v_def is null then return; end if;
  if (select bool_and(v_def like '%''' || x || '''%' or v_def like '%,' || x || ',%' or v_def like '%{' || x || ',%'
                      or v_def like '%,' || x || '}%') from unnest(v_nye) x) then return; end if;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m
      union select unnest(v_nye)) s
    where x <> '' order by 1);
  alter table public.moderation_log drop constraint moderation_log_handling_check;
  execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', v_vals);
end $do$;

-- ===========================================================================
-- 2. Loftet: højst 4 uger i træk, 2 ugers pause efter 4 i træk
-- ===========================================================================
-- Holder firmaet ugen? (betalt, manuel, behandles, reserveret og ikke
-- udløbet). p_undtagen: en booking, der ikke skal tælles med.
create or replace function public.ugens_butik_holder(p_firma uuid, p_uge date, p_undtagen uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.ugens_butik_bookinger b
     where b.firma_id = p_firma and b.uge_start = p_uge and b.id is distinct from p_undtagen
       and (b.status in ('behandles', 'betalt', 'manuel') or (b.status = 'reserveret' and b.reserveret_til > now())));
$fn$;

-- Bryder det loftet, hvis firmaet også får p_uge? true = ja (afvis).
-- Reglen gælder mængden af uger (rækkefølgen er ligegyldig): striben med
-- p_uge må højst være 4 uger, og mellem en stribe på 4 og den næste uge
-- (før eller efter) skal der være mindst 2 tomme uger. Kaldes under
-- firmaets lås.
create or replace function public.ugens_butik_loft_brudt(p_firma uuid, p_uge date, p_undtagen uuid default null)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_start date := p_uge;
  v_slut  date := p_uge;
  v_nabo  date;
  v_n     integer;
  v_m     integer;
begin
  if p_firma is null or p_uge is null then return false; end if;
  -- Striben, som p_uge bliver en del af.
  while public.ugens_butik_holder(p_firma, v_start - 7, p_undtagen) loop
    v_start := v_start - 7;
    if (v_slut - v_start) / 7 >= 4 then return true; end if;
  end loop;
  while public.ugens_butik_holder(p_firma, v_slut + 7, p_undtagen) loop
    v_slut := v_slut + 7;
    if (v_slut - v_start) / 7 >= 4 then return true; end if;
  end loop;
  v_n := (v_slut - v_start) / 7 + 1;
  -- Ugen lige før og lige efter striben er fri (striben er hel). Har
  -- firmaet ugen TO uger efter (eller før), er der kun én tom uge imellem:
  -- det må kun ske, hvis hverken striben eller nabostriben er på 4.
  if public.ugens_butik_holder(p_firma, v_slut + 14, p_undtagen) then
    if v_n >= 4 then return true; end if;
    v_nabo := v_slut + 14;
    v_m := 1;
    while v_m < 4 and public.ugens_butik_holder(p_firma, v_nabo + 7, p_undtagen) loop
      v_nabo := v_nabo + 7;
      v_m := v_m + 1;
    end loop;
    if v_m >= 4 then return true; end if;
  end if;
  if public.ugens_butik_holder(p_firma, v_start - 14, p_undtagen) then
    if v_n >= 4 then return true; end if;
    v_nabo := v_start - 14;
    v_m := 1;
    while v_m < 4 and public.ugens_butik_holder(p_firma, v_nabo - 7, p_undtagen) loop
      v_nabo := v_nabo - 7;
      v_m := v_m + 1;
    end loop;
    if v_m >= 4 then return true; end if;
  end if;
  -- (En stribe på højst 3 + 1 tom uge + en stribe på højst 3 er tilladt.)
  return false;
end;
$fn$;

-- Sidste værn: en booking, der BLIVER en uge, der holder pladsen (insert,
-- eller fx udløbet -> betalt), må ikke bryde loftet - medmindre staff har
-- omgået det (loft_omgaaet). Overgange mellem holdende statusser
-- (reserveret -> betalt) tjekkes ikke igen.
create or replace function public.ugens_butik_loft_vagt()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if new.status in ('reserveret', 'behandles', 'betalt', 'manuel')
     and (tg_op = 'INSERT' or old.status not in ('reserveret', 'behandles', 'betalt', 'manuel'))
     and not new.loft_omgaaet then
    perform public.ugens_butik_laas_firma(new.firma_id);
    if public.ugens_butik_loft_brudt(new.firma_id, new.uge_start, new.id) then
      raise exception 'Ugens butik: højst 4 uger i træk pr. firma, og 2 ugers pause efter 4 uger i træk'
        using errcode = 'BHU01';
    end if;
  end if;
  return new;
end;
$fn$;
drop trigger if exists ugens_butik_loft_vagt on public.ugens_butik_bookinger;
create trigger ugens_butik_loft_vagt before insert or update of status on public.ugens_butik_bookinger
  for each row execute function public.ugens_butik_loft_vagt();

-- ===========================================================================
-- 3. Rabat: pr. firma (tilsidesættelse) eller fra pakken; tællingen
-- ===========================================================================
-- Firmaets rabat i ugens kalenderår (ÅRET = året for ugens MANDAG, dansk
-- kalender): satsen og antallet fra ugens_butik_firma_rabat, hvis staff har
-- sat dem, ellers fra pakken; og hvor mange rabat-uger firmaet har brugt.
-- Brugt = bookinger med rabat i status betalt, behandles, reserveret (ikke
-- udløbet) og annulleret efter betaling UDEN refusion (firmaet har betalt).
-- Refunderet/ved at blive refunderet, udløbet eller annulleret uden betaling
-- giver rabatten tilbage. Kaldes under firmaets lås, når der bookes.
create or replace function public.ugens_butik_rabat(p_firma uuid, p_uge date)
returns table (procent integer, antal integer, brugt integer)
language sql stable security definer set search_path = '' as $fn$
  select coalesce(o.rabat_procent, p.ugens_butik_rabat_procent, 0),
         case when o.rabat_procent is not null then o.rabat_antal else coalesce(p.ugens_butik_rabat_antal, 0) end,
         (select count(*)::integer from public.ugens_butik_bookinger b
           where b.firma_id = p_firma and b.rabat_procent > 0
             and extract(year from b.uge_start) = extract(year from p_uge)
             and (b.status in ('behandles', 'betalt')
                  or (b.status = 'reserveret' and b.reserveret_til > now())
                  or (b.status = 'annulleret' and b.betalt_kl is not null)))
    from public.firmaer f
    left join public.erhverv_pakker p on p.id = f.pakke_id
    left join public.ugens_butik_firma_rabat o on o.firma_id = f.id
   where f.id = p_firma;
$fn$;

-- Chef eller sælger-rollen sætter (eller fjerner) firmaets egen rabat på
-- Ugens butik. p_procent og p_antal begge null = følg pakken igen.
-- Begrundelse påkrævet; logges. Åbne reservationer beholder deres pris.
-- {kode: 'ok'} | 'ingen_adgang' | 'ugyldig' | 'begrundelse_mangler' |
-- 'ikke_fundet' | 'inhabil'
create or replace function public.ugens_butik_saet_firma_rabat(
  p_staff uuid, p_firma uuid, p_procent integer, p_antal integer, p_begrundelse text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_grund  text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_bruger uuid;
  v_navn   text;
  g        record;
begin
  if public.ugens_butik_staff_rolle(p_staff) is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_firma is null or (p_procent is null) <> (p_antal is null)
     or (p_procent is not null and (p_procent not between 0 and 90 or p_antal not between 0 and 52)) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  select f.bruger_id, f.firmanavn into v_bruger, v_navn from public.firmaer f where f.id = p_firma;
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_bruger = p_staff then return jsonb_build_object('kode', 'inhabil'); end if;
  perform public.ugens_butik_laas_firma(p_firma);
  select o.rabat_procent, o.rabat_antal into g from public.ugens_butik_firma_rabat o where o.firma_id = p_firma for update;
  insert into public.ugens_butik_firma_rabat (firma_id, rabat_procent, rabat_antal, begrundelse, opdateret_af, opdateret_kl)
  values (p_firma, p_procent, p_antal, left(v_grund, 1000), p_staff, now())
  on conflict (firma_id) do update
     set rabat_procent = excluded.rabat_procent, rabat_antal = excluded.rabat_antal,
         begrundelse = excluded.begrundelse, opdateret_af = excluded.opdateret_af, opdateret_kl = excluded.opdateret_kl;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'ugens_butik_rabat_firma', 'firma', p_firma, v_bruger,
          left(format('Ugens butik-rabat for %s: %s (før: %s). %s', v_navn,
                      case when p_procent is null then 'følger pakken'
                           else format('%s %% de første %s uger pr. kalenderår', p_procent, p_antal) end,
                      case when g.rabat_procent is null then 'pakken'
                           else format('%s %% / %s uger', g.rabat_procent, g.rabat_antal) end,
                      v_grund), 1000));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- ===========================================================================
-- 4. Firmaets køb (igangværende uge, staff-reservation, loftet)
-- ===========================================================================
-- p_bruger SKAL være verificeret af serveren (auth). p_uge: mandagen. Svar:
--   {kode: 'ok', id, uge_start, beloeb_oere, reserveret_til, pi: null,
--    pi_forsoeg: 0, gammel_pi: [...]}                      ny reservation
--   {kode: 'findes', id, uge_start, beloeb_oere, reserveret_til, pi,
--    pi_forsoeg, status}       åben betaling for ugen (også staffs
--                             reservation - uanset hvor langt frem)
--   {kode: 'skift', pi}       firmaets åbne betaling for en ANDEN uge har en
--                             PaymentIntent - serveren annullerer den og prøver igen
--   {kode: 'aaben_reservation', uge_start}   staff har reserveret en anden uge
--                             til firmaet - den skal betales eller annulleres først
--   {kode: 'behandles'}       en betaling er på vej igennem banken
--   {kode: 'loft'}            firmaet ville få mere end 4 uger i træk (eller
--                             under 2 ugers pause efter 4 i træk)
--   {kode: 'optaget' | 'uge_ugyldig' | 'ugyldig' | 'ikke_firma' | 'spaerret'
--          | 'ikke_aktiv' | 'noedstop'}
-- Nye reservationer: fra den IGANGVÆRENDE uge og højst maks_uger_frem frem.
create or replace function public.ugens_butik_koeb_start(p_bruger uuid, p_uge date)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  s        public.ugens_butik_indstillinger%rowtype;
  v_firma  uuid;
  v_kode   text;
  v_nu     date := public.ugens_butik_uge(now());
  k        record;
  v_id     uuid;
  v_til    timestamptz;
  p        record;
  v_gamle  text[];
begin
  if p_bruger is null or p_uge is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  v_kode := public.ugens_butik_firma_spaerret(p_bruger);
  if v_kode is not null then return jsonb_build_object('kode', v_kode); end if;
  if public.nye_betalinger_stoppet() then return jsonb_build_object('kode', 'noedstop'); end if;
  select * into s from public.ugens_butik_indstillinger where id;
  if not found then return jsonb_build_object('kode', 'ugyldig'); end if;
  if extract(isodow from p_uge) <> 1 then return jsonb_build_object('kode', 'uge_ugyldig'); end if;
  select f.id into v_firma from public.firmaer f where f.bruger_id = p_bruger;
  perform public.ugens_butik_laas_firma(v_firma);

  -- Firmaets åbne betaling slås op FØR uge-intervallet: en staff-reservation
  -- kan betales, uanset hvor langt frem den er (og i den igangværende uge).
  select b.id, b.uge_start, b.status, b.kilde, b.beloeb_oere, b.reserveret_til, b.stripe_payment_intent_id,
         b.pi_forsoeg, b.slut_kl
    into k
    from public.ugens_butik_bookinger b
   where b.firma_id = v_firma and b.status in ('reserveret', 'behandles')
   for update;
  if k.id is not null then
    if k.status = 'behandles' then return jsonb_build_object('kode', 'behandles', 'uge_start', k.uge_start); end if;
    if k.uge_start = p_uge and k.reserveret_til > now() then
      -- En uge, der er slut, kan ikke betales (den udløber af sig selv).
      if k.slut_kl <= now() then return jsonb_build_object('kode', 'uge_ugyldig'); end if;
      update public.ugens_butik_bookinger set aktivitet_kl = now() where id = k.id;
      return jsonb_build_object('kode', 'findes', 'id', k.id, 'uge_start', k.uge_start, 'beloeb_oere', k.beloeb_oere,
                                'reserveret_til', k.reserveret_til, 'pi', k.stripe_payment_intent_id,
                                'pi_forsoeg', k.pi_forsoeg, 'status', k.status);
    end if;
    if k.kilde = 'staff' and k.reserveret_til > now() and k.slut_kl > now() then
      return jsonb_build_object('kode', 'aaben_reservation', 'uge_start', k.uge_start);
    end if;
  end if;

  -- En ny reservation: fra den igangværende uge og højst maks_uger_frem frem.
  if p_uge < v_nu or p_uge > v_nu + 7 * s.maks_uger_frem then
    return jsonb_build_object('kode', 'uge_ugyldig');
  end if;
  -- Loftet (firmaets åbne betaling for en anden uge frigives, så den tæller ikke).
  if public.ugens_butik_loft_brudt(v_firma, p_uge, k.id) then
    return jsonb_build_object('kode', 'loft');
  end if;

  if k.id is not null then
    if k.stripe_payment_intent_id is not null then
      -- En anden uge, eller reservationen er udløbet: serveren annullerer
      -- PaymentIntenten hos Stripe FØRST (eller spejler den, hvis den nåede
      -- at blive betalt - så har firmaet ugen) og prøver igen.
      return jsonb_build_object('kode', 'skift', 'pi', k.stripe_payment_intent_id, 'uge_start', k.uge_start);
    end if;
    -- Udløbet eller en ubetalt reservation uden PaymentIntent for en anden
    -- uge: den frigives, og der startes en ny.
    update public.ugens_butik_bookinger
       set status = case when reserveret_til <= now() then 'udloebet' else 'annulleret' end,
           udloebet_kl = case when reserveret_til <= now() then now() end,
           annulleret_kl = case when reserveret_til > now() then now() end,
           annullering_begrundelse = case when reserveret_til > now() then 'Firmaet valgte en anden uge' end,
           tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                            else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
           stripe_payment_intent_id = null
     where id = k.id;
    v_gamle := case when k.stripe_payment_intent_id is not null then array[k.stripe_payment_intent_id] else '{}' end;
  end if;

  perform public.ugens_butik_laas_uge(p_uge);
  v_gamle := coalesce(v_gamle, '{}') || public.ugens_butik_udloeb_uge(p_uge);
  if exists (select 1 from public.ugens_butik_bookinger b
              where b.uge_start = p_uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')) then
    return jsonb_build_object('kode', 'optaget', 'gammel_pi', to_jsonb(v_gamle));
  end if;
  -- Prisen (med rabat, hvis der er rabat-uger tilbage i ugens år) - den
  -- samme, uanset hvornår i ugen der købes.
  select * into p from public.ugens_butik_pris_for(v_firma, p_uge);
  -- Reservationen holder aldrig ud over ugens slutning (mandag kl. 00).
  v_til := least(now() + make_interval(mins => s.reservation_minutter), public.ugens_butik_uge_start_kl(p_uge + 7));
  insert into public.ugens_butik_bookinger (firma_id, bruger_id, uge_start, start_kl, slut_kl, kilde, betaling, status,
                                            reserveret_til, pris_ekskl_moms_oere, moms_oere, beloeb_oere,
                                            rabat_procent, rabat_oere)
  values (v_firma, p_bruger, p_uge, now(), now(), 'firma', 'stripe', 'reserveret',
          v_til, p.ekskl_oere, p.moms_oere, p.inkl_oere, p.rabat_procent, p.rabat_oere)
  returning id into v_id;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'uge_start', p_uge, 'beloeb_oere', p.inkl_oere,
                            'rabat_procent', p.rabat_procent, 'rabat_oere', p.rabat_oere,
                            'reserveret_til', v_til, 'pi', null, 'pi_forsoeg', 0, 'gammel_pi', to_jsonb(v_gamle));
end;
$fn$;

-- ===========================================================================
-- 5. Spejl fra Stripe: uge slut, firma ikke aktivt, valuta, loftet
-- ===========================================================================
-- Spejler PaymentIntentens status (webhooken, returen fra betalingen og
-- cron'en). Idempotent. Svar {kode, id?, grund?}:
--   'betalt'          betalt nu - firmaet har ugen
--   'allerede'        var allerede registreret
--   'beloeb_afviger'  betalt med et andet beløb eller i en anden valuta end
--                     dkk: ugen frigives, refunderes af koden
--   'for_sent'        ugen gives ikke - refunderes helt af koden (med alarm).
--                     grund: 'uge_slut' (ugen er slut), 'ikke_aktiv' (firmaet
--                     er på pause, suspenderet eller lukket), 'optaget' (ugen
--                     er taget), 'loft' (4 uger i træk), 'annulleret' (staff
--                     har annulleret, eller reservationen er udløbet)
--   'kasseret'        en kasseret PaymentIntent er betalt: refunderes af koden
--   'behandles' | 'afventer' | 'nulstillet' | 'uaendret' | 'ukendt'
drop function if exists public.ugens_butik_registrer(text, text, text, bigint, text);
create or replace function public.ugens_butik_registrer(
  p_pi text, p_status text, p_charge text, p_beloeb bigint, p_fejl text, p_valuta text default 'dkk')
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  k       record;
  v_k     uuid;
  v_firma uuid;
  v_uge   date;
  v_grund text;
  v_afv   boolean;
begin
  if p_pi is null then return jsonb_build_object('kode', 'ukendt'); end if;
  -- Låserækkefølge: firmaet, ugen, rækken. Firma og uge slås op uden lås.
  select b.firma_id, b.uge_start into v_firma, v_uge
    from public.ugens_butik_bookinger b where b.stripe_payment_intent_id = p_pi;
  if v_firma is null then
    select b.id into v_k from public.ugens_butik_bookinger b where p_pi = any(b.tidligere_payment_intents) limit 1;
    if v_k is not null then
      -- Den kasserede PaymentIntent er måske udløbet-reservationens: er
      -- bookingen udløbet med netop denne som seneste, og er ugen ledig,
      -- firmaet aktivt og loftet overholdt, får firmaet ugen alligevel.
      select b.firma_id, b.uge_start into v_firma, v_uge from public.ugens_butik_bookinger b where b.id = v_k;
      perform public.ugens_butik_laas_firma(v_firma);
      perform public.ugens_butik_laas_uge(v_uge);
      select b.id, b.status, b.beloeb_oere, b.betalt_kl, b.slut_kl, b.bruger_id, b.loft_omgaaet,
             b.tidligere_payment_intents[array_length(b.tidligere_payment_intents, 1)] as seneste
        into k from public.ugens_butik_bookinger b where b.id = v_k for update;
      if p_status = 'succeeded' and k.status = 'udloebet' and k.seneste = p_pi and k.betalt_kl is null then
        if p_beloeb is distinct from k.beloeb_oere or p_valuta is distinct from 'dkk' then
          update public.ugens_butik_bookinger
             set status = 'refunderes', betalt_kl = now(), stripe_payment_intent_id = p_pi,
                 tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
                 stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
                 refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(), kraever_opmaerksomhed = true,
                 opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
                   'Ugens butik er betalt med et andet beløb (eller en anden valuta) end prisen - ugen er ikke givet, og beløbet refunderes automatisk.'), 4000)
           where id = k.id;
          return jsonb_build_object('kode', 'beloeb_afviger', 'id', k.id);
        end if;
        v_grund := case
          when k.slut_kl <= now() then 'uge_slut'
          when public.ugens_butik_firma_spaerret(k.bruger_id) is not null then 'ikke_aktiv'
          when exists (select 1 from public.ugens_butik_bookinger b
                        where b.uge_start = v_uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')) then 'optaget'
          when not k.loft_omgaaet and public.ugens_butik_loft_brudt(v_firma, v_uge, k.id) then 'loft'
        end;
        if v_grund is null then
          update public.ugens_butik_bookinger
             set status = 'betalt', betalt_kl = now(), stripe_payment_intent_id = p_pi,
                 tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
                 stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
                 udloebet_kl = null, sidste_fejl = null
           where id = k.id;
          return jsonb_build_object('kode', 'betalt', 'id', k.id);
        end if;
        update public.ugens_butik_bookinger
           set status = 'refunderes', betalt_kl = now(), stripe_payment_intent_id = p_pi,
               tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
               stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
               refusion_aarsag = 'for_sent', refusion_anmodet_kl = now(), kraever_opmaerksomhed = true,
               opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
                 format('Ugens butik er betalt efter, at reservationen udløb (%s) - ugen er ikke givet, og hele beløbet refunderes automatisk.', v_grund)), 4000)
         where id = k.id;
        return jsonb_build_object('kode', 'for_sent', 'id', k.id, 'grund', v_grund);
      end if;
      if p_status = 'succeeded' then return jsonb_build_object('kode', 'kasseret', 'id', v_k); end if;
      return jsonb_build_object('kode', 'uaendret', 'id', v_k);
    end if;
    return jsonb_build_object('kode', 'ukendt');
  end if;
  perform public.ugens_butik_laas_firma(v_firma);
  perform public.ugens_butik_laas_uge(v_uge);
  select b.id, b.status, b.beloeb_oere, b.betalt_kl, b.slut_kl, b.bruger_id into k
    from public.ugens_butik_bookinger b where b.stripe_payment_intent_id = p_pi for update;
  if k.id is null then return jsonb_build_object('kode', 'ukendt'); end if;

  if p_status = 'succeeded' then
    if k.betalt_kl is not null then return jsonb_build_object('kode', 'allerede', 'id', k.id); end if;
    v_afv := p_beloeb is distinct from k.beloeb_oere or p_valuta is distinct from 'dkk';
    if v_afv then
      update public.ugens_butik_bookinger
         set status = 'refunderes', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
             modtaget_oere = p_beloeb, sidste_fejl = null, refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(),
             kraever_opmaerksomhed = true,
             opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
               'Ugens butik er betalt med et andet beløb (eller en anden valuta) end prisen - ugen er ikke givet, og beløbet refunderes automatisk.'), 4000)
       where id = k.id;
      return jsonb_build_object('kode', 'beloeb_afviger', 'id', k.id);
    end if;
    v_grund := case
      when k.status not in ('reserveret', 'behandles') then 'annulleret'
      when k.slut_kl <= now() then 'uge_slut'
      when public.ugens_butik_firma_spaerret(k.bruger_id) is not null then 'ikke_aktiv'
    end;
    if v_grund is null then
      update public.ugens_butik_bookinger
         set status = 'betalt', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
             modtaget_oere = p_beloeb, sidste_fejl = null
       where id = k.id;
      return jsonb_build_object('kode', 'betalt', 'id', k.id);
    end if;
    -- Annulleret (staff), udløbet, ugen er slut, eller firmaet er ikke
    -- aktivt længere: pengene sendes tilbage (hele beløbet).
    update public.ugens_butik_bookinger
       set status = 'refunderes', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
           modtaget_oere = p_beloeb, refusion_aarsag = 'for_sent', refusion_anmodet_kl = now(),
           kraever_opmaerksomhed = kraever_opmaerksomhed or v_grund <> 'annulleret',
           opmaerksomhed_tekst = case when v_grund = 'annulleret' then opmaerksomhed_tekst
                                      else left(concat_ws(E'\n', opmaerksomhed_tekst,
                                        case v_grund when 'uge_slut' then 'Ugens butik er betalt, efter at ugen var slut - ugen er ikke givet, og hele beløbet refunderes automatisk.'
                                             else 'Ugens butik er betalt, mens firmaet ikke var aktivt (pause, suspenderet eller lukket) - ugen er ikke givet, og hele beløbet refunderes automatisk.' end), 4000) end
     where id = k.id;
    return jsonb_build_object('kode', 'for_sent', 'id', k.id, 'grund', v_grund);
  elsif p_status = 'processing' then
    update public.ugens_butik_bookinger set status = 'behandles' where id = k.id and status = 'reserveret';
    return jsonb_build_object('kode', case when found then 'behandles' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'requires_payment_method' then
    update public.ugens_butik_bookinger set status = 'reserveret', sidste_fejl = left(p_fejl, 500)
     where id = k.id and status in ('reserveret', 'behandles');
    return jsonb_build_object('kode', case when found then 'afventer' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'canceled' then
    if k.status in ('reserveret', 'behandles') then
      update public.ugens_butik_bookinger
         set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
             stripe_payment_intent_id = null, pi_forsoeg = pi_forsoeg + 1, status = 'reserveret'
       where id = k.id;
      return jsonb_build_object('kode', 'nulstillet', 'id', k.id);
    end if;
  end if;
  return jsonb_build_object('kode', 'uaendret', 'id', k.id);
end;
$fn$;

-- ===========================================================================
-- 6. Staff: book, forhåndstjek, annullér/refundér
-- ===========================================================================
-- Book en uge manuelt (fx efter en aftale). p_med_betaling: true = en
-- reservation, firmaet betaler i Firma oversigt inden for
-- staff_reservation_timer (48 t - dog højst til ugens slutning); false =
-- 'manuel' uden betaling. Fra den igangværende uge og
-- staff_maks_uger_frem frem. 'manuel' virker også for et firma, der ikke er
-- aktivt (pause, midlertidigt suspenderet) - feltet vises først på
-- forsiden, når firmaet er aktivt. Med betaling: kun aktive firmaer.
-- p_omgaa_loft: staff omgår loftet (4 uger i træk) - logges med
-- begrundelse. Begrundelse påkrævet. Svar {kode: 'ok', id, status,
-- loft_omgaaet} | 'ingen_adgang' | 'ugyldig' | 'begrundelse_mangler' |
-- 'ikke_fundet' | 'inhabil' | 'spaerret' | 'ikke_aktiv' | 'uge_ugyldig' |
-- 'optaget' (gammel_pi) | 'aaben_reservation' | 'loft' | 'noedstop'
drop function if exists public.ugens_butik_staff_book(uuid, uuid, date, boolean, text);
create or replace function public.ugens_butik_staff_book(
  p_staff uuid, p_firma uuid, p_uge date, p_med_betaling boolean, p_begrundelse text, p_omgaa_loft boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  s       public.ugens_butik_indstillinger%rowtype;
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_nu    date := public.ugens_butik_uge(now());
  v_bruger uuid;
  v_kode  text;
  v_id    uuid;
  p       record;
  v_gamle text[];
  v_med   boolean := coalesce(p_med_betaling, false);
  v_loft  boolean;
  u       record;
begin
  if public.ugens_butik_staff_rolle(p_staff) is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_firma is null or p_uge is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  select * into s from public.ugens_butik_indstillinger where id;
  if extract(isodow from p_uge) <> 1 or p_uge < v_nu or p_uge > v_nu + 7 * s.staff_maks_uger_frem then
    return jsonb_build_object('kode', 'uge_ugyldig');
  end if;
  select f.bruger_id into v_bruger from public.firmaer f where f.id = p_firma;
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_bruger = p_staff then return jsonb_build_object('kode', 'inhabil'); end if;
  v_kode := public.ugens_butik_firma_spaerret(v_bruger);
  if v_kode = 'ikke_firma' then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_med then
    if v_kode is not null then return jsonb_build_object('kode', v_kode); end if;
    if public.nye_betalinger_stoppet() then return jsonb_build_object('kode', 'noedstop'); end if;
  else
    -- Uden betaling: også et firma på pause eller midlertidigt suspenderet -
    -- men ikke en lukket eller slettet konto.
    select x.konto_lukket_kl, x.konto_slettet_kl into u from public.users x where x.id = v_bruger;
    if u.konto_lukket_kl is not null or u.konto_slettet_kl is not null then
      return jsonb_build_object('kode', 'spaerret');
    end if;
  end if;

  perform public.ugens_butik_laas_firma(p_firma);
  if v_med and exists (select 1 from public.ugens_butik_bookinger b
                        where b.firma_id = p_firma and b.status in ('reserveret', 'behandles')
                          and (b.status = 'behandles' or b.reserveret_til > now())) then
    return jsonb_build_object('kode', 'aaben_reservation');
  end if;
  perform public.ugens_butik_laas_uge(p_uge);
  v_gamle := public.ugens_butik_udloeb_uge(p_uge);
  if exists (select 1 from public.ugens_butik_bookinger b
              where b.uge_start = p_uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')) then
    return jsonb_build_object('kode', 'optaget', 'gammel_pi', to_jsonb(v_gamle));
  end if;
  -- Loftet: staff kan omgå det (logges nedenfor).
  v_loft := public.ugens_butik_loft_brudt(p_firma, p_uge, null);
  if v_loft and not coalesce(p_omgaa_loft, false) then
    return jsonb_build_object('kode', 'loft', 'gammel_pi', to_jsonb(v_gamle));
  end if;
  if v_med then
    -- Firmaets egen udløbne reservation (en anden uge) frigives, så det
    -- unikke indeks (én åben betaling pr. firma) ikke rammer.
    select b.stripe_payment_intent_id into v_kode
      from public.ugens_butik_bookinger b
     where b.firma_id = p_firma and b.status = 'reserveret' and b.reserveret_til <= now()
     for update;
    update public.ugens_butik_bookinger b
       set status = 'udloebet', udloebet_kl = now(),
           tidligere_payment_intents = case when b.stripe_payment_intent_id is null then b.tidligere_payment_intents
                                            else array_append(b.tidligere_payment_intents, b.stripe_payment_intent_id) end,
           stripe_payment_intent_id = null
     where b.firma_id = p_firma and b.status = 'reserveret' and b.reserveret_til <= now();
    if v_kode is not null then v_gamle := v_gamle || v_kode; end if;
    -- Samme pris og rabat, som hvis firmaet selv havde købt ugen.
    select * into p from public.ugens_butik_pris_for(p_firma, p_uge);
    insert into public.ugens_butik_bookinger (firma_id, bruger_id, uge_start, start_kl, slut_kl, kilde, betaling, status,
                                              reserveret_til, pris_ekskl_moms_oere, moms_oere, beloeb_oere,
                                              rabat_procent, rabat_oere, oprettet_af, note, loft_omgaaet)
    values (p_firma, v_bruger, p_uge, now(), now(), 'staff', 'stripe', 'reserveret',
            least(now() + make_interval(hours => s.staff_reservation_timer), public.ugens_butik_uge_start_kl(p_uge + 7)),
            p.ekskl_oere, p.moms_oere, p.inkl_oere, p.rabat_procent, p.rabat_oere, p_staff, left(v_grund, 1000), v_loft)
    returning id into v_id;
  else
    insert into public.ugens_butik_bookinger (firma_id, bruger_id, uge_start, start_kl, slut_kl, kilde, betaling, status,
                                              pris_ekskl_moms_oere, moms_oere, beloeb_oere, oprettet_af, note, loft_omgaaet)
    values (p_firma, v_bruger, p_uge, now(), now(), 'staff', 'ingen', 'manuel', 0, 0, 0, p_staff, left(v_grund, 1000), v_loft)
    returning id into v_id;
  end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'ugens_butik_booket', 'ugens_butik', v_id, v_bruger,
          left(format('Ugens butik uge %s (%s) booket %s%s. %s', to_char(p_uge, 'IYYY-IW'), p_uge,
                      case when v_med then 'med betaling (firmaet betaler i Firma oversigt)' else 'uden betaling' end,
                      case when v_kode is not null and not v_med then format(' (firmaet er ikke aktivt: %s)', v_kode) else '' end,
                      v_grund), 1000));
  if v_loft then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_staff, 'ugens_butik_loft_omgaaet', 'ugens_butik', v_id, v_bruger,
            left(format('Ugens butik uge %s (%s): loftet (højst 4 uger i træk, 2 ugers pause) er omgået. %s',
                        to_char(p_uge, 'IYYY-IW'), p_uge, v_grund), 1000));
  end if;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'status', case when v_med then 'reserveret' else 'manuel' end,
                            'loft_omgaaet', v_loft, 'gammel_pi', to_jsonb(v_gamle));
end;
$fn$;

-- Forhåndstjek, FØR serveren annullerer en PaymentIntent hos Stripe
-- (staffAnnullerUgensButik): rolle, begrundelse, inhabilitet og status -
-- samme regler som ugens_butik_staff_annuller (som tjekker igen under lås).
-- null = ok, ellers koden ('ingen_adgang' | 'begrundelse_mangler' |
-- 'ikke_fundet' | 'inhabil' | 'behandles' | 'forkert_status').
create or replace function public.ugens_butik_staff_tjek(
  p_staff uuid, p_id uuid, p_begrundelse text, p_refunder boolean default false)
returns text language plpgsql stable security definer set search_path = '' as $fn$
declare
  k record;
begin
  if public.ugens_butik_staff_rolle(p_staff) is null then return 'ingen_adgang'; end if;
  if nullif(btrim(coalesce(p_begrundelse, '')), '') is null then return 'begrundelse_mangler'; end if;
  select b.status, b.bruger_id, b.betalt_kl into k from public.ugens_butik_bookinger b where b.id = p_id;
  if not found then return 'ikke_fundet'; end if;
  if k.bruger_id = p_staff then return 'inhabil'; end if;
  if k.status = 'behandles' then return 'behandles'; end if;
  if k.status = 'betalt'
     or (k.status in ('reserveret', 'manuel') and not coalesce(p_refunder, false))
     or (k.status = 'annulleret' and k.betalt_kl is not null and coalesce(p_refunder, false)) then
    return null;
  end if;
  return 'forkert_status';
end;
$fn$;

-- Annullér en booking. Chef og sælger-rollen (Filip, 26. okt. 2026: sælger-
-- rollen kan refundere Ugens butik ligesom chefen): manuelle og ubetalte
-- (reserveret), og betalte - med refusion (p_refunder = true: 'refunderes',
-- serveren refunderer HELE beløbet hos Stripe; cron'en prøver igen) eller
-- uden (pengene beholdes, fx efter aftale med firmaet). Hel eller ingen
-- refusion. Begrundelse påkrævet; logges. Svar {kode: 'ok', status, pi?} |
-- 'ingen_adgang' | 'begrundelse_mangler' | 'ikke_fundet' | 'forkert_status'
-- | 'behandles' | 'inhabil'
-- pi: en åben PaymentIntent, serveren skal annullere hos Stripe.
create or replace function public.ugens_butik_staff_annuller(
  p_staff uuid, p_id uuid, p_begrundelse text, p_refunder boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_rolle text := public.ugens_butik_staff_rolle(p_staff);
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_firma uuid;
  v_uge   date;
  k       record;
  v_ny    text;
begin
  if v_rolle is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  select b.firma_id, b.uge_start into v_firma, v_uge from public.ugens_butik_bookinger b where b.id = p_id;
  if v_firma is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  perform public.ugens_butik_laas_firma(v_firma);
  perform public.ugens_butik_laas_uge(v_uge);
  select b.id, b.status, b.bruger_id, b.stripe_payment_intent_id, b.betalt_kl, b.beloeb_oere into k
    from public.ugens_butik_bookinger b where b.id = p_id for update;
  if k.bruger_id = p_staff then return jsonb_build_object('kode', 'inhabil'); end if;
  if k.status = 'behandles' then return jsonb_build_object('kode', 'behandles'); end if;
  if k.status = 'betalt' then
    v_ny := case when coalesce(p_refunder, false) then 'refunderes' else 'annulleret' end;
    update public.ugens_butik_bookinger
       set status = v_ny, annulleret_kl = now(), annulleret_af = p_staff, annullering_begrundelse = left(v_grund, 1000),
           refusion_aarsag = case when v_ny = 'refunderes' then 'staff' else refusion_aarsag end,
           refusion_anmodet_kl = case when v_ny = 'refunderes' then now() else refusion_anmodet_kl end,
           refusion_naeste_kl = null,
           refusion_af = case when v_ny = 'refunderes' then p_staff else refusion_af end,
           refusion_begrundelse = case when v_ny = 'refunderes' then left(v_grund, 1000) else refusion_begrundelse end
     where id = p_id;
  elsif k.status in ('reserveret', 'manuel') then
    if coalesce(p_refunder, false) then return jsonb_build_object('kode', 'forkert_status'); end if;
    v_ny := 'annulleret';
    update public.ugens_butik_bookinger
       set status = 'annulleret', annulleret_kl = now(), annulleret_af = p_staff, annullering_begrundelse = left(v_grund, 1000),
           tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                            else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
           stripe_payment_intent_id = null
     where id = p_id;
  elsif k.status = 'annulleret' and k.betalt_kl is not null and coalesce(p_refunder, false) then
    -- En annulleret, betalt booking kan senere refunderes (chef eller sælger).
    v_ny := 'refunderes';
    update public.ugens_butik_bookinger
       set status = 'refunderes', refusion_aarsag = 'staff', refusion_anmodet_kl = now(), refusion_naeste_kl = null,
           refusion_af = p_staff, refusion_begrundelse = left(v_grund, 1000)
     where id = p_id;
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, case when v_ny = 'refunderes' then 'ugens_butik_refunderet' else 'ugens_butik_annulleret' end,
          'ugens_butik', p_id, k.bruger_id,
          left(format('Ugens butik uge %s (%s) %s. %s', to_char(v_uge, 'IYYY-IW'), v_uge,
                      case when v_ny = 'refunderes' then format('annulleret og refunderet (%s kr.)', k.beloeb_oere / 100.0)
                           when k.betalt_kl is not null then 'annulleret uden refusion'
                           else 'annulleret' end, v_grund), 1000));
  return jsonb_build_object('kode', 'ok', 'status', v_ny,
                            'pi', case when k.status = 'reserveret' then k.stripe_payment_intent_id end);
end;
$fn$;

-- ===========================================================================
-- 7. Oversigterne: admin og firmaet selv
-- ===========================================================================
-- Admin -> Erhverv -> Ugens butik: prisen, ugerne frem (fra den
-- igangværende), alle bookinger (nyeste uger først, højst 300) og firmaerne
-- med pakkens og firmaets egen rabat. null = ingen adgang (chef og sælger).
create or replace function public.ugens_butik_admin(p_staff uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  s    public.ugens_butik_indstillinger%rowtype;
  v_nu date := public.ugens_butik_uge(now());
begin
  if public.ugens_butik_staff_rolle(p_staff) is null then return null; end if;
  select * into s from public.ugens_butik_indstillinger where id;
  return jsonb_build_object(
    'rolle', public.ugens_butik_staff_rolle(p_staff),
    'pris', jsonb_build_object('ekskl_moms_oere', s.pris_ekskl_moms_oere,
                               'moms_oere', public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere),
                               'inkl_moms_oere', s.pris_ekskl_moms_oere + public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere),
                               'opdateret_kl', s.opdateret_kl),
    'loft', jsonb_build_object('maks_uger_i_traek', 4, 'pause_uger', 2),
    'denne_uge', v_nu,
    'uger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uge_start', g.uge, 'uge_nr', to_char(g.uge, 'IW')::int, 'aar', to_char(g.uge, 'IYYY')::int,
               'igangvaerende', g.uge = v_nu,
               'booking_id', b.id, 'status', b.status, 'firma_id', b.firma_id, 'firmanavn', f.firmanavn)
             order by g.uge)
        from generate_series(v_nu, v_nu + 7 * s.maks_uger_frem, interval '7 days') as g0(d)
        cross join lateral (select g0.d::date as uge) g
        left join public.ugens_butik_bookinger b
          on b.uge_start = g.uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')
        left join public.firmaer f on f.id = b.firma_id), '[]'::jsonb),
    'bookinger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
               'firma_id', b.firma_id, 'firmanavn', f.firmanavn, 'firma_bruger_id', b.bruger_id,
               'kilde', b.kilde, 'betaling', b.betaling, 'status', b.status,
               'reserveret_til', b.reserveret_til, 'beloeb_oere', b.beloeb_oere, 'modtaget_oere', b.modtaget_oere, 'rabat_procent', b.rabat_procent, 'rabat_oere', b.rabat_oere,
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl, 'refusion_aarsag', b.refusion_aarsag,
               'annulleret_kl', b.annulleret_kl, 'annullering_begrundelse', b.annullering_begrundelse,
               'note', b.note, 'oprettet_af_navn', su.navn, 'oprettet_kl', b.oprettet_kl,
               'loft_omgaaet', b.loft_omgaaet,
               'kraever_opmaerksomhed', b.kraever_opmaerksomhed, 'opmaerksomhed_tekst', b.opmaerksomhed_tekst,
               'stripe_payment_intent_id', b.stripe_payment_intent_id)
             order by b.uge_start desc, b.oprettet_kl desc)
        from (select * from public.ugens_butik_bookinger x order by x.uge_start desc, x.oprettet_kl desc limit 300) b
        left join public.firmaer f on f.id = b.firma_id
        left join public.users su on su.id = b.oprettet_af), '[]'::jsonb),
    'firmaer', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'firmanavn', f.firmanavn, 'aktiv', f.abonnement_status = 'aktiv',
                                          'abonnement_status', f.abonnement_status,
                                          'pakke_rabat_procent', coalesce(p.ugens_butik_rabat_procent, 0),
                                          'pakke_rabat_antal', coalesce(p.ugens_butik_rabat_antal, 0),
                                          'egen_rabat', case when o.rabat_procent is null then null
                                                             else jsonb_build_object('procent', o.rabat_procent, 'antal', o.rabat_antal,
                                                                                     'begrundelse', o.begrundelse, 'opdateret_kl', o.opdateret_kl,
                                                                                     'opdateret_af_navn', ou.navn) end)
             order by f.firmanavn)
        from public.firmaer f
        join public.users u on u.id = f.bruger_id
        left join public.erhverv_pakker p on p.id = f.pakke_id
        left join public.ugens_butik_firma_rabat o on o.firma_id = f.id
        left join public.users ou on ou.id = o.opdateret_af
       where u.konto_lukket_kl is null and u.konto_slettet_kl is null), '[]'::jsonb));
end;
$fn$;

-- Firma oversigt (også appen). null = ikke en firmakonto. Uger: fra den
-- IGANGVÆRENDE uge og maks_uger_frem uger frem med status 'ledig' |
-- 'optaget' (et andet firma - hvilket vises ikke) | 'din' (betalt/booket) |
-- 'din_reservation' (åben betaling) | 'loft' (ledig, men firmaet ville få
-- mere end 4 uger i træk eller under 2 ugers pause efter 4 i træk). En
-- anden reservation, der er udløbet, vises som ledig. Rabatten tælles for
-- den igangværende uges år (året for ugens mandag).
create or replace function public.firma_ugens_butik()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid;
  s       public.ugens_butik_indstillinger%rowtype;
  v_nu    date := public.ugens_butik_uge(now());
  v_moms  bigint;
  v_aaben uuid;
begin
  if v_uid is null then return null; end if;
  select f.id into v_firma from public.firmaer f join public.users u on u.id = f.bruger_id
   where f.bruger_id = v_uid and u.konto_type = 'erhverv';
  if v_firma is null then return null; end if;
  select * into s from public.ugens_butik_indstillinger where id;
  v_moms := public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere);
  select b.id into v_aaben from public.ugens_butik_bookinger b
   where b.firma_id = v_firma and b.status in ('reserveret', 'behandles') limit 1;
  return jsonb_build_object(
    'pris', jsonb_build_object('ekskl_moms_oere', s.pris_ekskl_moms_oere, 'moms_oere', v_moms,
                               'inkl_moms_oere', s.pris_ekskl_moms_oere + v_moms),
    'reservation_minutter', s.reservation_minutter,
    'loft', jsonb_build_object('maks_uger_i_traek', 4, 'pause_uger', 2),
    -- Rabatten (firmaets egen eller pakkens) og hvor mange rabat-uger, der
    -- er brugt i år (året for den igangværende uges mandag).
    'rabat', (select jsonb_build_object('procent', r.procent, 'antal_pr_aar', r.antal, 'brugt_i_aar', r.brugt,
                                        'tilbage_i_aar', greatest(r.antal - r.brugt, 0))
                from public.ugens_butik_rabat(v_firma, v_nu) r),
    'kan_koebe', public.ugens_butik_firma_spaerret(v_uid) is null,
    'grund', public.ugens_butik_firma_spaerret(v_uid),
    'denne_uge', v_nu,
    'uger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uge_start', g.uge, 'uge_nr', to_char(g.uge, 'IW')::int, 'aar', to_char(g.uge, 'IYYY')::int,
               'start_kl', public.ugens_butik_uge_start_kl(g.uge),
               'slut_kl', public.ugens_butik_uge_start_kl(g.uge + 7),
               'igangvaerende', g.uge = v_nu,
               'status', case when b.id is null then
                                (case when public.ugens_butik_loft_brudt(v_firma, g.uge, v_aaben) then 'loft' else 'ledig' end)
                              when b.firma_id = v_firma and b.status in ('reserveret', 'behandles') then 'din_reservation'
                              when b.firma_id = v_firma then 'din'
                              else 'optaget' end,
               -- Prisen for netop denne uge (rabat efter ugens kalenderår).
               'pris_inkl_moms_oere', pf.inkl_oere, 'pris_ekskl_moms_oere', pf.ekskl_oere,
               'rabat_procent', pf.rabat_procent)
             order by g.uge)
        from generate_series(v_nu, v_nu + 7 * s.maks_uger_frem, interval '7 days') as g0(d)
        cross join lateral (select g0.d::date as uge) g
        cross join lateral public.ugens_butik_pris_for(v_firma, g.uge) pf
        left join public.ugens_butik_bookinger b
          on b.uge_start = g.uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')
         and not (b.status = 'reserveret' and b.reserveret_til <= now())), '[]'::jsonb),
    'aaben', (
      select jsonb_build_object('id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
                                'status', b.status, 'kilde', b.kilde, 'reserveret_til', b.reserveret_til,
                                'beloeb_oere', b.beloeb_oere, 'rabat_procent', b.rabat_procent)
        from public.ugens_butik_bookinger b
       where b.firma_id = v_firma and b.status in ('reserveret', 'behandles')
         and (b.status = 'behandles' or (b.reserveret_til > now() and b.slut_kl > now()))),
    'bookinger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
               'aar', to_char(b.uge_start, 'IYYY')::int, 'start_kl', b.start_kl, 'slut_kl', b.slut_kl,
               'status', b.status, 'kilde', b.kilde, 'beloeb_oere', b.beloeb_oere,
               'rabat_procent', b.rabat_procent, 'rabat_oere', b.rabat_oere,
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl,
               'aktiv_nu', b.status in ('betalt', 'manuel') and b.start_kl <= now() and b.slut_kl > now())
             order by b.uge_start desc, b.oprettet_kl desc)
        from (select * from public.ugens_butik_bookinger x
               where x.firma_id = v_firma and x.status in ('betalt', 'manuel', 'refunderes', 'refunderet', 'annulleret')
                 and (x.status <> 'annulleret' or x.betalt_kl is not null or x.kilde = 'staff')
               order by x.uge_start desc limit 100) b), '[]'::jsonb));
end;
$fn$;

-- ===========================================================================
-- 8. erhverv_pakke_gem: chefen sætter også pakkens rabat på Ugens butik
-- ===========================================================================
-- Kun chef. p_id null = ny pakke. p_ugens_butik_rabat_procent/_antal: begge
-- null = uændret (ny pakke: 0 = ingen rabat); ellers begge sat (0-90 % og
-- 0-52 uger pr. kalenderår). Gælder nye bookinger - åbne reservationer
-- beholder deres pris. Logges.
drop function if exists public.erhverv_pakke_gem(uuid, uuid, text, text, numeric, integer, boolean, integer);
create or replace function public.erhverv_pakke_gem(
  p_staff uuid, p_id uuid, p_navn text, p_beskrivelse text, p_maanedspris numeric,
  p_auktioner_pr_uge integer, p_aktiv boolean default true, p_sortering integer default 0,
  p_ugens_butik_rabat_procent integer default null, p_ugens_butik_rabat_antal integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_navn text := btrim(coalesce(p_navn, ''));
  v_id   uuid;
  v_pct  integer;
  v_ant  integer;
begin
  if not public.erhverv_har_adgang(p_staff, true) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if char_length(v_navn) < 1 or char_length(v_navn) > 60 then
    return jsonb_build_object('kode', 'ugyldigt_navn');
  end if;
  if p_beskrivelse is not null and char_length(p_beskrivelse) > 1000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if p_maanedspris is not null and (p_maanedspris < 0 or p_maanedspris > 1000000 or p_maanedspris <> trunc(p_maanedspris)) then
    return jsonb_build_object('kode', 'ugyldig_pris');
  end if;
  if p_auktioner_pr_uge is null or p_auktioner_pr_uge < 1 or p_auktioner_pr_uge > 1000 then
    return jsonb_build_object('kode', 'ugyldigt_antal');
  end if;
  if (p_ugens_butik_rabat_procent is null) <> (p_ugens_butik_rabat_antal is null)
     or (p_ugens_butik_rabat_procent is not null
         and (p_ugens_butik_rabat_procent not between 0 and 90 or p_ugens_butik_rabat_antal not between 0 and 52)) then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  if exists (select 1 from public.erhverv_pakker where lower(navn) = lower(v_navn) and id is distinct from p_id) then
    return jsonb_build_object('kode', 'navn_findes');
  end if;

  if p_id is null then
    insert into public.erhverv_pakker (navn, beskrivelse, maanedspris, auktioner_pr_uge, aktiv, sortering,
                                       oprettet_af, opdateret_af, ugens_butik_rabat_procent, ugens_butik_rabat_antal)
    values (v_navn, nullif(btrim(coalesce(p_beskrivelse, '')), ''), p_maanedspris, p_auktioner_pr_uge,
            coalesce(p_aktiv, true), coalesce(p_sortering, 0), p_staff, p_staff,
            coalesce(p_ugens_butik_rabat_procent, 0), coalesce(p_ugens_butik_rabat_antal, 0))
    returning id, ugens_butik_rabat_procent, ugens_butik_rabat_antal into v_id, v_pct, v_ant;
  else
    update public.erhverv_pakker
       set navn = v_navn, beskrivelse = nullif(btrim(coalesce(p_beskrivelse, '')), ''),
           maanedspris = p_maanedspris, auktioner_pr_uge = p_auktioner_pr_uge,
           aktiv = coalesce(p_aktiv, aktiv), sortering = coalesce(p_sortering, sortering),
           ugens_butik_rabat_procent = coalesce(p_ugens_butik_rabat_procent, ugens_butik_rabat_procent),
           ugens_butik_rabat_antal = coalesce(p_ugens_butik_rabat_antal, ugens_butik_rabat_antal),
           opdateret_af = p_staff, opdateret_kl = now()
     where id = p_id
    returning id, ugens_butik_rabat_procent, ugens_butik_rabat_antal into v_id, v_pct, v_ant;
    if v_id is null then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_pakke_gemt', 'erhverv_pakke', v_id, null,
          left(format('%s: %s auktioner/uge, %s kr./md., %s, Ugens butik-rabat %s',
                      v_navn, p_auktioner_pr_uge, coalesce(p_maanedspris::text, 'pris ikke sat'),
                      case when coalesce(p_aktiv, true) then 'aktiv' else 'ikke aktiv' end,
                      case when v_pct > 0 and v_ant > 0 then format('%s %% de første %s uger pr. kalenderår', v_pct, v_ant)
                           else 'ingen' end), 1000));

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end $$;

-- ===========================================================================
-- 9. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.ugens_butik_holder(uuid, date, uuid)',
    'public.ugens_butik_loft_brudt(uuid, date, uuid)',
    'public.ugens_butik_rabat(uuid, date)',
    'public.ugens_butik_saet_firma_rabat(uuid, uuid, integer, integer, text)',
    'public.ugens_butik_koeb_start(uuid, date)',
    'public.ugens_butik_registrer(text, text, text, bigint, text, text)',
    'public.ugens_butik_staff_book(uuid, uuid, date, boolean, text, boolean)',
    'public.ugens_butik_staff_tjek(uuid, uuid, text, boolean)',
    'public.ugens_butik_staff_annuller(uuid, uuid, text, boolean)',
    'public.ugens_butik_admin(uuid)',
    'public.firma_ugens_butik()',
    'public.erhverv_pakke_gem(uuid, uuid, text, text, numeric, integer, boolean, integer, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
-- Interne byggesten: heller ikke service role.
revoke all on function public.ugens_butik_holder(uuid, date, uuid) from service_role;
revoke all on function public.ugens_butik_loft_vagt() from public, anon, authenticated, service_role;
-- Firmaet selv (auth.uid()).
grant execute on function public.firma_ugens_butik() to authenticated;
