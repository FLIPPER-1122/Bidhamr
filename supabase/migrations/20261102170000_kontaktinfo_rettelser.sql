-- Kontaktoplysninger i auktioner: rettelser efter review (27. okt. 2026).
--
-- Bygger på:
--   auktion_kontaktinfo_grund, auctions_kontaktinfo  20261102130000_beskrivelse_kontaktinfo.sql
--   besked_spam_grund                                20261102080000_handel_testfund.sql
--   besked_normaliser                                20261006030000_tryghed_chat_kontakt.sql
--   saet_annulleret_op_igen                          20261010030000_erhverv.sql
--   genopsaet_auktion                                20261005020000_startpris_anke.sql
-- Rører IKKE chatfilteret (besked_spam_grund) og IKKE grants på users eller
-- auctions (20261102060000).
--
-- Indhold:
--   1. auktion_kontaktinfo_grund (SPEJL: src/lib/auktionKontaktinfo.ts):
--      a) Beskedtjenester og betalingsapps som domæne stoppes altid - også for
--         firmaer: wa.me, t.me, m.me, fb.me, whatsapp, telegram, messenger,
--         facebook, instagram, snapchat, tiktok (grund 'socialt_medie'),
--         mobilepay ('mobilepay'), revolut, paypal, swipp ('bank').
--      b) Firmaer: kun værtsnavnet fjernes - stien bliver stående og tjekkes
--         som resten af teksten. Et link med 7 eller flere cifre (vært + sti)
--         stoppes altid ('telefon'): "www.firma.dk/22334455".
--      c) Færre falske positiver: står der intet kontaktord (ring, tlf,
--         sms, kontakt, mvh, MobilePay, konto, bank ...), neutraliseres
--         varenumre ("Varenummer 80275887"), IKEA-numre ("402.638.47") og
--         tekniske signalværdier ("Signal: analog"), før filteret køres
--         igen. 8 cifre i træk uden vareord stoppes som før. Kun i
--         auktioner - chatten er uændret.
--   2. Ny intern public.auktion_kontaktinfo_afvis(erhverv, titel, beskrivelse):
--      kaster BHA08 med detail {"felt","grund","erhverv"}. Teksten nævner
--      ikke links for firmaer (de må gerne skrive links).
--   3. auctions_kontaktinfo bruger hjælperen (samme regler som før: kun
--      brugere, kun ændrede felter).
--   4. lokation udledes af postnummeret (public.postnummer_koordinater.bynavn)
--      i en ny trigger auctions_lokation_fra_postnummer - for alle roller.
--      Hjemmesiden og appen sender allerede bynavnet fra samme liste, så
--      intet ændrer sig for dem; fri tekst i lokation kan ikke længere
--      komme frem. Ukendt postnummer giver lokation = null (visningen falder
--      tilbage til postnummeret). Eksisterende rækker røres ikke.
--   5. "Sæt op igen" (saet_annulleret_op_igen) og genopsætning efter en
--      ubetalt vinder (genopsaet_auktion) kører som service role, så
--      triggeren springer dem over. De tjekker nu selv titel og beskrivelse
--      og afviser med BHA08.
--   6. Testblok: samme eksempler som tests/enhed/auktionKontaktinfoEksempler.ts.
--
-- Drift-tjek (md5 af kroppen, CRLF -> LF, uden rene kommentarlinjer) af alt,
-- der erstattes - før noget ændres. Idempotent (kan køres igen).
-- Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælper
-- ---------------------------------------------------------------------------
create or replace function pg_temp.krop_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(regexp_replace(replace(pr.prosrc, E'\r\n', E'\n'),
                            E'^[ \t]*(--[^\n]*)?\n', '', 'gn'))
    from pg_proc pr where pr.oid = p_fn
