set lock_timeout = '5s';

-- Visningspris: den pris, kortet viser (nuværende bud, ellers startpris).
-- Sorteringen "Laveste bud"/"Højeste bud" på /auktioner bruger den, så en
-- auktion uden bud sorteres efter sin startpris i stedet for at havne sidst.
--
-- Genereret kolonne: databasen udfylder den selv. Den må ikke sendes med i
-- insert/update (web og app sender kun navngivne kolonner).
alter table public.auctions
  add column if not exists visningspris numeric
  generated always as (coalesce("nuværende_bud", startpris)) stored;

comment on column public.auctions.visningspris is
  'Viste pris: coalesce(nuværende_bud, startpris). Genereret – skriv aldrig til den.';

-- Sortering efter pris på aktive, synlige auktioner (id som fast tie-breaker,
-- som i src/lib/auktionSoegning.ts).
create index if not exists auctions_aktive_visningspris_idx
  on public.auctions (visningspris, id)
  where status = 'aktiv' and skjult = false;
