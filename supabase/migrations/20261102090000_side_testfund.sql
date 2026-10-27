-- =============================================================================
-- Testfund fra gennemgangen af konto, offentlige sider og admin (27. okt. 2026).
--
-- 1. DSA: en ny kategori bliver ikke længere slugt.
--    dsa_anmeldelse_opret: anmelder en indlogget bruger det samme indhold
--    igen, mens den første sag er åben ('ny'), returnerede funktionen bare
--    'findes' - den nye kategori (fx misbrug_boern med 24 timers frist) gik
--    tabt. Nu:
--      - samme kategori (eller en kategori, der allerede er føjet til sagen)
--        -> 'findes' som før,
--      - ny kategori -> gemmes på sagen: en note nederst i begrundelsen med
--        kategorien, tidspunktet og den nye begrundelse (højst 500 tegn), så
--        staff ser den, og den anonymiseres sammen med resten af begrundelsen
--        (dsa_oprydning_koer),
--      - er den nye kategori alvorligere (misbrug_boern > hadefuld_tale >
--        resten), skifter sagen til den nye kategori (den tidligere står i
--        noten), og fristen bliver den korteste af den gamle og den nye
--        (24 timer). Admin sorterer efter frist, så sagen rykker op.
--    Svaret er stadig 'findes' (med 'opdateret': true), så eksisterende
--    klienter (hjemmesiden på main og appen) virker uændret.
--
-- 5. Navneregel BHN01 ("må ikke indeholde BidHamr") gælder nu også fornavn
--    og efternavn, ikke kun navn. users_forbudt_navn:
--      - INSERT: et forbudt navn erstattes stille som før (navn -> 'Bruger',
--        fornavn/efternavn -> null), så signup aldrig vælter.
--      - UPDATE: afvises med BHN01, når navn, fornavn eller efternavn ændres
--        til noget forbudt.
--      - UPDATE af fornavn/efternavn på en privat konto (ikke 'erhverv', ikke
--        slettet): navn sættes altid til "fornavn efternavn". Så kan
--        "Bid" + "Hamr" heller ikke slippe igennem, og navn kan ikke afvige
--        fra de to felter. Firmakonti (navn = firmanavn) røres ikke.
--    Varianter som "B1dHamr", "Bid Hamr", "Bid.Hamr" og "Bid-Hamr" fanges
--    allerede af bidhamr_navn_forbudt (1/l/! -> i, alt uden for a-z0-9
--    fjernes). Triggeren kører før users_zz_visningsnavn (20261102060000),
--    så visningsnavn beregnes af det endelige navn.
--    Triggeren fyrer nu på "update of navn, fornavn, efternavn".
--    Tjekket på testdatabasen 27. okt. 2026: ingen eksisterende brugere
--    (heller ikke firmakonti) har et forbudt navn, fornavn eller efternavn,
--    og ingen har navn forskelligt fra "fornavn efternavn".
--
-- Ingen grants ændres. Kan køres flere gange (create or replace, drop
-- trigger if exists, md5-drifttjek). md5 = normaliseret krop (CR og
-- kommentarer fjernet, al whitespace fjernet, små bogstaver) som
-- 20261023010000. "gammel" = test og prod før denne migration, "ny" = efter.
-- Andet afbryder migrationen.
-- Køres først på testdatabasen (pjiigmzqwlfepxnjdvug). Produktion kræver
-- Filips "ja".
-- =============================================================================

set local lock_timeout = '5s';

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

create or replace function pg_temp.drift_tjek(p_fn text, p_gammel text, p_ny text)
returns void language plpgsql as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: findes ikke - kontrollér databasen, før migrationen køres', p_fn;
  end if;
  if h is distinct from p_gammel and h is distinct from p_ny then
    raise exception '%: md5 % er hverken den forventede gamle (%) eller nye (%) - kontrollér funktionen, før migrationen køres',
      p_fn, h, p_gammel, p_ny;
  end if;
end $f$;

select pg_temp.drift_tjek('public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)',
                          'ab9150038013a607a91e708f57252322', '737ef2430d4685215e45b28e72a88363');
select pg_temp.drift_tjek('public.users_forbudt_navn()',
                          'd27363fae9f8056c45e4f82cc69c17f9', 'b8666ef9d0933755a8da84377e1bf517');

-- ---------------------------------------------------------------------------
-- 1. DSA
-- ---------------------------------------------------------------------------

-- Hvor alvorlig en kategori er (højere = alvorligere = kortere frist).
create or replace function public.dsa_kategori_alvor(p_kategori text)
returns integer
language sql
immutable
set search_path = ''
as $fn$
  select case p_kategori
           when 'misbrug_boern' then 3
           when 'hadefuld_tale' then 2
           else 1
         end;
$fn$;

revoke all on function public.dsa_kategori_alvor(text) from public, anon, authenticated;
grant execute on function public.dsa_kategori_alvor(text) to service_role;

