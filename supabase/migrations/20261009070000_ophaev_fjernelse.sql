-- "Ophæv fjernelse" af en annulleret auktion (rettelse til
-- 20261009040000_skjult_auktion_pause.sql).
--
-- KØRES I PRODUKTION EFTER 20261009040000 (og på testdatabasen, hvor også
-- 041000/042000 og en kasseret 043000-udgave er kørt). Slutresultatet er det
-- samme begge steder: triggerfunktionen auctions_pause_skjult sættes til den
-- endelige udgave med create or replace, uanset hvad der ligger der nu.
--
-- Ændring: når en annulleret, skjult auktion "vises igen" (staff "Ophæv
-- fjernelse", en genåbnet rapport eller en direkte opdatering), forbliver den
-- skjult (uændret), men ophævelsen omfatter nu også afgørelser af typen
-- 'auktion_skjult' - ikke kun 'auktion_fjernet'/'auktion_annulleret'. Så får
-- en auktion, som sælgeren selv annullerede, og som staff derefter skjulte,
-- også sin skjul-afgørelse ophævet.
--
-- Hjemmesiden ophæver selv afgørelserne med en betinget opdatering (så den
-- ved, hvad der faktisk blev ophævet, og kun logger og giver besked én gang);
-- triggeren er værnet for alle andre veje (fx appen eller SQL).
--
-- Idempotent: kan køres flere gange.

set lock_timeout = '5s';

create or replace function public.auctions_pause_skjult()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rest interval;
begin
  -- Annulleret: pausen lukkes. En annulleret auktion genåbnes aldrig
  -- (Filip, 6. okt. 2026), så den resterende tid gemmes ikke.
  if new.status = 'annulleret' then
    if old.pauset_kl is not null or new.pauset_kl is not null then
      new.pauset_kl := null;
      new.pause_resterende := null;
      update public.auktion_pauser
         set annulleret_kl = now()
       where auction_id = new.id and genoptaget_kl is null and annulleret_kl is null;
    end if;
    -- En fjernet (annulleret) auktion bliver aldrig offentligt synlig igen -
    -- heller ikke ved "Vis igen", medhold eller en genåbnet rapport (Filip,
    -- 6. okt. 2026). Den forbliver skjult (kun sælger, deltagere og staff kan
    -- se den), og afgørelserne ophæves i stedet, så sælgeren kan sætte varen
    -- op igen med ét klik. Også en "Auktion skjult"-afgørelse ophæves - fx
    -- når sælgeren selv annullerede, og staff derefter skjulte auktionen.
    -- (dsa_klage_afgoer ophæver selv med grunden 'klage', før den kommer
    -- hertil.)
    if coalesce(old.skjult, false) and not coalesce(new.skjult, false) then
      new.skjult := true;
      update public.dsa_afgoerelser
         set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where indhold_type = 'auktion' and indhold_id = new.id
         and handling in ('auktion_fjernet', 'auktion_annulleret', 'auktion_skjult')
         and ophaevet_kl is null;
    end if;
    return new;
  end if;

  -- Skjules: en igangværende auktion sættes på pause.
  if coalesce(new.skjult, false) and not coalesce(old.skjult, false)
     and old.status = 'aktiv' and new.status = 'aktiv' and old.pauset_kl is null then
    v_rest := greatest(old.slutter_kl - now(), interval '0');
    new.pauset_kl := now();
    new.pause_resterende := v_rest;
    insert into public.auktion_pauser (auction_id, pauset_kl, resterende)
    values (new.id, new.pauset_kl, v_rest)
    on conflict (auction_id) where genoptaget_kl is null and annulleret_kl is null do nothing;
    return new;
  end if;

  -- Genoptages: pauset, aktiv og synlig - uanset hvilken kolonne der ændrede sig.
  if old.pauset_kl is not null and new.status = 'aktiv' and not coalesce(new.skjult, false) then
    new.slutter_kl := now() + greatest(coalesce(old.pause_resterende, interval '0'), interval '24 hours');
    new.pauset_kl := null;
    new.pause_resterende := null;
    update public.auktion_pauser
       set genoptaget_kl = now(), ny_slutter_kl = new.slutter_kl
     where auction_id = new.id and genoptaget_kl is null and annulleret_kl is null;
  end if;

  return new;
end;
$fn$;

revoke all on function public.auctions_pause_skjult() from public, anon, authenticated;

-- Triggeren genskabes, så den også findes, hvis den mangler.
drop trigger if exists auctions_pause_skjult on public.auctions;
create trigger auctions_pause_skjult
  before update on public.auctions
  for each row execute function public.auctions_pause_skjult();
