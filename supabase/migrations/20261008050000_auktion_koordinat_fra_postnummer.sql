-- Koordinat fra postnummer: alle auktioner skal have lat/lng, så
-- afstandsfilteret på /auktioner kun behøver en koordinat-boks (src/lib/
-- auktionSoegning.ts). Før blev auktioner uden koordinat fundet via en lang
-- liste af postnumre i adressen, som ved stor radius gjorde GET-adressen
-- over 8 kB (414/400 og "Auktionerne kunne ikke hentes").
--
-- (a) Trigger: mangler lat eller lng ved oprettelse eller ændring, sættes
--     begge ud fra public.postnummer_koordinater. En koordinat, som web eller
--     app selv har sat (præcis adresse), overskrives aldrig.
-- (b) Engangs-udfyldning af eksisterende auktioner uden koordinat.
--
-- Idempotent: kan køres igen uden skade.
set local lock_timeout = '5s';

create or replace function public.auctions_koordinat_fra_postnummer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_lat double precision;
  v_lng double precision;
begin
  if (new.lat is null or new.lng is null) and new.postnummer is not null then
    select p.lat, p.lng into v_lat, v_lng
      from public.postnummer_koordinater p
     where p.postnummer = btrim(new.postnummer);
    if found and v_lat is not null and v_lng is not null then
      new.lat := v_lat;
      new.lng := v_lng;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.auctions_koordinat_fra_postnummer() is
  'Sætter lat/lng ud fra postnummeret, når auktionen mangler en koordinat. Overskriver aldrig en koordinat, der allerede er sat.';

drop trigger if exists auctions_koordinat_fra_postnummer on public.auctions;
create trigger auctions_koordinat_fra_postnummer
  before insert or update of postnummer, lat, lng on public.auctions
  for each row execute function public.auctions_koordinat_fra_postnummer();

-- (b) Udfyldning. Køres som postgres, så auctions_beskyt_kolonner springer
-- over (redigeret_kl røres ikke – bydere får ikke "auktionen er ændret"),
-- og auctions_beskyt_taellere/auctions_indhold_kontrol gør intet ud over at
-- normalisere stand. auctions_forbudt_rapport reagerer kun på titel/
-- beskrivelse. Afsluttede rækker uden afsluttet_kl springes over, så
-- auctions_arkiv_felter ikke giver dem et nyt afsluttet_kl.
update public.auctions a
   set lat = p.lat,
       lng = p.lng
  from public.postnummer_koordinater p
 where (a.lat is null or a.lng is null)
   and p.postnummer = btrim(a.postnummer)
   and p.lat is not null
   and p.lng is not null
   and (a.status = 'aktiv' or a.afsluttet_kl is not null);
