-- Ingen automatisk betaling (Filip, 9. okt. 2026 - ROADMAP-BESLUTNINGER.md
-- øverst, CLAUDE.md regel 3): alle vindere ender på checkout-siden og betaler
-- selv. Et gemt kort bruges kun til at forudfylde checkout og trækkes kun,
-- når køberen selv trykker Betal.
--
-- Serveren har ikke længere kode, der trækker et kort automatisk
-- (forsoegAutobetaling er fjernet). Denne migration gør det umuligt at slå
-- automatisk betaling til igen - hverken fra hjemmesiden, appen eller en
-- gammel server-version:
--
--  1. Drift-tjek: triggerfunktionen betalingsprofiler_samtykke() skal være
--     repoets version (20261010070000_niels_betaling.sql), før den droppes.
--  2. Triggeren betalingsprofiler_samtykke droppes FØR opdateringen, så den
--     ikke nulstiller autobetaling_samtykke_version: samtykkeloggen
--     (autobetaling_samtykke_kl/_version) bevares som historik.
--  3. betalingsprofiler.autobetaling = false for alle. Hvor den var slået til,
--     sættes autobetaling_fravalgt_kl = nu (hvornår den blev slået fra).
--  4. CHECK autobetaling_altid_fra (autobetaling = false): kolonnen kan ikke
--     sættes til true igen. Kolonnen bevares (default false), så ældre kode,
--     der skriver false (fx "Fjern kort", sletning af konto), stadig virker.
--  5. Funktionen betalingsprofiler_samtykke() droppes (kun brugt af
--     triggeren; tjekkes først).
--
-- Bevares uændret (handelsdata slettes aldrig): betalinger.autobetaling_
-- forsoegt_kl og autobetaling_resultat, betalingsprofiler.autobetaling_
-- samtykke_kl, autobetaling_samtykke_version og autobetaling_fravalgt_kl.
--
-- Idempotent. Ingen rettigheder ændres.

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Forudsætninger og drift-tjek
-- ===========================================================================
do $do$
declare
  h text;
  n integer;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'betalingsprofiler'
       and column_name = 'autobetaling_fravalgt_kl'
  ) then
    raise exception 'ingen_autobetaling: 20261010070000_niels_betaling.sql er ikke kørt - kør den først';
  end if;

  if to_regprocedure('public.betalingsprofiler_samtykke()') is not null then
    -- Samme normalisering som de øvrige drift-tjek (CR, kommentarer og al
    -- whitespace fjernes, små bogstaver).
    select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
      into h
      from pg_proc p where p.oid = 'public.betalingsprofiler_samtykke()'::regprocedure;
    if h is distinct from 'cc6e4f6cffba780ed060509d773e4273' then
      raise exception 'public.betalingsprofiler_samtykke(): kroppen afviger fra repoets version (md5 %) - kontrollér funktionen, før migrationen køres', h;
    end if;

    -- Funktionen må kun bruges af triggeren på betalingsprofiler.
    select count(*) into n
      from pg_trigger t
     where t.tgfoid = 'public.betalingsprofiler_samtykke()'::regprocedure
       and not (t.tgrelid = 'public.betalingsprofiler'::regclass
                and t.tgname = 'betalingsprofiler_samtykke');
    if n > 0 then
      raise exception 'public.betalingsprofiler_samtykke() bruges af % anden trigger(e) - kontrollér før migrationen køres', n;
    end if;
  end if;
end $do$;

-- ===========================================================================
-- 1. Triggeren droppes først (bevarer samtykkeloggen)
-- ===========================================================================
drop trigger if exists betalingsprofiler_samtykke on public.betalingsprofiler;

-- ===========================================================================
-- 2. Automatisk betaling slås fra for alle
-- ===========================================================================
update public.betalingsprofiler
   set autobetaling = false,
       autobetaling_fravalgt_kl = now(),
       opdateret = now()
 where autobetaling;

-- ===========================================================================
-- 3. Kan ikke slås til igen
-- ===========================================================================
do $do$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.betalingsprofiler'::regclass
       and conname = 'autobetaling_altid_fra'
  ) then
    alter table public.betalingsprofiler
      add constraint autobetaling_altid_fra check (autobetaling = false);
  end if;
end $do$;

-- ===========================================================================
-- 4. Funktionen, der kun blev brugt af triggeren
-- ===========================================================================
drop function if exists public.betalingsprofiler_samtykke();

-- ===========================================================================
-- 5. Dokumentation på kolonnerne
-- ===========================================================================
comment on column public.betalingsprofiler.autobetaling is
  'Historik. Automatisk betaling findes ikke længere (Filip, 9. okt. 2026) - altid false (CHECK autobetaling_altid_fra). Et gemt kort bruges kun til at forudfylde checkout.';
comment on column public.betalingsprofiler.autobetaling_samtykke_kl is
  'Historik: hvornår brugeren sidst slog automatisk betaling til (før 9. okt. 2026). Skrives ikke længere.';
comment on column public.betalingsprofiler.autobetaling_samtykke_version is
  'Historik: versionen af samtykketeksten, brugeren så. Version 2026-10-08 = "Betal automatisk, når jeg vinder. Tilvalg: Vinder du, trækkes totalprisen på dit gemte kort. Du kan slå det fra når som helst." ''ukendt'' = slået til uden version. Skrives ikke længere.';
comment on column public.betalingsprofiler.autobetaling_fravalgt_kl is
  'Historik: hvornår automatisk betaling blev slået fra (af brugeren, eller af 20261012020000_ingen_autobetaling.sql). Skrives ikke længere.';
comment on column public.betalinger.autobetaling_forsoegt_kl is
  'Historik: hvornår et automatisk træk blev forsøgt (før 9. okt. 2026). Skrives ikke længere.';
comment on column public.betalinger.autobetaling_resultat is
  'Historik: resultatet af det automatiske træk (før 9. okt. 2026). Skrives ikke længere.';
