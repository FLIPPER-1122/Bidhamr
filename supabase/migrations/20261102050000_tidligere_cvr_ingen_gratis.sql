-- Firmapakker: to nye forretningsregler (Filip, 27. okt. 2026).
--
-- Bygger på 20261102020000_firmapakker_rettelser.sql (rettes ikke - den er
-- kørt på testdatabasen). 20261102030000/20261102040000 rører ikke de
-- funktioner, der erstattes her.
--
-- Indhold:
--   1. Et firma, hvis CVR har haft et abonnement før, får IKKE den gratis
--      velkomstmåned - medmindre staff udtrykkeligt giver den som en
--      særaftale. erhverv_firma_opret får to nye parametre:
--        p_saeraftale_gratis boolean default false
--        p_saeraftale_begrundelse text default null
--      - CVR'et har haft et abonnement før (erhverv_cvr_tidligere_json) og
--        ingen særaftale: firmaet oprettes med proeve_maaneder = 0. Så giver
--        erhverv_faar_velkomst_gratis false (den kræver proeve_maaneder > 0 -
--        uændret, ÉN definition), og Checkout (startBetaling) trækker første
--        betaling med det samme.
--      - Særaftale (p_saeraftale_gratis = true): begrundelsen er påkrævet og
--        skal være 5-500 tegn ('saeraftale_begrundelse'). Firmaet får 1 gratis
--        måned, og særaftalen logges i moderation_log med staffs navn og
--        begrundelsen.
--      - Nyt CVR: uændret (1 gratis måned). En særaftale på et nyt CVR
--        ændrer intet (firmaet får den gratis måned alligevel) og logges ikke
--        som særaftale.
--      - Kald uden de nye parametre virker som før for nye CVR'er.
--      Staff kan stadig give gratis måneder bagefter med hurtighandlingen
--      "gratis periode" (erhverv_firma_gratis_gem - uændret: månederne lægges
--      i proeve_ekstra_ventende og bruges, når firmaet starter Checkout).
--   2. Særpris og introrabat kan ikke kombineres - et firma har enten en
--      særpris eller rabat på normalprisen, aldrig begge.
--      - erhverv_firma_saerpris_gem afviser at SÆTTE en særpris med
--        'intro_aktiv', når firmaet har en introrabat, der er planlagt eller
--        kører (intro_procent sat og intro_til tom eller i fremtiden -
--        intro_status alene kan ikke bruges, den står 'aktiv', til Stripe har
--        meldt den færdig).
--      - erhverv_firma_intro_gem afviser at SÆTTE en introrabat med
--        'saerpris_aktiv', når firmaet har en særpris på sin nuværende pakke
--        (saerpris_oere sat og saerpris_pakke_id = pakke_id - en særpris på en
--        anden pakke er bortfaldet ved pakkeskift).
--      - At FJERNE den ene eller den anden er altid tilladt (også for et
--        firma, der har begge fra før reglen - de rettes ikke automatisk).
--      - erhverv_firma_opret kan ikke sætte en særpris (kun introrabat), så
--        der er intet at tjekke ved oprettelse.
--      - Pakkeskift: når særprisen bortfalder, sker der intet med introrabatten.
--      Serveren tjekker det samme, før Stripe kaldes
--      (src/app/actions/adminErhvervAbonnement.ts og saetSaerprisStripe i
--      src/lib/erhverv/betaling.ts; reglen i src/lib/erhverv/abonnementRegler.ts).
--
-- md5-drift-tjek (mønstret fra 20261102040000): hver funktion, der erstattes,
-- skal enten være repoets fra 20261102020000 eller allerede denne
-- migrations. Ellers afbrydes migrationen (intet ændres). Idempotent (kan
-- køres igen). Én transaktion. Kør først på testdatabasen. KØRES IKKE i
-- produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Hjælper og drift-tjek
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
  v_opret_ny  constant text := 'public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean,boolean,text)';
  v_opret_gl  constant text := 'public.erhverv_firma_opret(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid,integer,integer,boolean)';
