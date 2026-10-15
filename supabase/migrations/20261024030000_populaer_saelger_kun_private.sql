-- "Populær sælger"-mærket er kun for private konti (Filip, 15. okt. 2026 -
-- ROADMAP-BESLUTNINGER, "Beslutninger (Filip, 15. okt. 2026)"). Firmakonti
-- (konto_type <> 'privat') må aldrig få mærket, uanset antal salg.
--
-- populaer_saelger (fra 20261023020000) tjekkede ikke konto_type, så en
-- firmakonto med 50 gennemførte salg til 20 købere fik mærket. Nu kræves
-- konto_type = 'privat' (kolonnen er not null med standard 'privat').
-- populaere_saelgere (auktionskort) bruger populaer_saelger og følger med.
-- Mærket regnes altid ud fra databasen (ingen gemt kopi), så en firmakonto,
-- der havde det, mister det med det samme (hjemmesidens cache: højst 10 min).
--
-- Kræver 20261023020000. Idempotent (kan køres igen). KØRES IKKE i
-- produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regprocedure('public.populaer_saelger(uuid)') is null
     or to_regprocedure('public.gennemfoerte_salg(timestamptz,timestamptz,uuid)') is null then
    raise exception 'Forudsætning mangler: kør 20261023020000_badge_konkurrence.sql først';
  end if;
end $do$;

create or replace function public.populaer_saelger(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bruger is not null
     -- Kun private konti (Filip, 15. okt. 2026); lukkede og slettede konti
     -- får det heller ikke.
     and exists (select 1 from public.users u
                  where u.id = p_bruger and u.konto_type = 'privat'
                    and u.konto_lukket_kl is null and u.konto_slettet_kl is null)
     and (select count(*) >= public.populaer_saelger_graense()
                 and count(distinct g.buyer_id) >= public.populaer_saelger_min_koebere()
            from public.gennemfoerte_salg(null, null, p_bruger) g);
$$;
revoke all on function public.populaer_saelger(uuid) from public;
grant execute on function public.populaer_saelger(uuid) to anon, authenticated, service_role;

comment on function public.populaer_saelger(uuid) is
  'Populær sælger: kun private konti (konto_type = privat), mindst populaer_saelger_graense() gennemførte salg til mindst populaer_saelger_min_koebere() forskellige købere. Offentlig ja/nej (20261024030000).';
