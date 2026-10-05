-- Fragt-rettelser efter review af 20261006010000_fragt_skelet.sql.
--
-- Ingen pengeflytning og ingen aendring af afsendelsesfristen (ROADMAP-
-- BESLUTNINGER, "Saelger markerer selv pakken sendt", 6. oktober 2026).
--
-- Indhold:
--   1. Nye kolonner og status 'annulleres' (claim foer fragtfirmaet kaldes).
--   2. forsendelse_note_tilfoej: staff-noter tilfoejes uden dubletter.
--   3. Label og QR-kode kun til den rette part: label_sti og qr_kode fjernes
--      fra den generelle kolonne-grant; mine_forsendelse_label() i stedet.
--      Storage-policyen giver ikke laengere annullerede labels til brugerne.
--   4. Annullering i to trin: forsendelse_annuller_claim (status
--      'annulleres', FOER kaldet til fragtfirmaet) og forsendelse_annuller_afslut
--      (annulleret, eller rul tilbage/markér til staff). Den gamle
--      forsendelse_annuller (opdaterede EFTER kaldet) fjernes.
--   5. forsendelse_registrer_haendelse: haendelser mens labelen annulleres
--      markeres til staff; 'oprettet' ruller ikke en annullering tilbage.
--      forsendelse_marker_besked og ny forsendelse_marker_opmaerksomhed bruger
--      noteslaegeren fra 2.
--   6. fragt_cron_annulleringer: udgaaende labels paa annullerede handler
--      (uanset grund) findes til fragt-cron'en, og afbrudte annulleringer
--      ryddes op.
--   7. Admin: 'fragt' i admin_forside_tal() og moderation_log-handlingen
--      'fragt_haandteret'.
--
-- Idempotent: kan koeres flere gange.

-- ============================================================ 1. kolonner/status

alter table public.forsendelser
  add column if not exists annuller_forsoeg integer not null default 0,
  -- Seneste annulleringsforsoeg (saettes ved claim, nulstilles ikke): bruges
  -- til at finde afbrudte annulleringer og til at vente mellem forsoeg.
  add column if not exists annuller_forsoegt_kl timestamptz,
  -- Hvem startede annulleringen: 'bruger' (saelgeren) eller
  -- 'handel_annulleret' (fragt-cron, fordi handlen er annulleret).
  add column if not exists annulleret_aarsag text;

alter table public.forsendelser drop constraint if exists forsendelser_status_check;
alter table public.forsendelser add constraint forsendelser_status_check check (status in (
  'opretter', 'oprettet', 'annulleres', 'afleveret', 'i_transit', 'klar_til_afhentning',
  'leveret', 'returneret', 'annulleret', 'fejlet'));

alter table public.forsendelser drop constraint if exists forsendelser_annulleret_aarsag_check;
alter table public.forsendelser add constraint forsendelser_annulleret_aarsag_check check (
  annulleret_aarsag is null or annulleret_aarsag in ('bruger', 'handel_annulleret'));

comment on column public.forsendelser.status is
  'opretter: claimet, fragtfirmaet kaldes. oprettet: labelen findes. '
  'annulleres: annullering claimet, fragtfirmaet kaldes. afleveret .. returneret: '
  'seneste sporingsstatus. annulleret: annulleret hos fragtfirmaet. fejlet: '
  'oprettelsen fejlede.';

-- Sporings-cron: 'annulleres' spores ogsaa, saa en samtidig "afleveret" opdages.
drop index if exists public.forsendelser_aktive_idx;
create index if not exists forsendelser_aktive_idx
  on public.forsendelser (sidst_polled_kl nulls first)
  where status in ('oprettet', 'annulleres', 'afleveret', 'i_transit', 'klar_til_afhentning');

-- ============================================================ 2. noter

-- Tilfoejer p_ny til en staff-note med ' · '. Findes praecis samme del
-- allerede, aendres intet. Over 1000 tegn fjernes de aeldste tegn ('…').
create or replace function public.forsendelse_note_tilfoej(p_gammel text, p_ny text)
returns text
language plpgsql
immutable
set search_path = public
as $fn$
declare
  ny text := btrim(coalesce(p_ny, ''));
  v  text;
