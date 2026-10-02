-- Sager fra koeberen (ROADMAP fase 1: "Sag inden for 48 timer", "Uden BidHamr
-- Beskyttelse ...", "Sag kraever billeder", "Svindel-undtagelse", "Permanent
-- lukning af konti ved svindel"; ROADMAP-BESLUTNINGER afsnit 1, 4 og
-- "Sager (Filip, 3. oktober 2026)").
--
-- Bygger videre paa det eksisterende:
--   - trades.sag_aaben (20260924000000) er stadig "frys"-flaget, som alle
--     pengeveje allerede respekterer: handel_godkend, betaling_claim_overfoersel,
--     betaling_overfoersel_nulstil og overfoerTilSaelger afviser, naar det er sat.
--     En sag fra koeberen saetter flaget; en trigger forhindrer, at det fjernes,
--     mens sagen er aaben (fx via admin_frigiv_handel eller "Luk sag").
--   - Refusion claimes i betalinger.refusion_anmodet_kl med samme raekkelaas
--     som betaling_claim_overfoersel, saa refusion og overfoersel aldrig kan
--     ske samtidig. Nyt: betalinger.refusion_oere (delvis refusion: alt
--     undtagen BidHamr Beskyttelse).
--   - Staff-chat: staff_samtaler.sag_type = 'sag', sag_id = sager.id.
--
-- Regler ved oprettelse (sag_opret, kun koeberen, auth.uid()):
--   skadet / ikke_som_beskrevet: kraever BidHamr Beskyttelse. Handlen skal
--       vaere 'modtaget' og hoejst 48 timer siden koeberen trykkede "modtaget"
--       (trades.received_at).
--   svindel: altid (med eller uden beskyttelse). Enten 'modtaget' inden for 48
--       timer (tom pakke, anden vare, falsk kopi), eller 'pakke_sendt' i mindst
--       7 dage (varen er aldrig sendt / sporingen er falsk).
--   bortkommet: altid. Handlen skal vaere 'pakke_sendt' i mindst 7 dage
--       (trades.sendt_kl, ny). 7 dage = GLS' opbevaringstid i pakkeshoppen; en
--       normal dansk pakke er fremme paa 1-3 hverdage.
--   Billeder: naar pakken er modtaget, kraeves mindst et billede af hver:
--       pakke, label og indhold (hoejst 10). Er pakken ikke modtaget, er
--       billeder valgfrie.
--   Kun een sag pr. handel nogensinde fra koeberen. Staff kan genaabne.
--   Betalingen skal vaere betalt, ikke frigivet, ikke overfoert og ikke under
--   refusion.
--
-- Afgoerelse (service_role, staff-rolle tjekkes igen her):
--   koeber + svindel/bortkommet       -> refusion straks
--   koeber + skadet/ikke_som_beskrevet -> 'afventer_retur'; refusion naar staff
--                                        registrerer, at returpakken er afleveret
--   saelger                           -> frigivelse straks (frigivet_kl)
--   lukket                            -> ingen penge flyttes; handlen fortsaetter
--   Refusionsbeloeb = total_oere - beskyttelse_oere (alt undtagen BidHamr
--   Beskyttelse). Aldrig mere end betalt, een refusion pr. betaling.
--   Returfragt betales af BidHamr (registreres; label kommer med GLS).
--
-- Sager og billeder slettes aldrig (bogfoeringsloven/DAC7/bevis).
--
-- Idempotent: if not exists / create or replace / drop ... if exists /
-- on conflict. Ingen eksisterende data aendres.

-- ============================================================ trades.sendt_kl

alter table public.trades
  add column if not exists sendt_kl timestamptz;

comment on column public.trades.sendt_kl is
  'Naar saelgeren markerede pakken som sendt. Grundlag for "bortkommet"-sager '
  '(tidligst 7 dage efter). Tom for handler sendt foer 20261003010000 - '
  'sag_opret bruger da betalinger.betalt_kl.';

