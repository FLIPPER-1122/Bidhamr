-- Vaern om systembrugeren "BidHamr" og navnet BidHamr (review af staff-chat,
-- 20261003000000 + 20261003001000).
--
-- M1. Systembrugerens e-mail markeres som bekraeftet. En ubekraeftet
--     auth-bruger kan "overtages" af et nyt signUp med samme e-mail (GoTrue
--     genbruger raekken og saetter ny adgangskode); en bekraeftet kan ikke.
--     Tom adgangskode og banned_until roeres ikke.
-- M2. Ingen almindelig bruger maa hedde noget med "BidHamr" (ogsaa med
--     mellemrum, tegn, usynlige tegn, fuldbredde-/matematiske bogstaver eller
--     kyrilliske/graeske look-alikes). Se "Valg ved signup" herunder.
-- M3. Systembrugerens rolle, navn, e-mail og suspension kan ikke aendres -
--     heller ikke af service_role. Den kan heller ikke faa advarsler.
-- L1. messages_beskyt_fra_bidhamr: NFKC, flere usynlige tegn og tjek af
--     starten af HVER linje (ikke kun beskedens start).
--
-- Valg ved signup (M2): handle_new_user (on_auth_user_created) indsaetter
-- navn fra signUp-metadata. Hvis triggeren afviste, ville HELE signup'en
-- fejle med GoTrues generiske "Database error saving new user" (HTTP 500) -
-- appen kan ikke vise en dansk besked ud fra det. Derfor:
--   - INSERT: et forbudt navn erstattes stille med "Bruger" (signup lykkes,
--     brugeren kan rette navnet bagefter, og faar da den danske fejl, hvis han
--     proever BidHamr igen). Det gaelder ogsaa, naar navnet mangler og
--     e-mailen bruges som navn (fx kontakt@bidhamr.dk).
--   - UPDATE: afvises med 'Navnet må ikke indeholde "BidHamr".' (BHN01).
--     Kun naar navnet faktisk aendres, saa eksisterende brugere med et
--     saadant navn ikke blokeres i at opdatere andre felter.
-- Appen boer selv tjekke navnet foer signUp for at give en paen besked.
--
-- Eksisterende raekker roeres ikke. Find dem i produktion (efter denne
-- migration er koert) med:
--
--   select id, navn, email, oprettet
--     from public.users
--    where id <> '00000000-0000-4000-8000-0000000b1d00'
--      and public.bidhamr_navn_forbudt(navn)
--    order by oprettet;
--
-- Foer migrationen (groft, uden look-alikes):
--
--   select id, navn, email, oprettet
--     from public.users
--    where id <> '00000000-0000-4000-8000-0000000b1d00'
--      and regexp_replace(lower(normalize(coalesce(navn, ''), NFKC)), '[^a-z0-9]', '', 'g')
--          ~ 'bidha(m|rn)+e?r'
--    order by oprettet;
--
-- Idempotent: create or replace / drop ... if exists / betingede updates.

-- ============================================================ M1 E-mail bekraeftet

update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, now()),
       updated_at = now()
 where id = '00000000-0000-4000-8000-0000000b1d00'::uuid
   and email_confirmed_at is null;

-- ============================================================ Tekst-hjaelpere

-- Goer en tekst klar til sammenligning: NFKC (fuldbredde, matematiske
-- bogstaver, ligaturer -> almindelige), usynlige/format-tegn fjernes,
-- saerlige mellemrum bliver til almindelige, smaa bogstaver, og kendte
-- look-alikes (kyrillisk, graesk, small caps, 1/l/|/! for i, @/4 for a)
-- bliver til latinske. Kun til tjek - aldrig til at gemme teksten.
-- Alle tegn skrives med chr(), saa filen ikke indeholder usynlige tegn.
create or replace function public.bidhamr_sammenlign_tekst(p_tekst text)
returns text
language plpgsql
immutable
parallel safe
security invoker
set search_path = public
as $fn$
declare
  v text := normalize(coalesce(p_tekst, ''), NFKC);