begin
  if ny = '' then return p_gammel; end if;
  if nullif(btrim(coalesce(p_gammel, '')), '') is null then return left(ny, 1000); end if;
  if ny = any(string_to_array(p_gammel, ' · ')) then return p_gammel; end if;
  v := p_gammel || ' · ' || ny;
  if char_length(v) > 1000 then v := '…' || right(v, 999); end if;
  return v;
end;
$fn$;
revoke all on function public.forsendelse_note_tilfoej(text, text) from public, anon, authenticated;
grant execute on function public.forsendelse_note_tilfoej(text, text) to service_role;

-- ============================================================ 3. label-adgang

-- label_sti og qr_kode er ikke laengere i den generelle grant: koeberen maa
-- ikke se saelgerens label/QR (og omvendt for retur). De hentes via
-- mine_forsendelse_label().
revoke all on public.forsendelser from public, anon, authenticated;
revoke select (label_sti, qr_kode) on public.forsendelser from authenticated;
grant select (id, trade_id, type, fragtfirma, status, pakkestoerrelse,
              sporingsnummer, oprettet_kl, afleveret_kl,
              klar_til_afhentning_kl, leveret_kl, returneret_kl, annulleret_kl,
              sidste_haendelse_kl)
  on public.forsendelser to authenticated;
grant all on public.forsendelser to service_role;

-- Labelens sti og QR-kode for den kaldende bruger: saelgeren for en
-- udgaaende forsendelse, koeberen for en retur, og staff. Brugerne faar ikke
-- labels, der er (ved at blive) annulleret, eller som ikke er lavet endnu.
-- Ingen raekke = ingen adgang (eller ingen label).
create or replace function public.mine_forsendelse_label(p_forsendelse uuid)
returns table (label_sti text, qr_kode text)
language sql
stable
security definer
set search_path = public
as $fn$
  select f.label_sti, f.qr_kode
    from public.forsendelser f
    join public.trades t on t.id = f.trade_id
   where f.id = p_forsendelse
     and auth.uid() is not null
     and (public.er_staff()
       or (f.status not in ('opretter', 'annulleres', 'annulleret', 'fejlet')
           and ((f.type = 'udgaaende' and t.seller_id = auth.uid())
             or (f.type = 'retur' and t.buyer_id = auth.uid()))));
$fn$;
revoke all on function public.mine_forsendelse_label(uuid) from public, anon;
grant execute on function public.mine_forsendelse_label(uuid) to authenticated;

