-- Rettelser til 20261005020000_startpris_anke.sql (reviewer, 5. oktober 2026):
--
--   1. sag_genaabn kunne omgaa de 7 dages ventetid ved retur: en admin kunne
--      genaabne en sag i 'afventer_retur' og straks afgoere den til saelger
--      eller lukke den. Nu afvises genaabning af en sag i 'afventer_retur'
--      uden registreret retur (retur_afleveret_kl null) med kode
--      'retur_ventetid' (+ 'retur_frist_kl'), indtil
--        greatest(penge_flyttes_efter_kl, sag_anker.behandlet_kl) + 7 dage
--      - samme beregning som sag_afgoer i 20261005020000.
--      Admin-UI: src/app/actions/adminSager.ts (kan.genaabne, genaabnSag).
--
--   2. rediger_auktion: 'startpris_for_lav' kun naar startprisen AENDRES, saa
--      en gammel auktion med startpris 0 kan faa rettet titel/billeder (samme
--      regel som auctions_beskyt_kolonner).
--
--   3. Bud skal vaere mindst 1 kr - ogsaa paa gamle auktioner med startpris 0:
--        - naeste_bud_minimum: greatest(1, ...) i begge grene
--        - check_minimum_bid (foer laasen) og handle_new_bid (efter laasen):
--          eksplicit "Dit bud skal være mindst 1 kr." med praefikset
--          minimum_bid:, saa afgivBud (src/app/actions/bud.ts) viser teksten.
--      TS: mindsteNaesteBud i src/lib/auktionRegler.ts.
--
-- Genskrevet (praecise kopier af seneste definition + aendringerne ovenfor):
--   sag_genaabn         (seneste: 20261004050000)
--   rediger_auktion     (seneste: 20261005020000)
--   naeste_bud_minimum  (seneste: 20261004060000)
--   check_minimum_bid   (seneste: 20261004061000)
--   handle_new_bid      (seneste: 20261004060000)
-- moderation_log_handling_check, betalingsfrist og oprydning roeres ikke.
-- Koeres EFTER 20261005020000_startpris_anke.sql.
-- Idempotent: create or replace. Aendrer ingen eksisterende data.

-- ============================================================ 1. sag_genaabn: ventetid ved retur

-- Som 20261004050000 + kode 'retur_ventetid'. Signatur uaendret.
create or replace function public.sag_genaabn(
  p_medarbejder uuid,
  p_sag         uuid,
  p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_trade uuid;
  s       record;
  t       record;
  b       record;
  -- NYT: 7 dages ventetid ved retur (som sag_afgoer).
  v_anke_behandlet timestamptz;
  v_retur_frist    timestamptz;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if exists (select 1 from public.sag_anker a where a.sag_id = s.id) then
    return jsonb_build_object('kode', 'anket');
  end if;

  if s.status not in ('afventer_retur', 'afgjort_koeber', 'afgjort_saelger', 'lukket') then
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  -- NYT: venter sagen paa en retur, der ikke er registreret, kan den
  -- foerst genaabnes, naar koeberens 7 dages frist til at sende varen er
  -- udloebet - ellers kunne en genaabning + ny afgoerelse omgaa ventetiden
  -- i sag_afgoer. Samme beregning som sag_afgoer (20261005020000).
  -- (En anket sag er allerede afvist ovenfor; behandlet_kl er med for at
  -- holde beregningen ens.)
  if s.status = 'afventer_retur' and s.retur_afleveret_kl is null then
    select behandlet_kl into v_anke_behandlet from public.sag_anker where sag_id = s.id;
    v_retur_frist := greatest(coalesce(s.penge_flyttes_efter_kl, s.afgjort_kl + interval '4 days'),
                              coalesce(v_anke_behandlet, '-infinity'::timestamptz))
                     + interval '7 days';
    if v_retur_frist is null or now() < v_retur_frist then
      return jsonb_build_object('kode', 'retur_ventetid', 'retur_frist_kl', v_retur_frist);
    end if;
  end if;
  if t.status = 'annulleret'
     or b.id is null
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null then
    return jsonb_build_object('kode', 'penge_flyttet');
  end if;

  begin
    update public.sager
       set status = 'aaben', afgjort_af = null, afgjort_kl = null, begrundelse = null,
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = null, penge_flyttes_efter_kl = null,
           afviklet_kl = null, penge_fejl = null,
           genaabnet_antal = genaabnet_antal + 1, genaabnet_kl = now()
     where id = s.id;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  update public.trades
     set sag_aaben = true,
         sag_note = coalesce(sag_note, 'Sag fra køberen (genåbnet)'),
         sag_aabnet_at = now()
   where id = t.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_genaabnet', 'sag', s.id, t.buyer_id,
          left('Sag genåbnet (tidligere status: ' || s.status || ')'
               || case when s.penge_handling in ('refunder', 'frigiv') and s.afviklet_kl is null
                       then ' - den planlagte ' || case s.penge_handling when 'refunder'
                            then 'refusion' else 'udbetaling' end || ' er annulleret'
                       else '' end
               || ' | ' || v_grund, 4000));

  return jsonb_build_object(
    'kode', 'ok',
    'annulleret_planlagt', s.penge_handling in ('refunder', 'frigiv') and s.afviklet_kl is null,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal + 1);