begin
  if to_regclass('public.erhverv_staff_klik') is null
     or to_regprocedure('public.erhverv_cvr_tidligere_json(text)') is null
     or to_regprocedure('public.erhverv_faar_velkomst_gratis(uuid)') is null then
    raise exception 'Forudsætning mangler: kør 20261102020000-20261102040000 først';
  end if;

  -- erhverv_firma_opret skifter signatur: findes den nye, skal den være
  -- denne migrations; ellers skal den gamle være repoets.
  if to_regprocedure(v_opret_ny) is not null then
    h := pg_temp.krop_md5(v_opret_ny);
    if h <> '46cbc2c677a240e8368ef8736a523009' then
      raise exception '%: md5 % passer ikke med denne migration - kontrollér funktionen, før migrationen køres', v_opret_ny, h;
    end if;
  else
    h := pg_temp.krop_md5(v_opret_gl);
    if h is null then
      raise exception '% findes ikke - kør de tidligere migrationer først', v_opret_gl;
    end if;
    if h <> '2ad34500e2b6a8d886da3f56fddb3f64' then
      raise exception '%: md5 % passer ikke med repoet (2ad34500e2b6a8d886da3f56fddb3f64) - kontrollér funktionen, før migrationen køres', v_opret_gl, h;
    end if;
  end if;

  for r in
    select * from (values
      -- (funktion, repoets fra 20261102020000, denne migrations)
      ('public.erhverv_firma_intro_gem(uuid,uuid,integer,integer,text,text,uuid)', 'adc4333359ba19604aff25166e2d910a', 'f36100c2a4efe4b2bceccc48e8afa897'),
      ('public.erhverv_firma_saerpris_gem(uuid,uuid,bigint,uuid,text,text,uuid)', '5e0eff9397a5d5cebd6dc6542ca2edf7', 'c9735a579ffb009126f0a2aef05fa061')
    ) as t(fn, gammel, ny)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      raise exception '% findes ikke - kør de tidligere migrationer først', r.fn;
    end if;
    if h <> r.gammel and h <> r.ny then
      raise exception '%: md5 % passer hverken med repoet (%) eller denne migration (%) - kontrollér funktionen, før migrationen køres',
        r.fn, h, r.gammel, r.ny;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 1. Regler: kører en introrabat / har firmaet en særpris?
-- ===========================================================================
-- Samme regel som introGaelder/saerprisGaelder i
-- src/lib/erhverv/abonnementRegler.ts.
create or replace function public.erhverv_intro_gaelder(f public.firmaer)
returns boolean language sql stable set search_path = '' as $$
  select f.intro_procent is not null and (f.intro_til is null or f.intro_til > now());
$$;
revoke all on function public.erhverv_intro_gaelder(public.firmaer) from public, anon, authenticated, service_role;
comment on function public.erhverv_intro_gaelder(public.firmaer) is
  'Har firmaet en introrabat, der er planlagt eller kører (intro_til tom eller i fremtiden)? Særpris og introrabat kan ikke kombineres (Filip, 27. okt. 2026). 20261102050000.';

create or replace function public.erhverv_saerpris_gaelder(f public.firmaer)
returns boolean language sql stable set search_path = '' as $$
  select f.saerpris_oere is not null and f.saerpris_pakke_id is not distinct from f.pakke_id;
$$;
revoke all on function public.erhverv_saerpris_gaelder(public.firmaer) from public, anon, authenticated, service_role;
comment on function public.erhverv_saerpris_gaelder(public.firmaer) is
  'Har firmaet en særpris på sin nuværende pakke? (En særpris på en anden pakke er bortfaldet ved pakkeskift.) 20261102050000.';