begin
  -- Usynlige/format-tegn:
  --   00AD bloed bindestreg, 034F CGJ, 061C ALM, 115F-1160 + 3164 + FFA0
  --   Hangul-fyld, 17B4-17B5, 180B-180E mongolske, 200B-200F zero-width og
  --   retningsmaerker, 202A-202E retningsindlejring, 2060-2064 + 2066-206F,
  --   2800 tom blindskrift, FE00-FE0F variantvaelgere, FEFF BOM,
  --   E0000-E007F tag-tegn.
  v := regexp_replace(v,
         '[' || chr(173) || chr(847) || chr(1564)
             || chr(4447) || '-' || chr(4448)
             || chr(6068) || '-' || chr(6069)
             || chr(6155) || '-' || chr(6158)
             || chr(8203) || '-' || chr(8207)
             || chr(8234) || '-' || chr(8238)
             || chr(8288) || '-' || chr(8292)
             || chr(8294) || '-' || chr(8303)
             || chr(10240) || chr(12644)
             || chr(65024) || '-' || chr(65039)
             || chr(65279) || chr(65440)
             || chr(917504) || '-' || chr(917631)
             || ']', '', 'g');

  -- Saerlige mellemrum -> almindelige (NFKC tager de fleste).
  v := translate(v, chr(160) || chr(5760) || chr(8199) || chr(8239), '    ');

  v := lower(v);

  -- Look-alikes. Om lower() ogsaa goer ikke-ASCII-bogstaver smaa, afhaenger
  -- af databasens locale, saa baade store og smaa staar med.
  v := translate(v,
    '1l|!@4'
    || chr(1072) || chr(1040) || chr(913)  || chr(945)  || chr(593)  || chr(7424)   -- a
    || chr(1042) || chr(1068) || chr(1100) || chr(914)  || chr(665)  || chr(1074)   -- b (1074 = lille kyrillisk ve, efter lower())
    || chr(1280) || chr(1281) || chr(7429)                                          -- d
    || chr(1053) || chr(1210) || chr(1211) || chr(919)  || chr(668)  || chr(1085)   -- h (1085 = lille kyrillisk en)
    || chr(1030) || chr(1110) || chr(1216) || chr(1231) || chr(921)  || chr(953)
    || chr(305)  || chr(618)                                                        -- i
    || chr(1052) || chr(1084) || chr(924)  || chr(7437)                             -- m
    || chr(1075) || chr(640),                                                       -- r
    'iiiiaa'
    || 'aaaaaa'
    || 'bbbbbb'
    || 'ddd'
    || 'hhhhhh'
    || 'iiiiii'
    || 'ii'
    || 'mmmm'
    || 'rr');

  return v;
end;
$fn$;

revoke all on function public.bidhamr_sammenlign_tekst(text) from public, anon;
grant execute on function public.bidhamr_sammenlign_tekst(text) to authenticated, service_role;

