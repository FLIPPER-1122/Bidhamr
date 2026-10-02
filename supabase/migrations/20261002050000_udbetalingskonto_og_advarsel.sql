-- Udbetalingskonto og advarsler fra admin (ROADMAP-BESLUTNINGER, 2. oktober 2026).
--
-- 1. Man skal have en udbetalingskonto (Stripe Connect) for at oprette
--    en auktion:
--    - BEFORE INSERT-trigger paa auctions (auctions_kraev_udbetalingskonto).
--    - genopsaet_auktion tjekker det samme og returnerer koden
--      'mangler_udbetalingskonto'.
-- 2. admin_advarsel_betaling: "Giv advarsel" paa /admin/betalinger. Giver en
--    advarsel til koeber eller saelger, logger og markerer betalingen som
--    loest - atomisk. Kun service_role.
--
-- Idempotent: create or replace / drop trigger if exists. Aendrer ingen data.

-- ============================================================ 1. Udbetalingskonto

-- Har brugeren en udbetalingskonto? (konto oprettet og oplysningerne sendt
-- ind hos Stripe). Stripe maa gerne stadig behandle kontoen - udbetalingen
-- venter i saa fald (afventer_saelgerkonto). Intern hjaelper.
create or replace function public.har_udbetalingskonto(p_bruger uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.betalingsprofiler
     where user_id = p_bruger
       and stripe_account_id is not null
       and connect_detaljer_indsendt
  );
$fn$;

revoke all on function public.har_udbetalingskonto(uuid) from public, anon, authenticated;
grant execute on function public.har_udbetalingskonto(uuid) to service_role;

-- Hvem tjekkes?
-- Afgoerende er, om der er en indlogget bruger bag forespoergslen (auth.uid()
-- fra JWT'en), ikke current_user:
--   * authenticated (browser, appen) -> tjekkes. Ogsaa hvis indsaettelsen sker
--     inde i en security definer-funktion, hvor current_user er postgres, saa
--     en fremtidig definer-funktion ikke utilsigtet bliver et smuthul.
--   * service_role (server-kode, cron, admin) -> undtaget. Server-kode, der
--     opretter auktioner paa en saelgers vegne, skal selv tjekke reglen
--     (genopsaet_auktion goer det nedenfor).
--   * Ingen JWT og current_user postgres/supabase_admin (seed, migrationer,
--     SQL-editor) -> undtaget.
-- Alt andet (fx anon) tjekkes og afvises.
-- Errcode BHU01 er vores egen, saa klienter kan genkende fejlen.
create or replace function public.auctions_kraev_udbetalingskonto()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null
     and current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if new.bruger_id is null or not public.har_udbetalingskonto(new.bruger_id) then
    raise exception 'Du skal oprette en udbetalingskonto, før du kan sætte varer til salg.'
      using errcode = 'BHU01';
  end if;
  return new;
end;
$fn$;

revoke all on function public.auctions_kraev_udbetalingskonto() from public, anon, authenticated;

-- Triggere koeres alfabetisk: auctions_beskyt_ny og auctions_beskyt_taellere
-- (saetter systemfelter) koerer foer denne. Ingen af dem roerer bruger_id.
drop trigger if exists auctions_kraev_udbetalingskonto on public.auctions;
create trigger auctions_kraev_udbetalingskonto
  before insert on public.auctions
  for each row execute function public.auctions_kraev_udbetalingskonto();

-- genopsaet_auktion kaldes med service_role (undtaget fra triggeren), men det
-- er saelgeren, der saetter varen til salg igen. Derfor samme regel her.
-- Uaendret fra 20261002030000 bortset fra tjekket for udbetalingskonto.
create or replace function public.genopsaet_auktion(
  p_auction uuid, p_seller uuid, p_startpris numeric, p_slutter_kl timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  a     record;
  u     record;
  ny_id uuid;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = p_seller;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if not public.har_udbetalingskonto(p_seller) then
    return jsonb_build_object('kode', 'mangler_udbetalingskonto');
  end if;

  if a.status <> 'afsluttet' then return jsonb_build_object('kode', 'ikke_afsluttet'); end if;
  if a.skjult then return jsonb_build_object('kode', 'skjult'); end if;

  if not exists (select 1 from public.ubetalte_vindere v where v.auction_id = a.id) then
    return jsonb_build_object('kode', 'ikke_ubetalt');
  end if;
  if exists (select 1 from public.trades t
              where t.auction_id = a.id and t.status <> 'annulleret') then
    return jsonb_build_object('kode', 'solgt');
  end if;
  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = a.id) then
    return jsonb_build_object('kode', 'allerede_genopsat');
  end if;

  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  if p_slutter_kl is null or p_slutter_kl <= now()
     or p_slutter_kl > now() + interval '30 days' then
    return jsonb_build_object('kode', 'ugyldig_slutdato');
  end if;

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, kategori, postnummer, lat, lng,
    maerke, stand, skjult)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, p_startpris, a.lokation,
    a.forsendelse_mulig, 'aktiv', p_slutter_kl, a.kategori, a.postnummer, a.lat, a.lng,
    a.maerke, a.stand, false)
  returning id into ny_id;

  insert into public.genopsaetninger (gammel_auction_id, ny_auction_id, seller_id)
  values (a.id, ny_id, a.bruger_id);

  update public.andenchance_tilbud
     set status = 'annulleret', besvaret_kl = now()
   where auction_id = a.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'auction_id', ny_id);