-- Som 20260930010000, men saetter sendt_kl.
create or replace function public.trade_marker_sendt(p_trade uuid, p_tracking text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder   uuid := auth.uid();
  tracking text := nullif(btrim(p_tracking), '');
begin
  if kalder is null or tracking is null or char_length(tracking) > 100 then
    return false;
  end if;

  update public.trades
     set status = 'pakke_sendt',
         tracking_number = tracking,
         sendt_kl = coalesce(sendt_kl, now())
   where id = p_trade
     and seller_id = kalder
     and status = 'betaling_modtaget';

  return found;
end;
$fn$;

revoke execute on function public.trade_marker_sendt(uuid, text) from public, anon;
grant execute on function public.trade_marker_sendt(uuid, text) to authenticated;

-- ============================================================ betalinger.refusion_oere

alter table public.betalinger
  add column if not exists refusion_oere bigint;

do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_refusion_oere_check'
                    and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger
      add constraint betalinger_refusion_oere_check
      check (refusion_oere is null or (refusion_oere > 0 and refusion_oere <= total_oere));
  end if;
end;
$do$;

comment on column public.betalinger.refusion_oere is
  'Beloeb der refunderes (oere). null = fuld refusion (total_oere). Saettes ved '
  'medhold i en sag til total_oere - beskyttelse_oere. Kan aldrig overstige '
  'total_oere. Ses kun af chef.';

-- ============================================================ sager

create table if not exists public.sager (
  id                   uuid primary key default gen_random_uuid(),
  trade_id             uuid not null references public.trades(id) on delete restrict,
  oprettet_af          uuid not null references public.users(id) on delete restrict,
  type                 text not null,
  beskrivelse          text not null,
  status               text not null default 'aaben',
  -- Havde koeberen BidHamr Beskyttelse paa handlen (snapshot ved oprettelse).
  beskyttelse          boolean not null default false,
  -- Handlens status, da sagen blev oprettet ('modtaget' eller 'pakke_sendt').
  handel_status_ved_oprettelse text not null,
  oprettet_kl          timestamptz not null default now(),
  -- Afgoerelse. begrundelse vises for koeber og saelger; intern_note kun staff.
  afgjort_af           uuid references public.users(id) on delete restrict,
  afgjort_kl           timestamptz,
  begrundelse          text,
  intern_note          text,
  -- Retur (skadet / ikke som beskrevet med medhold til koeberen).
  retur_kraeves        boolean not null default false,
  returfragt_betaler   text,
  retur_afleveret_kl   timestamptz,
  retur_registreret_af uuid references public.users(id) on delete restrict,
  -- Refunderet beloeb (oere). Kun chef ser det.
  refusion_oere        bigint,
  genaabnet_antal      integer not null default 0,
  genaabnet_kl         timestamptz,
  -- Claim for "sag oprettet"-notifikationen til koeber og saelger (server/cron),
  -- saa den ogsaa sendes for sager oprettet direkte fra appen.
  notificeret_kl       timestamptz,
  opdateret            timestamptz not null default now(),
  constraint sager_type_check check (
    type in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel')),
  constraint sager_status_check check (
    status in ('aaben', 'afventer_retur', 'afgjort_koeber', 'afgjort_saelger', 'lukket')),
  constraint sager_beskrivelse_laengde check (
    char_length(btrim(beskrivelse)) between 10 and 4000),
  constraint sager_begrundelse_laengde check (
    begrundelse is null or char_length(btrim(begrundelse)) between 1 and 2000),
  constraint sager_intern_note_laengde check (
    intern_note is null or char_length(intern_note) <= 4000),
  constraint sager_returfragt_check check (
    returfragt_betaler is null or returfragt_betaler = 'bidhamr'),
  constraint sager_refusion_check check (refusion_oere is null or refusion_oere > 0),
  constraint sager_afgjort_par check (
    status in ('aaben', 'afventer_retur')
    or (afgjort_af is not null and afgjort_kl is not null and begrundelse is not null))
);

comment on table public.sager is
  'Sager oprettet af koeberen paa en handel (bortkommet, skadet, ikke som '
  'beskrevet, svindel). Fryser pengene via trades.sag_aaben. Slettes aldrig.';

-- Een aaben sag pr. handel.
create unique index if not exists sager_en_aaben_pr_handel
  on public.sager (trade_id) where status in ('aaben', 'afventer_retur');
create index if not exists sager_trade_idx on public.sager (trade_id);
create index if not exists sager_status_idx on public.sager (status, oprettet_kl desc);
create index if not exists sager_oprettet_af_idx on public.sager (oprettet_af);

alter table public.sager enable row level security;

-- Koeber og saelger paa handlen kan laese sagen. Staff bruger service_role.
drop policy if exists sager_select_parter on public.sager;
create policy sager_select_parter on public.sager
  for select to authenticated using (
    exists (select 1 from public.trades t
             where t.id = sager.trade_id
               and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );

revoke all on public.sager from anon, authenticated;
-- Ikke afgjort_af, intern_note, retur_registreret_af eller refusion_oere.
grant select (id, trade_id, type, beskrivelse, status, beskyttelse, oprettet_kl,
              afgjort_kl, begrundelse, retur_kraeves, returfragt_betaler,
              retur_afleveret_kl, genaabnet_kl)
  on public.sager to authenticated;
grant all on public.sager to service_role;

-- ============================================================ sag_billeder

create table if not exists public.sag_billeder (
  id          uuid primary key default gen_random_uuid(),
  sag_id      uuid not null references public.sager(id) on delete restrict,
  -- Sti i bucket 'sag-billeder': <koeber-id>/<handel-id>/<filnavn>
  sti         text not null unique,
  kategori    text not null,
  oprettet_kl timestamptz not null default now(),
  constraint sag_billeder_kategori_check check (
    kategori in ('pakke', 'label', 'indhold', 'andet')),
  constraint sag_billeder_sti_format check (
    sti ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$')
);

comment on table public.sag_billeder is
  'Billeder (bevis) knyttet til en sag. Filen ligger i bucket sag-billeder. Slettes aldrig.';

create index if not exists sag_billeder_sag_idx on public.sag_billeder (sag_id, oprettet_kl);

alter table public.sag_billeder enable row level security;

drop policy if exists sag_billeder_select_parter on public.sag_billeder;
create policy sag_billeder_select_parter on public.sag_billeder
  for select to authenticated using (
    exists (select 1 from public.sager s
              join public.trades t on t.id = s.trade_id
             where s.id = sag_billeder.sag_id
               and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );

revoke all on public.sag_billeder from anon, authenticated;
grant select (id, sag_id, sti, kategori, oprettet_kl) on public.sag_billeder to authenticated;
grant all on public.sag_billeder to service_role;

-- ============================================================ Vaern: slettes aldrig

create or replace function public.sager_ingen_sletning()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Sager og sagsbilleder kan ikke slettes.' using errcode = '42501';
end;
$fn$;

revoke execute on function public.sager_ingen_sletning() from public, anon, authenticated;

drop trigger if exists sager_ingen_sletning on public.sager;
create trigger sager_ingen_sletning
  before delete on public.sager
  for each row execute function public.sager_ingen_sletning();

drop trigger if exists sag_billeder_ingen_aendring on public.sag_billeder;
create trigger sag_billeder_ingen_aendring
  before update or delete on public.sag_billeder
  for each row execute function public.sager_ingen_sletning();

-- Faste felter paa en sag kan ikke aendres.
create or replace function public.sager_beskyt()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if new.id                           is distinct from old.id
  or new.trade_id                     is distinct from old.trade_id
  or new.oprettet_af                  is distinct from old.oprettet_af
  or new.type                         is distinct from old.type
  or new.beskrivelse                  is distinct from old.beskrivelse
  or new.beskyttelse                  is distinct from old.beskyttelse
  or new.handel_status_ved_oprettelse is distinct from old.handel_status_ved_oprettelse
  or new.oprettet_kl                  is distinct from old.oprettet_kl then
    raise exception 'Sagens faste oplysninger kan ikke ændres.' using errcode = '42501';
  end if;
  new.opdateret := now();
  return new;
end;
$fn$;

revoke execute on function public.sager_beskyt() from public, anon, authenticated;

drop trigger if exists sager_beskyt on public.sager;
create trigger sager_beskyt
  before update on public.sager
  for each row execute function public.sager_beskyt();

-- ============================================================ Vaern: frys

-- Mens en sag fra koeberen er aaben, kan trades.sag_aaben ikke fjernes - uanset
-- hvem der proever (admin_frigiv_handel, "Luk sag" i admin, service_role).
-- Undtagelse: handlen annulleres (refusion), saa er pengene paa vej tilbage
-- til koeberen. Sagen afgoeres altid FOER flaget fjernes (sag_afgoer).
create or replace function public.trades_beskyt_sagsfrys()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce(old.sag_aaben, false)
     and not coalesce(new.sag_aaben, false)
     and new.status <> 'annulleret'
     and exists (select 1 from public.sager s
                  where s.trade_id = new.id
                    and s.status in ('aaben', 'afventer_retur')) then
    raise exception 'Handlen har en åben sag fra køberen. Afgør sagen først.'
      using errcode = 'BHS01';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.trades_beskyt_sagsfrys() from public, anon, authenticated;

drop trigger if exists trades_beskyt_sagsfrys on public.trades;
create trigger trades_beskyt_sagsfrys
  before update on public.trades
  for each row execute function public.trades_beskyt_sagsfrys();

-- ============================================================ Storage

-- Privat bucket. 10 MB pr. billede; jpeg, png, heic/heif, webp.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sag-billeder', 'sag-billeder', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Maa den kaldende bruger uploade til stien? Kun koeberen, i sin egen mappe
-- (<eget id>/<handel-id>/...), paa en handel han er koeber paa, som er sendt
-- eller modtaget (sagen kan oprettes) eller har en aaben sag. Hoejst 30 filer
-- pr. handel (misbrugsvaern - en sag bruger hoejst 10).
create or replace function public.sag_billede_maa_uploade(p_sti text)
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
  if v_bruger is null or array_length(v_dele, 1) <> 3 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if v_dele[3] !~ '^[A-Za-z0-9._-]{1,100}$' then return false; end if;
  v_trade := v_dele[2]::uuid;

  if not exists (
    select 1 from public.trades t
     where t.id = v_trade
       and t.buyer_id = v_bruger
       and (t.status in ('pakke_sendt', 'modtaget')
            or exists (select 1 from public.sager s
                        where s.trade_id = t.id
                          and s.status in ('aaben', 'afventer_retur')))
  ) then
    return false;
  end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'sag-billeder'
             and o.name like v_bruger::text || '/' || v_trade::text || '/%') < 30;
end;
$fn$;

revoke all on function public.sag_billede_maa_uploade(text) from public, anon;
grant execute on function public.sag_billede_maa_uploade(text) to authenticated;

-- Maa den kaldende bruger laese filen? Uploaderen selv, staff, og saelgeren
-- paa handlen, naar billedet er knyttet til en sag.
create or replace function public.sag_billede_maa_laese(p_sti text)
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
         select 1 from public.sag_billeder b
           join public.sager s on s.id = b.sag_id
           join public.trades t on t.id = s.trade_id
          where b.sti = p_sti
            and (t.seller_id = auth.uid() or t.buyer_id = auth.uid()))
  );
$fn$;

revoke all on function public.sag_billede_maa_laese(text) from public, anon;
grant execute on function public.sag_billede_maa_laese(text) to authenticated;

drop policy if exists "sag_billeder_upload_koeber" on storage.objects;
create policy "sag_billeder_upload_koeber"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sag-billeder'
    and public.sag_billede_maa_uploade(name)
  );

drop policy if exists "sag_billeder_laes_parter" on storage.objects;
create policy "sag_billeder_laes_parter"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'sag-billeder'
    and public.sag_billede_maa_laese(name)
  );

