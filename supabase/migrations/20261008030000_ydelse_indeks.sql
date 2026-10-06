-- Hastighedsgennemgang (fase 5): indeks til de forespørgsler, forsiden,
-- /auktioner (med sidetal), auktionssiden og Mine handler bruger.
-- Kun nye indeks - ingen data eller regler ændres. Kan køres igen.
--
-- Bemærk: almindelig "create index" låser tabellen for skrivning, mens indekset
-- bygges. Tabellerne er små nu (sekunder). Er de blevet store, så kør hver
-- linje for sig som "create index concurrently" uden for en transaktion.

-- Søgning i titler: ilike '%ord%' kan ikke bruge et almindeligt b-tree-indeks.
-- pg_trgm kan allerede være installeret i et andet skema; indekset bruger det
-- skema, udvidelsen faktisk ligger i.
create extension if not exists pg_trgm with schema extensions;

do $$
declare
  skema text;
begin
  select n.nspname into skema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  execute format(
    'create index if not exists auctions_titel_trgm_idx on public.auctions using gin (titel %I.gin_trgm_ops)',
    skema
  );
end
$$;

-- Listerne viser kun aktive, synlige auktioner. Delvise indeks dækker præcis
-- de rækker og de to mest brugte sorteringer ("Slutter snart" og "Nyeste").
create index if not exists auctions_aktive_slutter_idx
  on public.auctions (slutter_kl, id)
  where status = 'aktiv' and skjult = false;

create index if not exists auctions_aktive_oprettet_idx
  on public.auctions (oprettet desc)
  where status = 'aktiv' and skjult = false;

-- Kategorisider (/auktioner?kategori=...), sorteret efter sluttid.
create index if not exists auctions_aktive_kategori_idx
  on public.auctions (kategori, slutter_kl)
  where status = 'aktiv' and skjult = false;

-- Auktionssiden henter de seneste 50 bud på én auktion (nyeste først).
create index if not exists bids_auktion_oprettet_idx
  on public.bids (auktion_id, oprettet desc);
