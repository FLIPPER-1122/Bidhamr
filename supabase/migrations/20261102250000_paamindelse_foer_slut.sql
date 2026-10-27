-- Påmindelse 1 time før en auktion slutter (Filip, 27. okt. 2026 -
-- ROADMAP-BESLUTNINGER.md, "Nye funktioner før lancering", punkt 5).
--
-- Brugere, der har auktionen som favorit ELLER har budt på den, får ÉN
-- påmindelse, når der er under 1 time tilbage:
--   - har budt og fører:        "Slutter om 1 time – du fører"
--   - har budt og fører ikke:   "Slutter om 1 time – du fører ikke længere"
--   - kun favorit:              "Slutter om 1 time"
-- Teksterne bygges i src/lib/notifikationer/paamindelseFoerSlut.ts.
--
-- Typen er den eksisterende VALGFRI 'fulgt_slutter_snart' (vises nu som
-- "Auktion slutter snart" under notifikationer). Brugernes gemte valg for
-- typen gælder uændret. Ingen ny type, så notifikation_kendt_type og
-- indstillingstabellen røres ikke.
--
-- Indhold:
--   1. auktion_paamindelser: idempotens-tabel, ÉN række pr. (auktion, bruger).
--      Primærnøglen er (auktion_id, bruger_id) - ikke sluttidspunktet - så en
--      forlængelse ved sene bud aldrig giver en påmindelse til. Kun
--      service_role. Rækkerne slettes ikke (lille tabel; viser, hvad der er
--      sendt).
--   2. paamindelser_foer_slut_claim(p_graense): ÉN forespørgsel finder alle
--      modtagere for alle auktioner i vinduet og claimer dem atomisk
--      (insert ... on conflict do nothing returning). To samtidige kørsler kan
--      derfor aldrig claime den samme (auktion, bruger). Ingen N+1.
--      Filtrering:
--        - kun status 'aktiv', ikke skjult, ikke på pause (pauset_kl), ikke
--          afventende kunst-kontrol. Annullerede og afsluttede er ude.
--        - vinduet: slutter om mere end 10 minutter og højst 1 time (cron
--          kører hvert 5. minut, så normalt rammes 55-60 min.; under 10 min.
--          sendes intet - så viser siden selv "slutter snart").
--        - aldrig sælgeren selv, aldrig slettede konti.
--        - aldrig brugere, der har slået typen helt fra (klokke, mail og
--          push alle false i notifikation_indstillinger).
--        - aldrig brugere, der allerede fik den gamle favorit-påmindelse
--          (nøglen 'slutter:<auktion>:<bruger>' i notifikation_afsendelser),
--          så overgangen fra den gamle cron-version ikke giver dubletter.
--      "Fører" = det højeste bud (beløb desc, oprettet asc) - samme regel
--      som budmotoren (20261010010000_autobud.sql).
--      Returnerer de claimede rækker med kanalvalget, så serveren kan sende
--      klokke (én bulk-insert), push (Expo i bundter) og evt. mail.
--      Lukket for alle undtagen service_role (kaldes kun fra cron).
--   3. Delvist indeks til vinduet (aktive auktioner efter sluttid).
--
-- Idempotent: if not exists / create or replace.

-- ============================================================ 1. Tabel

create table if not exists public.auktion_paamindelser (
  auktion_id uuid not null references public.auctions(id) on delete cascade,
  bruger_id  uuid not null references public.users(id) on delete cascade,
  budt       boolean not null,
  foerer     boolean not null,
  sendt_kl   timestamptz not null default now(),
  primary key (auktion_id, bruger_id)
);

create index if not exists auktion_paamindelser_bruger_idx
  on public.auktion_paamindelser (bruger_id);

alter table public.auktion_paamindelser enable row level security;
revoke all on public.auktion_paamindelser from public, anon, authenticated;
grant all on public.auktion_paamindelser to service_role;