end;
$fn$;

revoke all on function public.sag_genaabn(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sag_genaabn(uuid, uuid, text) to service_role;

-- ============================================================ 2. rediger_auktion: startpris kun ved aendring

-- Som 20261005020000, men 'startpris_for_lav' kun naar startprisen aendres.
-- Signatur uaendret.
create or replace function public.rediger_auktion(
  p_auktion           uuid,
  p_titel             text,
  p_beskrivelse       text,
  p_billeder          text[],
  p_kategori          text,
  p_startpris         numeric,
  p_forsendelse_mulig boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  a       record;
  u       record;
  v_titel   text := btrim(coalesce(p_titel, ''));
  v_beskr   text := nullif(btrim(coalesce(p_beskrivelse, '')), '');
  v_kat     text := btrim(coalesce(p_kategori, ''));
  v_ver     timestamptz := date_trunc('milliseconds', clock_timestamp());
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  -- Laaser raekken: et samtidigt bud (handle_new_bid, "for update") venter,
  -- til redigeringen er faerdig, eller er naaet foerst og ses herunder.
  select * into a from public.auctions where id = p_auktion for update;
  if not found or a.bruger_id is distinct from v_uid or a.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = v_uid;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if a.status <> 'aktiv' then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'slut');
  end if;
  if a."nuværende_bud" is not null
     or exists (select 1 from public.bids b where b.auktion_id = a.id) then
    return jsonb_build_object('kode', 'har_bud');
  end if;

  if char_length(v_titel) < 1 or char_length(v_titel) > 120 then
    return jsonb_build_object('kode', 'ugyldig_titel');
  end if;
  if v_beskr is not null and char_length(v_beskr) > 500 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if not public.er_gyldig_auktionskategori(v_kat) then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  -- Mindste startpris 1 kr - NYT: kun naar startprisen AENDRES, saa en
  -- gammel auktion med startpris 0 stadig kan faa rettet titel/billeder
  -- (samme regel som auctions_beskyt_kolonner).
  if p_startpris is distinct from a.startpris and p_startpris < 1 then
    return jsonb_build_object('kode', 'startpris_for_lav');
  end if;

  if not public.auktion_billeder_gyldige(v_uid, p_billeder) then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;

  update public.auctions
     set titel             = v_titel,
         beskrivelse       = v_beskr,
         billeder          = p_billeder,
         kategori          = v_kat,
         startpris         = p_startpris,
         forsendelse_mulig = coalesce(p_forsendelse_mulig, false),
         redigeret_kl      = v_ver
   where id = a.id;

  return jsonb_build_object('kode', 'ok', 'redigeret_kl', v_ver);
end;
$fn$;

revoke execute on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean)
  from public, anon;
