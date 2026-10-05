-- Rettelser til 20261006030000_tryghed_chat_kontakt.sql (test og review).
--
--   Telefonnumre: tal adskilt af mellemrum slaas IKKE laengere sammen.
--     Stoppes kun: (a) +45/0045/(+45) + 8 cifre (evt. mellemrum, bindestreg,
--     punktum), (b) 8 cifre i traek (foerste 2-9), der ikke er del af en
--     laengere cifferraekke, (c) 2-2-2-2 eller 4-4 (mellemrum, bindestreg,
--     punktum, foerste ciffer 2-9) med et kontaktord hoejst 25 tegn foer
--     (ring, tlf, telefon, mobil, sms, skriv til, kontakt mig, whatsapp,
--     signal, nummer - IKKE nr/ordrenr/postnr/model/str/stoerrelse).
--   M1: anonyme byder-spaerringer (kilde_auktion_id sat) rammer kun bud, ikke
--     chat: chatten bruger er_blokeret_navngivet_mellem().
--   M2: messages_tryghed: afsender, der ikke er part i handlen, slipper
--     igennem til RLS (afsloerer hverken blokering eller hastighedsgraense).
--   M3: MobilePay er en officiel betalingsmetode (Stripe). Kun MobilePay-
--     numre stoppes (4-5 cifre lige efter mobilepay/mp [boks], eller et
--     telefonnummer kort efter); beloeb med kr/,- rammes aldrig.
--     besked_mistaenkelig markerer kun betalingsapps sammen med
--     direkte/privat/til mig/udenom/uden om/uden BidHamr.
--   L5: links: kun bidhamr.dk med sti [a-z0-9/_-]* er tilladt
--     ("bidhamr.dk/evil.com" fanges); flere topdomaener og t.me fanges;
--     fragtfirmaernes sporingsdomaener er tilladt.
--   L6: "gentaget" taelles pr. handel.
--   L7: handel_i_gang daekker ogsaa sager afgjort med penge_handling 'ingen'
--     i ankefristen (afgjort_kl + 4 dage) og alle uafviklede afgoerelser.
--
-- Genskrevet (praecis kopi af 20261006030000 + aendringen):
--   handel_i_gang, besked_spam_grund, besked_mistaenkelig, messages_tryghed.
-- Ny intern funktion: er_blokeret_navngivet_mellem.
-- SPEJL: src/lib/tryghed.ts (spamGrund) - hold reglerne synkrone.
--
-- moderation_log_handling_check / maal_type_check roeres IKKE
-- (brugerRapportBehandlet logger med den eksisterende 'rapport_behandlet').
-- Idempotent: create or replace. Ingen data aendres.
-- Sidst i filen: DO-blok med testeksempler - fejler et eksempel, afbrydes
-- migrationen. Datatests (M1, M2, L6): supabase/testscripts/.

-- ============================================================ M1

-- Kun NAVNGIVNE blokeringer (kilde_auktion_id is null) i en af retningerne.
-- Bruges af chatten, saa en saelger ikke kan afsloere en anonymt spaerret
-- byder ved at se, om chatten afvises (BHB01). Intern: kun service_role.
create or replace function public.er_blokeret_navngivet_mellem(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.brugerblokeringer b
     where b.kilde_auktion_id is null
       and ((b.blokerer_id = p_a and b.blokeret_id = p_b)
            or (b.blokerer_id = p_b and b.blokeret_id = p_a)));
$fn$;

revoke all on function public.er_blokeret_navngivet_mellem(uuid, uuid) from public, anon, authenticated;
grant execute on function public.er_blokeret_navngivet_mellem(uuid, uuid) to service_role;

-- ============================================================ L7

