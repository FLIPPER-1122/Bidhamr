-- Sikkerhedsnet A: regler, stop og adgang (pengesikkerhed, 11. okt. 2026).
--
-- Filips ufravigelige regel: penge udbetales ALDRIG, før handlen er helt
-- afgjort. En gennemgang af pengeflowet fandt ingen kritiske huller, men flere
-- steder, hvor reglen kunne omgås. Denne migration lukker dem. (Sikkerhedsnet B
-- - tests, afstemning, reserve og overblik - ligger i 20261019020000.)
--
--   1. Nødstop: stripe_tilstand.udbetalinger_stoppet og nye_betalinger_stoppet
--      (med årsag, tidspunkt og hvem). Kun chef (stripe_noedstop_saet), logget i
--      moderation_log. Udbetalinger: betaling_udbetaling_blokeret,
--      _i_claim og saelger_udbetaling_claim stopper. Nye betalinger: en
--      PaymentIntent kan ikke gemmes på en betaling (trigger) - serveren
--      tjekker også før den kalder Stripe. Refusioner kører altid videre.
--   2. admin_frigiv_handel(p_trade, p_medarbejder, p_begrundelse): afviser
--      intet afsendt (betaling_modtaget ved forsendelse), staffs markering
--      (sag_aaben), sag_holder_pengene, uløst svindelvarsel, ikke-afhentet/
--      returneret pakke, inhabilitet (også "har handlet med") og kræver chef
--      fra 10.000 kr. (købers samlede betaling; under 10.000 kr. må admin selv
--      - Filip, 12. okt. 2026). Den gamle admin_frigiv_handel(uuid) fjernes.
--   3. handel_auto_frigiv: 14 dage efter afsendelse frigives KUN, når
--      BidHamrs fragtlabel er meldt leveret/afhentet. Ellers (ingen
--      leveringsmelding eller sælgerens eget sporingsnummer) får staff en
--      opgave (markering på betalingen, én gang) - aldrig automatisk frigivelse.
--   5. Erhverv: 'fortrydelsesfrist' i betaling_udbetaling_blokeret, indtil der
--      er gået 14 dage efter levering/modtagelse.
--   6. "BidHamr dækker" (chef): refusion fra platformen efter udbetaling, uden
--      tilbageførsel fra sælgeren. Lås, plan og log i databasen, kreditnota via
--      fakturasystemet (faktura_planlaeg), DAC7 tæller stadig salget.
--   7. betaling_udbetaling_blokeret: også sag_holder_pengene(),
--      handel_ikke_afhentet, returneret forsendelse og nødstop.
--   8. Inhabilitet i pengefunktionerne: penge_inhabil() = part i handlen ELLER
--      har handlet med en af parterne (dsa_er_inhabil). Rettet på stedet i
--      sag_afgoer, sag_anke_afgoer, betaling_refusion_proev_igen,
--      betaling_svindelvarsel_gennemgaaet, betaling_indsigelse_tilbagefoersel_
--      proev_igen, betaling_indsigelse_tabt_luk og handel_ikke_afhentet_registrer.
--  10. CHECK af gebyrformlerne på betalinger (købergebyr, sælgergebyr,
--      Beskyttelse 25-250 kr.). Tilføjes NOT VALID og valideres derefter;
--      afviger eksisterende rækker, bliver de stående NOT VALID (notice med
--      antal) - nye og ændrede rækker skal altid passe.
--  11. Beløbsloft: startpris, bud og maksimum højst 500.000 kr. (chefens valg).
--      Udbetaling fra 10.000 kr. pr. handel kræver chefens godkendelse
--      ('kraever_godkendelse', betaling_udbetaling_godkend). Grænsen står ét
--      sted: public.chef_beloebsgraense_oere() = 1.000.000 øre, og begge regler
--      bruger "beløb >= grænsen" (Filip, 12. okt. 2026).
--  12. Grants: authenticated mister insert/update/delete/truncate på
--      transactions; anon mister insert/update på auctions.
--  13. Fremmed udbetaling / ændret udbetalingsplan: sælgeren fryses
--      (betalingsprofiler.udbetaling_frosset_kl, evt. salg_frosset_kl), alle
--      ventende handler markeres til staff. Kun chefen ophæver
--      (saelger_frysning_ophaev). Chefen kan også selv fryse en sælger
--      (saelger_frys_manuelt). Grunden står i saelger_frysning_grunde, som kun
--      staff kan læse (sælgeren kan læse sin egen betalingsprofil).
--
-- Rettelser efter review (11. okt. 2026, før kørsel i produktion):
--   - Nødstop for nye betalinger standser betalingsfristen: ubetalt_vinder_
--     annuller annullerer ikke, mens stoppet er aktivt, og når stoppet
--     ophæves, forlænges fristen for de berørte betalinger med stoppets
--     varighed (mindst 24 timer tilbage) - stripe_noedstop_saet.
--   - Triggeren betalinger_noedstop_pi reagerer på enhver ny PaymentIntent.
--   - "BidHamr dækker" kræver, at udbetalingen er gennemført ('paid'), bruger
--     refusion_oere uden sag, og afslut sletter ikke andre markeringer.
--   - Inhabilitet ("har handlet med") også i sag_genaabn, admin_advarsel_
--     betaling, indpakning_vurder og admin_annuller_ikke_betalt.
--   - handel_udbetalingsstatus kender de nye grunde (neutral tekst ved
--     frysning, fortrydelsesfristen med i tidligst_kl).
--
-- Kan køres flere gange. md5-drift-tjek af alle funktioner, der ændres
-- (normaliseret krop som 20261016030000: CR fjernet, kommentarer fjernet, al
-- whitespace fjernet, små bogstaver). "gammel" er beregnet i PGlite ud fra
-- repoets filer (seneste version + trin 1's rettelser på stedet), "ny" er
-- denne migrations version. KØRES IKKE i produktion uden Filips "ja".
--
-- 12. okt. 2026 (Filip): admin må frigive handler under 10.000 kr. (før 5.000
-- kr.), og udbetalingsgrænsen gælder "fra 10.000 kr." (før "over"). Begge
-- bruger public.chef_beloebsgraense_oere(). Testdatabasen har den tidligere
-- udgave af denne migration kørt: "foer" er md5 af den udgaves
-- betaling_udbetaling_blokeret og _i_claim, som opgraderes på samme måde
-- som "gammel".

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Forudsætninger og drift-tjek
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

do $do$
declare
  r record;
  h text;
  -- Den tidligere udgave af denne migration (11. okt., grænse "over 10.000").
  v_foer jsonb := jsonb_build_object(
    'public.betaling_udbetaling_blokeret(uuid)', '955079acd293e57cf88b281c9766af66',
    'public.betaling_udbetaling_blokeret_i_claim(uuid,uuid)', '596af4384b413cb4a785f9e73b1d59e5');
begin
  if to_regclass('public.handel_ikke_afhentet') is null
     or to_regprocedure('public.dsa_er_inhabil(uuid,uuid)') is null
     or to_regprocedure('public.sag_holder_pengene(uuid)') is null
     or to_regclass('public.saelger_udbetalinger') is null then
    raise exception 'Forudsætning mangler: betalingsmodellen (20261011050000), DSA (20261009010000) og ikke-afhentet pakke (20261016031000) skal være kørt først';
  end if;
  if not exists (select 1 from public.stripe_tilstand where id and betalingsmodel = 'destination') then
    raise exception 'Forudsætning mangler: stripe_tilstand skal stå til destination (20261011050000)';
  end if;

  for r in
    select * from (values
      ('public.betaling_udbetaling_blokeret(uuid)',
       'ebbc9160aea98bff95eb44692d0b8eaa', 'b8092d70724ea3d2ed7f15d7d502f245'),
      ('public.betaling_udbetaling_blokeret_i_claim(uuid,uuid)',
       'd42ea663b6510620d6ccb073f773491d', '613e703e51f3530c0dd314036a327870'),
      ('public.saelger_udbetaling_claim(uuid,text,uuid[])',
       '0bc7bc82db57b73bb31d065efee84518', '788c61fb8c93db6f68d69902555763c7'),
      ('public.handel_auto_frigiv()',
       '52bab8ddd30985f672fe60bb380acd97', 'f7f45b6858eaa3eb527ba955e45a78f3'),
      ('public.sag_afgoer(uuid,uuid,text,text,text,boolean)',
       '40967c98c12a7fa2d14add66c1f41488', 'ea0cd85a0d3c06f363650778ceb414cb'),
      ('public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean)',
       'f6605b95c2072bd4a149e16893b0d256', '4f00919bdf83d3000f4769431906c5cc'),
      ('public.betaling_refusion_proev_igen(uuid,uuid,text)',
       '1dd6c252bd51865a13a87231f4815280', 'a2aa693f911076dd9cd8792b4a878ce9'),
      ('public.betaling_svindelvarsel_gennemgaaet(uuid,uuid,text)',
       '6f6ce4418533c857ed72e9224074a42b', '6e9c3c1107ce82f291a475a9c7e59cca'),
      ('public.betaling_indsigelse_tilbagefoersel_proev_igen(uuid,uuid)',
       '648bd9402a193b0c146794a2fd4c8332', '81e97adf64bcf689ad3f5f67aa32d257'),
      ('public.betaling_indsigelse_tabt_luk(uuid,uuid,text)',
       '73de6212839a3f503ad530eca65f4e46', 'd39f2d2d0e8b073ef8bfff2293ac31d6'),
      ('public.handel_ikke_afhentet_registrer(uuid,text,uuid,text,uuid,bigint)',
       'a77a954c936018065e902a67376a3d5d', '5db7b2d8ccaf053d89a38b4fb9a1cd37'),
      ('public.faktura_planlaeg(integer)',
       'bfbdedf311ba334efd676cf3ba5a59e7', 'eaccfc18b96f7d35e32abfd591253bbc'),
      ('public.dac7_salg(integer,uuid)',
       'c3c37f9a49953460381c377274cbd4f8', 'cd6313fbe3e51ee638d7051ef0e6f043'),
      -- Rettelser efter review (gammel: 20261011020000, 20261005021000 +
      -- 20261011010000, 20261003012000 (+ 20261010070000), 20261003051000,
      -- 20261011030000).
      ('public.ubetalt_vinder_annuller(uuid,boolean)',
       'a63a21a81e2c9c82a22e71f2d00de606', '785545cb6f4c3695e68b2dc2d77098c5'),
      ('public.sag_genaabn(uuid,uuid,text)',
       '422b8577375cb6de0e96434f4eed94c6', 'd32e4ff28c96d5f5c8902b7d133b040b'),
      ('public.admin_annuller_ikke_betalt(uuid,uuid,text)',
       'cb5c0f654085c0268d004c6d0819ae9d', '58b0efde68a9d7fb74b2387afe0b6243'),
      ('public.admin_advarsel_betaling(uuid,uuid,text,text,text)',
       '01d6344ca3959df44f7eed8527dd8076', 'c7ce25df3cbe69683f4e35138dc44491'),
      ('public.indpakning_vurder(uuid,uuid,text,text)',
       'ea358f982cfa5cd6537a0b3ff6d00b95', 'caec8ce7ab4446a812562fafd01c4763'),
      ('public.handel_udbetalingsstatus(uuid)',
       '9deebf252afa42a3de077045714d5962', 'f8a957f59515b6bc97c61cbdb13b6544')
    ) as v(fn, gammel, ny)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      raise exception '%: funktionen findes ikke - kør de tidligere migrationer først', r.fn;
    elsif h = r.ny then
      raise notice '%: allerede rettet', r.fn;
    elsif h = v_foer->>r.fn then
      raise notice '%: tidligere udgave af denne migration - opgraderes', r.fn;
    elsif h is distinct from r.gammel then
      raise exception '%: kroppen afviger fra repoets seneste version (md5 %) - kontrollér funktionen, før migrationen køres', r.fn, h;
    end if;
  end loop;

  -- Den gamle admin_frigiv_handel(uuid) fjernes (afsnit 2). Findes den, skal
  -- den være repoets version (20261002040000).
  if to_regprocedure('public.admin_frigiv_handel(uuid)') is not null then
    h := pg_temp.krop_md5('public.admin_frigiv_handel(uuid)');
    if h is distinct from '979ff06a115b00a5ba1b3788fa79d9d7' then
      raise exception 'admin_frigiv_handel(uuid): kroppen afviger fra 20261002040000 (md5 %) - kontrollér funktionen, før migrationen køres', h;
    end if;
  end if;
end $do$;

-- Retter en funktion på stedet: md5 før (gammel) eller allerede rettet (ny);
-- hvert mønster skal findes præcis det forventede antal gange; md5 bagefter
-- skal være "ny". Ellers afbrydes migrationen (intet ændres).
create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    n := (length(v_def) - length(replace(v_def, e->>0, ''))) / length(e->>0);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, e->>0, n;
    end if;
    v_def := replace(v_def, e->>0, e->>1);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- Udvider en CHECK med værdilister (som 20261016030000).
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['noedstop_udbetalinger', 'noedstop_betalinger', 'udbetaling_godkendt', 'bidhamr_daekker',
        'udbetaling_frosset', 'udbetaling_frysning_ophaevet', 'handel_frigivet']);