-- Storage: samme regel som mine_forsendelse_label (staff ser alt).
create or replace function public.fragt_label_maa_laese(p_sti text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null and (
       public.er_staff()
    or exists (
         select 1 from public.forsendelser f
           join public.trades t on t.id = f.trade_id
          where f.label_sti = p_sti
            and f.status not in ('opretter', 'annulleres', 'annulleret', 'fejlet')
            and ((f.type = 'udgaaende' and t.seller_id = auth.uid())
              or (f.type = 'retur' and t.buyer_id = auth.uid())))
  );
$fn$;
revoke all on function public.fragt_label_maa_laese(text) from public, anon;
grant execute on function public.fragt_label_maa_laese(text) to authenticated;

-- ============================================================ 4. annullering

-- Den gamle funktion opdaterede databasen EFTER fragtfirmaet - erstattet af
-- claim/afslut nedenfor.
drop function if exists public.forsendelse_annuller(uuid, uuid);

-- Trin 1: claim annulleringen (status 'annulleres'), FOER fragtfirmaet kaldes.
--   p_bruger sat:  brugeren (verificeret af serveren med auth) skal vaere
--                  saelgeren (udgaaende) eller koeberen (retur).
--   p_bruger null: systemet (fragt-cron) - kun naar handlen er annulleret.
-- Kun fra 'oprettet', eller en afbrudt 'annulleres' (over 15 minutter).
-- Svar: 'ok' | 'ikke_fundet' | 'i_gang' | 'kan_ikke'.
create or replace function public.forsendelse_annuller_claim(p_id uuid, p_bruger uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f        record;
  t        record;
  v_aarsag text;
begin
  select id, trade_id, type, status, forsendelses_id, annuller_forsoegt_kl into f
    from public.forsendelser where id = p_id for update;
  if f.id is null then return 'ikke_fundet'; end if;

  select seller_id, buyer_id, status into t from public.trades where id = f.trade_id;

  if p_bruger is not null then
    if not ((f.type = 'udgaaende' and t.seller_id = p_bruger)
         or (f.type = 'retur' and t.buyer_id = p_bruger)) then
      return 'ikke_fundet';
    end if;
    v_aarsag := 'bruger';
  else
    if t.status is distinct from 'annulleret' then return 'kan_ikke'; end if;
    v_aarsag := 'handel_annulleret';
  end if;

  if f.forsendelses_id is null then return 'kan_ikke'; end if;
  if f.status = 'annulleres' then
    if f.annuller_forsoegt_kl > now() - interval '15 minutes' then
      return 'i_gang';
    end if;
  elsif f.status <> 'oprettet' then
    return 'kan_ikke';
  end if;

  update public.forsendelser
     set status = 'annulleres',
         annuller_forsoeg = annuller_forsoeg + 1,
         annuller_forsoegt_kl = now(),
         annulleret_aarsag = v_aarsag
   where id = p_id and status in ('oprettet', 'annulleres');
  if not found then return 'kan_ikke'; end if;
  return 'ok';
end;
$fn$;
revoke all on function public.forsendelse_annuller_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.forsendelse_annuller_claim(uuid, uuid) to service_role;

-- Trin 2: fragtfirmaets svar.
--   p_ok true:  'annulleres' -> 'annulleret'. Er status skiftet imens (fx en
--               samtidig "afleveret"), markeres forsendelsen til staff.
--   p_ok false: 'annulleres' -> 'oprettet' (labelen er stadig aktiv), og
--               p_note (hvis sat) tilfoejes til staff.
-- Svar: 'annulleret' | 'rullet_tilbage' | 'aendret' (status var skiftet).
create or replace function public.forsendelse_annuller_afslut(p_id uuid, p_ok boolean, p_note text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
begin
  if p_ok then
    update public.forsendelser
       set status = 'annulleret', annulleret_kl = now()
     where id = p_id and status = 'annulleres';
    if found then return 'annulleret'; end if;
    select status into v_status from public.forsendelser where id = p_id;
    update public.forsendelser
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst,
             'Labelen blev annulleret hos fragtfirmaet, men forsendelsen havde imens fået status '
             || coalesce(v_status, '?') || '. Tjek forsendelsen hos fragtfirmaet.')
     where id = p_id and status <> 'annulleret';
    return 'aendret';
  end if;

  update public.forsendelser
     set status = 'oprettet',
         kraever_opmaerksomhed = kraever_opmaerksomhed or nullif(btrim(coalesce(p_note, '')), '') is not null,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, p_note)
   where id = p_id and status = 'annulleres';
  if found then return 'rullet_tilbage'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    update public.forsendelser
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, p_note)
     where id = p_id;
  end if;
  return 'aendret';
