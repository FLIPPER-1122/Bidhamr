-- Kraevede pakkebilleder i "Send pakke" (ROADMAP fase 1: "Kraevede
-- pakkebilleder i 'Send pakke' (kamera direkte, ikke kamerarulle): varen
-- indpakket i aaben kasse + lukket kasse med label"; ROADMAP-BESLUTNINGER:
-- "Pakkebilleder (kraevet)" og "Advarselssystem for daarlig indpakning").
--
-- Formaal: dokumentere INDPAKNINGEN. Staff bruger billederne i sager (skadet
-- vare med BidHamr Beskyttelse) og senere i advarselssystemet for daarlig
-- indpakning. Billederne beviser ikke, at varen blev i kassen.
--
-- AEndringer:
--   1. Privat bucket 'pakke-billeder' (10 MB, jpeg/png/heic/heif/webp).
--      Sti: <saelger-id>/<handel-id>/<filnavn>.
--      Upload: kun saelgeren, i sin egen mappe, paa en forsendelseshandel
--      (ikke afhentning) i status 'betaling_modtaget'. Hoejst 20 filer pr.
--      handel i storage (giver plads til nye forsoeg; hoejst 10 knyttes).
--      Laesning: saelgeren (egen mappe), staff, og koeberen - men kun billeder,
--      der er knyttet til handlen (dvs. efter afsendelsen).
--      Ingen update/delete-policies: bevis kan ikke overskrives eller slettes.
--   2. Tabel pakke_billeder (trade_id, sti unik, kategori 'aaben_kasse' |
--      'lukket_kasse', oprettet_kl). Slettes og aendres aldrig (trigger).
--      Koeber og saelger kan laese raekkerne; kun funktionen skriver.
--   3. trade_marker_sendt(p_trade, p_tracking, p_billeder jsonb) -> jsonb.
--      Kraever mindst et billede af hver kategori (hoejst 10 i alt), validerer
--      dem (findes i storage, i saelgerens mappe for handlen, ikke brugt foer)
--      og knytter dem til handlen i samme transaktion som statusskiftet.
--      Resten af logikken er uaendret fra 20261003030000 (afviser afhentning,
--      saetter sendt_kl, statusguard i samme update = idempotent).
--      Den gamle trade_marker_sendt(uuid, text) afviser nu altid med
--      fejlkoden 'billeder_kraeves' (exception), saa en gammel klient faar en
--      klar besked i stedet for et misvisende "allerede sendt".
--
-- Idempotent: if not exists / create or replace / drop ... if exists /
-- on conflict. Ingen eksisterende data aendres.

-- ============================================================ 1. tabel

