-- Bedoemmelse ved godkendelse (ROADMAP fase 1: "Bedoemmelse: koeber skal give
-- saelger 1-5 stjerner, foer godkendelse gaar igennem"; ROADMAP-BESLUTNINGER
-- afsnit 6).
--
-- Regler:
--   - Kun koeberen bedoemmer saelgeren. Saelgeren kan ikke bedoemme koeberen.
--   - Bedoemmelsen kan KUN gives i forbindelse med godkendelse af handlen -
--     og godkendelsen kan ikke ske uden. Begge dele sker i een transaktion i
--     handel_godkend_med_bedoemmelse.
--   - Frigives pengene automatisk (handel_auto_frigiv), af en sag
--     (sag_afvikl) eller af admin (admin_frigiv_handel), faar saelgeren ingen
--     bedoemmelse. Ingen af dem indsaetter i ratings, og efter denne migration
--     kan brugere ikke laengere indsaette direkte (foer kunne koeberen bedoemme
--     via ratings_insert_koeber, saa snart status var 'leveret' - ogsaa efter
--     automatisk frigivelse).
--
-- AEndringer:
--   1. ratings.trade_id (ny, nullable for gamle raekker) + unik pr. handel.
--      Gamle raekker kobles til handlen, hvor det er entydigt.
--   2. ratings_insert_koeber fjernes, og insert/update/delete tilbagekaldes
--      fra anon og authenticated. Laeseadgang (ratings_select_all) er uaendret.
--      Admin skjuler bedoemmelser med service_role som hidtil.
--   3. Ny handel_godkend_med_bedoemmelse(p_trade, p_stjerner, p_kommentar).
--      Godkendelsesdelen er kopieret praecist fra handel_godkend
--      (20261002040000_pengestroem_rettelser.sql; sager-migrationerne har ikke
--      aendret den). Eneste tilfoejelse ud over bedoemmelsen: afvisning, hvis
--      betalingen allerede er frigivet (saa giver den heller ingen bedoemmelse).
--   4. handel_godkend kan ikke laengere kaldes af authenticated. Funktionen
--      bevares (appen kaldte den), men en godkendelse uden bedoemmelse er ikke
--      mulig for brugere.
--
-- Idempotent: if not exists / drop if exists / create or replace.

-- ============================================================ 1. ratings.trade_id

alter table public.ratings
  add column if not exists trade_id uuid references public.trades(id) on delete cascade;

-- Gamle bedoemmelser kobles til handlen, naar der er praecis een handel med
-- samme auktion, koeber og saelger (flere handler pr. auktion er mulige efter
-- "tilbyd til naesthoejeste byder", men med forskellige koebere).
update public.ratings r
   set trade_id = (select t.id from public.trades t
                    where t.auction_id = r.auktion_id
                      and t.buyer_id = r.fra_bruger_id
                      and t.seller_id = r.til_bruger_id)
 where r.trade_id is null
   and (select count(*) from public.trades t
         where t.auction_id = r.auktion_id
           and t.buyer_id = r.fra_bruger_id
           and t.seller_id = r.til_bruger_id) = 1;

-- Een bedoemmelse pr. handel. (Den gamle unique (fra_bruger_id, auktion_id)
-- bevares ogsaa.)
create unique index if not exists ratings_trade_id_unik
  on public.ratings (trade_id) where trade_id is not null;

-- Kommentaren er offentlig paa profilen. Graensen haandhaeves ogsaa her, saa
-- ingen vej uden om funktionen kan gemme romaner. not valid: gamle raekker
-- tjekkes ikke (de kunne vaere laengere).
alter table public.ratings drop constraint if exists ratings_kommentar_laengde;
alter table public.ratings
  add constraint ratings_kommentar_laengde
  check (kommentar is null or char_length(kommentar) <= 1000) not valid;

-- ============================================================ 2. RLS og rettigheder

drop policy if exists "ratings_insert_koeber" on public.ratings;
drop policy if exists "ratings_insert_own" on public.ratings;
drop policy if exists "ratings_update_own" on public.ratings;
drop policy if exists "ratings_delete_own" on public.ratings;