end;
$fn$;
revoke all on function public.forsendelse_annuller_afslut(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.forsendelse_annuller_afslut(uuid, boolean, text) to service_role;

-- ============================================================ 5. haendelser/noter

-- Som i 20261006010000, med to aendringer:
--   - Haendelser, mens labelen annulleres ('annulleres'), flytter status frem
--     som normalt (virkeligheden vinder) og markeres til staff. 'oprettet'
--     ruller ikke en annullering tilbage.
--   - Staff-noter tilfoejes med forsendelse_note_tilfoej (ingen dubletter).
create or replace function public.forsendelse_registrer_haendelse(
  p_forsendelse uuid,
  p_type        text,
  p_tidspunkt   timestamptz,
  p_noegle      text,
  p_beskrivelse text,
  p_raa         jsonb,
  p_kilde       text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f       record;
  v_ny    boolean := false;
  v_tid   timestamptz := least(coalesce(p_tidspunkt, now()), now() + interval '5 minutes');
  v_raa   jsonb := p_raa;
  v_note  text := null;
  v_trade text;
begin
  if p_type not in ('oprettet', 'afleveret', 'i_transit', 'klar_til_afhentning',
                    'leveret', 'returneret', 'fejl') then
    raise exception 'ukendt haendelsestype %', p_type;
  end if;

  select * into f from public.forsendelser where id = p_forsendelse for update;
  if f.id is null then raise exception 'forsendelse findes ikke'; end if;

  -- For stor raa payload gemmes ikke (haendelsen gemmes stadig).
  if v_raa is not null and (jsonb_typeof(v_raa) <> 'object' or pg_column_size(v_raa) > 4096) then
    v_raa := jsonb_build_object('afkortet', true);
  end if;

  insert into public.forsendelse_haendelser
    (forsendelse_id, type, tidspunkt, noegle, beskrivelse, kilde, raa)
  values (f.id, p_type, v_tid, left(p_noegle, 200), left(p_beskrivelse, 300), p_kilde, v_raa)
  on conflict (forsendelse_id, noegle) do nothing;
  v_ny := found;

  if v_ny then
    if f.status in ('annulleret', 'fejlet', 'opretter') then
      -- Haendelse paa en label, der ikke er (eller ikke laengere er) aktiv.
      if p_type <> 'oprettet' then
        v_note := 'Sporingshændelse (' || p_type || ') på en forsendelse med status '
                  || f.status || '. Tjek, om sælgeren har brugt en annulleret label.';
      end if;
      update public.forsendelser
         set sidste_haendelse_kl = greatest(coalesce(sidste_haendelse_kl, v_tid), v_tid),
             kraever_opmaerksomhed = kraever_opmaerksomhed or v_note is not null,
             opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, v_note)
       where id = f.id;
    else
      if f.status = 'annulleres' and p_type <> 'oprettet' then
        v_note := 'Fragtfirmaet meldte pakken (' || p_type || '), mens labelen var ved at blive '
                  || 'annulleret. Tjek hos fragtfirmaet, om pakken er undervejs.';
      elsif p_type = 'returneret' then
        v_note := case when f.type = 'udgaaende'
          then 'Pakken er sendt retur til sælgeren (fx ikke hentet). Vurdér handlen (ikke-afhentet pakke, model 3).'
          else 'Returpakken er sendt tilbage til køberen. Vurdér sagen.' end;
      elsif p_type = 'fejl' then
        v_note := 'Fragtfirmaet meldte en fejl: ' || coalesce(left(p_beskrivelse, 200), 'ingen beskrivelse');
      elsif f.type = 'retur' and p_type = 'afleveret' then
        v_note := 'Returpakken er afleveret. Registrér det i sagen.';
      end if;

      update public.forsendelser
         set status = case
               when p_type <> 'fejl'
                and not (p_type = 'oprettet' and status = 'annulleres')
                and public.forsendelse_status_rang(p_type) > public.forsendelse_status_rang(status)
               then p_type else status end,
             afleveret_kl = case when p_type in ('afleveret', 'i_transit', 'klar_til_afhentning', 'leveret')
               then coalesce(afleveret_kl, v_tid) else afleveret_kl end,
             klar_til_afhentning_kl = case when p_type = 'klar_til_afhentning'
               then coalesce(klar_til_afhentning_kl, v_tid) else klar_til_afhentning_kl end,
             leveret_kl = case when p_type = 'leveret'
               then coalesce(leveret_kl, v_tid) else leveret_kl end,
             returneret_kl = case when p_type = 'returneret'
               then coalesce(returneret_kl, v_tid) else returneret_kl end,
             sidste_haendelse_kl = greatest(coalesce(sidste_haendelse_kl, v_tid), v_tid),
             kraever_opmaerksomhed = kraever_opmaerksomhed or v_note is not null,
             opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, v_note)
       where id = f.id;
    end if;
  end if;

  select tr.status into v_trade from public.trades tr
    join public.forsendelser fo on fo.trade_id = tr.id
   where fo.id = p_forsendelse;

  return (select jsonb_build_object(
    'ny', v_ny,
    'forsendelse_id', fo.id,
    'trade_id', fo.trade_id,
    'forsendelse_type', fo.type,
    'status', fo.status,
    'trade_status', v_trade)
    from public.forsendelser fo where fo.id = p_forsendelse);