-- ===========================================================================
-- 2. Introrabat: afvises, når firmaet har en særpris
-- ===========================================================================
create or replace function public.erhverv_firma_intro_gem(p_staff uuid, p_firma uuid, p_procent integer,
                                                          p_maaneder integer, p_fra text, p_begrundelse text,
                                                          p_klik uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
  v_noegle uuid := gen_random_uuid();
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if not public.erhverv_begrundelse_ok(p_begrundelse) then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if p_procent is not null and (p_procent not between 1 and 100 or p_maaneder is null or p_maaneder not between 1 and 24
                                or coalesce(p_fra, '') not in ('efter_gratis', 'straks')) then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  -- Særpris og introrabat kan ikke kombineres (fjerne er altid tilladt).
  if p_procent is not null and public.erhverv_saerpris_gaelder(f) then
    return jsonb_build_object('kode', 'saerpris_aktiv');
  end if;
  if not public.erhverv_staff_klik_tag(p_klik, 'firma_introrabat', f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert');
  end if;
  if p_procent is null then
    update public.firmaer
       set intro_procent = null, intro_maaneder = null, intro_fra = null, intro_status = null,
           intro_coupon_id = null, intro_til = null, intro_noegle = v_noegle, opdateret_kl = now()
     where id = f.id;
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_introrabat', 'Introrabat fjernet: ' || btrim(p_begrundelse));
  else
    update public.firmaer
       set intro_procent = p_procent, intro_maaneder = p_maaneder, intro_fra = p_fra, intro_status = 'planlagt',
           intro_coupon_id = null, intro_til = null, intro_noegle = v_noegle, opdateret_kl = now()
     where id = f.id;
    perform public.erhverv_firma_log(p_staff, f.id, 'firma_introrabat',
      format('Introrabat %s %% i %s måned%s %s: %s', p_procent, p_maaneder, case when p_maaneder = 1 then '' else 'er' end,
             case when p_fra = 'straks' then 'fra nu' else 'efter den gratis periode' end, btrim(p_begrundelse)));
  end if;
  return jsonb_build_object('kode', 'ok', 'noegle', v_noegle);
end $$;
revoke all on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_intro_gem(uuid, uuid, integer, integer, text, text, uuid) to service_role;

-- ===========================================================================
-- 3. Særpris: afvises, når firmaet har en introrabat
-- ===========================================================================
create or replace function public.erhverv_firma_saerpris_gem(p_staff uuid, p_firma uuid, p_oere bigint,
                                                             p_pakke uuid, p_aftale text, p_fra text,
                                                             p_klik uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.firmaer;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if not public.erhverv_begrundelse_ok(p_aftale) then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if p_oere is not null and (p_oere < 100 or p_oere > 100000000 or p_oere % 100 <> 0) then
    return jsonb_build_object('kode', 'ugyldig_pris');
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_oere is not null and p_pakke is distinct from f.pakke_id then
    return jsonb_build_object('kode', 'pakke_skiftet');
  end if;
  -- Særpris og introrabat kan ikke kombineres (fjerne er altid tilladt).
  if p_oere is not null and public.erhverv_intro_gaelder(f) then
    return jsonb_build_object('kode', 'intro_aktiv');
  end if;
  if not public.erhverv_staff_klik_tag(p_klik, 'firma_saerpris', f.id, p_staff) then
    return jsonb_build_object('kode', 'allerede_udfoert');
  end if;
  update public.firmaer
     set saerpris_oere = p_oere,
         saerpris_pakke_id = case when p_oere is null then null else p_pakke end,
         saerpris_aftale = case when p_oere is null then null else btrim(p_aftale) end,
         opdateret_kl = now()
   where id = f.id;
  perform public.erhverv_firma_log(p_staff, f.id, 'firma_saerpris',
    case when p_oere is null then 'Særpris fjernet (pakkens pris gælder): ' || btrim(p_aftale)
         else format('Særpris %s kr./md. ekskl. moms på %s (%s): %s', p_oere / 100,
                     (select navn from public.erhverv_pakker where id = p_pakke),
                     case when p_fra = 'straks' then 'fra nu - forskellen afregnes på næste regning' else 'fra næste betaling' end,
                     btrim(p_aftale)) end);
  return jsonb_build_object('kode', 'ok');
end $$;
revoke all on function public.erhverv_firma_saerpris_gem(uuid, uuid, bigint, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_saerpris_gem(uuid, uuid, bigint, uuid, text, text, uuid) to service_role;

-- ===========================================================================
-- 4. Oprettelse: ingen gratis måned til et tidligere CVR (undtagen særaftale)
-- ===========================================================================
-- p_cvr_bekraeftet: som 20261102020000 (null = som før, false = afvis med
-- 'cvr_tidligere_abonnement', true = staff har bekræftet).
-- p_saeraftale_gratis/p_saeraftale_begrundelse: se toppen.
-- Svar: {kode: 'ok', firma_id, cvr_tidligere_abonnement, gratis_maaneder,
-- saeraftale} | {kode: 'saeraftale_begrundelse' | ... (som før)}.
drop function if exists public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean);
create or replace function public.erhverv_firma_opret(
  p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text, p_by text,
  p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid, p_henvendelse uuid default null,
  p_intro_procent integer default null, p_intro_maaneder integer default null,
  p_cvr_bekraeftet boolean default null,
  p_saeraftale_gratis boolean default false, p_saeraftale_begrundelse text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  u    record;
  h    public.erhverv_henvendelser;
  v_id uuid;
  v_tidligere jsonb;
  v_har_tidligere boolean;
  v_saeraftale boolean := coalesce(p_saeraftale_gratis, false);
  v_saeraftale_brugt boolean;
  v_gratis integer;
  v_staff_navn text;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if v_saeraftale and char_length(btrim(coalesce(p_saeraftale_begrundelse, ''))) not between 5 and 500 then
    return jsonb_build_object('kode', 'saeraftale_begrundelse');
  end if;

  select * into u from public.users where id = p_bruger for update;
  if u.id is null then
    return jsonb_build_object('kode', 'bruger_findes_ikke');
  end if;
  if u.konto_type <> 'privat' or u.rolle <> 'bruger'
     or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or u.oprettet < now() - interval '1 hour'
     or exists (select 1 from public.auctions a where a.bruger_id = p_bruger)
     or exists (select 1 from public.bids b where b.bruger_id = p_bruger)
     or exists (select 1 from public.trades t where t.buyer_id = p_bruger or t.seller_id = p_bruger)
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;
  if not exists (select 1 from auth.users au
                  where au.id = p_bruger
                    and au.invited_at is not null
                    and au.last_sign_in_at is null
                    and coalesce(au.encrypted_password, '') = ''
                    and au.created_at > now() - interval '1 hour') then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;

  if p_cvr is null or p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;
  if exists (select 1 from public.firmaer f where f.cvr = p_cvr and f.abonnement_status <> 'opsagt') then
    return jsonb_build_object('kode', 'cvr_findes');
  end if;
  v_tidligere := public.erhverv_cvr_tidligere_json(p_cvr);
  v_har_tidligere := jsonb_array_length(v_tidligere) > 0;
  if v_har_tidligere and p_cvr_bekraeftet is false then
    return jsonb_build_object('kode', 'cvr_tidligere_abonnement', 'firmaer', v_tidligere);
  end if;
  if not exists (select 1 from public.erhverv_pakker p where p.id = p_pakke and p.arkiveret_kl is null) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if (p_intro_procent is null) <> (p_intro_maaneder is null)
     or (p_intro_procent is not null and (p_intro_procent not between 1 and 100 or p_intro_maaneder not between 1 and 24)) then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  if p_henvendelse is not null then
    select * into h from public.erhverv_henvendelser where id = p_henvendelse for update;
    if h.id is null then
      return jsonb_build_object('kode', 'henvendelse_findes_ikke');
    end if;
    if exists (select 1 from public.firmaer f where f.henvendelse_id = p_henvendelse) then
      return jsonb_build_object('kode', 'henvendelse_brugt');
    end if;
  end if;

  -- Gratis velkomstmåned: nye CVR'er altid; et CVR, der har haft et
  -- abonnement før, kun med en særaftale (Filip, 27. okt. 2026).
  v_saeraftale_brugt := v_har_tidligere and v_saeraftale;
  v_gratis := case when not v_har_tidligere or v_saeraftale_brugt then 1 else 0 end;

  begin
    insert into public.firmaer (bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon,
                                kontakt_email, kontaktperson, henvendelse_id, pakke_id, oprettet_af,
                                proeve_maaneder, intro_procent, intro_maaneder, intro_fra, intro_status, intro_noegle)
    values (p_bruger, btrim(p_firmanavn), p_cvr, btrim(p_adresse), btrim(p_postnummer), btrim(p_by),
            btrim(p_telefon), lower(btrim(p_kontakt_email)), btrim(p_kontaktperson), p_henvendelse,
            p_pakke, p_staff, v_gratis, p_intro_procent, p_intro_maaneder,
            case when p_intro_procent is not null then 'efter_gratis' end,
            case when p_intro_procent is not null then 'planlagt' end,
            case when p_intro_procent is not null then gen_random_uuid() end)
    returning id into v_id;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  update public.users
     set konto_type = 'erhverv',
         navn = left(btrim(p_firmanavn), 200),
         fornavn = null,
         efternavn = null,
         telefon = btrim(p_telefon)
   where id = p_bruger;

  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl)
  values (v_id, null, p_pakke, 'start', 'gennemfoert', p_staff, now());

  if p_henvendelse is not null then
    update public.erhverv_henvendelser
       set status = 'godkendt', behandlet_af = p_staff, behandlet_kl = now(), opdateret_kl = now()
     where id = p_henvendelse;
  end if;

  select coalesce(nullif(btrim(navn), ''), 'staff') into v_staff_navn from public.users where id = p_staff;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_oprettet', 'firma', v_id, p_bruger,
          left(btrim(p_firmanavn) || ' (CVR ' || p_cvr || '), pakke '
               || (select navn from public.erhverv_pakker where id = p_pakke)
               || case when v_gratis > 0 then ', 1 gratis måned' else ', ingen gratis måned' end
               || case when p_intro_procent is not null
                       then case when v_gratis > 0
                                 then format(', introrabat %s %% i %s måneder efter den gratis måned', p_intro_procent, p_intro_maaneder)
                                 else format(', introrabat %s %% i %s måneder fra første betaling', p_intro_procent, p_intro_maaneder) end
                       else '' end
               || case when v_har_tidligere
                       then case when p_cvr_bekraeftet then '; CVR''et har haft et abonnement før - bekræftet af staff'
                                 else '; CVR''et har haft et abonnement før' end
                       else '' end
               || case when v_saeraftale_brugt
                       then '; 1 gratis måned som særaftale givet af ' || v_staff_navn || ': '
                            || btrim(p_saeraftale_begrundelse)
                       else '' end, 1000));

  return jsonb_build_object('kode', 'ok', 'firma_id', v_id,
                            'cvr_tidligere_abonnement', v_har_tidligere,
                            'gratis_maaneder', v_gratis,
                            'saeraftale', v_saeraftale_brugt);
end $function$;
revoke all on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text) to service_role;
comment on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid, integer, integer, boolean, boolean, text) is
  'Opretter en firmakonto (chef og sælger-rollen). Et CVR, der har haft et abonnement før, får ingen gratis måned (proeve_maaneder = 0) - kun som særaftale (p_saeraftale_gratis + begrundelse 5-500 tegn, logges med staffs navn). 20261102050000.';

comment on function public.erhverv_faar_velkomst_gratis(uuid) is
  'Får firmaet velkomstperioden i Checkout? Kun når proeve_maaneder > 0, aldrig haft en gratis periode og aldrig betalt. Et firma oprettet med et CVR, der har haft et abonnement før, har proeve_maaneder = 0 (medmindre staff gav en særaftale) - 20261102050000.';

comment on column public.firmaer.proeve_maaneder is
  'Gratis måneder i velkomstperioden: 1 for nye CVR''er, 0 for et CVR, der har haft et abonnement før (medmindre staff gav 1 som særaftale - 20261102050000). Staff kan give flere, før firmaet har startet. Bruges som trial_end i Stripe Checkout, hvis erhverv_faar_velkomst_gratis. Staff-givne måneder til et firma, der ikke får velkomstperioden: proeve_ekstra_ventende.';