$$;

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek - før noget ændres. Hver: før (130000 / 080000) | efter denne fil.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- Filteret, der bygges på (20261102080000). Uændret af denne fil.
  v_md5 := pg_temp.krop_md5('public.besked_spam_grund(text)'::regprocedure);
  if v_md5 <> '4868b54e7fa5ac608e9f2e0d08795d7a' then
    raise exception 'besked_spam_grund er ikke udgaven fra 20261102080000 (md5 %). Kør den migration først, eller tjek spejlet i src/lib/tryghed.ts.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.besked_normaliser(text)'::regprocedure);
  if v_md5 <> 'f9d51fb4ddd0b58662cac11336405f46' then
    raise exception 'besked_normaliser er ændret uden for migrationerne (md5 %). Tjek spejlet i src/lib/tryghed.ts.', v_md5;
  end if;
  -- 20261102130000 skal være kørt.
  if to_regprocedure('public.auktion_kontaktinfo_grund(text, boolean)') is null
     or to_regprocedure('public.auctions_kontaktinfo()') is null then
    raise exception 'Kør 20261102130000_beskrivelse_kontaktinfo.sql først.';
  end if;
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_grund(text, boolean)'::regprocedure);
  if v_md5 not in ('3f11cbdeb8fc6641932e7101444b3c84', 'bd6ddb426cb4090fc5f8c410213ee74c') then
    raise exception 'auktion_kontaktinfo_grund er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.auctions_kontaktinfo()'::regprocedure);
  if v_md5 not in ('cf068be2eb64196ddad9855aca8a092b', 'add88823829b4c429bbce9f21a01b528') then
    raise exception 'auctions_kontaktinfo er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.saet_annulleret_op_igen(uuid, uuid)'::regprocedure);
  if v_md5 not in ('bfd84ae0f9e24d39e7c3151620942c60', 'd0252f30b17021ce913089cb4ea59402') then
    raise exception 'saet_annulleret_op_igen er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)'::regprocedure);
  if v_md5 not in ('d6a0e76dfb87cb4db219177e43630be1', '0f6e3c24fe1ea79ca5ab03272c1f781f') then
    raise exception 'genopsaet_auktion er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  -- Denne fils nye funktioner (ved genkørsel): kun denne fils udgave.
  if to_regprocedure('public.auktion_kontaktinfo_afvis(boolean, text, text)') is not null then
    v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_afvis(boolean, text, text)'::regprocedure);
    if v_md5 <> 'b367746d6387dfd23d29586311ba77a3' then
      raise exception 'auktion_kontaktinfo_afvis er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
    end if;
  end if;
  if to_regprocedure('public.auctions_lokation_fra_postnummer()') is not null then
    v_md5 := pg_temp.krop_md5('public.auctions_lokation_fra_postnummer()'::regprocedure);
    if v_md5 <> '6c548c508313f437dfffff51ba6c3d5d' then
      raise exception 'auctions_lokation_fra_postnummer er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
    end if;
  end if;
  if to_regclass('public.postnummer_koordinater') is null then
    raise exception 'public.postnummer_koordinater mangler - kør de tidligere migrationer først.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Filteret til auktioner
-- ---------------------------------------------------------------------------
create or replace function public.auktion_kontaktinfo_grund(p_tekst text, p_erhverv boolean)
 returns text
 language plpgsql
 immutable parallel safe
 set search_path = public