select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_maal_type_check', 'maal_type',
  array['system']);

-- ===========================================================================
-- 1. Nødstop
-- ===========================================================================
alter table public.stripe_tilstand
  add column if not exists udbetalinger_stoppet         boolean not null default false,
  add column if not exists udbetalinger_stoppet_aarsag  text,
  add column if not exists udbetalinger_stoppet_kl      timestamptz,
  add column if not exists udbetalinger_stoppet_af      uuid references public.users(id) on delete set null,
  add column if not exists nye_betalinger_stoppet        boolean not null default false,
  add column if not exists nye_betalinger_stoppet_aarsag text,
  add column if not exists nye_betalinger_stoppet_kl     timestamptz,
  add column if not exists nye_betalinger_stoppet_af     uuid references public.users(id) on delete set null;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'stripe_tilstand_noedstop_check'
                   and conrelid = 'public.stripe_tilstand'::regclass) then
    alter table public.stripe_tilstand add constraint stripe_tilstand_noedstop_check check (
          (not udbetalinger_stoppet or udbetalinger_stoppet_aarsag is not null)
      and (not nye_betalinger_stoppet or nye_betalinger_stoppet_aarsag is not null)
      and char_length(coalesce(udbetalinger_stoppet_aarsag, '')) <= 1000
      and char_length(coalesce(nye_betalinger_stoppet_aarsag, '')) <= 1000);
  end if;
end $do$;

comment on column public.stripe_tilstand.udbetalinger_stoppet is
  'Nødstop (kun chef, stripe_noedstop_saet): ingen udbetalinger fra sælgernes Stripe-konti til banken (betaling_udbetaling_blokeret, saelger_udbetaling_claim). Refusioner kører videre.';
comment on column public.stripe_tilstand.nye_betalinger_stoppet is
  'Nødstop (kun chef, stripe_noedstop_saet): ingen nye betalinger (PaymentIntents). Refusioner og udbetalinger påvirkes ikke.';

-- Ukendt/manglende række = stoppet (fail closed).
create or replace function public.udbetalinger_stoppet()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((select st.udbetalinger_stoppet from public.stripe_tilstand st where st.id), true);
$fn$;
revoke all on function public.udbetalinger_stoppet() from public, anon, authenticated;
grant execute on function public.udbetalinger_stoppet() to service_role;

create or replace function public.nye_betalinger_stoppet()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((select st.nye_betalinger_stoppet from public.stripe_tilstand st where st.id), true);
$fn$;
revoke all on function public.nye_betalinger_stoppet() from public, anon, authenticated;
grant execute on function public.nye_betalinger_stoppet() to service_role;

-- Kun chef. p_hvad: 'udbetalinger' | 'nye_betalinger'. Begrundelse kræves både
-- ved stop og genoptagelse. Kode: ok | uaendret | ingen_adgang | ugyldig |
-- begrundelse_mangler | begrundelse_for_lang.
--
-- Nye betalinger genoptages: køberne kunne ikke betale under stoppet, så
-- betalingsfristen forlænges for alle åbne betalinger, hvis frist var i gang,
-- da stoppet startede (status 'afventer' eller 'behandles', ikke ventende på
-- sælgerens konto,
-- betal_senest efter stoppets start): + stoppets varighed, og mindst 24
-- timer fra nu. Svaret har 'forlaenget' = [{trade_id, buyer_id, betal_senest}]
-- (serveren giver køberne besked).
create or replace function public.stripe_noedstop_saet(
  p_medarbejder uuid, p_hvad text, p_stop boolean, p_aarsag text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  st     record;
  v_begr text := nullif(btrim(coalesce(p_aarsag, '')), '');
  v_nu   boolean;
  v_forl jsonb := '[]'::jsonb;
  v_fejl integer := 0;
  r      record;
  v_trade  uuid;
  v_koeber uuid;
  v_frist  timestamptz;
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users u where u.id = p_medarbejder and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_hvad is null or p_hvad not in ('udbetalinger', 'nye_betalinger') or p_stop is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if v_begr is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_begr) > 1000 then return jsonb_build_object('kode', 'begrundelse_for_lang'); end if;

  select * into st from public.stripe_tilstand where id for update;
  if not found then return jsonb_build_object('kode', 'ugyldig'); end if;
  v_nu := case when p_hvad = 'udbetalinger' then st.udbetalinger_stoppet else st.nye_betalinger_stoppet end;
  if v_nu = p_stop then return jsonb_build_object('kode', 'uaendret'); end if;

  if p_hvad = 'udbetalinger' then
    update public.stripe_tilstand
       set udbetalinger_stoppet = p_stop,
           udbetalinger_stoppet_aarsag = case when p_stop then v_begr end,
           udbetalinger_stoppet_kl = case when p_stop then now() end,
           udbetalinger_stoppet_af = case when p_stop then p_medarbejder end
     where id;
  else
    update public.stripe_tilstand
       set nye_betalinger_stoppet = p_stop,
           nye_betalinger_stoppet_aarsag = case when p_stop then v_begr end,
           nye_betalinger_stoppet_kl = case when p_stop then now() end,
           nye_betalinger_stoppet_af = case when p_stop then p_medarbejder end
     where id;
    -- Genoptaget: fristen forlænges med stoppets varighed (mindst 24 t).
    -- Én række ad gangen i sin egen undertransaktion: en række, der fx ikke
    -- passer en NOT VALID-constraint, må ikke forhindre genoptagelsen - den
    -- tælles i 'forlaengelse_fejlet' (serveren giver chefen drift-alarm), og
    -- ubetalt_vinder_annuller annullerer den først efter fristen.
    if not p_stop and st.nye_betalinger_stoppet_kl is not null then
      for r in
        select b.id from public.betalinger b
         where b.status in ('afventer', 'behandles')
           and b.venter_paa_saelgerkonto_kl is null
           and b.betal_senest > st.nye_betalinger_stoppet_kl
         order by b.id
      loop
        begin
          update public.betalinger b
             set betal_senest = date_trunc('second', greatest(
                   b.betal_senest + (now() - st.nye_betalinger_stoppet_kl),
                   now() + interval '24 hours')),
                 -- Påmindelserne sendes igen ud fra den nye frist (som
                 -- handel_forlaeng_betalingsfrist).
                 paamindelse_24_sendt_kl = null,
                 paamindelse_40_sendt_kl = null,
                 opdateret = now()
           where b.id = r.id and b.status in ('afventer', 'behandles')
          returning b.trade_id, b.buyer_id, b.betal_senest into v_trade, v_koeber, v_frist;
          if found then
            v_forl := v_forl || jsonb_build_array(jsonb_build_object(
              'trade_id', v_trade, 'buyer_id', v_koeber, 'betal_senest', v_frist));
          end if;
        exception when others then
          raise warning 'stripe_noedstop_saet: fristen for betaling % kunne ikke forlænges: %', r.id, sqlerrm;
          v_fejl := v_fejl + 1;
        end;
      end loop;
    end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder,
          case when p_hvad = 'udbetalinger' then 'noedstop_udbetalinger' else 'noedstop_betalinger' end,
          'system', p_medarbejder, null,
          left((case when p_stop then 'Stoppet: ' else 'Genoptaget: ' end) || v_begr
               || case when jsonb_array_length(v_forl) > 0
                       then ' (betalingsfristen forlænget for ' || jsonb_array_length(v_forl) || ' handel(er))'
                       else '' end, 2000));
  return jsonb_build_object('kode', 'ok', 'hvad', p_hvad, 'stoppet', p_stop,
                            'forlaenget', v_forl, 'forlaengelse_fejlet', v_fejl);