end;
$fn$;

revoke all on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  to service_role;

-- ============================================================ 2. Giv advarsel

-- p_medarbejder er den indloggede medarbejder (assertRole("admin") paa
-- serveren; rollen tjekkes ogsaa her). Funktionen er kun aaben for
-- service_role, ligesom advarsel_ubetalt.
-- p_modtager: 'koeber' eller 'saelger'.
-- Returnerer { kode }. Koder: ok, ingen_adgang, ugyldig_modtager,
-- begrundelse_mangler, begrundelse_for_lang, ikke_fundet, indsigelse,
-- allerede_loest.
create or replace function public.admin_advarsel_betaling(
  p_betaling uuid, p_medarbejder uuid, p_modtager text, p_begrundelse text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b        record;
  grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  modtager uuid;
  hvem     text;
begin
  if not exists (select 1 from public.users
                  where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_modtager is null or p_modtager not in ('koeber', 'saelger') then
    return jsonb_build_object('kode', 'ugyldig_modtager');
  end if;
  if grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if length(grund) > 2000 then return jsonb_build_object('kode', 'begrundelse_for_lang'); end if;

  select id, trade_id, buyer_id, seller_id, kraever_opmaerksomhed,
         indsigelse_kl, indsigelse_status
    into b
    from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;

  -- Idempotent: kun en raekke, der stadig kraever opmaerksomhed, aendres.
  update public.betalinger
     set kraever_opmaerksomhed = false
   where id = b.id and kraever_opmaerksomhed;
  if not found then return jsonb_build_object('kode', 'allerede_loest'); end if;

  if p_modtager = 'koeber' then
    modtager := b.buyer_id; hvem := 'køber';
  else
    modtager := b.seller_id; hvem := 'sælger';
  end if;
  if modtager is null then
    raise exception 'Betalingen mangler %', hvem;
  end if;

  insert into public.advarsler (bruger_id, oprettet_af, aarsag)
  values (modtager, p_medarbejder, grund);

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'advarsel', 'handel', b.trade_id, modtager, grund);

  -- Samme logning som "Markér som løst", saa sagen vises under "Løste".
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'betaling_loest', 'handel', b.trade_id, b.buyer_id,
          'Advarsel givet til ' || hvem || ': ' || grund);

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.admin_advarsel_betaling(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_advarsel_betaling(uuid, uuid, text, text)
  to service_role;