-- Ingen update/delete-policies: bevis kan ikke overskrives eller slettes.
-- (Upload skal derfor ske med upsert: false.)

-- ============================================================ Hjaelper: billeder

-- Validerer en billedliste fra koeberen: [{ "sti": "...", "kategori": "..." }].
-- Hver sti skal ligge i koeberens mappe for handlen, findes i storage og ikke
-- vaere brugt foer. Returnerer null hvis ok, ellers en fejlkode.
create or replace function public.sag_valider_billeder(
  p_koeber uuid, p_trade uuid, p_billeder jsonb)
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
begin
  if p_billeder is null or jsonb_typeof(p_billeder) <> 'array' then
    return 'ugyldige_billeder';
  end if;
  if jsonb_array_length(p_billeder) > 10 then return 'for_mange_billeder'; end if;

  for e in select * from jsonb_array_elements(p_billeder) loop
    if jsonb_typeof(e) <> 'object' then return 'ugyldige_billeder'; end if;
    v_sti := e->>'sti';
    v_kat := e->>'kategori';
    if v_sti is null or v_kat is null
       or v_kat not in ('pakke', 'label', 'indhold', 'andet') then
      return 'ugyldige_billeder';
    end if;
    if split_part(v_sti, '/', 1) <> p_koeber::text
       or split_part(v_sti, '/', 2) <> p_trade::text
       or v_sti !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$' then
      return 'ugyldige_billeder';
    end if;
    if v_sti = any(v_stier) then return 'ugyldige_billeder'; end if;
    v_stier := v_stier || v_sti;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'sag-billeder' and o.name = v_sti) then
      return 'billede_mangler';
    end if;
    if exists (select 1 from public.sag_billeder b where b.sti = v_sti) then
      return 'ugyldige_billeder';
    end if;
  end loop;

  return null;