-- Dobbelt sikring: uden policy afviser RLS allerede, men rettighederne
-- fjernes ogsaa, saa en fremtidig policy ikke ved et uheld aabner igen.
revoke insert, update, delete on public.ratings from anon, authenticated;

comment on table public.ratings is
  'Bedoemmelser. Kun koeberen kan bedoemme handlens saelger, een gang pr. handel, '
  'og kun i forbindelse med godkendelse af varen (handel_godkend_med_bedoemmelse). '
  'Brugere kan ikke indsaette, aendre eller slette direkte - admin skjuler med '
  'service_role (skjult = true). Raekker slettes aldrig.';

-- ============================================================ 3. godkend med bedoemmelse

-- Koder (text):
--   ok                  godkendt og bedoemt
--   ikke_logget_ind     auth.uid() mangler
--   ugyldige_stjerner   p_stjerner er ikke 1-5
--   kommentar_for_lang  over 1000 tegn (efter trim)
--   kommentar_link      kommentaren indeholder et link
--   ikke_mulig          handlen kan ikke godkendes af kalderen nu (ikke koeber,
--                       ikke 'modtaget', ikke betalt, refusion, indsigelse,
--                       sag aaben, allerede frigivet - eller allerede godkendt,
--                       fx ved dobbeltklik)
create or replace function public.handel_godkend_med_bedoemmelse(
  p_trade uuid, p_stjerner int, p_kommentar text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  kalder      uuid := auth.uid();
  b           record;
  t           record;
  v_kommentar text := nullif(btrim(coalesce(p_kommentar, '')), '');
begin
  if kalder is null then return 'ikke_logget_ind'; end if;

  if p_stjerner is null or p_stjerner < 1 or p_stjerner > 5 then
    return 'ugyldige_stjerner';
  end if;
  if v_kommentar is not null and char_length(v_kommentar) > 1000 then
    return 'kommentar_for_lang';
  end if;
  -- Kommentarer er offentlige paa saelgerens profil. Links afvises, saa de
  -- ikke kan bruges til spam eller phishing. Kun entydige topdomaener -
  -- .de/.se/.no/.eu udelades, fordi "fint.De skrev" ellers ville blive afvist.
  if v_kommentar is not null
     and v_kommentar ~* '(https?://|www\.|[a-z0-9-]+\.(dk|com|net|org|io|info|biz|xyz|ly)(/|\s|$))' then
    return 'kommentar_link';
  end if;

  -- ---- Herfra som handel_godkend (20261002040000) ----
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.frigivet_kl is not null  -- nyt: frigivet uden koeberen = ingen bedoemmelse
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return 'ikke_mulig';
  end if;

  update public.trades
     set status = 'leveret'
   where id = p_trade
     and status = 'modtaget'
     and buyer_id = kalder
     and not coalesce(sag_aaben, false)
  returning * into t;

  if not found then return 'ikke_mulig'; end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where id = b.id and frigivet_kl is null;
  -- ---- Slut paa handel_godkend ----

  -- Bedoemmelsen: altid fra koeberen til handlens saelger. Ingen af
  -- id'erne kommer fra kalderen. Statusskiftet ovenfor sker kun een gang, saa
  -- et dobbeltklik naar aldrig hertil to gange. on conflict: findes der
  -- allerede en (gammel) bedoemmelse for auktionen/handlen, beholdes den, og
  -- godkendelsen gaar igennem alligevel.
  if t.seller_id <> kalder then
    insert into public.ratings
      (fra_bruger_id, til_bruger_id, auktion_id, trade_id, stjerner, kommentar)
    values
      (kalder, t.seller_id, t.auction_id, t.id, p_stjerner::smallint, v_kommentar)
    on conflict do nothing;
  end if;

  return 'ok';
end;
$fn$;

revoke all on function public.handel_godkend_med_bedoemmelse(uuid, int, text) from public, anon;
grant execute on function public.handel_godkend_med_bedoemmelse(uuid, int, text) to authenticated;

-- ============================================================ 4. luk den gamle handel_godkend

-- Godkendelse uden bedoemmelse er ikke laengere tilladt for brugere.
-- OBS: Expo-appen kaldte handel_godkend og skal skifte til
-- handel_godkend_med_bedoemmelse.
revoke all on function public.handel_godkend(uuid) from public, anon, authenticated;