-- Spejl af ANMELD_KATEGORIER (src/lib/dsa/regler.ts) - kun til noten.
create or replace function public.dsa_kategori_navn(p_kategori text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case p_kategori
           when 'forbudt_vare'      then 'Forbudt eller ulovlig vare'
           when 'kunst'             then 'Kunst'
           when 'falske_varer'      then 'Falsk vare eller kopi af et mærke'
           when 'svindel'           then 'Svindel eller vildledning'
           when 'ophavsret'         then 'Krænkelse af ophavsret'
           when 'personoplysninger' then 'Personoplysninger'
           when 'hadefuld_tale'     then 'Hadefuld, truende eller ulovlig tale'
           when 'misbrug_boern'     then 'Seksuelt misbrug af børn'
           when 'vilkaar'           then 'Bryder BidHamrs regler'
           when 'andet'             then 'Andet'
           else p_kategori
         end;
$fn$;

revoke all on function public.dsa_kategori_navn(text) from public, anon, authenticated;
grant execute on function public.dsa_kategori_navn(text) to service_role;

create or replace function public.dsa_anmeldelse_opret(
  p_anmelder uuid, p_type text, p_id uuid, p_placering text, p_kategori text,
  p_begrundelse text, p_navn text, p_email text, p_god_tro boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_begr   text := btrim(coalesce(p_begrundelse, ''));
  v_navn   text := nullif(btrim(coalesce(p_navn, '')), '');
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_plac   text := btrim(coalesce(p_placering, ''));
  v_anonym boolean := p_anmelder is null;
  v_ejer   uuid;
  v_auk    uuid;
  v_frist  timestamptz;
  v_id     uuid;
  v_nr     text;
  v_gl_kat text;
  v_gl_begr text;
  v_note   text;
  v_hoejere boolean;
  n        integer;
  e        record;
begin
  if p_kategori is null or p_kategori not in
     ('forbudt_vare', 'falske_varer', 'svindel', 'ophavsret', 'personoplysninger',
      'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'kunst', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_type is null or p_type not in
     ('auktion', 'profil', 'spoergsmaal', 'spoergsmaal_svar', 'bedoemmelse', 'bedoemmelse_svar', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if char_length(v_begr) < 10 or char_length(v_begr) > 2000 then
    return jsonb_build_object('kode', 'begrundelse');
  end if;
  if p_god_tro is not true then
    return jsonb_build_object('kode', 'god_tro');
  end if;
  if char_length(v_plac) < 1 or char_length(v_plac) > 500 then
    return jsonb_build_object('kode', 'ugyldig_placering');
  end if;
  if v_navn is not null and char_length(v_navn) > 100 then
    return jsonb_build_object('kode', 'navn_for_langt');
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$') then
    return jsonb_build_object('kode', 'anmelder_mangler');
  end if;

  if v_anonym and p_kategori <> 'misbrug_boern'
     and (v_navn is null or v_email is null) then
    return jsonb_build_object('kode', 'anmelder_mangler');
  end if;
  if not v_anonym and not exists (select 1 from public.users u where u.id = p_anmelder) then
    return jsonb_build_object('kode', 'anmelder_mangler');
  end if;

  if p_type <> 'andet' then
    select * into e from public.dsa_indhold_ejer(p_type, p_id) limit 1;
    if not found then
      if v_anonym then return jsonb_build_object('kode', 'ok'); end if;
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    v_ejer := e.bruger_id;
    v_auk := e.auktion_id;
    if not v_anonym and v_ejer = p_anmelder then
      return jsonb_build_object('kode', 'sig_selv');
    end if;
    if v_anonym and v_email is not null
       and exists (select 1 from public.users u where u.id = v_ejer and lower(u.email) = v_email) then
      return jsonb_build_object('kode', 'ok');
    end if;
  end if;

  v_frist := now() + case when public.dsa_kategori_alvor(p_kategori) >= 2
                          then interval '24 hours' else interval '7 days' end;

  if not v_anonym then
    select a.id, a.sagsnummer, a.kategori, a.begrundelse
      into v_id, v_nr, v_gl_kat, v_gl_begr
      from public.dsa_anmeldelser a
     where a.status = 'ny'
       and a.indhold_type = p_type
       and a.indhold_id is not distinct from p_id
       and a.anmelder_id = p_anmelder
       and (p_type <> 'andet' or a.placering = v_plac)
     order by a.oprettet_kl
     limit 1
       for update;
    if found then
      -- Samme kategori, eller kategorien er allerede føjet til sagen.
      if v_gl_kat = p_kategori
         or strpos(v_gl_begr, '): ' || public.dsa_kategori_navn(p_kategori) || chr(10)) > 0 then
        return jsonb_build_object('kode', 'findes', 'id', v_id, 'sagsnummer', v_nr);
      end if;
      -- Ny kategori: gemmes på sagen (ikke slugt). Alvorligere -> sagen
      -- skifter kategori og får den korteste frist.
      v_hoejere := public.dsa_kategori_alvor(p_kategori) > public.dsa_kategori_alvor(v_gl_kat);
      v_note := chr(10) || chr(10)
             || 'Ny kategori fra anmelderen ('
             || to_char(now() at time zone 'Europe/Copenhagen', 'DD-MM-YYYY HH24:MI') || '): '
             || public.dsa_kategori_navn(p_kategori) || chr(10)
             || case when v_hoejere
                     then 'Sagen er flyttet fra: ' || public.dsa_kategori_navn(v_gl_kat) || chr(10)
                     else '' end
             || left(v_begr, 500);
      update public.dsa_anmeldelser a
         set kategori = case when v_hoejere then p_kategori else a.kategori end,
             frist_kl = least(a.frist_kl, v_frist),
             begrundelse = left(a.begrundelse, 2000 - char_length(v_note)) || v_note
       where a.id = v_id;
      return jsonb_build_object('kode', 'findes', 'id', v_id, 'sagsnummer', v_nr, 'opdateret', true);
    end if;
  end if;

  if not v_anonym or v_email is not null then
    select count(*) into n from public.dsa_anmeldelser a
     where a.oprettet_kl > now() - interval '1 day'
       and ((not v_anonym and a.anmelder_id = p_anmelder)
            or (v_anonym and a.anmelder_id is null and a.anmelder_email = v_email));
    if n >= 20 then return jsonb_build_object('kode', 'for_mange'); end if;
  end if;
  if p_kategori <> 'misbrug_boern' then
    select count(*) into n from public.dsa_anmeldelser a
     where a.oprettet_kl > now() - interval '1 hour'
       and a.kategori <> 'misbrug_boern'
       and (a.anmelder_id is null) = v_anonym;
    if n >= (case when v_anonym then 500 else 1000 end) then
      return jsonb_build_object('kode', 'for_mange');
    end if;
  end if;

  insert into public.dsa_anmeldelser
    (indhold_type, indhold_id, auktion_id, anmeldt_bruger_id, placering, kategori, begrundelse,
     anmelder_id, anmelder_navn, anmelder_email, god_tro, frist_kl)
  values
    (p_type, case when p_type = 'andet' then null else p_id end, v_auk, v_ejer, v_plac, p_kategori, v_begr,
     p_anmelder, v_navn, v_email, true, v_frist)
  returning id, sagsnummer into v_id, v_nr;

  return jsonb_build_object('kode', 'ok', 'id', v_id, 'sagsnummer', v_nr, 'frist_kl', v_frist);
end;
$function$;

revoke all on function public.dsa_anmeldelse_opret(uuid, text, uuid, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.dsa_anmeldelse_opret(uuid, text, uuid, text, text, text, text, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Navneregel BHN01 på navn, fornavn og efternavn
-- ---------------------------------------------------------------------------

create or replace function public.users_forbudt_navn()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_fornavn   text;
  v_efternavn text;
begin
  -- Systembrugeren må hedde BidHamr (konstanten som i users_beskyt_systembruger).
  if new.id = '00000000-0000-4000-8000-0000000b1d00'::uuid then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Signup (handle_new_user) må ikke vælte: forbudte navne erstattes.
    if public.bidhamr_navn_forbudt(new.navn) then new.navn := 'Bruger'; end if;
    if public.bidhamr_navn_forbudt(new.fornavn) then new.fornavn := null; end if;
    if public.bidhamr_navn_forbudt(new.efternavn) then new.efternavn := null; end if;
    return new;
  end if;

  -- Privat konto: navn er altid "fornavn efternavn", når et af dem ændres.
  -- Firmakonti (navn = firmanavn) og slettede konti røres ikke.
  v_fornavn := nullif(btrim(coalesce(new.fornavn, '')), '');
  v_efternavn := nullif(btrim(coalesce(new.efternavn, '')), '');
  if new.konto_type is distinct from 'erhverv'
     and new.konto_slettet_kl is null
     and v_fornavn is not null
     and (new.fornavn is distinct from old.fornavn or new.efternavn is distinct from old.efternavn) then
    new.navn := concat_ws(' ', v_fornavn, v_efternavn);
  end if;

  -- "update of ..." fyrer også, når kolonnen står i SET uden at ændres - kun
  -- ændrede navne tjekkes, så ældre rækker ikke blokeres.
  if (new.navn is distinct from old.navn and public.bidhamr_navn_forbudt(new.navn))
     or (new.fornavn is distinct from old.fornavn and public.bidhamr_navn_forbudt(new.fornavn))
     or (new.efternavn is distinct from old.efternavn and public.bidhamr_navn_forbudt(new.efternavn)) then
    raise exception 'Navnet må ikke indeholde "BidHamr".' using errcode = 'BHN01';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.users_forbudt_navn() from public, anon, authenticated;

drop trigger if exists users_forbudt_navn on public.users;
create trigger users_forbudt_navn
  before insert or update of navn, fornavn, efternavn on public.users
  for each row execute function public.users_forbudt_navn();

-- Efter-tjek: de nye kroppe er dem, migrationen forventer.
select pg_temp.drift_tjek('public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)',
                          '737ef2430d4685215e45b28e72a88363', '737ef2430d4685215e45b28e72a88363');
select pg_temp.drift_tjek('public.users_forbudt_navn()', 'b8666ef9d0933755a8da84377e1bf517', 'b8666ef9d0933755a8da84377e1bf517');

drop function pg_temp.drift_tjek(text, text, text);
drop function pg_temp.krop_md5(text);