end;
$fn$;

revoke all on function public.sag_valider_billeder(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sag_valider_billeder(uuid, uuid, jsonb) to service_role;

-- ============================================================ Koeber: opret sag

-- Returnerer {"kode": "ok", "sag_id"} eller en fejlkode:
--   ikke_logget_ind, ikke_fundet (ogsaa hvis kalderen ikke er koeber), ugyldig_type, ugyldig_beskrivelse,
--   findes (der er allerede en sag paa handlen), ikke_betalt (betalingen er
--   ikke betalt, er frigivet/overfoert eller under refusion), kraever_beskyttelse,
--   for_sent (48 timer er gaaet), for_tidligt (pakken er sendt for under 7 dage
--   siden), forkert_trin (handlen er ikke i et trin, hvor typen kan oprettes),
--   billeder_kraeves (mindst et af hver: pakke, label, indhold),
--   ugyldige_billeder, billede_mangler, for_mange_billeder.
create or replace function public.sag_opret(
  p_trade       uuid,
  p_type        text,
  p_beskrivelse text,
  p_billeder    jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger   uuid := auth.uid();
  v_beskr    text := btrim(coalesce(p_beskrivelse, ''));
  v_billeder jsonb := coalesce(p_billeder, '[]'::jsonb);
  b          record;
  t          record;
  v_sendt    timestamptz;
  v_fejl     text;
  v_sag      uuid;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if p_type is null or p_type not in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if char_length(v_beskr) not between 10 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;

  -- Ikke koeberen: samme svar som en ukendt handel (afsloerer intet). Tjekkes
  -- foer laasene, saa uvedkommende ikke kan laase fremmede raekker.
  if not exists (select 1 from public.trades
                  where id = p_trade and buyer_id = v_bruger) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laaseraekkefoelge som betaling_claim_overfoersel: betaling, derefter handel.
  select * into b from public.betalinger where trade_id = p_trade for update;
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or t.buyer_id <> v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if exists (select 1 from public.sager s where s.trade_id = p_trade) then
    return jsonb_build_object('kode', 'findes');
  end if;

  if b.id is null
     or b.status <> 'betalt'
     or b.frigivet_kl is not null
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null then
    return jsonb_build_object('kode', 'ikke_betalt');
  end if;

  if p_type in ('skadet', 'ikke_som_beskrevet') and not b.beskyttelse then
    return jsonb_build_object('kode', 'kraever_beskyttelse');
  end if;

  -- Trin og frister.
  if t.status = 'modtaget' then
    if p_type = 'bortkommet' then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    if t.received_at is null or t.received_at < now() - interval '48 hours' then
      return jsonb_build_object('kode', 'for_sent');
    end if;
  elsif t.status = 'pakke_sendt' then
    if p_type not in ('bortkommet', 'svindel') then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    v_sendt := coalesce(t.sendt_kl, b.betalt_kl);
    if v_sendt is null or v_sendt > now() - interval '7 days' then
      return jsonb_build_object('kode', 'for_tidligt');
    end if;
  else
    return jsonb_build_object('kode', 'forkert_trin');
  end if;

  -- Billeder: valideres altid; kraeves naar pakken er modtaget.
  v_fejl := public.sag_valider_billeder(v_bruger, p_trade, v_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  if t.status = 'modtaget' and not (
       exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'pakke')
   and exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'label')
   and exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'indhold')) then
    return jsonb_build_object('kode', 'billeder_kraeves');
  end if;

  begin
    insert into public.sager (trade_id, oprettet_af, type, beskrivelse, beskyttelse,
                              handel_status_ved_oprettelse)
    values (p_trade, v_bruger, p_type, v_beskr, b.beskyttelse, t.status)
    returning id into v_sag;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  insert into public.sag_billeder (sag_id, sti, kategori)
  select v_sag, e->>'sti', e->>'kategori'
    from jsonb_array_elements(v_billeder) e;

  -- Frys pengene. sag_note/sag_aabnet_* er de eksisterende admin-felter.
  update public.trades
     set sag_aaben = true,
         sag_note = 'Sag fra køberen: ' || case p_type
                      when 'bortkommet' then 'pakken er ikke kommet frem'
                      when 'skadet' then 'varen er skadet'
                      when 'ikke_som_beskrevet' then 'varen er ikke som beskrevet'
                      else 'svindel' end,
         sag_aabnet_af = v_bruger,
         sag_aabnet_at = now()
   where id = p_trade;

  return jsonb_build_object('kode', 'ok', 'sag_id', v_sag);