end;
$fn$;
revoke all on function public.forsendelse_registrer_haendelse(uuid, text, timestamptz, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.forsendelse_registrer_haendelse(uuid, text, timestamptz, text, text, jsonb, text) to service_role;

-- Som i 20261006010000, men noten tilfoejes uden dubletter.
create or replace function public.forsendelse_marker_besked(
  p_id   uuid,
  p_felt text,
  p_note text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_note boolean := nullif(btrim(coalesce(p_note, '')), '') is not null;
begin
  if p_felt = 'afleveret' then
    update public.forsendelser
       set afleveret_besked_kl = now(),
           kraever_opmaerksomhed = kraever_opmaerksomhed or v_note,
           opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, p_note)
     where id = p_id and afleveret_besked_kl is null;
  elsif p_felt = 'leveret' then
    update public.forsendelser
       set leveret_besked_kl = now(),
           kraever_opmaerksomhed = kraever_opmaerksomhed or v_note,
           opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, p_note)
     where id = p_id and leveret_besked_kl is null;
  else
    raise exception 'ukendt felt %', p_felt;
  end if;
  return found;
end;
$fn$;
revoke all on function public.forsendelse_marker_besked(uuid, text, text) from public, anon, authenticated;
grant execute on function public.forsendelse_marker_besked(uuid, text, text) to service_role;

-- Markerer en forsendelse til staff med en note (fx en fejlet annullering).
create or replace function public.forsendelse_marker_opmaerksomhed(p_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then return false; end if;
  update public.forsendelser
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, p_note)
   where id = p_id;
  return found;
end;
$fn$;
revoke all on function public.forsendelse_marker_opmaerksomhed(uuid, text) from public, anon, authenticated;
grant execute on function public.forsendelse_marker_opmaerksomhed(uuid, text) to service_role;

-- ============================================================ 6. cron

-- Til fragt-cron'en:
--   a) Afbrudte annulleringer startet af en bruger ('annulleres' i over 15
--      minutter, handlen ikke annulleret) rulles tilbage til 'oprettet' og
--      markeres til staff - vi ved ikke, om fragtfirmaet naaede at annullere.
--   b) Returnerer udgaaende labels paa annullerede handler (uanset hvorfor
--      handlen blev annulleret), der skal annulleres hos fragtfirmaet: status
--      'oprettet' (hoejst 3 forsoeg, 1 time imellem) eller en afbrudt
--      'annulleres'.
create or replace function public.fragt_cron_annulleringer(p_graense integer)
returns table (id uuid, trade_id uuid)
language plpgsql
security definer
set search_path = public
as $fn$
#variable_conflict use_column
begin
  update public.forsendelser fo
     set status = 'oprettet',
         kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(fo.opmaerksomhed_tekst,
           'En annullering af labelen blev afbrudt. Tjek hos fragtfirmaet, om labelen er annulleret.')
    from public.trades t
   where t.id = fo.trade_id
     and fo.status = 'annulleres'
     and fo.annuller_forsoegt_kl < now() - interval '15 minutes'
     and t.status <> 'annulleret';

  return query
    select f.id, f.trade_id
      from public.forsendelser f
      join public.trades t on t.id = f.trade_id
     where t.status = 'annulleret'
       and f.type = 'udgaaende'
       and f.forsendelses_id is not null
       and ((f.status = 'oprettet'
             and f.annuller_forsoeg < 3
             and (f.annuller_forsoegt_kl is null or f.annuller_forsoegt_kl < now() - interval '1 hour'))
         or (f.status = 'annulleres'
             and f.annuller_forsoegt_kl < now() - interval '15 minutes'))
     order by f.annuller_forsoegt_kl nulls first, f.oprettet_kl
     limit greatest(1, least(coalesce(p_graense, 10), 50));