comment on table public.auktion_paamindelser is
  'Påmindelse 1 time før slut: én række pr. (auktion, bruger). Idempotens - kun service_role.';

-- ============================================================ 3. Indeks

create index if not exists auctions_aktiv_slutter_idx
  on public.auctions (slutter_kl) where status = 'aktiv';

-- ============================================================ 2. Claim

create or replace function public.paamindelser_foer_slut_claim(p_graense integer default 2000)
returns table (
  auktion_id uuid,
  bruger_id  uuid,
  titel      text,
  slutter_kl timestamptz,
  budt       boolean,
  foerer     boolean,
  klokke     boolean,
  mail       boolean,
  push       boolean
)
language sql
security definer
set search_path = public
as $fn$
  with auk as (
    select a.id, a.titel, a.slutter_kl, a.bruger_id as saelger
      from public.auctions a
     where a.status = 'aktiv'
       and a.skjult = false
       and a.pauset_kl is null
       and a.kunst_kontrol is distinct from 'afventer'
       and a.slutter_kl > now() + interval '10 minutes'
       and a.slutter_kl <= now() + interval '1 hour'
  ),
  foerende as (
    select distinct on (b.auktion_id) b.auktion_id, b.bruger_id
      from public.bids b
      join auk on auk.id = b.auktion_id
     order by b.auktion_id, b."beløb" desc, b.oprettet asc
  ),
  deltagere as (
    select b.auktion_id, b.bruger_id, true as budt
      from public.bids b
      join auk on auk.id = b.auktion_id
    union all
    select f.auction_id, f.user_id, false
      from public.favorites f
      join auk on auk.id = f.auction_id
  ),
  modtagere as (
    select d.auktion_id, d.bruger_id, bool_or(d.budt) as budt
      from deltagere d
     group by d.auktion_id, d.bruger_id
  ),
  kandidater as materialized (
    select m.auktion_id,
           m.bruger_id,
           auk.titel,
           auk.slutter_kl,
           m.budt,
           (m.budt and fo.bruger_id is not distinct from m.bruger_id) as foerer,
           coalesce(ni.klokke, true) as klokke,
           coalesce(ni.mail, true)   as mail,
           coalesce(ni.push, true)   as push
      from modtagere m
      join auk on auk.id = m.auktion_id
      join public.users u on u.id = m.bruger_id
      left join foerende fo on fo.auktion_id = m.auktion_id
      left join public.notifikation_indstillinger ni
        on ni.bruger_id = m.bruger_id and ni.type = 'fulgt_slutter_snart'
     where m.bruger_id <> auk.saelger
       and u.konto_slettet_kl is null
       and (ni.bruger_id is null or ni.klokke or ni.mail or ni.push)
       and not exists (
         select 1 from public.auktion_paamindelser p
          where p.auktion_id = m.auktion_id and p.bruger_id = m.bruger_id)
       and not exists (
         select 1 from public.notifikation_afsendelser n
          where n.noegle = 'slutter:' || m.auktion_id::text || ':' || m.bruger_id::text)
     order by auk.slutter_kl, m.auktion_id, m.bruger_id
     limit greatest(1, least(coalesce(p_graense, 2000), 5000))
  ),
  claimet as (
    insert into public.auktion_paamindelser as p (auktion_id, bruger_id, budt, foerer)
    select k.auktion_id, k.bruger_id, k.budt, k.foerer from kandidater k
    on conflict on constraint auktion_paamindelser_pkey do nothing
    returning p.auktion_id, p.bruger_id
  )
  select k.auktion_id, k.bruger_id, k.titel, k.slutter_kl, k.budt, k.foerer,
         k.klokke, k.mail, k.push
    from kandidater k
    join claimet c on c.auktion_id = k.auktion_id and c.bruger_id = k.bruger_id;
$fn$;

revoke all on function public.paamindelser_foer_slut_claim(integer) from public, anon, authenticated;
grant execute on function public.paamindelser_foer_slut_claim(integer) to service_role;