as $function$
declare
  v text;
  g text;
  m text[];
  -- Værtsnavnet i et link: https://..., www.... eller navn.dk (som chatfilterets links).
  p_vaert constant text :=
    '(https?://[a-z0-9.-]+'
    || '|(?<![a-z0-9.@-])www\.[a-z0-9.-]+'
    || '|(?<![a-z0-9.@-])([a-z0-9-]+\.)+(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)\M)';
  -- Et helt link: værtsnavn + sti/forespørgsel til næste mellemrum.
  p_link constant text := p_vaert || '([/?#:]\S*)?';
  -- Topdomæner til de blokerede tjenester.
  p_tld constant text :=
    '(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co|gg|am|to)\M';
  -- Beskedtjenester og sociale medier som domæne - altid stoppet.
  p_blok_some constant text :=
    '(?<![a-z0-9.@-])([a-z0-9-]+\.)*((wa|t|m|fb)\.me\M|fb\.com\M'
    || '|[a-z0-9-]*(whatsapp|telegram|messenger|facebook|instagram|snapchat|tiktok)[a-z0-9-]*\.' || p_tld || ')';
  p_blok_mobilepay constant text :=
    '(?<![a-z0-9.@-])([a-z0-9-]+\.)*[a-z0-9-]*mobilepay[a-z0-9-]*\.' || p_tld;
  p_blok_betaling constant text :=
    '(?<![a-z0-9.@-])([a-z0-9-]+\.)*[a-z0-9-]*(revolut|paypal|swipp)[a-z0-9-]*\.' || p_tld;
  -- Står et af disse ord i teksten, neutraliseres intet (tjekkes som chatten).
  p_kontaktord constant text :=
    '\m(ring|ringe|ringer|tlf[a-z]*|telefon[a-zæøå]*|mobil|mobilnr|mobilnummer[a-z]*|sms|kontakt'
    || '|whats\s*app|mvh|hilsen|mobile\s*pay|mp'
    || '|konto[a-zæøå]*|bank[a-zæøå]*|iban|overf(ø|o)r[a-zæøå]*|reg|regnr)\M';
  -- Varenummer, artikelnr., produktnr., reservedelsnr., delnr., art.nr., SKU, EAN
  -- + mindst 6 cifre/skilletegn uden mellemrum ("Varenummer 80275887").
  -- "vare", "del", "art" osv. alene tæller ikke - kun med nr/nummer.
  p_vareord constant text :=
    '\m(sku|ean|(vare|artikel|produkt|reservedel|del|art)s?e?\.?\s*(nr|nummer|nummeret))\M\.?[\s:#]*'
    || '[0-9][0-9./-]{4,}[0-9](?![0-9])';
  -- IKEA-format: 402.638.47 (ikke en del af en længere cifferrække).
  p_ikea constant text := '(?<![0-9]\.?)[0-9]{3}\.[0-9]{3}\.[0-9]{2}(?!\.?[0-9])';
  -- Tekniske signalværdier: "Signal: analog", "Signal: 20 dB".
  p_signal constant text :=
    '\msignal\s*[:=]\s*(analog|digital|hdmi|dvb[a-z0-9-]*|wifi|bluetooth|stereo|mono|svagt|godt|stærkt'
    || '|[0-9]+\s*(db|mhz|ghz|hz))\M';
begin
  if coalesce(btrim(p_tekst), '') = '' then
    return null;
  end if;
  v := public.besked_normaliser(p_tekst);
  g := public.besked_spam_grund(v);
  -- E-mail tjekkes altid på hele teksten.
  if g = 'email' then
    return g;
  end if;

  -- a) Beskedtjenester og betalingsapps som link - for alle.
  if v ~ p_blok_some then
    return 'socialt_medie';
  end if;
  if v ~ p_blok_mobilepay then
    return 'mobilepay';
  end if;
  if v ~ p_blok_betaling then
    return 'bank';
  end if;

  if g is null then
    return null;
  end if;

  -- b) Links: stoppes for private. Firmaer: 7+ cifre i et link stoppes, og
  --    kun værtsnavnene fjernes - stien tjekkes med resten af teksten.
  if g = 'link' then
    if not coalesce(p_erhverv, false) then
      return 'link';
    end if;
    for m in select regexp_matches(v, '(' || p_link || ')', 'g') loop
      if length(regexp_replace(m[1], '[^0-9]', '', 'g')) >= 7 then
        return 'telefon';
      end if;
    end loop;
    v := regexp_replace(v, p_vaert, ' ', 'g');
    g := public.besked_spam_grund(v);
    if g is null or g in ('email', 'link') then
      return g;
    end if;
  end if;

  -- c) Intet kontaktord: varenumre, IKEA-numre og signalværdier er ikke
  --    kontaktoplysninger.
  if v !~ p_kontaktord then
    v := regexp_replace(v, p_vareord, ' # ', 'g');
    v := regexp_replace(v, p_ikea, ' # ', 'g');
    v := regexp_replace(v, p_signal, ' # ', 'g');
    g := public.besked_spam_grund(v);
  end if;
  return g;