end;
$fn$;
revoke all on function public.fragt_cron_annulleringer(integer) from public, anon, authenticated;
grant execute on function public.fragt_cron_annulleringer(integer) to service_role;

-- ============================================================ 7. admin

-- Ny handling: staff markerer en forsendelse som haandteret.
alter table public.moderation_log drop constraint if exists moderation_log_handling_check;
alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest',
    'chat_aabnet','chat_lukket','faellesbesked',
    'sag_afgjort_koeber','sag_afgjort_saelger','sag_retur_afleveret',
    'sag_genaabnet','konto_lukket','sag_afviklet',
    'indpakning_paamindelse','konto_lukning_foreslaaet','konto_lukning_afvist',
    'udbetalingskonto_loest',
    'udbetalingskonto_nulstillet',
    'rapport_behandlet',
    'sag_anke_indgivet','sag_anke_stadfaestet','sag_anke_omgjort',
    'chat_laest',
    'refusion_proevet_igen',
    'fragt_haandteret'));

-- admin_forside_tal: som i 20261005031000_admin_forside_rettelser.sql, plus
-- 'fragt' (forsendelser, staff skal se paa).
create or replace function public.admin_forside_tal()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  c_system   constant uuid := '00000000-0000-4000-8000-0000000b1d00';
  c_tz       constant text := 'Europe/Copenhagen';
  v_lokal    timestamp := now() at time zone c_tz;
  v_dag      timestamptz := date_trunc('day', v_lokal) at time zone c_tz;
  v_uge      timestamptz := date_trunc('week', v_lokal) at time zone c_tz;
  v_maaned   timestamptz := date_trunc('month', v_lokal) at time zone c_tz;
  v_start30  date := (date_trunc('day', v_lokal) - interval '29 days')::date;
  v_handling jsonb;
  v_brugere  jsonb;
  v_tilvaekst jsonb;
  v_aktivitet jsonb;