-- Er handlen i gang (betaling, forsendelse, afhentning, sag eller anke)?
-- Saa maa en blokering ikke stoppe chatten - parterne skal kunne gennemfoere
-- handlen og bruge sagsflowet.
-- NYT: en afgjort sag taeller, saa laenge ankefristen (4 dage efter
-- afgjort_kl) loeber, og saa laenge afgoerelsen ikke er afviklet - ogsaa
-- penge_handling 'ingen'.
create or replace function public.handel_i_gang(p_trade uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
           select 1 from public.trades t
            where t.id = p_trade
              and (t.status in ('afventer_betaling', 'betaling_modtaget', 'pakke_sendt', 'modtaget')
                   or t.sag_aaben))
      or exists (
           select 1 from public.sager s
            where s.trade_id = p_trade
              and (s.status in ('aaben', 'afventer_retur')
                   or (s.penge_handling in ('refunder', 'frigiv', 'ingen') and s.afviklet_kl is null)
                   or (s.afgjort_kl is not null and s.afgjort_kl > now() - interval '4 days')))
      or exists (
           select 1 from public.sag_anker a
            where a.trade_id = p_trade and a.status = 'afventer');
$fn$;

revoke all on function public.handel_i_gang(uuid) from public, anon, authenticated;
grant execute on function public.handel_i_gang(uuid) to service_role;

-- ============================================================ Spamfilter