end;
$fn$;

revoke all on function public.sag_opret(uuid, text, text, jsonb) from public, anon;
grant execute on function public.sag_opret(uuid, text, text, jsonb) to authenticated;

-- Koeberen tilfoejer flere billeder til sin aabne sag (hoejst 10 i alt).
-- Returnerer {"kode": "ok"} eller ikke_logget_ind, ikke_fundet, lukket,
-- ugyldige_billeder, billede_mangler, for_mange_billeder.
create or replace function public.sag_tilfoej_billeder(p_sag uuid, p_billeder jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid := auth.uid();
  s        record;
  v_fejl   text;
  v_antal  integer;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;

  select * into s from public.sager where id = p_sag for update;
  if not found or s.oprettet_af <> v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.status not in ('aaben', 'afventer_retur') then
    return jsonb_build_object('kode', 'lukket');
  end if;
  if p_billeder is null or jsonb_typeof(p_billeder) <> 'array'
     or jsonb_array_length(p_billeder) = 0 then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;

  select count(*) into v_antal from public.sag_billeder where sag_id = s.id;
  if v_antal + jsonb_array_length(p_billeder) > 10 then
    return jsonb_build_object('kode', 'for_mange_billeder');
  end if;

  v_fejl := public.sag_valider_billeder(v_bruger, s.trade_id, p_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  insert into public.sag_billeder (sag_id, sti, kategori)
  select s.id, e->>'sti', e->>'kategori'
    from jsonb_array_elements(p_billeder) e;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.sag_tilfoej_billeder(uuid, jsonb) from public, anon;
grant execute on function public.sag_tilfoej_billeder(uuid, jsonb) to authenticated;

-- ============================================================ Intern: refusion

-- Claimer en sagsrefusion paa betalingen (alt undtagen BidHamr Beskyttelse).
-- Kaldes kun inde fra sag_afgoer/sag_retur_afleveret, som allerede holder
-- betalingsraekkens laas (samme laas som betaling_claim_overfoersel).
-- Returnerer refusionsbeloebet i oere, eller null + fejlkode i p_fejl via
-- exception-fri returnering: 'indsigelse' | 'ikke_mulig'.
create or replace function public.sag_claim_refusion(p_betaling uuid, out beloeb bigint, out fejl text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then
    fejl := 'ikke_mulig';
    return;
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    fejl := 'indsigelse';
    return;
  end if;
  if b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null then
    fejl := 'ikke_mulig';
    return;
  end if;

  beloeb := b.total_oere - coalesce(b.beskyttelse_oere, 0);
  if beloeb <= 0 or beloeb > b.total_oere then
    beloeb := null;
    fejl := 'ikke_mulig';
    return;
  end if;

  update public.betalinger
     set refusion_anmodet_kl = now(),
         refusion_aarsag = 'sag',
         refusion_oere = beloeb,
         opdateret = now()
   where id = b.id;
end;
$fn$;

revoke all on function public.sag_claim_refusion(uuid) from public, anon, authenticated;
grant execute on function public.sag_claim_refusion(uuid) to service_role;

-- ============================================================ moderation_log

-- Bevarer ALLE vaerdier fra 20261003000000_staff_chat.sql.
alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest',
    'chat_aabnet','chat_lukket','faellesbesked',
    'sag_afgjort_koeber','sag_afgjort_saelger','sag_retur_afleveret',
    'sag_genaabnet','konto_lukket'));

alter table public.moderation_log
  drop constraint if exists moderation_log_maal_type_check;

alter table public.moderation_log
  add constraint moderation_log_maal_type_check check (
    maal_type in ('auktion','anmeldelse','bruger','handel','samtale','sag'));

-- ============================================================ Staff: afgoer

-- p_udfald: 'koeber' | 'saelger' | 'lukket'.
-- Returnerer {"kode": "ok", "handling", "betaling_id"?, "trade_id", "buyer_id",
-- "seller_id", "auction_id", "type"} hvor handling er:
--   'refunder'     - refusionen er claimet; serveren kalder Stripe nu
--   'afvent_retur' - koeberen skal sende varen retur (BidHamr betaler fragten)
--   'frigiv'       - frigivet til saelger; serveren overfoerer nu
--   'frigiv_blokeret' - saelger fik medhold, men en indsigelse blokerer frigivelsen
--   'lukket'       - sagen er lukket uden at flytte penge
-- Fejlkoder: ingen_adgang, ugyldigt_udfald, begrundelse_mangler,
-- for_lang_tekst, ikke_fundet, forkert_status, indsigelse, ikke_mulig.
-- Logger i moderation_log (uden beloeb - medarbejdere kan se loggen).
create or replace function public.sag_afgoer(
  p_medarbejder uuid,
  p_sag         uuid,
  p_udfald      text,
  p_begrundelse text,
  p_intern_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grund  text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_note   text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_trade  uuid;
  s        record;
  t        record;
  b        record;
  r        record;
  v_handling text;
  v_log    text;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('koeber', 'saelger', 'lukket') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if s.status = 'aaben' then
    null;
  elsif s.status = 'afventer_retur' and p_udfald in ('saelger', 'lukket') then
    -- Fx koeberen sender aldrig varen retur.
    null;
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  if p_udfald = 'koeber' then
    if b.id is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;

    if s.type in ('svindel', 'bortkommet') then
      select * into r from public.sag_claim_refusion(b.id);
      if r.fejl is not null then return jsonb_build_object('kode', r.fejl); end if;

      update public.sager
         set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             refusion_oere = r.beloeb
       where id = s.id;

      -- Sagen er afgjort; handlen annulleres og frysningen fjernes.
      update public.trades
         set status = 'annulleret', sag_aaben = false
       where id = t.id
         and status in ('betaling_modtaget', 'pakke_sendt', 'modtaget', 'leveret', 'annulleret');

      v_handling := 'refunder';
      v_log := 'Medhold til køber - refusion straks (alt undtagen BidHamr Beskyttelse)';
    else
      -- Skadet / ikke som beskrevet: retur foer refusion. Tjek allerede nu, at
      -- en refusion vil vaere mulig (ingen indsigelse, intet overfoert).
      if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
        return jsonb_build_object('kode', 'indsigelse');
      end if;
      if b.status <> 'betalt'
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null then
        return jsonb_build_object('kode', 'ikke_mulig');
      end if;

      update public.sager
         set status = 'afventer_retur', retur_kraeves = true,
             returfragt_betaler = 'bidhamr',
             afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note)
       where id = s.id;
      -- trades.sag_aaben forbliver true: pengene er stadig frosset.

      v_handling := 'afvent_retur';
      v_log := 'Medhold til køber - varen sendes retur (BidHamr betaler returfragten), refusion når returpakken er afleveret';
    end if;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_koeber', 'sag', s.id, t.buyer_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  elsif p_udfald = 'saelger' then
    update public.sager
       set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null
     where id = s.id;

    update public.trades set sag_aaben = false where id = t.id;

    -- Frigiv straks (som admin_frigiv_handel), medmindre noget blokerer.
    if b.id is not null
       and b.status = 'betalt'
       and b.refusion_anmodet_kl is null
       and not public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
       and t.status in ('pakke_sendt', 'modtaget') then
      update public.trades
         set status = 'leveret', received_at = coalesce(received_at, now())
       where id = t.id;
      update public.betalinger
         set frigivet_kl = coalesce(frigivet_kl, now()), opdateret = now()
       where id = b.id;
      v_handling := 'frigiv';
      v_log := 'Medhold til sælger - pengene frigives';
    else
      v_handling := 'frigiv_blokeret';
      v_log := 'Medhold til sælger - frigivelse blokeret (indsigelse eller betaling ikke klar)';
    end if;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_saelger', 'sag', s.id, t.seller_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  else
    update public.sager
       set status = 'lukket', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null
     where id = s.id;

    update public.trades set sag_aaben = false where id = t.id;

    v_handling := 'lukket';
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', s.id, t.buyer_id,
            left('Sag lukket uden at flytte penge | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type);
end;
$fn$;

revoke all on function public.sag_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sag_afgoer(uuid, uuid, text, text, text) to service_role;

-- ============================================================ Staff: retur afleveret

-- Staff registrerer, at returpakken er afleveret (indtil GLS-sporingen er
-- bygget). Claimer refusionen og afgoer sagen til koeberen.
-- Returnerer {"kode": "ok", "betaling_id", ...} eller ingen_adgang,
-- ikke_fundet, forkert_status, indsigelse, ikke_mulig.
create or replace function public.sag_retur_afleveret(
  p_medarbejder uuid,
  p_sag         uuid,
  p_note        text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_trade uuid;
  s       record;
  t       record;
  b       record;
  r       record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(coalesce(v_note, '')) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if s.status <> 'afventer_retur' then
    return jsonb_build_object('kode', 'forkert_status');
  end if;
  if b.id is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;

  select * into r from public.sag_claim_refusion(b.id);
  if r.fejl is not null then return jsonb_build_object('kode', r.fejl); end if;

  update public.sager
     set status = 'afgjort_koeber',
         retur_afleveret_kl = now(),
         retur_registreret_af = p_medarbejder,
         refusion_oere = r.beloeb,
         intern_note = case when v_note is null then intern_note
                            else left(coalesce(intern_note || chr(10), '') || 'Retur: ' || v_note, 4000) end
   where id = s.id;

  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = t.id
     and status in ('betaling_modtaget', 'pakke_sendt', 'modtaget', 'leveret', 'annulleret');

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_retur_afleveret', 'sag', s.id, t.buyer_id,
          left('Returpakken er afleveret - refusion til køber (alt undtagen BidHamr Beskyttelse)'
               || coalesce(' | ' || v_note, ''), 4000));

  return jsonb_build_object(
    'kode', 'ok', 'handling', 'refunder', 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type);
end;
$fn$;

revoke all on function public.sag_retur_afleveret(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sag_retur_afleveret(uuid, uuid, text) to service_role;

-- ============================================================ Admin: genaabn

-- Admin/chef genaabner en afgjort eller lukket sag (anke er ikke bygget endnu).
-- Kun naar ingen penge er flyttet: ingen refusion, intet overfoert/paabegyndt,
-- og handlen er ikke annulleret. Pengene fryses igen (trades.sag_aaben).
-- Returnerer {"kode": "ok", ...} eller ingen_adgang, begrundelse_mangler,
-- ikke_fundet, forkert_status, penge_flyttet, findes (en anden aaben sag).
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

  if s.status not in ('afgjort_saelger', 'lukket') then
    return jsonb_build_object('kode', 'forkert_status');
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
          left('Sag genåbnet (tidligere status: ' || s.status || ') | ' || v_grund, 4000));

  return jsonb_build_object(
    'kode', 'ok', 'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type);
end;
$fn$;

revoke all on function public.sag_genaabn(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sag_genaabn(uuid, uuid, text) to service_role;

-- ============================================================ Konto lukket permanent

alter table public.users
  add column if not exists konto_lukket_kl timestamptz,
  add column if not exists konto_lukket_af uuid references public.users(id) on delete restrict;

comment on column public.users.konto_lukket_kl is
  'Kontoen er lukket permanent (fx svindel). Suspensionen kan ikke ophaeves, '
  'saa laenge feltet er sat. Ses ikke af brugere (kolonne-grants).';

-- Kolonnerne er ikke i grant-listen fra 20260930100000, saa anon/authenticated
-- kan ikke laese dem. Kun service_role/postgres maa saette dem, og en lukket
-- konto kan ikke faa suspensionen ophaevet eller tidsbegraenset - heller ikke
-- af service_role. (Genaabning kraever en bevidst SQL-aendring af
-- konto_lukket_kl foerst.)
create or replace function public.users_beskyt_lukket_konto()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if (new.konto_lukket_kl is distinct from old.konto_lukket_kl
      or new.konto_lukket_af is distinct from old.konto_lukket_af)
     and not (coalesce(auth.role(), '') = 'service_role'
              or current_user in ('postgres', 'supabase_admin', 'service_role')) then
    raise exception 'Du må ikke ændre denne oplysning.' using errcode = '42501';
  end if;

  if new.konto_lukket_kl is not null
     and old.konto_lukket_kl is not null
     and (not coalesce(new.suspenderet, false) or new.suspenderet_til is not null) then
    raise exception 'Kontoen er lukket permanent og kan ikke åbnes igen.'
      using errcode = 'BHK01';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.users_beskyt_lukket_konto() from public, anon, authenticated;

drop trigger if exists users_beskyt_lukket_konto on public.users;
create trigger users_beskyt_lukket_konto
  before update on public.users
  for each row execute function public.users_beskyt_lukket_konto();

-- Admin/chef lukker en konto permanent (suspenderet uden slutdato + aarsag).
-- p_sag er valgfri (logges). Returnerer {"kode": "ok"|"allerede_lukket"} eller
-- ingen_adgang, aarsag_mangler, ugyldig_bruger, sig_selv, staff (staff-konti
-- lukkes ikke herfra).
create or replace function public.bruger_luk_konto_permanent(
  p_medarbejder uuid,
  p_bruger      uuid,
  p_aarsag      text,
  p_sag         uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_aarsag text := nullif(btrim(coalesce(p_aarsag, '')), '');
  u        record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_aarsag is null then return jsonb_build_object('kode', 'aarsag_mangler'); end if;
  if char_length(v_aarsag) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_medarbejder then return jsonb_build_object('kode', 'sig_selv'); end if;

  select * into u from public.users where id = p_bruger for update;
  if not found then return jsonb_build_object('kode', 'ugyldig_bruger'); end if;
  if u.rolle in ('medarbejder', 'admin', 'chef') then
    return jsonb_build_object('kode', 'staff');
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'allerede_lukket');
  end if;
  if p_sag is not null and not exists (
    select 1 from public.sager s join public.trades t on t.id = s.trade_id
     where s.id = p_sag and (t.buyer_id = p_bruger or t.seller_id = p_bruger)) then
    return jsonb_build_object('kode', 'ugyldig_sag');
  end if;

  update public.users
     set suspenderet = true,
         suspenderet_aarsag = v_aarsag,
         suspenderet_kl = now(),
         suspenderet_til = null,
         konto_lukket_kl = now(),
         konto_lukket_af = p_medarbejder
   where id = p_bruger;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'konto_lukket', 'bruger', p_bruger, p_bruger,
          left('Konto lukket permanent' || coalesce(' (sag ' || p_sag::text || ')', '')
               || ' | ' || v_aarsag, 4000));

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)
  to service_role;

-- ============================================================ Staff-badge

-- Antal sager, der venter paa en afgoerelse (status 'aaben'). Kun staff faar
-- et tal; andre faar 0.
create or replace function public.antal_aabne_sager()
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select case when not public.er_staff() then 0 else (
    select count(*)::integer from public.sager where status = 'aaben'
  ) end;
$fn$;

revoke all on function public.antal_aabne_sager() from public, anon;
grant execute on function public.antal_aabne_sager() to authenticated;