end;
$function$;

comment on function public.auktion_kontaktinfo_grund(text, boolean) is
  'Kontaktoplysninger i en auktions titel/beskrivelse: grund som besked_spam_grund eller null. Firmaer (p_erhverv) må skrive links (kun værtsnavnet fjernes; 7+ cifre i et link og beskedtjenester/betalingsapps stoppes). Varenumre, IKEA-numre og signalværdier tæller ikke uden kontaktord. SPEJL: auktionKontaktGrund() i src/lib/auktionKontaktinfo.ts. 20261102170000.';

-- Ren funktion (ingen data). Appen må gerne kalde den for at advare i forvejen.
revoke all on function public.auktion_kontaktinfo_grund(text, boolean) from public, anon;
grant execute on function public.auktion_kontaktinfo_grund(text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Afvisningen (BHA08) - fælles for triggeren og "Sæt op igen".
--    null i et felt = feltet tjekkes ikke.
-- ---------------------------------------------------------------------------
create or replace function public.auktion_kontaktinfo_afvis(p_erhverv boolean, p_titel text, p_beskrivelse text)
 returns void
 language plpgsql
 immutable
 set search_path = public
as $function$
declare
  v_erhverv boolean := coalesce(p_erhverv, false);
  v_felt    text;
  v_grund   text;
begin
  v_grund := public.auktion_kontaktinfo_grund(p_titel, v_erhverv);
  if v_grund is not null then
    v_felt := 'titel';
  else
    v_grund := public.auktion_kontaktinfo_grund(p_beskrivelse, v_erhverv);
    if v_grund is not null then
      v_felt := 'beskrivelse';
    end if;
  end if;
  if v_felt is null then
    return;
  end if;
  -- Samme tekster som auktionKontaktTekst() i src/lib/auktionKontaktinfo.ts.
  if v_erhverv then
    raise exception 'Skriv ikke telefonnummer, e-mail, betalingsoplysninger eller sociale medier i %. Jeres kontaktoplysninger står på firmasiden.',
      case v_felt when 'titel' then 'titlen' else 'beskrivelsen' end
      using errcode = 'BHA08',
            detail = jsonb_build_object('felt', v_felt, 'grund', v_grund, 'erhverv', v_erhverv)::text;
  end if;
  raise exception 'Skriv ikke telefonnummer, e-mail eller links i %. Køber og sælger skal tale sammen via BidHamr.',
    case v_felt when 'titel' then 'titlen' else 'beskrivelsen' end
    using errcode = 'BHA08',
          detail = jsonb_build_object('felt', v_felt, 'grund', v_grund, 'erhverv', v_erhverv)::text;
end;
$function$;

comment on function public.auktion_kontaktinfo_afvis(boolean, text, text) is
  'Kaster BHA08 (detail {"felt","grund","erhverv"}), hvis titel eller beskrivelse indeholder kontaktoplysninger. Intern: bruges af auctions_kontaktinfo, saet_annulleret_op_igen og genopsaet_auktion. 20261102170000.';

-- Intern.
revoke all on function public.auktion_kontaktinfo_afvis(boolean, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Triggeren (samme regler som 20261102130000 - teksten følger kontotypen)
-- ---------------------------------------------------------------------------
-- security definer: læser users.konto_type uanset kolonne-grants på users.
create or replace function public.auctions_kontaktinfo()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_erhverv boolean;
begin
  -- Service role, staff-værktøjer og interne job (ingen brugerrolle) må rette.
  -- "Sæt op igen" og genopsætning tjekker selv (auktion_kontaktinfo_afvis).
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.titel is not distinct from old.titel
     and new.beskrivelse is not distinct from old.beskrivelse then
    return new;
  end if;

  select u.konto_type = 'erhverv' into v_erhverv
    from public.users u where u.id = new.bruger_id;

  -- Ved UPDATE tjekkes kun det felt, der faktisk er ændret.
  perform public.auktion_kontaktinfo_afvis(
    coalesce(v_erhverv, false),
    case when tg_op = 'INSERT' or new.titel is distinct from old.titel then new.titel end,
    case when tg_op = 'INSERT' or new.beskrivelse is distinct from old.beskrivelse then new.beskrivelse end);
  return new;
end;
$function$;

comment on function public.auctions_kontaktinfo() is
  'Afviser kontaktoplysninger i titel/beskrivelse (BHA08) for brugere. Service role slipper igennem. 20261102130000, tekst for firmaer 20261102170000.';

revoke all on function public.auctions_kontaktinfo() from public, anon, authenticated;

drop trigger if exists auctions_zzz_kontaktinfo on public.auctions;
create trigger auctions_zzz_kontaktinfo
  before insert or update of titel, beskrivelse on public.auctions
  for each row execute function public.auctions_kontaktinfo();

-- ---------------------------------------------------------------------------
-- 5. lokation udledes af postnummeret
-- ---------------------------------------------------------------------------
-- lokation er offentlig tekst (kort, auktionsside). Hjemmesiden og appen
-- sender bynavnet fra samme postnummerliste som public.postnummer_koordinater
-- (src/data/postnumre.ts), så databasen sætter det selv - for alle roller,
-- så også kopier ("Sæt op igen") får bynavnet. Ukendt postnummer: null.
create or replace function public.auctions_lokation_fra_postnummer()
 returns trigger
 language plpgsql
 set search_path = ''
as $function$
declare
  v_by text;
begin
  if tg_op = 'UPDATE'
     and new.postnummer is not distinct from old.postnummer
     and new.lokation is not distinct from old.lokation then
    return new;
  end if;
  select p.bynavn into v_by
    from public.postnummer_koordinater p
   where p.postnummer = btrim(new.postnummer);
  new.lokation := v_by;
  return new;
end;
$function$;

comment on function public.auctions_lokation_fra_postnummer() is
  'Sætter auctions.lokation til bynavnet for postnummeret (public.postnummer_koordinater), null hvis ukendt. Fri tekst i lokation kan ikke gemmes. 20261102170000.';

revoke all on function public.auctions_lokation_fra_postnummer() from public, anon, authenticated;

drop trigger if exists auctions_lokation_fra_postnummer on public.auctions;
create trigger auctions_lokation_fra_postnummer
  before insert or update of postnummer, lokation on public.auctions
  for each row execute function public.auctions_lokation_fra_postnummer();

comment on column public.auctions.lokation is
  'Bynavn for postnummeret - sættes af databasen (auctions_lokation_fra_postnummer, 20261102170000).';

-- ---------------------------------------------------------------------------
-- 6. "Sæt op igen": tjek titel og beskrivelse (service role - triggeren
--    springer over). Som 20261010030000 + auktion_kontaktinfo_afvis.
-- ---------------------------------------------------------------------------
create or replace function public.saet_annulleret_op_igen(p_auction uuid, p_seller uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  a      record;
  u      record;
  v_kode text;
  v_tjek jsonb;
  dage   integer;
  pris   numeric;
  ny_id  uuid;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_seller is null or a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  select suspenderet, suspenderet_til, konto_lukket_kl, konto_slettet_kl, konto_type into u
    from public.users where id = p_seller;
  if u.konto_lukket_kl is not null or u.konto_slettet_kl is not null then
    return jsonb_build_object('kode', 'konto_lukket');
  end if;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;
  if not public.har_udbetalingskonto(p_seller) then
    return jsonb_build_object('kode', 'mangler_udbetalingskonto');
  end if;

  v_kode := public.kan_saette_op_igen(p_auction);
  if v_kode <> 'ok' then return jsonb_build_object('kode', v_kode); end if;

  -- NYT (erhverv): abonnement og ugens kvote (låser firmarækken).
  if u.konto_type = 'erhverv' then
    v_tjek := public.erhverv_kvote(p_seller, true);
    if v_tjek->>'kode' <> 'ok' then
      return jsonb_build_object('kode', v_tjek->>'kode', 'naeste_ledige', v_tjek->'naeste_ledige');
    end if;
  end if;

  -- Indholdskontrollen (auctions_indhold_kontrol) springer serveren over -
  -- forbudte ord tjekkes derfor her.
  v_tjek := public.forbudt_tekst_tjek(coalesce(a.titel, '') || ' ' || coalesce(a.beskrivelse, ''));
  if v_tjek->>'resultat' = 'blokeret' then
    return jsonb_build_object('kode', 'forbudt_vare', 'ord', v_tjek->>'ord', 'kategori', v_tjek->>'kategori');
  end if;

  -- 20261102170000: kontaktoplysninger (BHA08) - triggeren springer serveren over.
  perform public.auktion_kontaktinfo_afvis(u.konto_type = 'erhverv', a.titel, a.beskrivelse);

  dage := case when public.er_gyldig_varighed(a.varighed_dage) then a.varighed_dage else 7 end;
  pris := greatest(trunc(coalesce(a.startpris, 1)), 1);

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, varighed_dage, redigeret_kl,
    kategori, postnummer, lat, lng, maerke, stand, skjult,
    spoergsmaal_aktiv, forbudt_bekraeftet, producent, sikkerhedsoplysninger)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, pris, a.lokation,
    a.forsendelse_mulig, 'aktiv', now() + make_interval(days => dage), dage,
    date_trunc('milliseconds', now()),
    a.kategori, a.postnummer, a.lat, a.lng, a.maerke, a.stand, false,
    a.spoergsmaal_aktiv, a.forbudt_bekraeftet, a.producent, a.sikkerhedsoplysninger)
  returning id into ny_id;

  insert into public.genopsaetninger (gammel_auction_id, ny_auction_id, seller_id)
  values (a.id, ny_id, a.bruger_id);

  return jsonb_build_object('kode', 'ok', 'auction_id', ny_id);
end;
$function$;

revoke all on function public.saet_annulleret_op_igen(uuid, uuid) from public, anon, authenticated;
grant execute on function public.saet_annulleret_op_igen(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Genopsætning efter en ubetalt vinder: samme tjek. Som 20261005020000 +
--    auktion_kontaktinfo_afvis.
-- ---------------------------------------------------------------------------
create or replace function public.genopsaet_auktion(
  p_auction uuid, p_seller uuid, p_startpris numeric, p_slutter_kl timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  a     record;
  u     record;
  ny_id uuid;
  dage  integer;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  select suspenderet, suspenderet_til, konto_type into u from public.users where id = p_seller;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if not public.har_udbetalingskonto(p_seller) then
    return jsonb_build_object('kode', 'mangler_udbetalingskonto');
  end if;

  if a.status <> 'afsluttet' then return jsonb_build_object('kode', 'ikke_afsluttet'); end if;
  if a.skjult then return jsonb_build_object('kode', 'skjult'); end if;

  if not exists (select 1 from public.ubetalte_vindere v where v.auction_id = a.id) then
    return jsonb_build_object('kode', 'ikke_ubetalt');
  end if;
  if exists (select 1 from public.trades t
              where t.auction_id = a.id and t.status <> 'annulleret') then
    return jsonb_build_object('kode', 'solgt');
  end if;
  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = a.id) then
    return jsonb_build_object('kode', 'allerede_genopsat');
  end if;

  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  -- NYT: mindste startpris 1 kr.
  if p_startpris < 1 then
    return jsonb_build_object('kode', 'startpris_for_lav');
  end if;

  dage := public.varighed_fra_slutter_kl(p_slutter_kl);
  if not public.er_gyldig_varighed(dage) then
    return jsonb_build_object('kode', 'ugyldig_slutdato');
  end if;

  -- 20261102170000: kontaktoplysninger (BHA08) - triggeren springer serveren over.
  perform public.auktion_kontaktinfo_afvis(u.konto_type = 'erhverv', a.titel, a.beskrivelse);

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, varighed_dage, redigeret_kl,
    kategori, postnummer, lat, lng, maerke, stand, skjult)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, p_startpris, a.lokation,
    a.forsendelse_mulig, 'aktiv', now() + make_interval(days => dage), dage,
    date_trunc('milliseconds', now()),
    a.kategori, a.postnummer, a.lat, a.lng, a.maerke, a.stand, false)
  returning id into ny_id;

  insert into public.genopsaetninger (gammel_auction_id, ny_auction_id, seller_id)
  values (a.id, ny_id, a.bruger_id);

  update public.andenchance_tilbud
     set status = 'annulleret', besvaret_kl = now()
   where auction_id = a.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'auction_id', ny_id);