grant execute on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean)
  to authenticated;

-- ============================================================ 3. Bud mindst 1 kr

-- Som 20261004060000, men altid mindst 1 kr (ogsaa med et eksisterende bud).
create or replace function public.naeste_bud_minimum(p_nuvaerende numeric, p_startpris numeric)
returns numeric
language sql
immutable
set search_path = public
as $fn$
  select greatest(1::numeric, case
    when p_nuvaerende is null then greatest(ceil(coalesce(p_startpris, 0)), 1)
    else p_nuvaerende + public.budstigning(p_nuvaerende)
  end);
$fn$;

grant execute on function public.naeste_bud_minimum(numeric, numeric) to anon, authenticated, service_role;

-- Som 20261004061000 + bud mindst 1 kr.
create or replace function public.check_minimum_bid()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  minimum numeric;
begin
  if new."beløb" is null or new."beløb" <> trunc(new."beløb") then
    raise exception 'Buddet skal være i hele kroner.' using errcode = '22023';
  end if;

  -- NYT: mindst 1 kr - ogsaa paa gamle auktioner med startpris 0.
  if new."beløb" < 1 then
    raise exception 'minimum_bid: Dit bud skal være mindst 1 kr.';
  end if;

  select public.naeste_bud_minimum(a."nuværende_bud", a.startpris) into minimum
    from public.auctions a where a.id = new.auktion_id;

  if minimum is not null and new."beløb" < minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(minimum);
  end if;
  return new;
end;
$function$;

revoke execute on function public.check_minimum_bid() from public, anon, authenticated;

-- Som 20261004060000 + bud mindst 1 kr (efter laasen).
create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_auktion record;
  v_bruger record;
  v_minimum numeric;
begin
  select suspenderet, suspenderet_til into v_bruger
    from public.users where id = new.bruger_id;

  if v_bruger is null then
    raise exception 'Brugeren findes ikke';
  end if;

  if v_bruger.suspenderet
     and (v_bruger.suspenderet_til is null or v_bruger.suspenderet_til > now()) then
    raise exception 'Din konto er suspenderet, og du kan ikke byde.'
      using errcode = '42501';
  end if;

  select * into v_auktion from public.auctions where id = new.auktion_id for update;

  if v_auktion is null then
    raise exception 'Auktionen findes ikke';
  end if;

  if v_auktion.skjult then
    raise exception 'Auktionen er ikke tilgængelig';
  end if;

  if v_auktion.status <> 'aktiv' then
    raise exception 'Auktionen er ikke aktiv længere';
  end if;

  if v_auktion.slutter_kl <= now() then
    raise exception 'Auktionen er allerede slut';
  end if;

  if new.auktion_redigeret_kl is not null
     and date_trunc('milliseconds', new.auktion_redigeret_kl)
         is distinct from v_auktion.redigeret_kl then
    raise exception 'Sælgeren har lige ændret auktionen. Se den igen, før du byder.';
  end if;

  -- NYT: mindst 1 kr - ogsaa paa gamle auktioner med startpris 0.
  if new."beløb" is null or new."beløb" < 1 then
    raise exception 'minimum_bid: Dit bud skal være mindst 1 kr.';
  end if;

  v_minimum := public.naeste_bud_minimum(v_auktion."nuværende_bud", v_auktion.startpris);
  if new."beløb" < v_minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(v_minimum);
  end if;

  update public.auctions
  set
    "nuværende_bud" = new."beløb",
    slutter_kl = case
      when slutter_kl - now() < interval '2 minutes'
        then now() + interval '2 minutes'
      else slutter_kl
    end
  where id = new.auktion_id;

  return new;
end;
$function$;

revoke execute on function public.handle_new_bid() from public, anon, authenticated;