-- Indeholder navnet "BidHamr" (i en eller anden forklaedning)? Alt andet end
-- a-z og 0-9 fjernes foerst, saa "Bid-Hamr", "B i d H a m r" osv. fanges.
-- "rn" ligner "m", og "BidHammer"/"BidHamer" fanges ogsaa.
create or replace function public.bidhamr_navn_forbudt(p_navn text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = public
as $fn$
  select regexp_replace(public.bidhamr_sammenlign_tekst(p_navn), '[^a-z0-9]', '', 'g')
         ~ 'bidha(m|rn)+e?r';
$fn$;

revoke all on function public.bidhamr_navn_forbudt(text) from public, anon;
grant execute on function public.bidhamr_navn_forbudt(text) to authenticated, service_role;

-- ============================================================ M2 Forbudt navn

create or replace function public.users_forbudt_navn()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  -- Systembrugeren maa hedde BidHamr. Konstanten staar direkte her (som i
  -- users_beskyt_systembruger).
  if new.id = '00000000-0000-4000-8000-0000000b1d00'::uuid then
    return new;
  end if;
  if new.navn is null or not public.bidhamr_navn_forbudt(new.navn) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Signup (handle_new_user) maa ikke vaelte: navnet erstattes.
    new.navn := 'Bruger';
    return new;
  end if;

  -- "update of navn" fyrer ogsaa, naar navnet staar i SET uden at aendres.
  if new.navn is not distinct from old.navn then
    return new;
  end if;

  raise exception 'Navnet må ikke indeholde "BidHamr".' using errcode = 'BHN01';
end;
$fn$;

revoke execute on function public.users_forbudt_navn() from public, anon, authenticated;

drop trigger if exists users_forbudt_navn on public.users;
create trigger users_forbudt_navn
  before insert or update of navn on public.users
  for each row execute function public.users_forbudt_navn();

-- ============================================================ M3 Systembrugeren laast

-- Gaelder ALLE roller (ogsaa service_role/postgres): systembrugeren er altid
-- "BidHamr", almindelig bruger, aldrig suspenderet.
create or replace function public.users_laas_systembruger()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if old.id = '00000000-0000-4000-8000-0000000b1d00'::uuid and (
       new.id                 is distinct from old.id
    or new.rolle              is distinct from old.rolle
    or new.navn               is distinct from old.navn
    or new.email              is distinct from old.email
    or new.suspenderet        is distinct from old.suspenderet
    or new.suspenderet_aarsag is distinct from old.suspenderet_aarsag
    or new.suspenderet_kl     is distinct from old.suspenderet_kl
    or new.suspenderet_til    is distinct from old.suspenderet_til) then
    raise exception 'Systembrugeren BidHamr kan ikke ændres.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.users_laas_systembruger() from public, anon, authenticated;

drop trigger if exists users_laas_systembruger on public.users;
create trigger users_laas_systembruger
  before update on public.users
  for each row execute function public.users_laas_systembruger();

-- Ingen advarsler til systembrugeren.
create or replace function public.advarsler_ikke_systembruger()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if new.bruger_id = '00000000-0000-4000-8000-0000000b1d00'::uuid then
    raise exception 'Systembrugeren BidHamr kan ikke få advarsler.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.advarsler_ikke_systembruger() from public, anon, authenticated;

drop trigger if exists advarsler_ikke_systembruger on public.advarsler;
create trigger advarsler_ikke_systembruger
  before insert or update of bruger_id on public.advarsler
  for each row execute function public.advarsler_ikke_systembruger();

-- ============================================================ L1 Udgivelse som BidHamr

-- Som i 20261003001000, men:
--   - teksten sammenlignes via bidhamr_sammenlign_tekst (NFKC, flere
--     usynlige tegn, look-alikes)
--   - hver linje tjekkes (ogsaa efter \r, NEL, U+2028/2029), saa praefikset
--     ikke kan gemmes efter en tom/foerste linje
--   - al tegnsaetning/mellemrum i starten af linjen og mellem ordene
--     ignoreres ("Besked fra: Bid-Hamr", "**Besked fra BidHamr**")
--   - en UPDATE, der ikke aendrer teksten, tjekkes ikke
create or replace function public.messages_beskyt_fra_bidhamr()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.fra_bidhamr := false;
  else
    new.fra_bidhamr := old.fra_bidhamr;
    -- Uaendret tekst (fx kun laest-markering) tjekkes ikke igen, saa aeldre
    -- beskeder aldrig blokerer en opdatering af andre felter.
    if new.content is not distinct from old.content then
      return new;
    end if;
  end if;

  if exists (
    select 1
      from regexp_split_to_table(
             public.bidhamr_sammenlign_tekst(new.content),
             '[' || chr(10) || chr(13) || chr(133) || chr(8232) || chr(8233) || ']') as linje
     where regexp_replace(linje, '[^a-z0-9]', '', 'g') ~ '^beskedfrabidha(m|rn)+e?r'
  ) then
    raise exception 'Beskeder må ikke starte med "Besked fra BidHamr".'
      using errcode = 'BHM01';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.messages_beskyt_fra_bidhamr() from public, anon, authenticated;

drop trigger if exists messages_beskyt_fra_bidhamr on public.messages;
create trigger messages_beskyt_fra_bidhamr
  before insert or update on public.messages
  for each row execute function public.messages_beskyt_fra_bidhamr();