end;
$fn$;
revoke all on function public.stripe_noedstop_saet(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.stripe_noedstop_saet(uuid, text, boolean, text) to service_role;

-- Værn i databasen: en ny PaymentIntent kan ikke gemmes på en betaling, mens
-- nye betalinger er stoppet (serveren tjekker også, før den kalder Stripe).
-- Gælder enhver ændring til en ny PaymentIntent (også en, der erstatter en
-- anden). Webhooken skriver aldrig PaymentIntent-id'et - en betaling, der
-- gennemføres under stoppet, registreres stadig (betaling_registrer_betalt).
create or replace function public.betalinger_noedstop_pi()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.stripe_payment_intent_id is not null
     and (tg_op = 'INSERT' or old.stripe_payment_intent_id is distinct from new.stripe_payment_intent_id)
     and public.nye_betalinger_stoppet() then
    raise exception 'nye_betalinger_stoppet: Betalingen er midlertidigt sat på pause. Prøv igen senere.'
      using errcode = 'BHP01';
  end if;
  return new;
end;
$fn$;
revoke all on function public.betalinger_noedstop_pi() from public, anon, authenticated;

drop trigger if exists betalinger_noedstop_pi on public.betalinger;
create trigger betalinger_noedstop_pi
  before insert or update of stripe_payment_intent_id on public.betalinger
  for each row execute function public.betalinger_noedstop_pi();

-- Betalingsfristen står stille under et stop for nye betalinger: køberen kan
-- ikke betale, så handlen annulleres ikke (og der oprettes ingen "ubetalt
-- vinder"). Fristen forlænges, når stoppet ophæves (stripe_noedstop_saet).
-- Serveren springer også selv over (annullerUbetalte) - dette er værnet under
-- låsen, hvis stoppet sættes midt i en cron-kørsel.
do $do$
begin
  raise notice 'ubetalt_vinder_annuller: %', pg_temp.ps_ret('public.ubetalt_vinder_annuller(uuid,boolean)',
    'a63a21a81e2c9c82a22e71f2d00de606', '785545cb6f4c3695e68b2dc2d77098c5', jsonb_build_array(
      jsonb_build_array(
        'if b.venter_paa_saelgerkonto_kl is not null or not (',
        'if public.nye_betalinger_stoppet() or b.venter_paa_saelgerkonto_kl is not null or not (', 1)));
end $do$;

-- ===========================================================================
-- Nye kolonner (betalinger, betalingsprofiler)
-- ===========================================================================
alter table public.betalinger
  add column if not exists udbetaling_godkendt_kl         timestamptz,
  add column if not exists udbetaling_godkendt_af         uuid references public.users(id) on delete set null,
  add column if not exists auto_frigiv_opgave_kl          timestamptz,
  add column if not exists bidhamr_daekker_kl             timestamptz,
  add column if not exists bidhamr_daekker_af             uuid references public.users(id) on delete set null,
  add column if not exists bidhamr_daekker_oere           bigint,
  add column if not exists bidhamr_daekker_begrundelse    text,
  add column if not exists bidhamr_daekker_laas_noegle    uuid,
  add column if not exists bidhamr_daekker_laas_til       timestamptz,
  add column if not exists bidhamr_daekker_refund_id      text,
  add column if not exists bidhamr_daekker_refunderet_kl  timestamptz,
  add column if not exists bidhamr_daekker_fejl           text,
  -- Markeringen, som den stod, da chefen startede "BidHamr dækker"
  -- (betaling_registrer_refunderet overskriver sidste_fejl): sættes tilbage
  -- af betaling_bidhamr_daekker_afslut, så andre åbne grunde ikke forsvinder.
  add column if not exists bidhamr_daekker_foer_fejl      text,
  add column if not exists bidhamr_daekker_foer_opm       boolean;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'betalinger_bidhamr_daekker_check'
                   and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_bidhamr_daekker_check check (
          (bidhamr_daekker_oere is null or (bidhamr_daekker_oere > 0 and bidhamr_daekker_oere <= total_oere))
      and (bidhamr_daekker_kl is null or (bidhamr_daekker_af is not null and bidhamr_daekker_oere is not null
                                          and bidhamr_daekker_begrundelse is not null))
      and char_length(coalesce(bidhamr_daekker_begrundelse, '')) <= 2000
      and char_length(coalesce(bidhamr_daekker_fejl, '')) <= 500);
  end if;
end $do$;

comment on column public.betalinger.udbetaling_godkendt_kl is
  'Chefens godkendelse af en udbetaling fra 10.000 kr. (betaling_udbetaling_godkend). Uden den blokerer betaling_udbetaling_blokeret med kraever_godkendelse.';
comment on column public.betalinger.auto_frigiv_opgave_kl is
  '14 dage efter afsendelse uden leveringsmelding (eller uden BidHamrs fragtlabel): staff har fået en opgave (markering) i stedet for automatisk frigivelse (handel_auto_frigiv).';
comment on column public.betalinger.bidhamr_daekker_kl is
  '"BidHamr dækker" (kun chef): køberen refunderes fra platformen efter udbetaling, uden tilbageførsel fra sælgeren. Beløbet låses i bidhamr_daekker_oere ved første claim.';

-- Pengene er låst, til staff har set på det (fremmed udbetaling eller ændret
-- udbetalingsplan). salg_frosset_kl stopper også nye auktioner og bud på
-- sælgerens auktioner. Kun chefen ophæver.
alter table public.betalingsprofiler
  add column if not exists udbetaling_frosset_kl    timestamptz,
  add column if not exists salg_frosset_kl          timestamptz,
  add column if not exists connect_plan_tjekket_kl  timestamptz;

-- Grunden til en frysning må sælgeren ikke se. Sælgeren kan læse hele sin
-- egen betalingsprofil (RLS, select('*') bruges fra klienten), så grunden
-- står i sin egen tabel, som kun service role kan læse og skrive.
create table if not exists public.saelger_frysning_grunde (
  user_id    uuid primary key references public.users(id) on delete cascade,
  grund      text not null,
  tekst      text,
  frosset_af uuid references public.users(id) on delete set null,
  oprettet   timestamptz not null default now(),
  constraint saelger_frysning_grunde_grund_check
    check (grund in ('fremmed_udbetaling', 'udbetalingsplan', 'manuel')),
  constraint saelger_frysning_grunde_tekst_check
    check (char_length(coalesce(tekst, '')) <= 2000)
);
alter table public.saelger_frysning_grunde enable row level security;
revoke all on table public.saelger_frysning_grunde from public, anon, authenticated;
grant all on table public.saelger_frysning_grunde to service_role;
comment on table public.saelger_frysning_grunde is
  'Hvorfor sælgerens udbetalinger er frosset (kun staff via service role). Rækken slettes, når chefen ophæver frysningen - historikken står i moderation_log.';

-- En tidligere udgave af migrationen (kun testdatabasen) havde grunden som
-- kolonne på betalingsprofiler: flyt den og fjern kolonnen.
do $do$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'betalingsprofiler'
                and column_name = 'udbetaling_frosset_grund') then
    execute $q$
      insert into public.saelger_frysning_grunde (user_id, grund, oprettet)
      select bp.user_id, bp.udbetaling_frosset_grund, coalesce(bp.udbetaling_frosset_kl, now())
        from public.betalingsprofiler bp
       where bp.udbetaling_frosset_grund is not null
      on conflict (user_id) do nothing$q$;
    alter table public.betalingsprofiler drop column udbetaling_frosset_grund;
  end if;
end $do$;

comment on column public.betalingsprofiler.udbetaling_frosset_kl is
  'Udbetalinger fra sælgerens Stripe-konto er frosset (fremmed udbetaling, ændret udbetalingsplan eller chefens valg - grunden står i saelger_frysning_grunde), til chefen har ophævet det (saelger_frysning_ophaev). Kun service role skriver.';
comment on column public.betalingsprofiler.salg_frosset_kl is
  'Sælgeren kan ikke oprette auktioner, og der kan ikke bydes på sælgerens auktioner (fremmed udbetaling). Ophæves sammen med udbetaling_frosset_kl.';

-- ===========================================================================
-- 8. Inhabilitet: part i handlen eller har handlet med en af parterne
-- ===========================================================================
create or replace function public.penge_inhabil(p_medarbejder uuid, p_koeber uuid, p_saelger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_medarbejder is not null and (
       p_medarbejder = p_koeber
    or p_medarbejder = p_saelger
    or public.dsa_er_inhabil(p_medarbejder, p_koeber)
    or public.dsa_er_inhabil(p_medarbejder, p_saelger));
$fn$;
revoke all on function public.penge_inhabil(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.penge_inhabil(uuid, uuid, uuid) to service_role;

do $do$
declare
  t jsonb := jsonb_build_array(
    'if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then',
    'if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then', 1);
  b jsonb := jsonb_build_array(
    'if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then',
    'if public.penge_inhabil(p_medarbejder, b.buyer_id, b.seller_id) then', 1);
  ia jsonb := jsonb_build_array(
    'if p_kilde = ''staff'' and p_medarbejder in (t.buyer_id, t.seller_id) then',
    'if p_kilde = ''staff'' and public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then', 1);
  an jsonb := jsonb_build_array(
    'if p_admin = b.buyer_id or p_admin = b.seller_id then',
    'if public.penge_inhabil(p_admin, b.buyer_id, b.seller_id) then', 1);
begin
  -- Rettelser efter review: de sidste fire pengefunktioner.
  raise notice 'sag_genaabn: %', pg_temp.ps_ret('public.sag_genaabn(uuid,uuid,text)',
    '422b8577375cb6de0e96434f4eed94c6', 'd32e4ff28c96d5f5c8902b7d133b040b', jsonb_build_array(t));
  raise notice 'admin_annuller_ikke_betalt: %', pg_temp.ps_ret('public.admin_annuller_ikke_betalt(uuid,uuid,text)',
    'cb5c0f654085c0268d004c6d0819ae9d', '58b0efde68a9d7fb74b2387afe0b6243', jsonb_build_array(an));
  raise notice 'admin_advarsel_betaling: %', pg_temp.ps_ret('public.admin_advarsel_betaling(uuid,uuid,text,text,text)',
    '01d6344ca3959df44f7eed8527dd8076', 'c7ce25df3cbe69683f4e35138dc44491', jsonb_build_array(b));
  raise notice 'indpakning_vurder: %', pg_temp.ps_ret('public.indpakning_vurder(uuid,uuid,text,text)',
    'ea358f982cfa5cd6537a0b3ff6d00b95', 'caec8ce7ab4446a812562fafd01c4763', jsonb_build_array(t));
  raise notice 'sag_afgoer: %', pg_temp.ps_ret('public.sag_afgoer(uuid,uuid,text,text,text,boolean)',
    '40967c98c12a7fa2d14add66c1f41488', 'ea0cd85a0d3c06f363650778ceb414cb', jsonb_build_array(t));
  raise notice 'sag_anke_afgoer: %', pg_temp.ps_ret('public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean)',
    'f6605b95c2072bd4a149e16893b0d256', '4f00919bdf83d3000f4769431906c5cc', jsonb_build_array(t));
  raise notice 'betaling_refusion_proev_igen: %', pg_temp.ps_ret('public.betaling_refusion_proev_igen(uuid,uuid,text)',
    '1dd6c252bd51865a13a87231f4815280', 'a2aa693f911076dd9cd8792b4a878ce9', jsonb_build_array(b));
  raise notice 'betaling_svindelvarsel_gennemgaaet: %', pg_temp.ps_ret('public.betaling_svindelvarsel_gennemgaaet(uuid,uuid,text)',
    '6f6ce4418533c857ed72e9224074a42b', '6e9c3c1107ce82f291a475a9c7e59cca', jsonb_build_array(b));
  raise notice 'betaling_indsigelse_tilbagefoersel_proev_igen: %', pg_temp.ps_ret('public.betaling_indsigelse_tilbagefoersel_proev_igen(uuid,uuid)',
    '648bd9402a193b0c146794a2fd4c8332', '81e97adf64bcf689ad3f5f67aa32d257', jsonb_build_array(b));
  raise notice 'betaling_indsigelse_tabt_luk: %', pg_temp.ps_ret('public.betaling_indsigelse_tabt_luk(uuid,uuid,text)',
    '73de6212839a3f503ad530eca65f4e46', 'd39f2d2d0e8b073ef8bfff2293ac31d6', jsonb_build_array(b));
  raise notice 'handel_ikke_afhentet_registrer: %', pg_temp.ps_ret('public.handel_ikke_afhentet_registrer(uuid,text,uuid,text,uuid,bigint)',
    'a77a954c936018065e902a67376a3d5d', '5db7b2d8ccaf053d89a38b4fb9a1cd37', jsonb_build_array(ia));
end $do$;

-- ===========================================================================
-- Chefens beløbsgrænse: 10.000 kr. (Filip, 12. okt. 2026)
-- ===========================================================================
-- Ét sted for grænsen (1.000.000 øre). Fra og med grænsen kræver en
-- admin-frigivelse chefen (admin_frigiv_handel, købers samlede betaling), og
-- en udbetaling til sælgeren venter på chefens godkendelse
-- (betaling_udbetaling_blokeret, _i_claim, betaling_udbetaling_godkend).
-- Under grænsen må admin selv frigive. Samme tal i koden:
-- CHEF_BELOEBSGRAENSE_OERE i src/lib/betaling/beregn.ts.
create or replace function public.chef_beloebsgraense_oere()
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select 1000000::bigint;
$fn$;
comment on function public.chef_beloebsgraense_oere() is
  'Chefens beløbsgrænse i øre (10.000 kr., Filip 12. okt. 2026): fra og med grænsen kræver admin-frigivelse chefen, og udbetalingen kræver chefens godkendelse.';
revoke all on function public.chef_beloebsgraense_oere() from public, anon, authenticated;
grant execute on function public.chef_beloebsgraense_oere() to service_role;

-- ===========================================================================
-- 5 + 7 + 11 + 13. betaling_udbetaling_blokeret (genoprettes helt)
-- ===========================================================================
-- null = intet blokerer. Hårde grunde først (sag, indsigelse, refusion ...),
-- derefter de tekniske (kontoen, midlerne), og til sidst fortrydelsesfrist,
-- chefens godkendelse og nødstop.
create or replace function public.betaling_udbetaling_blokeret(p_betaling uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  b       record;
  t       record;
  bp      record;
  v_erhv  boolean;
  v_lev   timestamptz;
begin
  select * into b from public.betalinger where id = p_betaling;
  if not found then return 'ikke_fundet'; end if;
  select * into t from public.trades where id = b.trade_id;
  select * into bp from public.betalingsprofiler where user_id = b.seller_id;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return 'ikke_betalt'; end if;
  if b.frigivet_kl is null then return 'ikke_frigivet'; end if;
  if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then return 'allerede_udbetalt'; end if;
  if b.refusion_anmodet_kl is not null or b.refunderet_kl is not null then return 'refusion'; end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then return 'indsigelse'; end if;
  if b.svindelvarsel_kl is not null and b.svindelvarsel_loest_kl is null then return 'svindelvarsel'; end if;
  if b.radar_review_aaben then return 'radar_review'; end if;
  if t.id is null or t.status = 'annulleret' then return 'handel_annulleret'; end if;
  if t.sag_aaben then return 'sag_aaben'; end if;
  if public.sag_holder_pengene(t.id) then return 'sag'; end if;
  if exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id) then return 'ikke_afhentet'; end if;
  if exists (select 1 from public.forsendelser fo
              where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.returneret_kl is not null) then
    return 'returneret';
  end if;
  if b.kraever_opmaerksomhed then return 'kraever_opmaerksomhed'; end if;
  if b.pengemodel = 'destination' then
    if b.stripe_destination_transfer_id is null then return 'transfer_ukendt'; end if;
    if b.midler_tilgaengelige_kl is null or b.midler_tilgaengelige_kl > now() then return 'midler_ikke_tilgaengelige'; end if;
    if b.udbetal_tidligst is not null and b.udbetal_tidligst > now() then return 'ventetid'; end if;
    if bp.user_id is null or bp.connect_frakoblet_kl is not null then return 'konto_frakoblet'; end if;
    if bp.stripe_account_id is distinct from b.saelger_stripe_konto then return 'konto_skiftet'; end if;
    if not bp.connect_plan_ok then return 'plan_ikke_manuel'; end if;
    if not coalesce(bp.connect_udbetalinger_aktiv, false) then return 'udbetalinger_inaktive'; end if;
    if bp.connect_udbetaling_fejlet_kl is not null then return 'venter_paa_bank'; end if;
  end if;
  if bp.udbetaling_frosset_kl is not null then return 'udbetaling_frosset'; end if;
  -- Erhverv: køberens fortrydelsesret (14 dage efter levering/modtagelse).
  select coalesce(a.erhverv, false) into v_erhv from public.auctions a where a.id = t.auction_id;
  v_erhv := coalesce(v_erhv, false)
            or exists (select 1 from public.users u where u.id = b.seller_id and u.konto_type = 'erhverv');
  if v_erhv then
    select max(fo.leveret_kl) into v_lev
      from public.forsendelser fo
     where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.status not in ('annulleret', 'fejlet');
    v_lev := coalesce(v_lev, t.received_at, case when coalesce(t.afhentning, false) then b.frigivet_kl end);
    if v_lev is null or v_lev > now() - interval '14 days' then return 'fortrydelsesfrist'; end if;
  end if;
  -- Fra 10.000 kr. til sælgeren kræver chefens godkendelse (Filip, 12. okt. 2026).
  if b.udbetaling_oere >= public.chef_beloebsgraense_oere() and b.udbetaling_godkendt_kl is null then return 'kraever_godkendelse'; end if;
  if public.udbetalinger_stoppet() then return 'udbetalinger_stoppet'; end if;
  return null;
end;
$fn$;

revoke all on function public.betaling_udbetaling_blokeret(uuid) from public, anon, authenticated;
grant execute on function public.betaling_udbetaling_blokeret(uuid) to service_role;

-- Samme regler for en betaling i den uafklarede udbetaling p_udbetaling.
create or replace function public.betaling_udbetaling_blokeret_i_claim(p_betaling uuid, p_udbetaling uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  b       record;
  t       record;
  bp      record;
  v_erhv  boolean;
  v_lev   timestamptz;
begin
  select * into b from public.betalinger where id = p_betaling;
  if not found then return 'ikke_fundet'; end if;
  if b.saelger_udbetaling_id is distinct from p_udbetaling then return 'ikke_i_claim'; end if;
  select * into t from public.trades where id = b.trade_id;
  select * into bp from public.betalingsprofiler where user_id = b.seller_id;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return 'ikke_betalt'; end if;
  if b.frigivet_kl is null then return 'ikke_frigivet'; end if;
  if b.stripe_transfer_id is not null then return 'allerede_udbetalt'; end if;
  if b.refusion_anmodet_kl is not null or b.refunderet_kl is not null then return 'refusion'; end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then return 'indsigelse'; end if;
  if b.svindelvarsel_kl is not null and b.svindelvarsel_loest_kl is null then return 'svindelvarsel'; end if;
  if b.radar_review_aaben then return 'radar_review'; end if;
  if t.id is null or t.status = 'annulleret' then return 'handel_annulleret'; end if;
  if t.sag_aaben then return 'sag_aaben'; end if;
  if public.sag_holder_pengene(t.id) then return 'sag'; end if;
  if exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id) then return 'ikke_afhentet'; end if;
  if exists (select 1 from public.forsendelser fo
              where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.returneret_kl is not null) then
    return 'returneret';
  end if;
  if b.kraever_opmaerksomhed then return 'kraever_opmaerksomhed'; end if;
  if b.pengemodel <> 'destination' then return 'ikke_destination'; end if;
  if b.stripe_destination_transfer_id is null then return 'transfer_ukendt'; end if;
  if b.midler_tilgaengelige_kl is null or b.midler_tilgaengelige_kl > now() then return 'midler_ikke_tilgaengelige'; end if;
  if b.udbetal_tidligst is not null and b.udbetal_tidligst > now() then return 'ventetid'; end if;
  if bp.user_id is null or bp.connect_frakoblet_kl is not null then return 'konto_frakoblet'; end if;
  if bp.stripe_account_id is distinct from b.saelger_stripe_konto then return 'konto_skiftet'; end if;
  if not bp.connect_plan_ok then return 'plan_ikke_manuel'; end if;
  if not coalesce(bp.connect_udbetalinger_aktiv, false) then return 'udbetalinger_inaktive'; end if;
  if bp.connect_udbetaling_fejlet_kl is not null then return 'venter_paa_bank'; end if;
  if bp.udbetaling_frosset_kl is not null then return 'udbetaling_frosset'; end if;
  select coalesce(a.erhverv, false) into v_erhv from public.auctions a where a.id = t.auction_id;
  v_erhv := coalesce(v_erhv, false)
            or exists (select 1 from public.users u where u.id = b.seller_id and u.konto_type = 'erhverv');
  if v_erhv then
    select max(fo.leveret_kl) into v_lev
      from public.forsendelser fo
     where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.status not in ('annulleret', 'fejlet');
    v_lev := coalesce(v_lev, t.received_at, case when coalesce(t.afhentning, false) then b.frigivet_kl end);
    if v_lev is null or v_lev > now() - interval '14 days' then return 'fortrydelsesfrist'; end if;
  end if;
  if b.udbetaling_oere >= public.chef_beloebsgraense_oere() and b.udbetaling_godkendt_kl is null then return 'kraever_godkendelse'; end if;
  if public.udbetalinger_stoppet() then return 'udbetalinger_stoppet'; end if;
  return null;
end;
$fn$;

revoke all on function public.betaling_udbetaling_blokeret_i_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.betaling_udbetaling_blokeret_i_claim(uuid, uuid) to service_role;

-- Som 20261011030000, men nødstop og frysning afvises først (kode 'stoppet' /
-- 'frosset' - intet låses).
create or replace function public.saelger_udbetaling_claim(
  p_saelger uuid, p_konto text, p_betalinger uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b        record;
  v_grund  text;
  v_ok     uuid[] := '{}';
  v_afvist jsonb := '[]'::jsonb;
  v_sum    bigint := 0;
  v_id     uuid;
begin
  if p_saelger is null or p_konto is null or coalesce(array_length(p_betalinger, 1), 0) = 0 then
    return jsonb_build_object('kode', 'intet', 'afvist', v_afvist);
  end if;
  if public.udbetalinger_stoppet() then
    return jsonb_build_object('kode', 'stoppet', 'afvist', v_afvist);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('saelger_udbetaling:' || p_saelger::text));
  if exists (select 1 from public.betalingsprofiler bp
              where bp.user_id = p_saelger and bp.udbetaling_frosset_kl is not null) then
    return jsonb_build_object('kode', 'frosset', 'afvist', v_afvist);
  end if;
  if exists (select 1 from public.saelger_udbetalinger u
              where u.seller_id = p_saelger and u.status in ('claimet', 'usikker')) then
    return jsonb_build_object('kode', 'i_gang', 'afvist', v_afvist);
  end if;

  for b in
    select * from public.betalinger
     where id = any (p_betalinger)
     order by id
       for update
  loop
    perform 1 from public.trades t where t.id = b.trade_id for update;
    if b.seller_id <> p_saelger then
      v_grund := 'anden_saelger';
    elsif b.pengemodel <> 'destination' then
      v_grund := 'ikke_destination';
    elsif b.saelger_stripe_konto is distinct from p_konto then
      v_grund := 'anden_konto';
    elsif b.udbetaling_oere <= 0 then
      v_grund := 'intet_beloeb';
    else
      v_grund := public.betaling_udbetaling_blokeret(b.id);
    end if;
    if v_grund is null then
      v_ok := v_ok || b.id;
      v_sum := v_sum + b.udbetaling_oere;
    else
      v_afvist := v_afvist || jsonb_build_object('betaling_id', b.id, 'grund', v_grund);
    end if;
  end loop;

  if coalesce(array_length(v_ok, 1), 0) = 0 then
    return jsonb_build_object('kode', 'intet', 'afvist', v_afvist);
  end if;

  insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids)
  values (p_saelger, p_konto, v_sum, 'dkk', 'claimet', v_ok)
  returning id into v_id;

  update public.betalinger
     set saelger_udbetaling_id = v_id,
         overfoersel_paabegyndt_kl = coalesce(overfoersel_paabegyndt_kl, now()),
         opdateret = now()
   where id = any (v_ok);

  return jsonb_build_object('kode', 'ok', 'udbetaling_id', v_id, 'beloeb_oere', v_sum,
                            'betalinger', to_jsonb(v_ok), 'afvist', v_afvist);
end;
$fn$;

revoke all on function public.saelger_udbetaling_claim(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_claim(uuid, text, uuid[]) to service_role;

-- ===========================================================================
-- 11. Chefens godkendelse af udbetaling fra 10.000 kr.
-- ===========================================================================
-- Kode: ok | ingen_adgang | inhabil | ikke_fundet | ikke_noedvendig |
-- allerede | ikke_frigivet | udbetalt | note_mangler | note_for_lang
create or replace function public.betaling_udbetaling_godkend(
  p_medarbejder uuid, p_betaling uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b      record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users u where u.id = p_medarbejder and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is null then return jsonb_build_object('kode', 'note_mangler'); end if;
  if char_length(v_note) > 2000 then return jsonb_build_object('kode', 'note_for_lang'); end if;
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if public.penge_inhabil(p_medarbejder, b.buyer_id, b.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if b.udbetaling_oere < public.chef_beloebsgraense_oere() then return jsonb_build_object('kode', 'ikke_noedvendig'); end if;
  if b.udbetaling_godkendt_kl is not null then return jsonb_build_object('kode', 'allerede'); end if;
  if b.status <> 'betalt' or b.frigivet_kl is null then return jsonb_build_object('kode', 'ikke_frigivet'); end if;
  if b.saelger_udbetaling_id is not null or b.stripe_transfer_id is not null then
    return jsonb_build_object('kode', 'udbetalt');
  end if;
  update public.betalinger
     set udbetaling_godkendt_kl = now(), udbetaling_godkendt_af = p_medarbejder, opdateret = now()
   where id = b.id;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'udbetaling_godkendt', 'handel', b.trade_id, b.seller_id,
          left('Udbetaling over beløbsgrænsen godkendt - ' || v_note, 2000));
  return jsonb_build_object('kode', 'ok', 'trade_id', b.trade_id, 'seller_id', b.seller_id);
end;
$fn$;
revoke all on function public.betaling_udbetaling_godkend(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_udbetaling_godkend(uuid, uuid, text) to service_role;

-- ===========================================================================
-- 13. Frysning af sælgerens udbetalinger (fremmed udbetaling / plan ændret)
-- ===========================================================================
-- Fælles kerne. Alle sælgerens ventende handler (betalt, ikke udbetalt, ikke
-- refunderet) markeres til staff. Idempotent: svarer true, når frysningen er
-- ny (eller salget nu også fryses). p_medarbejder står i loggen.
create or replace function public.saelger_frys_kerne(
  p_saelger uuid, p_grund text, p_frys_salg boolean, p_tekst text, p_medarbejder uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  bp     record;
  -- Hele teksten (fx chefens begrundelse på op til 1000 tegn) gemmes i
  -- grunde og loggen; kun de første 300 tegn i betalingens sidste_fejl.
  v_fuld  text := left(coalesce(nullif(btrim(coalesce(p_tekst, '')), ''), 'Sælgerens udbetalinger er frosset'), 1500);
  v_tekst text := left(v_fuld, 300);
begin
  if p_saelger is null or p_medarbejder is null
     or p_grund is null or p_grund not in ('fremmed_udbetaling', 'udbetalingsplan', 'manuel') then
    return false;
  end if;
  select * into bp from public.betalingsprofiler where user_id = p_saelger for update;
  if not found then return false; end if;
  if bp.udbetaling_frosset_kl is not null
     and (not coalesce(p_frys_salg, false) or bp.salg_frosset_kl is not null) then
    return false;
  end if;
  update public.betalingsprofiler
     set udbetaling_frosset_kl = coalesce(udbetaling_frosset_kl, now()),
         salg_frosset_kl = case when coalesce(p_frys_salg, false) then coalesce(salg_frosset_kl, now()) else salg_frosset_kl end,
         opdateret = now()
   where user_id = p_saelger;
  -- Første grund gælder (som før).
  insert into public.saelger_frysning_grunde (user_id, grund, tekst, frosset_af)
  values (p_saelger, p_grund, v_fuld, p_medarbejder)
  on conflict (user_id) do nothing;
  update public.betalinger
     set kraever_opmaerksomhed = true,
         sidste_fejl = left(coalesce(nullif(sidste_fejl, '') || ' | ', '') || v_tekst, 500),
         opdateret = now()
   where seller_id = p_saelger
     and status = 'betalt'
     and saelger_udbetaling_id is null
     and stripe_transfer_id is null
     and refunderet_kl is null;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'udbetaling_frosset', 'bruger', p_saelger, p_saelger,
          left(v_fuld || case when coalesce(p_frys_salg, false) then ' (også nye auktioner og bud)' else '' end, 2000));
  return true;
end;
$fn$;
revoke all on function public.saelger_frys_kerne(uuid, text, boolean, text, uuid) from public, anon, authenticated;

-- Kun service role (webhook, overvågning): grund fremmed_udbetaling eller
-- udbetalingsplan, logget som BidHamr (systemet).
create or replace function public.saelger_frys_udbetaling(
  p_saelger uuid, p_grund text, p_frys_salg boolean, p_tekst text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_grund is null or p_grund not in ('fremmed_udbetaling', 'udbetalingsplan') then return false; end if;
  return public.saelger_frys_kerne(p_saelger, p_grund, p_frys_salg, p_tekst, public.bidhamr_system_id());
end;
$fn$;
revoke all on function public.saelger_frys_udbetaling(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.saelger_frys_udbetaling(uuid, text, boolean, text) to service_role;

-- Chefen fryser selv en sælger (Admin → brugeren → "Frys sælger"). Kun chef,
-- ikke inhabil, begrundelse påkrævet. p_frys_salg: også nye auktioner og bud.
-- Kode: ok | ingen_adgang | inhabil | begrundelse_mangler |
-- begrundelse_for_lang | ingen_profil | allerede
create or replace function public.saelger_frys_manuelt(
  p_medarbejder uuid, p_saelger uuid, p_begrundelse text, p_frys_salg boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_begr text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users u where u.id = p_medarbejder and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_begr is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_begr) > 1000 then return jsonb_build_object('kode', 'begrundelse_for_lang'); end if;
  if p_saelger is null then return jsonb_build_object('kode', 'ingen_profil'); end if;
  if p_medarbejder = p_saelger or public.dsa_er_inhabil(p_medarbejder, p_saelger) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if not exists (select 1 from public.betalingsprofiler bp where bp.user_id = p_saelger) then
    return jsonb_build_object('kode', 'ingen_profil');
  end if;
  if not public.saelger_frys_kerne(p_saelger, 'manuel', coalesce(p_frys_salg, false),
                                   'Frosset af chefen: ' || v_begr, p_medarbejder) then
    return jsonb_build_object('kode', 'allerede');
  end if;
  return jsonb_build_object('kode', 'ok');
end;
$fn$;
revoke all on function public.saelger_frys_manuelt(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.saelger_frys_manuelt(uuid, uuid, text, boolean) to service_role;

-- Kun chef, ikke inhabil. Ophæver begge frysninger. Markeringerne på
-- betalingerne lukker staff selv (Markér som løst).
-- Kode: ok | ingen_adgang | inhabil | ikke_frosset | note_mangler | note_for_lang
create or replace function public.saelger_frysning_ophaev(p_medarbejder uuid, p_saelger uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  bp     record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users u where u.id = p_medarbejder and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is null then return jsonb_build_object('kode', 'note_mangler'); end if;
  if char_length(v_note) > 2000 then return jsonb_build_object('kode', 'note_for_lang'); end if;
  if p_medarbejder = p_saelger or public.dsa_er_inhabil(p_medarbejder, p_saelger) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  select * into bp from public.betalingsprofiler where user_id = p_saelger for update;
  if not found or (bp.udbetaling_frosset_kl is null and bp.salg_frosset_kl is null) then
    return jsonb_build_object('kode', 'ikke_frosset');
  end if;
  update public.betalingsprofiler
     set udbetaling_frosset_kl = null, salg_frosset_kl = null, opdateret = now()
   where user_id = p_saelger;
  delete from public.saelger_frysning_grunde where user_id = p_saelger;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'udbetaling_frysning_ophaevet', 'bruger', p_saelger, p_saelger, left(v_note, 2000));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;
revoke all on function public.saelger_frysning_ophaev(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.saelger_frysning_ophaev(uuid, uuid, text) to service_role;

-- Nye auktioner og bud på sælgerens auktioner afvises, mens salget er frosset
-- (gælder alle roller - også serveren).
create or replace function public.auctions_salg_frosset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.bruger_id is not null and exists (
       select 1 from public.betalingsprofiler bp
        where bp.user_id = new.bruger_id and bp.salg_frosset_kl is not null) then
    raise exception 'saelger_spaerret: Du kan ikke sætte varer til salg lige nu. Kontakt BidHamr.'
      using errcode = 'BHU04';
  end if;
  return new;
end;
$fn$;
revoke all on function public.auctions_salg_frosset() from public, anon, authenticated;
drop trigger if exists auctions_salg_frosset on public.auctions;
create trigger auctions_salg_frosset before insert on public.auctions
  for each row execute function public.auctions_salg_frosset();

create or replace function public.bids_salg_frosset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (
    select 1
      from public.auctions a
      join public.betalingsprofiler bp on bp.user_id = a.bruger_id
     where a.id = new.auktion_id
       and bp.salg_frosset_kl is not null) then
    raise exception 'saelger_spaerret: Der kan ikke bydes på sælgerens auktioner lige nu.'
      using errcode = 'BHU05';
  end if;
  return new;
end;
$fn$;
revoke all on function public.bids_salg_frosset() from public, anon, authenticated;
drop trigger if exists bids_salg_frosset on public.bids;
create trigger bids_salg_frosset before insert on public.bids
  for each row execute function public.bids_salg_frosset();

-- ===========================================================================
-- 2. admin_frigiv_handel med medarbejder (erstatter admin_frigiv_handel(uuid))
-- ===========================================================================
drop function if exists public.admin_frigiv_handel(uuid);

-- Admin/chef frigiver pengene til sælgeren uden købers godkendelse.
-- Kode: ok | ugyldig | ingen_adgang | begrundelse_mangler | begrundelse_for_lang |
--   ingen_betaling | ikke_fundet | inhabil | ikke_betalt | allerede | refusion |
--   indsigelse | svindelvarsel | radar_review | forkert_status | ikke_sendt |
--   sag_aaben | sag | ikke_afhentet | kraever_chef
-- Fra 10.000 kr. (købers samlede betaling) kræver chef; under 10.000 kr. må
-- admin selv (Filip, 12. okt. 2026). Grænsen: chef_beloebsgraense_oere().
create or replace function public.admin_frigiv_handel(p_trade uuid, p_medarbejder uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b       record;
  t       record;
  v_rolle text;
  v_begr  text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  if p_trade is null or p_medarbejder is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  select u.rolle into v_rolle from public.users u where u.id = p_medarbejder;
  if v_rolle is null or v_rolle not in ('admin', 'chef') then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if v_begr is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_begr) > 2000 then return jsonb_build_object('kode', 'begrundelse_for_lang'); end if;

  -- Låserækkefølge: betaling, handel.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then
    if not exists (select 1 from public.trades where id = p_trade) then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    return jsonb_build_object('kode', 'ingen_betaling');
  end if;
  select * into t from public.trades where id = p_trade for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return jsonb_build_object('kode', 'ikke_betalt'); end if;
  if b.frigivet_kl is not null or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'allerede');
  end if;
  if b.refusion_anmodet_kl is not null or b.refunderet_kl is not null then
    return jsonb_build_object('kode', 'refusion');
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or b.indsigelse_status = 'lost' or b.indsigelse_tilbagefoert_oere is not null then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if b.svindelvarsel_kl is not null and b.svindelvarsel_loest_kl is null then
    return jsonb_build_object('kode', 'svindelvarsel');
  end if;
  if b.radar_review_aaben then return jsonb_build_object('kode', 'radar_review'); end if;
  if t.status not in ('betaling_modtaget', 'pakke_sendt', 'modtaget') then
    return jsonb_build_object('kode', 'forkert_status');
  end if;
  -- Forsendelse, men intet afsendt: pengene kan ikke frigives.
  if t.status = 'betaling_modtaget' and not coalesce(t.afhentning, false) then
    return jsonb_build_object('kode', 'ikke_sendt');
  end if;
  if coalesce(t.sag_aaben, false) then return jsonb_build_object('kode', 'sag_aaben'); end if;
  if public.sag_holder_pengene(t.id) then return jsonb_build_object('kode', 'sag'); end if;
  if exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id)
     or exists (select 1 from public.forsendelser fo
                 where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.returneret_kl is not null) then
    return jsonb_build_object('kode', 'ikke_afhentet');
  end if;
  if b.total_oere >= public.chef_beloebsgraense_oere() and v_rolle <> 'chef' then
    return jsonb_build_object('kode', 'kraever_chef');
  end if;

  update public.trades
     set status = 'leveret', received_at = coalesce(received_at, now())
   where id = t.id and status = t.status;
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where id = b.id and frigivet_kl is null;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'handel_frigivet', 'handel', t.id, t.seller_id,
          left('Frigivet til sælger af BidHamr - ' || v_begr, 2000));

  return jsonb_build_object('kode', 'ok', 'betaling_id', b.id, 'trade_id', t.id,
                            'seller_id', t.seller_id, 'buyer_id', t.buyer_id,
                            'over_graense', b.total_oere >= public.chef_beloebsgraense_oere());
end;
$fn$;
revoke all on function public.admin_frigiv_handel(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_frigiv_handel(uuid, uuid, text) to service_role;

-- ===========================================================================
-- 3. Automatisk frigivelse (Filip, 11. okt. 2026)
-- ===========================================================================
-- Som 20261016030000, men 14 dage efter afsendelse frigives KUN, når en
-- udgående forsendelse med BidHamrs fragtlabel er meldt leveret/afhentet
-- (forsendelser.leveret_kl). Ellers - ingen leveringsmelding, eller sælgerens
-- eget sporingsnummer uden BidHamr-label - frigives der aldrig automatisk:
-- staff får én gang en opgave (markering på betalingen, auto_frigiv_opgave_kl).
-- 48 timer efter købers "modtaget" er uændret.
create or replace function public.handel_auto_frigiv()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  k       record;
  b       record;
  t       record;
  v_grund text;
  v_label boolean;
  v_lev   boolean;
  v_tekst text;
  v_ud    jsonb := '[]'::jsonb;
begin
  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.trades tr
      join public.betalinger bt on bt.trade_id = tr.id
     where bt.status = 'betalt'
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null and bt.saelger_udbetaling_id is null
       and not coalesce(tr.sag_aaben, false)
       -- Frasorteres her, saa de ikke fylder de 200 pladser hver gang.
       and not public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
       and not exists (
         select 1 from public.sager s
          where s.trade_id = tr.id
            and (s.status in ('aaben', 'afventer_retur')
                 or (s.penge_handling is not null and s.afviklet_kl is null)))
       -- Pakken er sendt retur (ikke afhentet): aldrig automatisk.
       and not exists (
         select 1 from public.forsendelser fo
          where fo.trade_id = tr.id and fo.type = 'udgaaende' and fo.returneret_kl is not null)
       and not exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = tr.id)
       and ((tr.status = 'modtaget' and tr.received_at < now() - interval '48 hours')
            or (tr.status = 'pakke_sendt'
                and coalesce(tr.sendt_kl, bt.betalt_kl) < now() - interval '14 days'
                -- Opgaven er givet: kun med igen, når pakken er meldt leveret.
                and (bt.auto_frigiv_opgave_kl is null
                     or exists (select 1 from public.forsendelser fo
                                 where fo.trade_id = tr.id and fo.type = 'udgaaende'
                                   and fo.status not in ('annulleret', 'fejlet')
                                   and fo.leveret_kl is not null))))
     order by tr.id
     limit 200
  loop
    -- Hver raekke i sin egen undertransaktion: een fejl (fx en constraint)
    -- ruller kun den raekke tilbage og stopper ikke resten af batchen.
    begin
      -- Laaseraekkefoelge: betaling, handel. Alt tjekkes igen under laas.
      select * into b from public.betalinger where id = k.betaling_id for update;
      select * into t from public.trades where id = k.trade_id for update;

      if b.status <> 'betalt'
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
         or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
         or coalesce(t.sag_aaben, false)
         or public.sag_holder_pengene(t.id)
         or exists (select 1 from public.forsendelser fo
                     where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.returneret_kl is not null)
         or exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id) then
        continue;
      end if;

      if t.status = 'modtaget' and t.received_at < now() - interval '48 hours' then
        v_grund := '48_timer';
      elsif t.status = 'pakke_sendt'
            and coalesce(t.sendt_kl, b.betalt_kl) < now() - interval '14 days' then
        select count(*) > 0,
               coalesce(bool_or(fo.leveret_kl is not null), false)
          into v_label, v_lev
          from public.forsendelser fo
         where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.status not in ('annulleret', 'fejlet');
        if v_label and v_lev then
          v_grund := '14_dage';
        else
          -- Aldrig automatisk: en opgave til staff (én gang).
          if b.auto_frigiv_opgave_kl is null then
            v_tekst := case when v_label
              then 'Pakken blev sendt med BidHamrs fragtlabel for over 14 dage siden, men fragtfirmaet har ikke meldt den leveret eller afhentet. Pengene frigives ikke automatisk - efterlys pakken hos fragtfirmaet og afgør handlen.'
              else 'Pakken blev sendt uden BidHamrs fragtlabel (sælgerens eget sporingsnummer) for over 14 dage siden, og køberen har ikke bekræftet modtagelsen. Pengene frigives aldrig automatisk - kontakt køberen og afgør handlen.'
            end;
            update public.betalinger
               set auto_frigiv_opgave_kl = now(),
                   kraever_opmaerksomhed = true,
                   sidste_fejl = left(coalesce(nullif(sidste_fejl, '') || ' | ', '') || v_tekst, 500),
                   opdateret = now()
             where id = b.id and auto_frigiv_opgave_kl is null;
          end if;
          continue;
        end if;
      else
        continue;
      end if;

      update public.trades
         set status = 'leveret', received_at = coalesce(received_at, now())
       where id = t.id and status = t.status;
      if not found then continue; end if;

      update public.betalinger
         set frigivet_kl = now(), opdateret = now()
       where id = b.id and frigivet_kl is null;

      v_ud := v_ud || jsonb_build_array(jsonb_build_object(
        'betaling_id', b.id, 'trade_id', t.id, 'buyer_id', t.buyer_id,
        'seller_id', t.seller_id, 'auction_id', t.auction_id, 'grund', v_grund));
    exception when others then
      raise warning 'handel_auto_frigiv: handel % fejlede: %', k.trade_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.handel_auto_frigiv() from public, anon, authenticated;
grant execute on function public.handel_auto_frigiv() to service_role;

-- ===========================================================================
-- 6. "BidHamr dækker" - refusion fra platformen efter udbetaling (kun chef)
-- ===========================================================================
-- Udbetalingen til sælgerens bank er gennemført (saelger_udbetalinger.status
-- = 'paid' - en udbetaling, der stadig er på vej, kan fejle og komme tilbage
-- på sælgerens Stripe-konto, og så skal den almindelige refusion bruges); en
-- udbetaling trækkes aldrig tilbage fra sælgeren. Chefen kan lade BidHamr
-- refundere køberen af platformens egen saldo (refunds.create uden
-- reverse_transfer og uden refund_application_fee). Beløbet låses første gang:
--   en sag med medhold, der venter på refusion -> total - BidHamr Beskyttelse
--   ellers                                     -> det bestilte refusionsbeløb
--                                                 (refusion_oere), ellers total
-- Kode: ok | ingen_adgang | begrundelse_mangler | begrundelse_for_lang |
--   ikke_fundet | inhabil | ugyldig | allerede | i_gang | ikke_betalt |
--   ikke_udbetalt | udbetaling_uafklaret | indsigelse | konflikt
create or replace function public.betaling_bidhamr_daekker_claim(
  p_medarbejder uuid, p_betaling uuid, p_begrundelse text, p_noegle uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b      record;
  v_begr text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_ust  text;
  v_r    bigint;
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users u where u.id = p_medarbejder and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_noegle is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  perform 1 from public.trades where id = b.trade_id for update;
  if public.penge_inhabil(p_medarbejder, b.buyer_id, b.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if b.bidhamr_daekker_refunderet_kl is not null or b.status = 'refunderet' then
    return jsonb_build_object('kode', 'allerede');
  end if;
  if b.bidhamr_daekker_laas_til is not null and b.bidhamr_daekker_laas_til > now() then
    return jsonb_build_object('kode', 'i_gang');
  end if;
  -- Første gang kræves begrundelse; et nyt forsøg genbruger den låste plan.
  if b.bidhamr_daekker_kl is null then
    if v_begr is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
    if char_length(v_begr) > 2000 then return jsonb_build_object('kode', 'begrundelse_for_lang'); end if;
  end if;
  if b.pengemodel <> 'destination' or b.stripe_payment_intent_id is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return jsonb_build_object('kode', 'ikke_betalt'); end if;
  if b.saelger_udbetaling_id is null then return jsonb_build_object('kode', 'ikke_udbetalt'); end if;
  select u.status into v_ust from public.saelger_udbetalinger u where u.id = b.saelger_udbetaling_id;
  if v_ust is null or v_ust <> 'paid' then
    return jsonb_build_object('kode', 'udbetaling_uafklaret');
  end if;
  if b.indsigelse_kl is not null
     and (public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) or b.indsigelse_status = 'lost') then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if b.stripe_refund_id is not null or b.gebyr_refunderet_kl is not null or b.refusion_tilbagefoert_kl is not null then
    return jsonb_build_object('kode', 'konflikt');
  end if;

  if b.bidhamr_daekker_oere is null then
    v_r := case
      when exists (select 1 from public.sager s
                    where s.trade_id = b.trade_id and s.penge_handling = 'refunder' and s.afviklet_kl is null)
        then b.total_oere - coalesce(b.beskyttelse_oere, 0)
      else coalesce(b.refusion_oere, b.total_oere) end;
    if v_r <= 0 or v_r > b.total_oere then return jsonb_build_object('kode', 'ugyldig'); end if;
    update public.betalinger
       set bidhamr_daekker_kl = now(),
           bidhamr_daekker_af = p_medarbejder,
           bidhamr_daekker_oere = v_r,
           bidhamr_daekker_begrundelse = left(v_begr, 2000),
           bidhamr_daekker_foer_fejl = sidste_fejl,
           bidhamr_daekker_foer_opm = kraever_opmaerksomhed
     where id = b.id;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'bidhamr_daekker', 'handel', b.trade_id, b.buyer_id,
            left('BidHamr dækker: køberen refunderes fra BidHamr efter udbetaling - ' || v_begr, 2000));
  else
    v_r := b.bidhamr_daekker_oere;
  end if;

  update public.betalinger
     set bidhamr_daekker_laas_noegle = p_noegle,
         bidhamr_daekker_laas_til = now() + interval '15 minutes',
         bidhamr_daekker_fejl = null,
         opdateret = now()
   where id = b.id;

  return jsonb_build_object('kode', 'ok', 'refusion_oere', v_r,
                            'payment_intent', b.stripe_payment_intent_id,
                            'charge', b.stripe_charge_id,
                            'trade_id', b.trade_id, 'buyer_id', b.buyer_id, 'seller_id', b.seller_id,
                            'refund_id', b.bidhamr_daekker_refund_id);
end;
$fn$;
revoke all on function public.betaling_bidhamr_daekker_claim(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.betaling_bidhamr_daekker_claim(uuid, uuid, text, uuid) to service_role;

-- Refusionen er oprettet hos Stripe (under låsen). Gemmer refund-id'et; er den
-- gennemført, registreres betalingen som refunderet (betaling_registrer_
-- refunderet: sager lukkes, handlen annulleres) og afsluttes. Svar: ok |
-- afventer | ikke_laast | konflikt | ikke_fundet
create or replace function public.betaling_bidhamr_daekker_registrer(
  p_betaling uuid, p_noegle uuid, p_refund text, p_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return 'ikke_fundet'; end if;
  if p_noegle is null or b.bidhamr_daekker_laas_noegle is distinct from p_noegle
     or b.bidhamr_daekker_laas_til is null or b.bidhamr_daekker_laas_til <= now() then
    return 'ikke_laast';
  end if;
  if b.bidhamr_daekker_refund_id is not null and b.bidhamr_daekker_refund_id <> p_refund then
    return 'konflikt';
  end if;
  update public.betalinger
     set bidhamr_daekker_refund_id = p_refund, opdateret = now()
   where id = b.id;
  if p_status <> 'succeeded' then return 'afventer'; end if;
  perform public.betaling_registrer_refunderet(b.stripe_payment_intent_id, p_refund);
  perform public.betaling_bidhamr_daekker_afslut(b.stripe_payment_intent_id);
  return 'ok';
end;
$fn$;

-- Afslutter en "BidHamr dækker"-refusion, når betalingen er registreret som
-- refunderet (også fra webhooken). Markeringen "Refunderet EFTER overfoersel"
-- er forventet her og fjernes - men kun den: markeringen fra før (gemt ved
-- første claim, hvis den var åben) og alt, der er kommet til siden, bevares.
-- kraever_opmaerksomhed nulstilles kun, når der ikke er andre åbne grunde
-- (ingen anden tekst, sælgeren er ikke frosset). Idempotent. Svar: ok | intet
create or replace function public.betaling_bidhamr_daekker_afslut(p_payment_intent text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b         record;
  c_mark    constant text := 'Refunderet EFTER overfoersel til saelger - kontroller hos Stripe';
  v_dele    text[];
  v_tekst   text;
  v_frosset boolean;
begin
  select * into b from public.betalinger where stripe_payment_intent_id = p_payment_intent for update;
  if not found or b.bidhamr_daekker_kl is null or b.status <> 'refunderet'
     or b.bidhamr_daekker_refunderet_kl is not null then
    return 'intet';
  end if;
  -- Delene (adskilt af ' | '): først markeringen fra før, så de nuværende -
  -- uden den forventede markering og uden dubletter.
  select array_agg(x order by n) into v_dele
    from (select distinct on (btrim(x)) btrim(x) as x, n
            from unnest(string_to_array(
                   case when coalesce(b.bidhamr_daekker_foer_opm, false)
                        then coalesce(b.bidhamr_daekker_foer_fejl, '') || ' | ' else '' end
                   || coalesce(b.sidste_fejl, ''), ' | ')) with ordinality as u(x, n)
           where btrim(x) <> '' and btrim(x) <> c_mark
             -- "Refusion fejlede" er netop løst af BidHamr dækker.
             and not public.betaling_fejl_er_refusion(btrim(x))
           order by btrim(x), n) d;
  v_tekst := nullif(left(array_to_string(v_dele, ' | '), 500), '');
  v_frosset := exists (select 1 from public.betalingsprofiler bp
                        where bp.user_id = b.seller_id and bp.udbetaling_frosset_kl is not null);
  update public.betalinger
     set bidhamr_daekker_refunderet_kl = now(),
         -- Den gennemførte refusion (stripe_refund_id sættes af
         -- betaling_registrer_refunderet) - aldrig et tidligere, fejlet id.
         bidhamr_daekker_refund_id = coalesce(stripe_refund_id, bidhamr_daekker_refund_id),
         bidhamr_daekker_laas_til = null,
         sidste_fejl = v_tekst,
         -- Var betalingen markeret uden tekst (ukendt grund), bevares
         -- markeringen. Var grunden kun "refusion fejlede", er den løst.
         kraever_opmaerksomhed = (v_tekst is not null or v_frosset
                                  or (coalesce(b.bidhamr_daekker_foer_opm, false)
                                      and nullif(btrim(coalesce(b.bidhamr_daekker_foer_fejl, '')), '') is null)),
         opdateret = now()
   where id = b.id;
  return 'ok';
end;
$fn$;
revoke all on function public.betaling_bidhamr_daekker_afslut(text) from public, anon, authenticated;
grant execute on function public.betaling_bidhamr_daekker_afslut(text) to service_role;
revoke all on function public.betaling_bidhamr_daekker_registrer(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.betaling_bidhamr_daekker_registrer(uuid, uuid, text, text) to service_role;

-- Låsen frigives (fejl gemmes uden beløb).
create or replace function public.betaling_bidhamr_daekker_frigiv(p_betaling uuid, p_noegle uuid, p_fejl text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.betalinger
     set bidhamr_daekker_laas_til = null,
         bidhamr_daekker_fejl = left(nullif(btrim(coalesce(p_fejl, '')), ''), 500),
         opdateret = now()
   where id = p_betaling and bidhamr_daekker_laas_noegle = p_noegle;
  return found;
end;
$fn$;
revoke all on function public.betaling_bidhamr_daekker_frigiv(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_bidhamr_daekker_frigiv(uuid, uuid, text) to service_role;

-- Den gemte refusion (bidhamr_daekker_refund_id) er fejlet eller annulleret
-- hos Stripe (serveren har slået den op): id'et nulstilles under låsen, før
-- et nyt forsøg - ellers giver registrer en falsk 'konflikt', og
-- kreditnotaen (faktura_planlaeg) får et forkert id. Virker kun med den
-- rigtige låsenøgle og kun, når id'et matcher. Svar: true = nulstillet.
create or replace function public.betaling_bidhamr_daekker_glem_refund(
  p_betaling uuid, p_noegle uuid, p_fejlet_refund text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_noegle is null or p_fejlet_refund is null then return false; end if;
  update public.betalinger
     set bidhamr_daekker_refund_id = null, opdateret = now()
   where id = p_betaling
     and bidhamr_daekker_laas_noegle = p_noegle
     and bidhamr_daekker_laas_til > now()
     and bidhamr_daekker_refund_id = p_fejlet_refund
     and bidhamr_daekker_refunderet_kl is null
     and status <> 'refunderet';
  return found;
end;
$fn$;
revoke all on function public.betaling_bidhamr_daekker_glem_refund(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_bidhamr_daekker_glem_refund(uuid, uuid, text) to service_role;

-- Kreditnota (købers faktura krediteres; sælgerens sælgergebyr står - han fik
-- sin udbetaling) og DAC7 (salget tæller stadig).
do $do$
begin
  raise notice 'faktura_planlaeg: %', pg_temp.ps_ret('public.faktura_planlaeg(integer)',
    'bfbdedf311ba334efd676cf3ba5a59e7', 'eaccfc18b96f7d35e32abfd591253bbc', jsonb_build_array(
      jsonb_build_array(
        E'public.faktura_ikke_afhentet_ok(x.id) as ia_ok\n      from public.fakturaer fa',
        E'public.faktura_ikke_afhentet_ok(x.id) as ia_ok,\n           x.bidhamr_daekker_refund_id, x.bidhamr_daekker_oere, x.total_oere\n      from public.fakturaer fa', 1),
      jsonb_build_array(
        E'and not (x.refusion_aarsag is not distinct from ''ikke_afhentet'' and fa.part = ''koeber'')',
        E'and not (x.refusion_aarsag is not distinct from ''ikke_afhentet'' and fa.part = ''koeber'')\n       -- BidHamr dækker (20261019010000): sælgeren fik sin udbetaling - hans faktura står.\n       and not (x.bidhamr_daekker_refund_id is not null and fa.part = ''saelger'')', 1),
      jsonb_build_array(
        E'    elsif rf.gebyr_refunderet_kl is null or rf.refusion_gebyr_oere is null then',
        E'    elsif rf.bidhamr_daekker_refund_id is not null then\n      -- BidHamr dækker: købers gebyrer, fragt (og Beskyttelse, medmindre den\n      -- blev beholdt ved en sag) er givet tilbage af BidHamr.\n      if rf.bidhamr_daekker_oere = rf.total_oere then\n        v_linjer := rf.linjer;\n      elsif rf.beskyttelse_oere > 0 and rf.bidhamr_daekker_oere = rf.total_oere - rf.beskyttelse_oere then\n        select coalesce(jsonb_agg(l), ''[]''::jsonb) into v_linjer\n          from jsonb_array_elements(rf.linjer) l\n         where l->>''kode'' <> ''beskyttelse'';\n      else\n        v_linjer := rf.linjer;\n        v_status := ''kraever_handling'';\n        v_manuel := true;\n        v_fejl := ''BidHamr dækkede refusionen med et beløb, der ikke passer med en fuld refusion eller en refusion uden BidHamr Beskyttelse - lav kreditnotaen manuelt i Dinero.'';\n      end if;\n    elsif rf.gebyr_refunderet_kl is null or rf.refusion_gebyr_oere is null then', 1)));

  raise notice 'dac7_salg: %', pg_temp.ps_ret('public.dac7_salg(integer,uuid)',
    'c3c37f9a49953460381c377274cbd4f8', 'cd6313fbe3e51ee638d7051ef0e6f043', jsonb_build_array(
      jsonb_build_array(
        E'where b.status = ''betalt''',
        E'where (b.status = ''betalt'' or (b.status = ''refunderet'' and b.bidhamr_daekker_refund_id is not null))', 1)));
end $do$;

-- ===========================================================================
-- 10. Gebyrformlerne (ROADMAP-BESLUTNINGER afsnit 3 og 4)
-- ===========================================================================
-- Købergebyr og sælgergebyr 5 % af buddet (round), BidHamr Beskyttelse 5 %,
-- min 25 kr., maks 250 kr. - eller 0 (ikke valgt, afhentning, erhverv).
-- Gælder kun den nye model (historiske separat-rækker er undtaget). NOT VALID
-- + VALIDATE: afviger eksisterende rækker, bliver constrainten stående NOT
-- VALID (nye og ændrede rækker skal stadig passe), og antallet skrives.
do $do$
declare
  c record;
  n integer;
begin
  for c in
    select * from (values
      ('betalinger_koebergebyr_formel',
       'check (pengemodel = ''separat'' or koebergebyr_oere = round(bud_oere * 5 / 100.0))',
       'not (pengemodel = ''separat'' or koebergebyr_oere = round(bud_oere * 5 / 100.0))'),
      ('betalinger_saelgergebyr_formel',
       'check (pengemodel = ''separat'' or saelgergebyr_oere = round(bud_oere * 5 / 100.0))',
       'not (pengemodel = ''separat'' or saelgergebyr_oere = round(bud_oere * 5 / 100.0))'),
      ('betalinger_beskyttelse_formel',
       'check (pengemodel = ''separat'' or beskyttelse_oere = 0 or beskyttelse_oere = least(greatest(round(bud_oere * 5 / 100.0), 2500), 25000))',
       'not (pengemodel = ''separat'' or beskyttelse_oere = 0 or beskyttelse_oere = least(greatest(round(bud_oere * 5 / 100.0), 2500), 25000))')
    ) as v(navn, def, afvig)
  loop
    if not exists (select 1 from pg_constraint where conname = c.navn and conrelid = 'public.betalinger'::regclass) then
      execute format('alter table public.betalinger add constraint %I %s not valid', c.navn, c.def);
    end if;
    if exists (select 1 from pg_constraint where conname = c.navn and conrelid = 'public.betalinger'::regclass
                and not convalidated) then
      execute format('select count(*) from public.betalinger where %s', c.afvig) into n;
      if n = 0 then
        execute format('alter table public.betalinger validate constraint %I', c.navn);
      else
        raise notice '%: % eksisterende række(r) afviger - constrainten står NOT VALID (nye og ændrede rækker skal passe)', c.navn, n;
      end if;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 11. Beløbsloft: startpris, bud og maksimum højst 500.000 kr.
-- ===========================================================================
create or replace function public.beloebsloft_auktion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.startpris > 500000 then
    raise exception 'beloeb_for_hoejt: Startprisen kan højst være 500.000 kr.' using errcode = 'BHB05';
  end if;
  return new;
end;
$fn$;
revoke all on function public.beloebsloft_auktion() from public, anon, authenticated;
drop trigger if exists beloebsloft_auktion on public.auctions;
create trigger beloebsloft_auktion before insert or update of startpris on public.auctions
  for each row execute function public.beloebsloft_auktion();

create or replace function public.beloebsloft_bud()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new."beløb" > 500000 then
    raise exception 'beloeb_for_hoejt: Det højeste tilladte bud er 500.000 kr.' using errcode = 'BHB05';
  end if;
  return new;
end;
$fn$;
revoke all on function public.beloebsloft_bud() from public, anon, authenticated;
drop trigger if exists beloebsloft_bud on public.bids;
create trigger beloebsloft_bud before insert on public.bids
  for each row execute function public.beloebsloft_bud();

create or replace function public.beloebsloft_maksimum()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.maks_beloeb > 500000 then
    raise exception 'beloeb_for_hoejt: Dit maksimum kan højst være 500.000 kr.' using errcode = 'BHB05';
  end if;
  return new;
end;
$fn$;
revoke all on function public.beloebsloft_maksimum() from public, anon, authenticated;
drop trigger if exists beloebsloft_maksimum on public.bud_maksimum;
create trigger beloebsloft_maksimum before insert or update of maks_beloeb on public.bud_maksimum
  for each row execute function public.beloebsloft_maksimum();

do $do$
declare
  n integer;
begin
  select count(*) into n from public.bud_maksimum where maks_beloeb > 500000;
  if n > 0 then
    raise notice 'Beløbsloft: % maksimum over 500.000 kr. findes - de kan ikke afgive automatiske bud over loftet', n;
  end if;
end $do$;

-- ===========================================================================
-- 14. Sælgerens udbetalingsstatus (hjemmesiden og appen)
-- ===========================================================================
-- Som 20261011030000, men de nye grunde fra betaling_udbetaling_blokeret
-- vises rigtigt. Statuskoderne er de samme som før (appen kender dem); nyt
-- felt 'aarsag' (null | 'fortrydelsesfrist' | 'kontrol') til en mere præcis
-- tekst:
--   sag, ikke_afhentet, returneret                 -> stoppet
--   udbetaling_frosset, kraever_godkendelse,
--   udbetalinger_stoppet                           -> stoppet, aarsag 'kontrol'
--                                                     (grunden afsløres ikke)
--   fortrydelsesfrist                              -> venter, aarsag
--                                                     'fortrydelsesfrist'
-- tidligst_kl tager erhvervets fortrydelsesfrist (14 dage efter levering/
-- modtagelse) med; er pakken ikke leveret endnu, er tidligst_kl null.
create or replace function public.handel_udbetalingsstatus(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  b       record;
  u       record;
  t       record;
  v_grund text;
  v_tid   timestamptz;
  v_erhv  boolean;
  v_lev   timestamptz;
begin
  if v_uid is null or p_trade is null then return null; end if;
  select * into b from public.betalinger
   where trade_id = p_trade and seller_id = v_uid
   order by oprettet desc, id
   limit 1;
  if not found or b.pengemodel <> 'destination' or b.status <> 'betalt' or b.frigivet_kl is null then
    return null;
  end if;
  if b.saelger_udbetaling_id is not null then
    select * into u from public.saelger_udbetalinger where id = b.saelger_udbetaling_id;
    if u.status = 'paid' then
      return jsonb_build_object('status', 'udbetalt', 'tidligst_kl', null,
                                'sendt_kl', u.betalt_kl, 'beloeb_oere', b.udbetaling_oere, 'aarsag', null);
    end if;
    return jsonb_build_object('status', 'paa_vej', 'tidligst_kl', null,
                              'sendt_kl', coalesce(u.oprettet_hos_stripe_kl, b.overfoert_kl),
                              'beloeb_oere', b.udbetaling_oere, 'aarsag', null);
  end if;
  v_grund := public.betaling_udbetaling_blokeret(b.id);
  if v_grund = 'venter_paa_bank' then
    return jsonb_build_object('status', 'venter_paa_bank', 'tidligst_kl', null,
                              'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere, 'aarsag', null);
  end if;
  if v_grund in ('udbetalinger_inaktive', 'plan_ikke_manuel', 'transfer_ukendt') then
    return jsonb_build_object('status', 'kraever_handling', 'tidligst_kl', null,
                              'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere, 'aarsag', null);
  end if;
  if v_grund in ('udbetaling_frosset', 'kraever_godkendelse', 'udbetalinger_stoppet') then
    return jsonb_build_object('status', 'stoppet', 'tidligst_kl', null,
                              'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere, 'aarsag', 'kontrol');
  end if;
  if v_grund is not null and v_grund not in ('midler_ikke_tilgaengelige', 'ventetid', 'fortrydelsesfrist') then
    -- refusion, indsigelse, svindelvarsel, radar_review, handel_annulleret,
    -- sag_aaben, sag, ikke_afhentet, returneret, kraever_opmaerksomhed,
    -- konto_frakoblet, konto_skiftet og ukendte grunde.
    return jsonb_build_object('status', 'stoppet', 'tidligst_kl', null,
                              'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere, 'aarsag', null);
  end if;
  v_tid := greatest(b.midler_tilgaengelige_kl, b.udbetal_tidligst);
  -- Erhverv: tidligst 14 dage efter levering/modtagelse (som
  -- betaling_udbetaling_blokeret). Ukendt levering: intet tidspunkt.
  select * into t from public.trades where id = b.trade_id;
  select coalesce(a.erhverv, false) into v_erhv from public.auctions a where a.id = t.auction_id;
  v_erhv := coalesce(v_erhv, false)
            or exists (select 1 from public.users us where us.id = b.seller_id and us.konto_type = 'erhverv');
  if v_erhv then
    select max(fo.leveret_kl) into v_lev
      from public.forsendelser fo
     where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.status not in ('annulleret', 'fejlet');
    v_lev := coalesce(v_lev, t.received_at, case when coalesce(t.afhentning, false) then b.frigivet_kl end);
    if v_lev is null then
      return jsonb_build_object('status', 'venter', 'tidligst_kl', null,
                                'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere, 'aarsag', 'fortrydelsesfrist');
    end if;
    v_tid := greatest(v_tid, v_lev + interval '14 days');
  end if;
  return jsonb_build_object('status', 'venter',
                            'tidligst_kl', case when v_tid > now() then v_tid end,
                            'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere,
                            'aarsag', case when v_grund = 'fortrydelsesfrist'
                                             or (v_erhv and v_tid > now() and v_tid = v_lev + interval '14 days')
                                           then 'fortrydelsesfrist' end);
end;
$fn$;

revoke all on function public.handel_udbetalingsstatus(uuid) from public, anon, authenticated;
grant execute on function public.handel_udbetalingsstatus(uuid) to authenticated, service_role;

-- Kroppen skal være præcis denne migrations version (samme "ny" som i
-- drift-tjekket øverst - ellers fejler en anden kørsel).
do $do$
declare
  h text := pg_temp.krop_md5('public.handel_udbetalingsstatus(uuid)');
begin
  if h is distinct from 'f8a957f59515b6bc97c61cbdb13b6544' then
    raise exception 'handel_udbetalingsstatus: efter create or replace er md5 % (forventet f8a957f59515b6bc97c61cbdb13b6544)', h;
  end if;
end $do$;

-- ===========================================================================
-- 12. Grants
-- ===========================================================================
do $do$
begin
  if to_regclass('public.transactions') is not null then
    revoke insert, update, delete, truncate on table public.transactions from authenticated;
  end if;
  revoke insert, update on table public.auctions from anon;
end $do$;

drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.flet_check(regclass, text, text, text[]);
drop function pg_temp.krop_md5(text);
