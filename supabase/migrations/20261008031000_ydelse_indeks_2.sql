-- Ydelse 2: fjern det gamle enkelt-kolonne-indeks på bids(auktion_id).
--
-- bids_auktion_oprettet_idx (auktion_id, oprettet desc) fra
-- 20261008030000_ydelse_indeks.sql dækker alle opslag på auktion_id (det er
-- første kolonne), også fremmednøglens opslag, når en auktion ændres. Det
-- gamle indeks koster derfor kun skrivetid og plads.
--
-- Sikkerhedsnet: indekset droppes KUN, hvis det nye indeks findes og er
-- gyldigt, og intet (constraint eller anden afhængighed) bruger det gamle.
-- Tjekket med SELECT i både test og produktion 2026-10-06: ingen
-- pg_constraint.conindid og ingen pg_depend-rækker peger på det.
-- Er den forrige migration ikke kørt, gør denne intet. Kan køres igen.

do $$
begin
  if exists (
       select 1
       from pg_index i
       where i.indexrelid = to_regclass('public.bids_auktion_oprettet_idx')
         and i.indisvalid
     )
     and to_regclass('public.bids_auktion_id_idx') is not null
     and not exists (
       select 1 from pg_constraint c
       where c.conindid = to_regclass('public.bids_auktion_id_idx')
     )
     and not exists (
       select 1 from pg_depend d
       where d.refclassid = 'pg_class'::regclass
         and d.refobjid = to_regclass('public.bids_auktion_id_idx')
     )
  then
    drop index if exists public.bids_auktion_id_idx;
    raise notice 'bids_auktion_id_idx droppet';
  else
    raise notice 'bids_auktion_id_idx beholdt (betingelserne er ikke opfyldt)';
  end if;
end
$$;