create table if not exists public.pakke_billeder (
  id          uuid primary key default gen_random_uuid(),
  trade_id    uuid not null references public.trades(id) on delete restrict,
  -- Sti i bucket 'pakke-billeder': <saelger-id>/<handel-id>/<filnavn>
  sti         text not null unique,
  kategori    text not null,
  oprettet_kl timestamptz not null default now(),
  constraint pakke_billeder_kategori_check check (
    kategori in ('aaben_kasse', 'lukket_kasse')),
  constraint pakke_billeder_sti_format check (
    sti ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$')
);

comment on table public.pakke_billeder is
  'Saelgerens billeder af indpakningen, taget ved "Send pakke" (varen i den '
  'aabne kasse + den lukkede kasse med label). Filen ligger i bucket '
  'pakke-billeder. Bruges af staff i sager og til advarsler for daarlig '
  'indpakning. Slettes og aendres aldrig.';

create index if not exists pakke_billeder_trade_idx
  on public.pakke_billeder (trade_id, oprettet_kl);

alter table public.pakke_billeder enable row level security;

-- Koeber og saelger paa handlen kan laese raekkerne. Raekkerne findes foerst,
-- naar pakken er markeret som sendt. Staff bruger service_role.
drop policy if exists pakke_billeder_select_parter on public.pakke_billeder;
create policy pakke_billeder_select_parter on public.pakke_billeder
  for select to authenticated using (
    exists (select 1 from public.trades t
             where t.id = pakke_billeder.trade_id
               and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );

revoke all on public.pakke_billeder from public, anon, authenticated;
grant select (id, trade_id, sti, kategori, oprettet_kl) on public.pakke_billeder to authenticated;
grant all on public.pakke_billeder to service_role;

-- Bevis: kan hverken aendres eller slettes (heller ikke af service_role).
create or replace function public.pakke_billeder_ingen_aendring()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Pakkebilleder kan ikke aendres eller slettes.' using errcode = '42501';
end;
$fn$;

revoke execute on function public.pakke_billeder_ingen_aendring() from public, anon, authenticated;

drop trigger if exists pakke_billeder_ingen_aendring on public.pakke_billeder;
create trigger pakke_billeder_ingen_aendring
  before update or delete on public.pakke_billeder
  for each row execute function public.pakke_billeder_ingen_aendring();

-- ============================================================ 2. storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pakke-billeder', 'pakke-billeder', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Maa den kaldende bruger uploade til stien? Kun saelgeren, i sin egen mappe
-- (<eget id>/<handel-id>/...), paa en forsendelseshandel, han er saelger paa,
-- som afventer afsendelse. Hoejst 20 filer pr. handel (misbrugsvaern - der
-- knyttes hoejst 10; resten er nye forsoeg efter en afbrudt upload).
create or replace function public.pakke_billede_maa_uploade(p_sti text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid := auth.uid();
  v_dele   text[] := string_to_array(coalesce(p_sti, ''), '/');
  v_trade  uuid;
begin
  if v_bruger is null or coalesce(array_length(v_dele, 1), 0) <> 3 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if v_dele[3] !~ '^[A-Za-z0-9._-]{1,100}$' then return false; end if;
  v_trade := v_dele[2]::uuid;

  if not exists (
    select 1 from public.trades t
     where t.id = v_trade
       and t.seller_id = v_bruger
       and t.status = 'betaling_modtaget'
       and not t.afhentning
  ) then
    return false;
  end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'pakke-billeder'
             and o.name like v_bruger::text || '/' || v_trade::text || '/%') < 20;
end;
$fn$;

revoke all on function public.pakke_billede_maa_uploade(text) from public, anon;
grant execute on function public.pakke_billede_maa_uploade(text) to authenticated;

-- Maa den kaldende bruger laese filen? Uploaderen (saelgeren) selv, staff,
-- og koeberen paa handlen, naar billedet er knyttet til handlen (efter
-- afsendelsen). Ikke-knyttede filer (afbrudte forsoeg) ser koeberen aldrig.
create or replace function public.pakke_billede_maa_laese(p_sti text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null and (
       split_part(coalesce(p_sti, ''), '/', 1) = auth.uid()::text
    or public.er_staff()
    or exists (
         select 1 from public.pakke_billeder b
           join public.trades t on t.id = b.trade_id
          where b.sti = p_sti
            and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );
$fn$;

revoke all on function public.pakke_billede_maa_laese(text) from public, anon;
grant execute on function public.pakke_billede_maa_laese(text) to authenticated;

drop policy if exists "pakke_billeder_upload_saelger" on storage.objects;
create policy "pakke_billeder_upload_saelger"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'pakke-billeder'
    and public.pakke_billede_maa_uploade(name)
  );

drop policy if exists "pakke_billeder_laes_parter" on storage.objects;
create policy "pakke_billeder_laes_parter"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'pakke-billeder'
    and public.pakke_billede_maa_laese(name)
  );

-- Ingen update/delete-policies: bevis kan ikke overskrives eller slettes.
-- (Upload skal derfor ske med upsert: false.)

-- ============================================================ 3. validering

-- Validerer en billedliste fra saelgeren: [{ "sti": "...", "kategori": "..." }].
-- Hver sti skal ligge i saelgerens mappe for handlen, findes i storage og ikke
-- vaere brugt foer. Mindst et billede af hver kategori, hoejst 10 i alt.
-- Returnerer null hvis ok, ellers en fejlkode: billeder_kraeves,
-- ugyldige_billeder, billede_mangler, for_mange_billeder.
-- Intern - kaldes kun fra trade_marker_sendt.
create or replace function public.pakke_valider_billeder(
  p_saelger uuid, p_trade uuid, p_billeder jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  e        jsonb;
  v_sti    text;
  v_kat    text;
  v_stier  text[] := '{}';
  v_aaben  boolean := false;
  v_lukket boolean := false;
begin
  if p_billeder is null or jsonb_typeof(p_billeder) <> 'array' then
    return 'billeder_kraeves';
  end if;
  if jsonb_array_length(p_billeder) > 10 then return 'for_mange_billeder'; end if;

  for e in select * from jsonb_array_elements(p_billeder) loop
    if jsonb_typeof(e) <> 'object' then return 'ugyldige_billeder'; end if;
    v_sti := e->>'sti';
    v_kat := e->>'kategori';
    if v_sti is null or v_kat is null
       or v_kat not in ('aaben_kasse', 'lukket_kasse') then
      return 'ugyldige_billeder';
    end if;
    if split_part(v_sti, '/', 1) <> p_saelger::text
       or split_part(v_sti, '/', 2) <> p_trade::text
       or v_sti !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$' then
      return 'ugyldige_billeder';
    end if;
    if v_sti = any(v_stier) then return 'ugyldige_billeder'; end if;
    v_stier := v_stier || v_sti;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'pakke-billeder' and o.name = v_sti) then
      return 'billede_mangler';
    end if;
    if exists (select 1 from public.pakke_billeder b where b.sti = v_sti) then
      return 'ugyldige_billeder';
    end if;
    if v_kat = 'aaben_kasse' then v_aaben := true; else v_lukket := true; end if;
  end loop;

  if not (v_aaben and v_lukket) then return 'billeder_kraeves'; end if;
  return null;
end;
$fn$;

revoke all on function public.pakke_valider_billeder(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pakke_valider_billeder(uuid, uuid, jsonb) to service_role;

-- ============================================================ 4. send pakke

-- Som 20261003030000 (afviser afhentning, saetter sendt_kl, statusguard i
-- samme update), men kraever pakkebilleder, der knyttes i samme transaktion.
-- Saelgeren udledes af auth.uid().
--
-- Returnerer {"kode": "ok"} eller en fejlkode:
--   ikke_logget_ind, ugyldigt_tracking (tomt eller over 100 tegn),
--   ikke_fundet (ogsaa hvis kalderen ikke er saelger), afhentning,
--   allerede_sendt (handlen er ikke 'betaling_modtaget' - fx dobbeltklik),
--   billeder_kraeves, ugyldige_billeder, billede_mangler, for_mange_billeder.
create or replace function public.trade_marker_sendt(
  p_trade    uuid,
  p_tracking text,
  p_billeder jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder   uuid := auth.uid();
  tracking text := nullif(btrim(p_tracking), '');
  t        record;
  v_fejl   text;
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if tracking is null or char_length(tracking) > 100 then
    return jsonb_build_object('kode', 'ugyldigt_tracking');
  end if;

  -- Ikke saelgeren: samme svar som en ukendt handel. Tjekkes foer laasen, saa
  -- uvedkommende ikke kan laase fremmede raekker.
  if not exists (select 1 from public.trades
                  where id = p_trade and seller_id = kalder) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laas handlen, saa to samtidige kald ikke begge knytter billeder.
  select id, seller_id, status, afhentning into t
    from public.trades where id = p_trade for update;
  if t.id is null or t.seller_id <> kalder then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if t.afhentning then return jsonb_build_object('kode', 'afhentning'); end if;
  if t.status <> 'betaling_modtaget' then
    return jsonb_build_object('kode', 'allerede_sendt');
  end if;

  v_fejl := public.pakke_valider_billeder(kalder, p_trade, p_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  update public.trades
     set status = 'pakke_sendt',
         tracking_number = tracking,
         sendt_kl = coalesce(sendt_kl, now())
   where id = p_trade
     and seller_id = kalder
     and status = 'betaling_modtaget'
     and not afhentning;

  if not found then return jsonb_build_object('kode', 'allerede_sendt'); end if;

  insert into public.pakke_billeder (trade_id, sti, kategori)
  select p_trade, e->>'sti', e->>'kategori'
    from jsonb_array_elements(p_billeder) e;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke execute on function public.trade_marker_sendt(uuid, text, jsonb) from public, anon;
grant execute on function public.trade_marker_sendt(uuid, text, jsonb) to authenticated;

-- Den gamle udgave uden billeder afviser altid. Beholdes (frem for drop), saa
-- en gammel klient faar en klar fejlkode i stedet for "funktionen findes ikke".
create or replace function public.trade_marker_sendt(p_trade uuid, p_tracking text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  raise exception 'billeder_kraeves'
    using errcode = 'P0001',
          detail = 'Pakkebilleder kraeves: brug trade_marker_sendt(p_trade, p_tracking, p_billeder).';
end;
$fn$;

revoke execute on function public.trade_marker_sendt(uuid, text) from public, anon;
grant execute on function public.trade_marker_sendt(uuid, text) to authenticated;