begin
  -- ---------------------------------------------------------- Kræver handling
  select jsonb_build_object(
    -- Samme taelling som antal_aabne_sager() (uden anker - de har eget kort).
    'aabne_sager',
      (select count(*) from public.sager where status = 'aaben'),
    -- Afventer retur, hvor koeberens 7 dages frist er udloebet, og returen
    -- ikke er registreret: staff skal tage stilling. Samme beregning som
    -- sag_afgoer / sag_genaabn (20261005021000).
    'retur_udloebet',
      (select count(*)
         from public.sager s
         left join public.sag_anker a on a.sag_id = s.id
        where s.status = 'afventer_retur'
          and s.retur_afleveret_kl is null
          and (a.id is null or a.status <> 'afventer')
          and greatest(coalesce(s.penge_flyttes_efter_kl, s.afgjort_kl + interval '4 days'),
                       coalesce(a.behandlet_kl, '-infinity'::timestamptz))
              + interval '7 days' <= now()),
    'anker',
      (select count(*) from public.sag_anker where status = 'afventer'),
    'rapporter',
      (select count(*) from public.reports where status = 'pending'),
    -- Handler der haenger: samme regler som Haenger-fanen paa /admin/handler
    -- (admin_haengende_handler ovenfor).
    'ikke_sendt',
      (select count(*) from public.admin_haengende_handler() where grund = 'ikke_sendt'),
    'ikke_modtaget',
      (select count(*) from public.admin_haengende_handler() where grund = 'ikke_modtaget'),
    'afhentning',
      (select count(*) from public.admin_haengende_handler() where grund = 'afhentning'),
    'ubetalte',
      (select count(*) from public.ubetalte_vindere where status = 'afventer'),
    -- Alle betalinger, staff skal se paa (samme som menuens badge).
    'betalinger',
      (select count(*) from public.betalinger where kraever_opmaerksomhed),
    -- Delmaengder af 'betalinger' til visning.
    'overfoersel_fejlet',
      (select count(*) from public.betalinger
        where kraever_opmaerksomhed
          and overfoersel_forsoeg > 0
          and stripe_transfer_id is null),
    'refusion_fejlet',
      (select count(*) from public.betalinger
        where kraever_opmaerksomhed
          and refusion_forsoeg > 0
          and refunderet_kl is null),
    'afvigelser',
      (select count(*) from public.betaling_afvigelser where refunderet_kl is null),
    'udbetalingskonti',
      (select count(*) from public.betalingsprofiler where connect_kraever_opmaerksomhed),
    'kontolukninger',
      (select count(*) from public.konto_lukning_forslag where status = 'afventer'),
    -- Forsendelser, staff skal se paa (samme som fanen Fragt paa /admin/handler).
    'fragt',
      (select count(*) from public.forsendelser where kraever_opmaerksomhed)
  ) into v_handling;

  -- ---------------------------------------------------------- Brugere
  select jsonb_build_object(
    'i_alt',   count(*),
    'i_dag',   count(*) filter (where oprettet >= v_dag),
    'uge',     count(*) filter (where oprettet >= v_uge),
    'maaned',  count(*) filter (where oprettet >= v_maaned)
  ) into v_brugere
  from public.users
  where id <> c_system;

  -- Tilvaekst: een raekke pr. dag (lokal dato), nye + kumulativt i alt ved
  -- dagens udgang.
  with dage as (
    select d::date as dag
      from generate_series(v_start30, date_trunc('day', v_lokal)::date, interval '1 day') d
  ), nye as (
    select (oprettet at time zone c_tz)::date as dag, count(*) as antal
      from public.users
     where id <> c_system
       and oprettet >= (v_start30::timestamp at time zone c_tz)
     group by 1
  ), foer as (
    select count(*) as antal
      from public.users
     where id <> c_system
       and oprettet < (v_start30::timestamp at time zone c_tz)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'dag', to_char(x.dag, 'YYYY-MM-DD'),
           'nye', x.nye,
           'kumulativt', x.kumulativt) order by x.dag), '[]'::jsonb)
    into v_tilvaekst
    from (
      select dg.dag,
             coalesce(n.antal, 0) as nye,
             (select antal from foer)
               + sum(coalesce(n.antal, 0)) over (order by dg.dag) as kumulativt
        from dage dg
        left join nye n on n.dag = dg.dag
    ) x;

  -- ---------------------------------------------------------- Aktivitet
  select jsonb_build_object(
    'auktioner', (
      select jsonb_build_object(
        'i_dag',  count(*) filter (where oprettet >= v_dag),
        'uge',    count(*) filter (where oprettet >= v_uge),
        'maaned', count(*) filter (where oprettet >= v_maaned))
        from public.auctions
       where oprettet >= least(v_uge, v_maaned)),
    -- Solgte varer = handler, hvor betalingen er gennemfoert i perioden
    -- (ogsaa hvis den senere er refunderet - salget skete).
    'solgte', (
      select jsonb_build_object(
        'i_dag',  count(*) filter (where betalt_kl >= v_dag),
        'uge',    count(*) filter (where betalt_kl >= v_uge),
        'maaned', count(*) filter (where betalt_kl >= v_maaned))
        from public.betalinger
       where betalt_kl >= least(v_uge, v_maaned))
  ) into v_aktivitet;

  return jsonb_build_object(
    'handling',  v_handling,
    'brugere',   v_brugere,
    'tilvaekst', v_tilvaekst,
    'aktivitet', v_aktivitet,
    'beregnet_kl', now());
end;
$fn$;
comment on function public.admin_forside_tal() is
  'Tal til admin-forsiden (antal, ingen beloeb eller personoplysninger). '
  'Kun service_role - serveren kalder den efter assertRole(''medarbejder'').';

revoke all on function public.admin_forside_tal() from public, anon, authenticated;
grant execute on function public.admin_forside_tal() to service_role;
