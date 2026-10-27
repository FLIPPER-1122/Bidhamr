-- =============================================================================
-- Rettelser efter review af 20261102090000_side_testfund.sql (27. okt. 2026).
--
-- 1. DSA: anmelderens oprindelige begrundelse ændres aldrig.
--    090000 føjede en ny kategori til sagen som en note nederst i
--    begrundelsen og beskar den oprindelige tekst
--    (left(a.begrundelse, 2000 - ...)). Begrundelsen ER anmeldelsen (DSA
--    art. 16) og må ikke ændres. Nu:
--      - ny tabel dsa_anmeldelse_tillaeg: én række pr. ny kategori, som
--        anmelderen føjer til en åben sag (kategori, begrundelse, sagens
--        kategori før tilføjelsen, tidspunkt). Kun service_role, RLS slået
--        til, kan ikke slettes (dsa_slettes_aldrig) og anonymiseres i
--        dsa_oprydning_koer samtidig med anmeldelsen.
--      - dsa_anmeldelse_opret gemmer tilføjelsen dér og rører aldrig
--        begrundelse. Dubletjekket bruger tabellen (unik på sag + kategori)
--        i stedet for at lede efter noteteksten i begrundelsen - så kan
--        anmelderens egen tekst ikke længere snyde dubletjekket. En kategori,
--        sagen tidligere har haft (fx den oprindelige, før sagen blev
--        flyttet til en alvorligere), giver også 'findes'.
--      - Kategori og frist opfører sig som i 090000: en alvorligere kategori
--        flytter sagen, og fristen bliver den korteste.
--      - Noter, som 090000 allerede har skrevet i en begrundelse, flyttes ud
--        i tabellen, og den oprindelige tekst genskabes - kun når det kan
--        gøres sikkert (teksten er ikke beskåret, dvs. under 2000 tegn, og
--        hver note kan læses entydigt). Andre rækker røres ikke, og der gives
--        en NOTICE med sagsnumrene. Testdatabasen havde ingen 27. okt. 2026.
--
-- 2. Navnereglen "navn = fornavn efternavn" gælder nu altid for private
--    konti: users_forbudt_navn sætter navn til concat_ws(' ', fornavn,
--    efternavn), når fornavn findes - også når kun navn opdateres
--    (authenticated har update på navn alene) og ved INSERT. Firmakonti
--    ('erhverv'), slettede konti og systembrugeren er undtaget. Signup
--    (handle_new_user og kontoOprettelse.gemProfil), hjemmesidens
--    indstillinger og appens navneskift sender allerede navn = "fornavn
--    efternavn", så de virker uændret.
--
-- Svaret fra dsa_anmeldelse_opret er uændret ('findes' + 'opdateret'), så
-- hjemmesiden på den gamle main og appen virker uden ændringer. Ingen grants
-- på eksisterende objekter ændres.
--
-- Kan køres flere gange (create ... if not exists, create or replace, drop
-- trigger if exists, md5-drifttjek). md5 = normaliseret krop som i 090000.
-- "gammel" = efter 20261102090000, "ny" = efter denne migration. Andet
-- afbryder migrationen. Kræver, at 090000 er kørt først.
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
                          '737ef2430d4685215e45b28e72a88363', '6d1e8d5e87a99f3bfa424150d4faa8d6');
select pg_temp.drift_tjek('public.users_forbudt_navn()',
                          'b8666ef9d0933755a8da84377e1bf517', 'b05f12e8654ddaae99c85596d9d4066a');
select pg_temp.drift_tjek('public.dsa_oprydning_koer()',
                          '169c1d6a1c4365195a58c0359ae95a3d', '5200972bb089e5384a4c3e737db3ae16');

-- ---------------------------------------------------------------------------
-- 1. DSA: tilføjelser til en anmeldelse
-- ---------------------------------------------------------------------------

