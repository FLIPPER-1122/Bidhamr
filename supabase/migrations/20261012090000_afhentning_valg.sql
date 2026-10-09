-- Afhentning som valg i checkout (ROADMAP-BESLUTNINGER afsnit 1 "Ingen
-- automatisk betaling": køberen vælger "pakkeshop via liste/kort, levering
-- hjem eller afhentning, hvis sælger tilbyder det") + BHT04/BHT05.
-- Køres EFTER 20261012010000_fragt_dao_shipmondo.sql. Idempotent.
--
-- Ændringer:
--   1. auctions.afhentning_mulig: sælgeren tilbyder OGSÅ afhentning ved siden
--      af forsendelse. Uden forsendelse er auktionen altid kun afhentning
--      (som før), og flaget tvinges til false (trigger). Låses efter første
--      bud af auctions_beskyt_kolonner (alle kolonner). Genopsætning kopierer
--      flaget.
--   2. handel_levering: maade 'afhentning' (fragt 0, ingen fragtfirma,
--      modtager eller pakkeshop) + beskyttelse_ved_forsendelse_oere.
--   3. trades_saet_afhentning (fuld genoprettelse): flaget må også gå
--      false -> true - KUN før betaling, på en auktion med både forsendelse
--      og afhentning, når betalingen er sat til fragt 0 og leveringsvalget er
--      'afhentning' (det gør kun handel_gem_levering). Så bruges
--      afhentningsflowet (kode, 7 dages frist, ingen sag) som ved kun
--      afhentning. true -> false som før (fragt > 0 eller sporingsnummer).
--   4. handel_gem_levering (fuld genoprettelse): maade 'afhentning'. Fragten
--      bliver 0 i betalingen og i BidHamrs gebyr (application fee følger via
--      betalinger_trin2_vedligehold). Samme PaymentIntent-regler som ved
--      prisskift: findes der en PaymentIntent, annulleres den hos Stripe
--      først (pi_skal_annulleres), og pi_forsoeg + 1. Kun før betaling.
--      Chefens valg: BidHamr Beskyttelse kan ikke bruges ved afhentning
--      (ingen sag), så den fjernes fra betalingen ved afhentning og lægges
--      på igen, hvis køberen skifter tilbage til forsendelse før betaling.
--   5. handel_checkout (fuld genoprettelse): afhentning_mulig, kun_afhentning
--      og beskyttelse_ved_forsendelse_oere.
--   6. auctions_fragt (fuld genoprettelse): egne fejlkoder BHT04 (vægt <= 0)
--      og BHT05 (ukendt pakkestørrelse) i stedet for BHT01/BHT02.
--
-- Handelsdata slettes aldrig (handel_levering opdateres, slettes ikke).

-- ============================================================ 0. drift-tjek

-- Funktionerne genoprettes fuldt. Kroppen skal være repoets version
-- (20261012010000 / 20261003031000) eller denne migrations (genkørsel).
-- Samme normalisering som de øvrige drift-tjek (CR, kommentarer og al
-- whitespace fjernes, små bogstaver).
do $$
declare
  r record;
  h text;
begin
  for r in
    select * from (values
      ('public.trades_saet_afhentning()', 'b3bcebdc046461d5bae5d04893772876', '0c18a50f76e57f08fa160b18bfc17c24'),
      ('public.handel_gem_levering(uuid,uuid,jsonb,text)', '739056bcc241626de624015a6aaaa649', '9a4e2018067b68ce1e376e574893ce12'),
      ('public.handel_checkout(uuid)', '08126a374af8041b1b5bc433bbcada65', 'e2766090ed57381b98c34f3a08c0982a'),
      ('public.auctions_fragt()', 'ece5fe9a9b232eab60be35d259e5ece5', 'dde64c0079acbf871fa22b594c2ff6f7')
    ) as x(fn, basis, ny)
  loop
    if to_regprocedure(r.fn) is null then
      raise exception 'afhentning_valg: % findes ikke - kør 20261012010000_fragt_dao_shipmondo.sql først', r.fn;
    end if;
    select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
      into h
      from pg_proc p where p.oid = to_regprocedure(r.fn);
    if h is distinct from r.basis and h is distinct from r.ny then
      raise exception '%: kroppen afviger fra repoets version (md5 %) - kontrollér funktionen, før migrationen køres', r.fn, h;
    end if;
  end loop;
end $$;

-- ============================================================ 1. auctions.afhentning_mulig

alter table public.auctions
  add column if not exists afhentning_mulig boolean not null default false;

comment on column public.auctions.afhentning_mulig is
  'true: sælgeren tilbyder OGSÅ afhentning ved siden af forsendelse - køberen vælger i checkout. '
  'Kun meningsfuld med forsendelse_mulig = true (ellers altid false; auktionen er så kun afhentning).';

grant select (afhentning_mulig) on public.auctions to anon, authenticated;
grant insert (afhentning_mulig), update (afhentning_mulig) on public.auctions to authenticated;

create or replace function public.auctions_afhentning_mulig()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.afhentning_mulig := coalesce(new.afhentning_mulig, false) and coalesce(new.forsendelse_mulig, false);
  return new;
end;
$fn$;
revoke all on function public.auctions_afhentning_mulig() from public, anon, authenticated;

drop trigger if exists auctions_afhentning_mulig on public.auctions;
create trigger auctions_afhentning_mulig
  before insert or update of forsendelse_mulig, afhentning_mulig on public.auctions
  for each row execute function public.auctions_afhentning_mulig();

-- Genopsætning: den nye auktion tilbyder også afhentning, hvis den gamle gjorde.
create or replace function public.genopsaetninger_kopier_afhentning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.auctions ny
     set afhentning_mulig = g.afhentning_mulig
    from public.auctions g
   where g.id = new.gammel_auction_id
     and ny.id = new.ny_auction_id
     and ny.forsendelse_mulig
     and ny.afhentning_mulig is distinct from g.afhentning_mulig;
  return new;
end;
$fn$;
revoke all on function public.genopsaetninger_kopier_afhentning() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.genopsaetninger') is not null then
    execute 'drop trigger if exists genopsaetninger_kopier_afhentning on public.genopsaetninger';
    execute 'create trigger genopsaetninger_kopier_afhentning after insert on public.genopsaetninger
             for each row execute function public.genopsaetninger_kopier_afhentning()';
  end if;
end $$;

-- ============================================================ 2. handel_levering: afhentning

alter table public.handel_levering
  -- Købers BidHamr Beskyttelse (øre), mens afhentning er valgt: lægges på
  -- betalingen igen, hvis køberen skifter til forsendelse før betaling.
  add column if not exists beskyttelse_ved_forsendelse_oere integer;

alter table public.handel_levering
  alter column fragtfirma drop not null,
  alter column modtager_navn drop not null,
  alter column modtager_telefon drop not null;

alter table public.handel_levering drop constraint if exists handel_levering_maade_check;
alter table public.handel_levering add constraint handel_levering_maade_check check (
  maade in ('pakkeshop', 'doer', 'afhentning'));

alter table public.handel_levering drop constraint if exists handel_levering_afhentning_check;
alter table public.handel_levering add constraint handel_levering_afhentning_check check (
  case when maade = 'afhentning'
       then fragt_oere = 0 and fragtfirma is null and pakkeshop_id is null
       else fragtfirma is not null and modtager_navn is not null and modtager_telefon is not null
            and beskyttelse_ved_forsendelse_oere is null
  end);

alter table public.handel_levering drop constraint if exists handel_levering_beskyttelse_check;
alter table public.handel_levering add constraint handel_levering_beskyttelse_check check (
  beskyttelse_ved_forsendelse_oere is null or beskyttelse_ved_forsendelse_oere between 0 and 100000000);

comment on table public.handel_levering is
  'Købers leveringsvalg på en handel (checkout før betaling): pakkeshop, døren eller afhentning '
  '(kun når auktionen tilbyder både forsendelse og afhentning). Handelsdata - slettes aldrig.';

-- ============================================================ 3. trades_saet_afhentning

create or replace function public.trades_saet_afhentning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    -- Altid fra auktionen - aldrig fra kalderen. En auktion med både
    -- forsendelse og afhentning starter som forsendelse (køberen vælger).
    select not coalesce(a.forsendelse_mulig, false) into new.afhentning
      from public.auctions a where a.id = new.auction_id;
    new.afhentning := coalesce(new.afhentning, false);
  elsif old.afhentning
        and not coalesce(new.afhentning, true)
        and (new.tracking_number is not null
             or exists (select 1 from public.betalinger b
                         where b.trade_id = new.id and b.fragt_oere > 0)) then
    -- true -> false, når handlen beviseligt sendes (fragt i betalingen
    -- eller sporingsnummer).
    new.afhentning := false;
  elsif not old.afhentning
        and coalesce(new.afhentning, false)
        and old.status = 'afventer_betaling'
        and new.status = 'afventer_betaling'
        and old.tracking_number is null
        and new.tracking_number is null
        and exists (select 1 from public.auctions a
                     where a.id = new.auction_id
                       and a.forsendelse_mulig and a.afhentning_mulig)
        and exists (select 1 from public.betalinger b
                     where b.trade_id = new.id and b.fragt_oere = 0
                       and b.status = 'afventer' and b.stripe_charge_id is null)
        and exists (select 1 from public.handel_levering hl
                     where hl.trade_id = new.id and hl.maade = 'afhentning')
        and not exists (select 1 from public.forsendelser f
                         where f.trade_id = new.id and f.type = 'udgaaende'
                           and f.status not in ('annulleret', 'fejlet')) then
    -- false -> true: køberen har valgt afhentning i checkout før betaling
    -- (handel_gem_levering har sat fragten til 0 og gemt valget).
    new.afhentning := true;
  else
    -- Ellers kan flaget ikke ændres.
    new.afhentning := old.afhentning;
  end if;
  return new;
end;
$fn$;
revoke all on function public.trades_saet_afhentning() from public, anon, authenticated;

-- ============================================================ 4. handel_gem_levering

-- Gemmer købers leveringsvalg og retter betalingens fragt, BidHamr
-- Beskyttelse og total (gebyret følger med via betalinger_trin2_vedligehold).
-- KUN service_role: serveren har verificeret køberen med auth (p_bruger),
-- slået pakkeshoppen op hos fragtfirmaet, og - hvis der findes en
-- PaymentIntent, og beløbet ændres - annulleret den hos Stripe først
-- (p_annulleret_pi).
--
-- Regler:
--   - Kun køberen, ikke når en fragtlabel er lavet.
--   - Kun afhentning (auktionen tilbyder ikke forsendelse): 'afhentning'.
--   - 'afhentning' kun når auktionen tilbyder både forsendelse og afhentning,
--     og kun før betaling. Fragt 0 og ingen BidHamr Beskyttelse (den gemmes i
--     handel_levering og lægges på igen ved skift til forsendelse).
--   - Betalingen afventer uden charge: valget må ændre beløbet. Findes der en
--     PaymentIntent, og beløbet (eller afhentning/forsendelse) ændres, kræves
--     p_annulleret_pi = den gemte PaymentIntent; den fjernes (pi_forsoeg + 1,
--     tidligere_payment_intents), så serveren laver en ny med det nye beløb.
--     Ellers svar 'pi_skal_annulleres'.
--   - Betalt: kun valg med samme fragt og samme leveringsform (fx en anden
--     pakkeshop), før label.
--   - Levering til døren kun hvis auktionen har en dør-pris (ikke Stor).
--
-- p_valg: {maade: 'pakkeshop' | 'doer' | 'afhentning', fragtfirma,
--          pakkeshop: {id, navn, adresse, postnummer, by, lat, lng} | null,
--          modtager: {navn, adresse, postnummer, by, telefon, email},
--          gem_forslag: bool}   (afhentning: kun maade)
-- Svar: {kode: 'ok', fragt_oere, total_oere, beskyttelse_oere, afhentning,
--        pris_aendret, pi_nulstillet} |
--       {kode: 'pi_skal_annulleres', pi} |
--       {kode: 'ikke_fundet' | 'afhentning' | 'forkert_status' | 'laast' |
--              'ikke_mulig' | 'pris_laast' | 'ugyldig'}
create or replace function public.handel_gem_levering(
  p_trade          uuid,
  p_bruger         uuid,
  p_valg           jsonb,
  p_annulleret_pi  text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  t         record;
  b         record;
  a         record;
  v_maade   text := p_valg->>'maade';
  v_firma   text := p_valg->>'fragtfirma';
  v_shop    jsonb := p_valg->'pakkeshop';
  v_mod     jsonb := p_valg->'modtager';
  v_afh     boolean := (p_valg->>'maade') = 'afhentning';
  v_valgbar boolean;
  v_gemt    integer;
  v_pris    integer;
  v_besk    bigint;
  v_aendret boolean := false;
  v_pi_nul  boolean := false;
  v_flag    boolean;
begin
  if p_trade is null or p_bruger is null or p_valg is null
     or jsonb_typeof(p_valg) <> 'object'
     or coalesce(v_maade, '') not in ('pakkeshop', 'doer', 'afhentning')
     or (not v_afh and (coalesce(v_firma, '') not in ('test', 'gls', 'shipmondo')
                        or v_mod is null or jsonb_typeof(v_mod) <> 'object'))
     or (v_maade = 'pakkeshop' and (v_shop is null or jsonb_typeof(v_shop) <> 'object')) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  select id, buyer_id, seller_id, status, afhentning, auction_id into t
    from public.trades where id = p_trade for update;
  if t.id is null or t.buyer_id <> p_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select forsendelse_mulig, afhentning_mulig, fragt_pakkeshop_oere, fragt_doer_oere into a
    from public.auctions where id = t.auction_id;
  v_valgbar := coalesce(a.forsendelse_mulig, false) and coalesce(a.afhentning_mulig, false);

  select * into b from public.betalinger where trade_id = p_trade for update;
  if b.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Kun afhentning: intet valg.
  if not v_valgbar and (coalesce(t.afhentning, false) or coalesce(b.fragt_oere, 0) <= 0) then
    return jsonb_build_object('kode', 'afhentning');
  end if;
  if v_afh and not v_valgbar then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  if exists (select 1 from public.forsendelser f
              where f.trade_id = p_trade and f.type = 'udgaaende'
                and f.status not in ('annulleret', 'fejlet')) then
    return jsonb_build_object('kode', 'laast');
  end if;

  v_pris := case v_maade when 'pakkeshop' then a.fragt_pakkeshop_oere
                         when 'doer' then a.fragt_doer_oere
                         else 0 end;
  if v_pris is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;

  -- BidHamr Beskyttelse: 0 ved afhentning (gemmes); ved forsendelse den
  -- nuværende - eller den gemte, hvis afhentning var valgt.
  select hl.beskyttelse_ved_forsendelse_oere into v_gemt
    from public.handel_levering hl where hl.trade_id = p_trade and hl.maade = 'afhentning';
  if coalesce(t.afhentning, false) then
    v_gemt := coalesce(v_gemt, 0);
  else
    v_gemt := b.beskyttelse_oere;
  end if;
  v_besk := case when v_afh then 0 else v_gemt end;
  v_flag := v_afh is distinct from coalesce(t.afhentning, false);

  if b.status = 'afventer' and b.stripe_charge_id is null and t.status = 'afventer_betaling' then
    if v_pris <> b.fragt_oere or v_besk <> b.beskyttelse_oere or v_flag then
      v_aendret := v_pris <> b.fragt_oere or v_besk <> b.beskyttelse_oere;
      if b.stripe_payment_intent_id is not null then
        if p_annulleret_pi is distinct from b.stripe_payment_intent_id then
          return jsonb_build_object('kode', 'pi_skal_annulleres', 'pi', b.stripe_payment_intent_id);
        end if;
        update public.betalinger
           set stripe_payment_intent_id = null,
               pi_forsoeg = pi_forsoeg + 1,
               tidligere_payment_intents = tidligere_payment_intents || b.stripe_payment_intent_id,
               fragt_oere = v_pris,
               beskyttelse = v_besk > 0,
               beskyttelse_oere = v_besk,
               total_oere = bud_oere + koebergebyr_oere + v_pris + v_besk,
               opdateret = now()
         where id = b.id and status = 'afventer' and stripe_charge_id is null
           and stripe_payment_intent_id = b.stripe_payment_intent_id;
        v_pi_nul := true;
      else
        -- pi_forsoeg + 1 også uden PaymentIntent: en PaymentIntent, der er ved
        -- at blive lavet med det gamle beløb (samme idempotency key), kan så
        -- ikke gemmes (sikrPaymentIntent gemmer kun ved samme pi_forsoeg,
        -- total og gebyr).
        update public.betalinger
           set fragt_oere = v_pris,
               beskyttelse = v_besk > 0,
               beskyttelse_oere = v_besk,
               total_oere = bud_oere + koebergebyr_oere + v_pris + v_besk,
               pi_forsoeg = pi_forsoeg + 1,
               opdateret = now()
         where id = b.id and status = 'afventer' and stripe_charge_id is null
           and stripe_payment_intent_id is null;
      end if;
      if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
    end if;
  elsif b.status = 'betalt' and t.status = 'betaling_modtaget' then
    if v_pris <> b.fragt_oere or v_flag then return jsonb_build_object('kode', 'pris_laast'); end if;
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  if v_afh then
    insert into public.handel_levering as hl (
      trade_id, maade, fragtfirma,
      pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
      pakkeshop_lat, pakkeshop_lng,
      modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email,
      fragt_oere, beskyttelse_ved_forsendelse_oere)
    values (
      p_trade, 'afhentning', null,
      null, null, null, null, null, null, null,
      null, null, null, null, null, null,
      0, v_gemt)
    on conflict (trade_id) do update set
      maade = excluded.maade, fragtfirma = null,
      pakkeshop_id = null, pakkeshop_navn = null, pakkeshop_adresse = null,
      pakkeshop_postnummer = null, pakkeshop_by = null, pakkeshop_lat = null, pakkeshop_lng = null,
      modtager_navn = null, modtager_adresse = null, modtager_postnummer = null,
      modtager_by = null, modtager_telefon = null, modtager_email = null,
      fragt_oere = 0, beskyttelse_ved_forsendelse_oere = excluded.beskyttelse_ved_forsendelse_oere,
      opdateret_kl = now();
  else
    insert into public.handel_levering as hl (
      trade_id, maade, fragtfirma,
      pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
      pakkeshop_lat, pakkeshop_lng,
      modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email,
      fragt_oere, beskyttelse_ved_forsendelse_oere)
    values (
      p_trade, v_maade, v_firma,
      case when v_maade = 'pakkeshop' then v_shop->>'id' end,
      case when v_maade = 'pakkeshop' then v_shop->>'navn' end,
      case when v_maade = 'pakkeshop' then v_shop->>'adresse' end,
      case when v_maade = 'pakkeshop' then v_shop->>'postnummer' end,
      case when v_maade = 'pakkeshop' then v_shop->>'by' end,
      case when v_maade = 'pakkeshop' then (v_shop->>'lat')::double precision end,
      case when v_maade = 'pakkeshop' then (v_shop->>'lng')::double precision end,
      btrim(v_mod->>'navn'), nullif(btrim(coalesce(v_mod->>'adresse', '')), ''),
      nullif(btrim(coalesce(v_mod->>'postnummer', '')), ''), nullif(btrim(coalesce(v_mod->>'by', '')), ''),
      v_mod->>'telefon', nullif(btrim(coalesce(v_mod->>'email', '')), ''),
      v_pris, null)
    on conflict (trade_id) do update set
      maade = excluded.maade, fragtfirma = excluded.fragtfirma,
      pakkeshop_id = excluded.pakkeshop_id, pakkeshop_navn = excluded.pakkeshop_navn,
      pakkeshop_adresse = excluded.pakkeshop_adresse, pakkeshop_postnummer = excluded.pakkeshop_postnummer,
      pakkeshop_by = excluded.pakkeshop_by, pakkeshop_lat = excluded.pakkeshop_lat,
      pakkeshop_lng = excluded.pakkeshop_lng,
      modtager_navn = excluded.modtager_navn, modtager_adresse = excluded.modtager_adresse,
      modtager_postnummer = excluded.modtager_postnummer, modtager_by = excluded.modtager_by,
      modtager_telefon = excluded.modtager_telefon, modtager_email = excluded.modtager_email,
      fragt_oere = excluded.fragt_oere, beskyttelse_ved_forsendelse_oere = null,
      opdateret_kl = now();
  end if;

  -- Afhentning <-> forsendelse: handlens flag følger valget (trades_saet_afhentning
  -- tjekker igen). Bliver flaget ikke som valgt, rulles alt tilbage.
  if v_flag then
    update public.trades set afhentning = v_afh where id = p_trade;
    if (select tr.afhentning from public.trades tr where tr.id = p_trade) is distinct from v_afh then
      raise exception 'afhentning_skift_afvist: Handlens leveringsform kunne ikke ændres.' using errcode = 'BHT11';
    end if;
  end if;

  if not v_afh and coalesce((p_valg->>'gem_forslag')::boolean, true) then
    insert into public.leveringsforslag as lf (
      user_id, maade, pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
      modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, opdateret_kl)
    select p_bruger, hl.maade, hl.pakkeshop_id, hl.pakkeshop_navn, hl.pakkeshop_adresse,
           hl.pakkeshop_postnummer, hl.pakkeshop_by, hl.modtager_navn, hl.modtager_adresse,
           hl.modtager_postnummer, hl.modtager_by, hl.modtager_telefon, now()
      from public.handel_levering hl where hl.trade_id = p_trade
    on conflict (user_id) do update set
      maade = excluded.maade,
      pakkeshop_id = coalesce(excluded.pakkeshop_id, lf.pakkeshop_id),
      pakkeshop_navn = coalesce(excluded.pakkeshop_navn, lf.pakkeshop_navn),
      pakkeshop_adresse = coalesce(excluded.pakkeshop_adresse, lf.pakkeshop_adresse),
      pakkeshop_postnummer = coalesce(excluded.pakkeshop_postnummer, lf.pakkeshop_postnummer),
      pakkeshop_by = coalesce(excluded.pakkeshop_by, lf.pakkeshop_by),
      modtager_navn = excluded.modtager_navn,
      modtager_adresse = coalesce(excluded.modtager_adresse, lf.modtager_adresse),
      modtager_postnummer = coalesce(excluded.modtager_postnummer, lf.modtager_postnummer),
      modtager_by = coalesce(excluded.modtager_by, lf.modtager_by),
      modtager_telefon = excluded.modtager_telefon,
      opdateret_kl = now();
  end if;

  select fragt_oere, total_oere, beskyttelse_oere into b from public.betalinger where trade_id = p_trade;
  return jsonb_build_object('kode', 'ok', 'fragt_oere', b.fragt_oere, 'total_oere', b.total_oere,
                            'beskyttelse_oere', b.beskyttelse_oere, 'afhentning', v_afh,
                            'pris_aendret', v_aendret, 'pi_nulstillet', v_pi_nul);
end;
$fn$;
revoke all on function public.handel_gem_levering(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.handel_gem_levering(uuid, uuid, jsonb, text) to service_role;

-- ============================================================ 5. handel_checkout

-- Checkout-data for køberen: hvad kan vælges, og hvad koster det.
-- Svar: null (ikke køber / ingen handel) eller
--   {trade_id,
--    afhentning       -- afhentning er valgt nu (eller kun afhentning),
--    kun_afhentning   -- auktionen tilbyder ikke forsendelse: intet valg,
--    afhentning_mulig -- køberen kan vælge afhentning (0 kr.) i stedet for forsendelse,
--    pakkestoerrelse, pakkeshop_oere, doer_oere,
--    beskyttelse_ved_forsendelse_oere -- BidHamr Beskyttelse, hvis der vælges forsendelse,
--    valgt: {maade, pakkeshop_id, pakkeshop_navn, fragt_oere} | null,
--    betaling: {status, fragt_oere, total_oere, kan_aendre_pris}, label_lavet}
create or replace function public.handel_checkout(p_trade uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'trade_id', t.id,
    'afhentning', coalesce(t.afhentning, false) or coalesce(b.fragt_oere, 0) = 0,
    'kun_afhentning', not (coalesce(a.forsendelse_mulig, false) and coalesce(a.afhentning_mulig, false))
                      and (coalesce(t.afhentning, false) or coalesce(b.fragt_oere, 0) = 0),
    'afhentning_mulig', coalesce(a.forsendelse_mulig, false) and coalesce(a.afhentning_mulig, false),
    'pakkestoerrelse', a.pakkestoerrelse,
    'pakkeshop_oere', a.fragt_pakkeshop_oere,
    'doer_oere', a.fragt_doer_oere,
    'beskyttelse_ved_forsendelse_oere',
      case when coalesce(t.afhentning, false)
           then coalesce((select hl.beskyttelse_ved_forsendelse_oere from public.handel_levering hl
                           where hl.trade_id = t.id and hl.maade = 'afhentning'), 0)
           else b.beskyttelse_oere end,
    'valgt', (select jsonb_build_object('maade', hl.maade, 'pakkeshop_id', hl.pakkeshop_id,
                                        'pakkeshop_navn', hl.pakkeshop_navn, 'fragt_oere', hl.fragt_oere)
                from public.handel_levering hl where hl.trade_id = t.id),
    'betaling', jsonb_build_object(
      'status', b.status,
      'fragt_oere', b.fragt_oere,
      'total_oere', b.total_oere,
      'kan_aendre_pris', b.status = 'afventer' and b.stripe_charge_id is null and t.status = 'afventer_betaling'),
    'label_lavet', exists (select 1 from public.forsendelser f
                            where f.trade_id = t.id and f.type = 'udgaaende'
                              and f.status not in ('annulleret', 'fejlet')))
    from public.trades t
    join public.auctions a on a.id = t.auction_id
    left join public.betalinger b on b.trade_id = t.id
   where t.id = p_trade
     and auth.uid() is not null
     and t.buyer_id = auth.uid();
$fn$;
revoke all on function public.handel_checkout(uuid) from public, anon;
grant execute on function public.handel_checkout(uuid) to authenticated;

-- ============================================================ 6. auctions_fragt: BHT04/BHT05

-- Som i 20261012010000, men med egne fejlkoder:
--   BHT01 'fragt_for_tung: ...'           over 15 kg med forsendelse
--   BHT02 'fragt_stoerrelse: ...'         vægten passer ikke til pakkestørrelsen
--   BHT03 'fragt_vaegt: ...'              størrelse uden vægt (kun brugerens egne ændringer)
--   BHT04 'fragt_vaegt_ugyldig: ...'      vægt 0 eller negativ
--   BHT05 'fragt_ukendt_stoerrelse: ...'  pakkestørrelsen findes ikke
create or replace function public.auctions_fragt()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_min    text;
  v_maks   integer;
  v_system boolean := coalesce(auth.role(), '') = 'service_role'
                      or current_user in ('postgres', 'supabase_admin', 'service_role');
  p        record;
begin
  if tg_op = 'UPDATE'
     and new.forsendelse_mulig is not distinct from old.forsendelse_mulig
     and new.pakkestoerrelse is not distinct from old.pakkestoerrelse
     and new.vaegt_gram is not distinct from old.vaegt_gram then
    new.fragt_pakkeshop_oere := old.fragt_pakkeshop_oere;
    new.fragt_doer_oere := old.fragt_doer_oere;
    return new;
  end if;

  if not coalesce(new.forsendelse_mulig, false) then
    new.fragt_pakkeshop_oere := null;
    new.fragt_doer_oere := null;
    return new;
  end if;

  if new.vaegt_gram is not null and new.vaegt_gram <= 0 then
    raise exception 'fragt_vaegt_ugyldig: Angiv en gyldig vægt.' using errcode = 'BHT04';
  end if;
  if new.pakkestoerrelse is not null
     and not exists (select 1 from public.fragt_pakkestoerrelser x where x.kode = new.pakkestoerrelse) then
    raise exception 'fragt_ukendt_stoerrelse: Ukendt pakkestørrelse.' using errcode = 'BHT05';
  end if;

  if new.vaegt_gram is not null then
    v_min := public.fragt_stoerrelse_for_vaegt(new.vaegt_gram);
    if v_min is null then
      raise exception 'fragt_for_tung: Varer over 15 kg kan kun afhentes. Slå forsendelse fra.'
        using errcode = 'BHT01';
    end if;
    if new.pakkestoerrelse is null then
      new.pakkestoerrelse := v_min;
    else
      select maks_gram into v_maks from public.fragt_pakkestoerrelser where kode = new.pakkestoerrelse;
      if v_maks is null or new.vaegt_gram > v_maks then
        raise exception 'fragt_stoerrelse: Vægten passer ikke til pakkestørrelsen. Vælg en større pakke.'
          using errcode = 'BHT02';
      end if;
    end if;
  elsif not v_system and new.pakkestoerrelse is not null
        and (tg_op = 'INSERT'
             or new.pakkestoerrelse is distinct from old.pakkestoerrelse
             or new.vaegt_gram is distinct from old.vaegt_gram) then
    raise exception 'fragt_vaegt: Skriv, hvor meget pakken vejer.'
      using errcode = 'BHT03';
  end if;

  -- Ældre klienter, der ikke sender størrelsen: Mellem (chefens valg).
  new.pakkestoerrelse := coalesce(new.pakkestoerrelse, 'mellem');

  select * into p from public.fragt_pakkestoerrelser where kode = new.pakkestoerrelse;
  if p.kode is null then
    raise exception 'fragt_ukendt_stoerrelse: Ukendt pakkestørrelse.' using errcode = 'BHT05';
  end if;
  new.fragt_pakkeshop_oere := p.pakkeshop_oere;
  new.fragt_doer_oere := p.doer_oere;
  return new;
end;
$fn$;
revoke all on function public.auctions_fragt() from public, anon, authenticated;