-- Kontaktoplysninger, der skal stoppes: 'email', 'link', 'telefon',
-- 'mobilepay' eller null. Links til bidhamr.dk og fragtfirmaernes
-- sporingssider er tilladt.
-- SPEJL: spamGrund() i src/lib/tryghed.ts - samme regler, hold synkron.
--
-- Eksempler (testet i DO-blokken sidst i filen):
--   ikke stoppet: "Jeg har størrelse 42 43 44 45", "Postnr 8000 8200",
--     "Den koster 2500 3000 kr afhængig af model", "Den er fra 2019 2020",
--     "Ordrenr 2024 1234", "Model 25-10-20-30", "22 34 56 78" (uden
--     kontaktord), "sporing 00370730253300123456", "Prisen er 1.250 kr,
--     12.10.2026", "Kan jeg betale med MobilePay? 1250 kr er fint"
--   stoppet: "ring på 22 34 56 78", "+45 22 34 56 78", "22345678",
--     "Tlf. 2234 5678", "mobilepay 12345", "bidhamr.dk/evil.com"
create or replace function public.besked_spam_grund(p_tekst text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public
as $fn$
declare
  v text := public.besked_normaliser(p_tekst);
  w text;
  -- Telefonnummer-dele (bruges ogsaa efter "mobilepay").
  -- (a) +45 / 0045 / (+45) + 8 cifre, evt. adskilt af mellemrum, - eller .
  p_landekode constant text :=
    '(\(\s*\+\s*45\s*\)|\+\s*45|(?<![0-9])0045)[\s.-]{0,2}[0-9]([\s.-]{0,2}[0-9]){7}(?![0-9])';
  -- (b) 8 cifre i traek, foerste 2-9, ikke del af en laengere cifferraekke.
  p_otte constant text := '(?<![0-9])[2-9][0-9]{7}(?![0-9])';
  -- (c) 2-2-2-2 eller 4-4 (kraever et kontaktord foran).
  p_grupperet constant text :=
    '(?<![0-9])([2-9][0-9][\s.-][0-9]{2}[\s.-][0-9]{2}[\s.-][0-9]{2}|[2-9][0-9]{3}[\s.-][0-9]{4})(?![0-9])';
  p_kontaktord constant text :=
    '\m(ring|ringe|ringer|tlf|tlfnr|telefon|telefonnummer|telefonnummeret|telefonnr'
    || '|mobil|mobilnummer|mobilnummeret|mobilnr|sms|skriv til|kontakt mig'
    || '|whats\s*app|signal|nummer|nummeret)\M';
  p_mobilepay constant text := '(mobile\s*pay|\mmp\M)';
begin
  -- E-mail, ogsaa "navn (at) mail punktum dk" og "snabel-a". (Uaendret.)
  if v ~ '[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\msnabel-?a\M)\s*[a-z0-9-]+(\.|\s+(punktum|dot)\s+)[a-z]{2,}' then
    return 'email';
  end if;

  -- Links. Tilladte adresser fjernes foerst:
  --   bidhamr.dk med sti af [a-z0-9/_-] (ikke "bidhamr.dk/evil.com" eller
  --   "evil-bidhamr.dk"), og fragtfirmaernes sporingssider.
  w := regexp_replace(v,
         '(?<![a-z0-9.@-])(https?://)?(www\.)?bidhamr\.dk(/[a-z0-9/_-]*)?(?![a-z0-9@-]|\.[a-z0-9])',
         ' ', 'g');
  w := regexp_replace(w,
         '(?<![a-z0-9.@-])(https?://)?([a-z0-9-]+\.)*'
         || '(gls\.dk|gls-group\.eu|gls-group\.com|postnord\.dk|dao\.as|bring\.dk'
         || '|ups\.com|dhl\.dk|dhl\.com|shipmondo\.com)'
         || '(/[a-z0-9/_?=&%#+-]*)?(?![a-z0-9@-]|\.[a-z0-9])',
         ' ', 'g');
  if w ~ '(https?://|www\.)'
     or w ~ '\m[a-z0-9-]{2,}\.(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)\M'
     or w ~ '\mt\.me\M'
     or w ~ '\m[a-z0-9-]{2,}\s+(punktum|dot)\s+(dk|com|net|org|io|me|eu|se|de|no|nu|co)\M' then
    return 'link';
  end if;

  -- MobilePay-nummer: 4-5 cifre lige efter "mobilepay"/"mp" (evt. "boks",
  -- "nr", "nummer", "på", "til", ":"), men aldrig et beloeb ("1250 kr",
  -- "1250,-"). Eller et telefonnummer hoejst 25 tegn efter.
  if v ~ (p_mobilepay || '(\s*(boks|box))?[\s:#.]*((nr|nummer|nummeret|på|til)[\s:#.]*)?'
          || '(?<![0-9])[0-9]{4,5}(?![0-9])(?!\s*(kr|dkk|,-|\.-|,[0-9]|\.[0-9]))')
     or v ~ (p_mobilepay || '.{0,25}(' || p_landekode || '|' || p_otte || '|' || p_grupperet || ')') then
    return 'mobilepay';
  end if;

  -- Danske telefonnumre. Tal adskilt af mellemrum slaas IKKE sammen
  -- ("str. 42 43 44 45", "postnr 8000 8200" er ikke telefonnumre).
  if v ~ p_landekode
     or v ~ p_otte
     or v ~ (p_kontaktord || '.{0,25}' || p_grupperet) then
    return 'telefon';
  end if;

  return null;
end;
$fn$;

revoke all on function public.besked_spam_grund(text) from public, anon;
grant execute on function public.besked_spam_grund(text) to authenticated, service_role;

-- Mistaenkeligt (forsoeg paa at handle uden om BidHamr). Beskeden sendes,
-- men markeres til staff.
-- NYT: betalingsapps (MobilePay er en officiel betalingsmetode via Stripe)
-- markeres kun sammen med direkte/privat/til mig/udenom/uden om/uden BidHamr.
create or replace function public.besked_mistaenkelig(p_tekst text)
returns boolean
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select public.besked_normaliser(p_tekst) ~ (
    'udenom|uden om (bidhamr|bid hamr|siden|appen|platformen|gebyr)'
    || '|uden (gebyr|gebyret|gebyrer)|spar(e|er)? (gebyr|gebyret|gebyrerne)'
    || '|betal(e|er)? (direkte|privat|kontant)|direkte (overf|betaling)'
    || '|bankoverf|overf(ø|o)r(e|er|sel)? (pengene|beløbet|belobet|direkte)'
    || '|\mreg\.?\s*(nr|nummer)\M|kontonummer|kontonr'
    || '|(mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M).{0,40}'
    ||   '(direkte|privat|til mig|udenom|uden om|uden (bidhamr|bid hamr))'
    || '|(direkte|privat|til mig|udenom|uden om|uden (bidhamr|bid hamr)).{0,40}'
    ||   '(mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M)'
    || '|whats\s*app|telegram|snapchat|\msnap\M|messenger'
    || '|ring til mig|sms (til )?mig|skriv (til mig )?på (mail|sms|face|insta|snap)');
$fn$;

revoke all on function public.besked_mistaenkelig(text) from public, anon;
grant execute on function public.besked_mistaenkelig(text) to authenticated, service_role;

-- BEFORE INSERT/UPDATE paa messages: blokering, hastighed og spamfilter.
-- service_role (faellesbeskeder fra BidHamr) og postgres (seed) er undtaget.
-- NYT: M1 (kun navngivne blokeringer), M2 (ikke-part -> RLS), L6 (gentaget
-- pr. handel). Triggeren er uaendret (oprettet i 20261006030000).
create or replace function public.messages_tryghed()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t         record;
  v_modpart uuid;
  v_grund   text;
  v_norm    text;
  n         integer;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null
     and current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Markeringen kan ikke fjernes eller saettes af brugere.
    new.blokeret_grund := old.blokeret_grund;
    return new;
  end if;

  new.blokeret_grund := null;
  if new.fra_bidhamr then
    return new;
  end if;

  select id, buyer_id, seller_id into t from public.trades where id = new.trade_id;
  if not found then
    return new;   -- RLS/fremmednoeglen afviser
  end if;
  -- NYT (M2): ikke part i handlen -> RLS afviser, uden at afsloere
  -- blokering eller hastighedsgraense.
  if new.sender_id is null
     or (new.sender_id is distinct from t.buyer_id
         and new.sender_id is distinct from t.seller_id) then
    return new;
  end if;
  v_modpart := case when new.sender_id = t.buyer_id then t.seller_id else t.buyer_id end;

  -- Blokering: kun uden for en handel, der er i gang.
  -- NYT (M1): kun navngivne blokeringer. En anonym byder-spaerring rammer
  -- kun bud - ellers kunne saelgeren afsloere byderen via chatten.
  if public.er_blokeret_navngivet_mellem(v_modpart, new.sender_id)
     and not public.handel_i_gang(t.id) then
    raise exception 'Du kan ikke skrive til denne bruger.' using errcode = 'BHB01';
  end if;

  -- For mange beskeder: 10 pr. minut og 150 pr. time (alle handler).
  select count(*) into n from public.messages
   where sender_id = new.sender_id and created_at > now() - interval '1 minute';
  if n >= 10 then
    raise exception 'Du sender beskeder for hurtigt.' using errcode = 'BHM03';
  end if;
  select count(*) into n from public.messages
   where sender_id = new.sender_id and created_at > now() - interval '1 hour';
  if n >= 150 then
    raise exception 'Du sender beskeder for hurtigt.' using errcode = 'BHM03';
  end if;

  v_grund := public.besked_spam_grund(new.content);

  -- Gentagne ens beskeder: den tredje ens besked inden for 30 minutter
  -- i SAMME handel (NYT, L6) stoppes. Korte svar ("ok", "tak") taeller ikke.
  if v_grund is null and char_length(btrim(new.content)) >= 10 then
    v_norm := public.besked_sammenlign(new.content);
    select count(*) into n from public.messages m
     where m.sender_id = new.sender_id
       and m.trade_id = new.trade_id
       and m.created_at > now() - interval '30 minutes'
       and public.besked_sammenlign(m.content) = v_norm;
    if n >= 2 then
      v_grund := 'gentaget';
    end if;
  end if;

  new.blokeret_grund := v_grund;
  return new;
end;
$fn$;

revoke all on function public.messages_tryghed() from public, anon, authenticated;

-- ============================================================ Test

-- Fejler et eksempel, afbrydes migrationen (intet er aendret).
-- Samme eksempler testes i TypeScript-spejlet (src/lib/tryghed.ts).
do $test$
declare
  r record;
  v_faktisk text;
  v_fejl text := '';
begin
  for r in
    select * from (values
      -- Telefon: falske positiver fra test - maa IKKE stoppes.
      ('Jeg har størrelse 42 43 44 45', null),
      ('Skostørrelse 38 39 40 41 er udsolgt', null),
      ('Postnr 8000 8200', null),
      ('Den koster 2500 3000 kr afhængig af model', null),
      ('Den er fra 2019 2020', null),
      ('Ordrenr 2024 1234', null),
      ('Model 25-10-20-30', null),
      ('22 34 56 78', null),
      ('sporing 00370730253300123456', null),
      ('Prisen er 1.250 kr, 12.10.2026', null),
      ('EAN 5701234567890 og IMEI 356938035643809', null),
      ('Str 2234 5678', null),
      -- Telefon: skal stoppes.
      ('ring på 22 34 56 78', 'telefon'),
      ('+45 22 34 56 78', 'telefon'),
      ('(+45) 22345678', 'telefon'),
      ('0045 2234-5678', 'telefon'),
      ('22345678', 'telefon'),
      ('Tlf. 2234 5678', 'telefon'),
      ('Mit nummer er 22-34-56-78', 'telefon'),
      ('skriv til mig på whatsapp 22.34.56.78', 'telefon'),
      -- MobilePay (M3).
      ('Kan jeg betale med MobilePay? 1250 kr er fint', null),
      ('mobilepay 1250 kr', null),
      ('mp 1250,-', null),
      ('Jeg betaler gerne med MobilePay', null),
      ('mobilepay 12345', 'mobilepay'),
      ('MobilePay boks: 4321', 'mobilepay'),
      ('mp nr 98765', 'mobilepay'),
      ('send på mobilepay til 22 34 56 78', 'mobilepay'),
      -- Links (L5).
      ('se bidhamr.dk/auktion/123', null),
      ('Se mere på bidhamr.dk.', null),
      ('https://www.bidhamr.dk/handler', null),
      ('Pakken kan følges på gls-group.eu/DK/da/find-pakke?match=123', null),
      ('https://tracking.postnord.dk/da/?id=00370730253300123456', null),
      ('www.dhl.dk og shipmondo.com', null),
      ('bidhamr.dk/evil.com', 'link'),
      ('evil-bidhamr.dk', 'link'),
      ('bidhamr.dk.evil.com', 'link'),
      ('gls.dk.evil.io', 'link'),
      ('kig på shop.io', 'link'),
      ('skriv på t.me/minkanal', 'link'),
      ('min side minside.se', 'link'),
      ('evilgls.dk', 'link'),
      -- E-mail (uaendret).
      ('skriv til hans@mail.dk', 'email')
    ) as x(tekst, forventet)
  loop
    v_faktisk := public.besked_spam_grund(r.tekst);
    if v_faktisk is distinct from r.forventet then
      v_fejl := v_fejl || format(E'\n  %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.forventet, 'null'), coalesce(v_faktisk, 'null'));
    end if;
  end loop;

  for r in
    select * from (values
      ('Kan jeg betale med MobilePay?', false),
      ('Jeg har både MobilePay og PayPal', false),
      ('Send pengene direkte på MobilePay', true),
      ('mobilepay til mig så slipper vi gebyret', true),
      ('Betal via revolut uden om BidHamr', true),
      ('Vi kan tage den på paypal privat', true)
    ) as x(tekst, forventet)
  loop
    if public.besked_mistaenkelig(r.tekst) is distinct from r.forventet then
      v_fejl := v_fejl || format(E'\n  mistaenkelig %L: forventet %s', r.tekst, r.forventet);
    end if;
  end loop;

  if v_fejl <> '' then
    raise exception 'Spamfilter-test fejlede:%', v_fejl;
  end if;
end;
$test$;