end;
$fn$;

revoke all on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. Testblok - samme liste som tests/enhed/auktionKontaktinfoEksempler.ts.
--    Fejler et eksempel, afbrydes migrationen.
-- ---------------------------------------------------------------------------
do $test$
declare
  r record;
  v_privat text;
  v_firma text;
  v_fejl text := '';
  v_kode text;
  v_detail text;
  v_besked text;
begin
  for r in
    select * from (values
      -- Kontaktoplysninger - stoppes for alle.
      ('Ring på 22 33 44 55 for mere info', 'telefon', 'telefon'),
      ('Spørgsmål? 22334455', 'telefon', 'telefon'),
      ('Tlf. +45 2233 4455', 'telefon', 'telefon'),
      ('Skriv til hans@gmail.com', 'email', 'email'),
      ('Kontakt info@firma.dk', 'email', 'email'),
      ('Betal med MobilePay 22334455', 'mobilepay', 'mobilepay'),
      ('MobilePay 22334455', 'mobilepay', 'mobilepay'),
      ('Overfør til reg 1234 konto 12345678', 'bank', 'bank'),
      ('Skriv på snap @hans_123', 'socialt_medie', 'socialt_medie'),
      -- Links - stoppes for private, må gerne stå for firmaer.
      ('Se flere billeder på www.dba.dk', 'link', null),
      ('Læs mere på https://firma.dk/sofaer/model-x', 'link', null),
      ('Producentens side: firma.com', 'link', null),
      ('www.firma.dk', 'link', null),
      ('Se www.firma.dk - varenr. 80275887', 'link', null),
      -- Et link fjerner ikke resten.
      ('Se www.firma.dk eller ring 22 33 44 55', 'link', 'telefon'),
      ('Se www.firma.dk - MobilePay 22334455', 'link', 'mobilepay'),
      ('www.firma.dk / salg@firma.dk', 'email', 'email'),
      -- Stien tjekkes, og 7+ cifre i et link stoppes.
      ('www.firma.dk/22334455', 'link', 'telefon'),
      ('Se https://firma.dk/sofa?tlf=22334455', 'link', 'telefon'),
      ('www.firma.dk/produkt/1234567', 'link', 'telefon'),
      ('Se 22334455.dk', 'link', 'telefon'),
      -- Beskedtjenester og betalingsapps - stoppes også for firmaer.
      ('https://wa.me/4522334455', 'socialt_medie', 'socialt_medie'),
      ('t.me/firmaet', 'socialt_medie', 'socialt_medie'),
      ('instagram.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('Følg os: www.facebook.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('m.me/firmaet', 'socialt_medie', 'socialt_medie'),
      ('mobilepay.dk/box/12345', 'mobilepay', 'mobilepay'),
      ('Betal på paypal.me/firmaet', 'bank', 'bank'),
      -- Varenumre, IKEA-numre og signalværdier (uden kontaktord).
      ('Varenummer 80275887', null, null),
      ('IKEA Billy reol 402.638.47', null, null),
      ('IKEA Billy reol 402.638.47.', null, null),
      ('Signal: analog', null, null),
      ('Art.nr. 802-758-87, reservedelsnr 40263847', null, null),
      ('Varenummer 80275887 ring 22334455', 'telefon', 'telefon'),
      ('Varenummer 80275887 22334455', 'telefon', 'telefon'),
      ('Vare 22334455', 'telefon', 'telefon'),
      ('Fin sofa. 22334455. Afhentes.', 'telefon', 'telefon'),
      ('Signal: hans_123', 'socialt_medie', 'socialt_medie'),
      -- Almindelige beskrivelser - slipper igennem.
      ('Sofa i grå uld. Mål: 200 x 90 x 45 cm. Nypris 4.500 kr, sælges for 1.200 kr.', null, null),
      ('Købt 12.03.2024, brugt ca. 10 gange. Afhentes efter 24/12.', null, null),
      ('Cykel 28 tommer, 7 gear, årgang 2019. Stelnummer WAW12345678.', null, null),
      ('iPhone 13, 128 GB, sort. Batteri 87 %. IMEI 356938035643809', null, null),
      ('Lego 42115, komplet med vejledning og æske', null, null),
      ('Børnetøj str 86 92 98 104, 10 dele', null, null),
      ('Kan sendes med GLS eller afhentes i 8000 Aarhus C', null, null),
      ('Fra 2019/2020. Pris 2.500-3.000 ved nypris.', null, null)
    ) as x(tekst, privat, firma)
  loop
    v_privat := public.auktion_kontaktinfo_grund(r.tekst, false);
    v_firma := public.auktion_kontaktinfo_grund(r.tekst, true);
    if v_privat is distinct from r.privat then
      v_fejl := v_fejl || format(E'\n  privat %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.privat, 'null'), coalesce(v_privat, 'null'));
    end if;
    if v_firma is distinct from r.firma then
      v_fejl := v_fejl || format(E'\n  firma %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.firma, 'null'), coalesce(v_firma, 'null'));
    end if;
  end loop;
  if public.auktion_kontaktinfo_grund(null, false) is not null
     or public.auktion_kontaktinfo_grund('   ', true) is not null then
    v_fejl := v_fejl || E'\n  tom tekst skulle give null';
  end if;

  -- Afvisningen: fejlkode, felt og tekst (firmaer får ikke "links").
  begin
    perform public.auktion_kontaktinfo_afvis(true, 'Sofa', 'Ring 22334455');
    v_fejl := v_fejl || E'\n  afvis(firma) kastede ikke';
  exception when sqlstate 'BHA08' then
    get stacked diagnostics v_besked = message_text, v_detail = pg_exception_detail;
    if v_besked ~ 'links' or v_detail::jsonb->>'felt' <> 'beskrivelse'
       or (v_detail::jsonb->>'erhverv')::boolean is not true then
      v_fejl := v_fejl || format(E'\n  afvis(firma): %s / %s', v_besked, v_detail);
    end if;
  end;
  begin
    perform public.auktion_kontaktinfo_afvis(false, 'Se www.dba.dk', null);
    v_fejl := v_fejl || E'\n  afvis(privat) kastede ikke';
  exception when sqlstate 'BHA08' then
    get stacked diagnostics v_besked = message_text, v_detail = pg_exception_detail;
    if v_besked !~ 'links i titlen' or v_detail::jsonb->>'grund' <> 'link' then
      v_fejl := v_fejl || format(E'\n  afvis(privat): %s / %s', v_besked, v_detail);
    end if;
  end;
  perform public.auktion_kontaktinfo_afvis(true, 'Sofa fra www.firma.dk', 'Varenummer 80275887');

  if v_fejl <> '' then
    raise exception 'Kontaktinfo-filteret til auktioner fejlede:%', v_fejl;
  end if;
end
$test$;