create table if not exists public.dsa_anmeldelse_tillaeg (
  id                uuid primary key default gen_random_uuid(),
  anmeldelse_id     uuid not null references public.dsa_anmeldelser(id) on delete restrict,
  kategori          text not null check (kategori in
                      ('forbudt_vare', 'falske_varer', 'svindel', 'ophavsret', 'personoplysninger',
                       'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'kunst', 'andet')),
  -- Sagens kategori lige før tilføjelsen (så den oprindelige kategori kan
  -- ses, selvom sagen er flyttet til en alvorligere).
  sag_kategori_foer text not null,
  begrundelse       text not null check (char_length(btrim(begrundelse)) between 10 and 2000),
  anonymiseret_kl   timestamptz,
  oprettet_kl       timestamptz not null default now(),
  constraint dsa_anmeldelse_tillaeg_unik unique (anmeldelse_id, kategori)
);

alter table public.dsa_anmeldelse_tillaeg enable row level security;

revoke all on table public.dsa_anmeldelse_tillaeg from public, anon, authenticated, service_role;
grant select, insert, update on table public.dsa_anmeldelse_tillaeg to service_role;

drop trigger if exists dsa_anmeldelse_tillaeg_slettes_aldrig on public.dsa_anmeldelse_tillaeg;
create trigger dsa_anmeldelse_tillaeg_slettes_aldrig before delete on public.dsa_anmeldelse_tillaeg
  for each row execute function public.dsa_slettes_aldrig();

comment on table public.dsa_anmeldelse_tillaeg is
  'DSA art. 16: nye kategorier, som anmelderen har føjet til en åben anmeldelse (dsa_anmeldelse_opret). Anmeldelsens egen begrundelse ændres aldrig. Kun service_role. Slettes aldrig - anonymiseres sammen med anmeldelsen (dsa_oprydning_koer). 20261102110000.';

-- Noter fra 090000 flyttes ud af begrundelsen (kun når det er sikkert).
do $do$
declare
  c_moenster constant text :=
    E'\n\nNy kategori fra anmelderen \\((\\d{2}-\\d{2}-\\d{4} \\d{2}:\\d{2})\\): ';
  r        record;
  v_dele   text[];
  v_tider  text[];
  v_n      integer;
  v_orig   text;
  v_rest   text;
  v_linje  text;
  v_kat    text[];
  v_flyt   text[];
  v_begr   text[];
  v_foer   text[];
  v_cur    text;
  v_ok     boolean;
  v_kode   text;
  v_usikre text[] := '{}';
  v_flyttet integer := 0;
  i        integer;
begin
  for r in
    select a.id, a.sagsnummer, a.kategori, a.begrundelse
      from public.dsa_anmeldelser a
     where a.anonymiseret_kl is null
       and a.begrundelse ~ c_moenster
       and not exists (select 1 from public.dsa_anmeldelse_tillaeg t where t.anmeldelse_id = a.id)
     for update
  loop
    v_ok := char_length(r.begrundelse) < 2000;  -- 2000 = måske beskåret
    v_dele := regexp_split_to_array(r.begrundelse, c_moenster);
    select array_agg(m[1] order by o) into v_tider
      from regexp_matches(r.begrundelse, c_moenster, 'g') with ordinality as x(m, o);
    v_n := coalesce(array_length(v_tider, 1), 0);
    v_ok := v_ok and v_n >= 1 and array_length(v_dele, 1) = v_n + 1;
    v_orig := v_dele[1];
    v_ok := v_ok and char_length(btrim(coalesce(v_orig, ''))) >= 10;
    v_kat := '{}'; v_flyt := '{}'; v_begr := '{}';

    if v_ok then
      for i in 1 .. v_n loop
        v_rest := v_dele[i + 1];
        -- Første linje: kategoriens navn.
        v_linje := split_part(v_rest, chr(10), 1);
        select k into v_kode from unnest(array['forbudt_vare', 'falske_varer', 'svindel', 'ophavsret',
               'personoplysninger', 'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'kunst', 'andet']) k
         where public.dsa_kategori_navn(k) = v_linje;
        if v_kode is null or strpos(v_rest, chr(10)) = 0 then v_ok := false; exit; end if;
        v_kat := v_kat || v_kode;
        v_rest := substr(v_rest, strpos(v_rest, chr(10)) + 1);
        -- Evt. "Sagen er flyttet fra: <navn>".
        v_kode := null;
        if v_rest like 'Sagen er flyttet fra: %' then
          v_linje := substr(split_part(v_rest, chr(10), 1), char_length('Sagen er flyttet fra: ') + 1);
          select k into v_kode from unnest(array['forbudt_vare', 'falske_varer', 'svindel', 'ophavsret',
                 'personoplysninger', 'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'kunst', 'andet']) k
           where public.dsa_kategori_navn(k) = v_linje;
          if v_kode is null or strpos(v_rest, chr(10)) = 0 then v_ok := false; exit; end if;
          v_rest := substr(v_rest, strpos(v_rest, chr(10)) + 1);
        end if;
        v_flyt := v_flyt || v_kode;
        if char_length(btrim(v_rest)) < 10 or char_length(v_rest) > 500 then v_ok := false; exit; end if;
        v_begr := v_begr || v_rest;
      end loop;
    end if;

    -- Hver kategori højst én gang.
    if v_ok and (select count(distinct k) from unnest(v_kat) k) <> v_n then v_ok := false; end if;

    if not v_ok then
      v_usikre := v_usikre || r.sagsnummer;
      continue;
    end if;

    -- Sagens kategori før hver tilføjelse: baglæns fra den nuværende.
    v_foer := array_fill(null::text, array[v_n]);
    v_cur := r.kategori;
    for i in reverse v_n .. 1 loop
      if v_flyt[i] is not null then v_cur := v_flyt[i]; end if;
      v_foer[i] := v_cur;
    end loop;

    for i in 1 .. v_n loop
      insert into public.dsa_anmeldelse_tillaeg (anmeldelse_id, kategori, sag_kategori_foer, begrundelse, oprettet_kl)
      values (r.id, v_kat[i], v_foer[i], v_begr[i],
              to_timestamp(v_tider[i], 'DD-MM-YYYY HH24:MI')::timestamp at time zone 'Europe/Copenhagen');
    end loop;
    update public.dsa_anmeldelser a set begrundelse = v_orig where a.id = r.id;
    v_flyttet := v_flyttet + 1;
  end loop;

  if v_flyttet > 0 then
    raise notice 'DSA: noter flyttet ud af begrundelsen på % anmeldelse(r).', v_flyttet;
  end if;
  if cardinality(v_usikre) > 0 then
    raise notice 'DSA: noter i begrundelsen kunne ikke flyttes sikkert og er urørt: %', array_to_string(v_usikre, ', ');
  end if;
end;
$do$;

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
    select a.id, a.sagsnummer, a.kategori
      into v_id, v_nr, v_gl_kat
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
      -- Samme kategori, en kategori, der allerede er føjet til sagen, eller
      -- en kategori, sagen har haft før (fx den oprindelige).
      if v_gl_kat = p_kategori
         or exists (select 1 from public.dsa_anmeldelse_tillaeg t
                     where t.anmeldelse_id = v_id
                       and (t.kategori = p_kategori or t.sag_kategori_foer = p_kategori)) then
        return jsonb_build_object('kode', 'findes', 'id', v_id, 'sagsnummer', v_nr);
      end if;
      -- Ny kategori: gemmes som tilføjelse (begrundelsen røres aldrig).
      -- Alvorligere -> sagen skifter kategori og får den korteste frist.
      v_hoejere := public.dsa_kategori_alvor(p_kategori) > public.dsa_kategori_alvor(v_gl_kat);
      insert into public.dsa_anmeldelse_tillaeg (anmeldelse_id, kategori, sag_kategori_foer, begrundelse)
      values (v_id, p_kategori, v_gl_kat, v_begr)
      on conflict (anmeldelse_id, kategori) do nothing;
      if not found then
        return jsonb_build_object('kode', 'findes', 'id', v_id, 'sagsnummer', v_nr);
      end if;
      update public.dsa_anmeldelser a
         set kategori = case when v_hoejere then p_kategori else a.kategori end,
             frist_kl = least(a.frist_kl, v_frist)
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

-- Oprydning: som 20261009011000 + tilføjelserne anonymiseres sammen med
-- anmeldelsen (også ældre, allerede anonymiserede anmeldelser).
create or replace function public.dsa_oprydning_koer()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_anm integer := 0;
  v_til integer := 0;
  v_kl  integer := 0;
begin
  update public.dsa_anmeldelser a
     set anmelder_navn = null, anmelder_email = null, anmelder_id = null,
         begrundelse = '(Slettet 12 måneder efter afgørelsen)',
         placering = case when a.indhold_type = 'andet' then '(slettet)' else a.placering end,
         svar_til_anmelder = case when a.svar_til_anmelder is null then null else '(slettet)' end,
         intern_note = public.dsa_rens_kontakt(a.intern_note),
         eskaleret_note = public.dsa_rens_kontakt(a.eskaleret_note),
         anonymiseret_kl = now()
   where a.id in (
           select x.id from public.dsa_anmeldelser x
            where x.anonymiseret_kl is null
              and x.status = 'afgjort'
              and x.behandlet_kl < now() - interval '12 months'
              and not exists (select 1 from public.dsa_klager k
                               where k.anmeldelse_id = x.id
                                 and (k.status = 'afventer' or k.afgjort_kl > now() - interval '12 months'))
            order by x.behandlet_kl
            limit 5000);
  get diagnostics v_anm = row_count;

  -- Anmelderens tilføjelser (fritekst) følger anmeldelsen.
  update public.dsa_anmeldelse_tillaeg t
     set begrundelse = '(Slettet 12 måneder efter afgørelsen)',
         anonymiseret_kl = now()
    from public.dsa_anmeldelser a
   where a.id = t.anmeldelse_id
     and a.anonymiseret_kl is not null
     and t.anonymiseret_kl is null;
  get diagnostics v_til = row_count;

  -- Anmelderens klage: e-mail, konto-kobling og fritekst (svaret er skrevet
  -- til anmelderen og kan nævne den).
  update public.dsa_klager k
     set klager_email = null,
         klager_id = null,
         begrundelse = '(Slettet 12 måneder efter afgørelsen)',
         svar = case when k.svar is null then null else '(slettet)' end,
         intern_note = public.dsa_rens_kontakt(k.intern_note),
         anonymiseret_kl = now()
   where k.id in (
           select x.id from public.dsa_klager x
            where x.anonymiseret_kl is null
              and x.anmeldelse_id is not null
              and x.status = 'afgjort'
              and x.afgjort_kl < now() - interval '12 months'
            limit 5000);
  get diagnostics v_kl = row_count;

  return jsonb_build_object('anmeldelser_anonymiseret', v_anm, 'tillaeg_anonymiseret', v_til,
                            'klager_anonymiseret', v_kl);
end;
$fn$;
revoke all on function public.dsa_oprydning_koer() from public, anon, authenticated;
grant execute on function public.dsa_oprydning_koer() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Navneregel: navn = "fornavn efternavn" på private konti - altid
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
  end if;

  -- Privat konto med fornavn: navn er ALTID "fornavn efternavn" - også når
  -- kun navn opdateres (authenticated har update på navn alene). Firmakonti
  -- (navn = firmanavn) og slettede konti røres ikke.
  v_fornavn := nullif(btrim(coalesce(new.fornavn, '')), '');
  v_efternavn := nullif(btrim(coalesce(new.efternavn, '')), '');
  if new.konto_type is distinct from 'erhverv'
     and new.konto_slettet_kl is null
     and v_fornavn is not null then
    new.navn := concat_ws(' ', v_fornavn, v_efternavn);
  end if;

  if tg_op = 'INSERT' then
    return new;
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
                          '6d1e8d5e87a99f3bfa424150d4faa8d6', '6d1e8d5e87a99f3bfa424150d4faa8d6');
select pg_temp.drift_tjek('public.users_forbudt_navn()', 'b05f12e8654ddaae99c85596d9d4066a', 'b05f12e8654ddaae99c85596d9d4066a');
select pg_temp.drift_tjek('public.dsa_oprydning_koer()', '5200972bb089e5384a4c3e737db3ae16', '5200972bb089e5384a4c3e737db3ae16');

drop function pg_temp.drift_tjek(text, text, text);
drop function pg_temp.krop_md5(text);
