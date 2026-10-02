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
--       timer (tom pakke, anden vare, falsk kopi - billeder kraeves), eller
--       'pakke_sendt' i mindst 7 dage (varen er aldrig sendt / sporingen er
--       falsk - behandles som "aldrig modtaget": ingen billeder, men
--       sager.tjek_sporing saettes, saa staff tjekker sporingen hos GLS).
--   Paa 'pakke_sendt' kan sagen oprettes fra dag 7, indtil pengene frigives
--       automatisk (dag 14, handel_auto_frigiv).
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
-- Afgoerelse (service_role, staff-rolle tjekkes igen her). Medarbejder, admin
-- og chef maa afgoere. ANKEFRIST: pengene flyttes foerst 4 dage efter
-- afgoerelsen (sager.penge_flyttes_efter_kl). Indtil da er sagen afgjort, men
-- pengene stadig frosset (trades.sag_aaben = true), og admin kan genaabne
-- sagen, hvilket annullerer den planlagte flytning. Cron
-- (sag_afvikl_forfaldne -> sag_afvikl) flytter pengene, naar fristen er udloebet:
--   koeber + svindel/bortkommet       -> refusion efter fristen
--   koeber + skadet/ikke_som_beskrevet -> 'afventer_retur'; refusion naar BAADE
--                                        fristen er udloebet OG staff har
--                                        registreret, at returpakken er afleveret
--   saelger                           -> frigivelse efter fristen (frigivet_kl)
--   lukket                            -> ingen penge flyttes; frysningen fjernes
--                                        efter fristen, og handlen fortsaetter
--   Refusionsbeloeb = total_oere - beskyttelse_oere (alt undtagen BidHamr
--   Beskyttelse). Aldrig mere end betalt, een refusion pr. betaling.
--   Returfragt betales af BidHamr (registreres; label kommer med GLS).
--
-- Automatisk frigivelse (cron, handel_auto_frigiv): 48 timer efter "modtaget"
-- uden sag, eller 14 dage efter afsendelse, hvis koeberen hverken har trykket
-- "modtaget" eller oprettet en sag. Respekterer frysning, indsigelse og refusion.
--
-- Refusion fra admin (betaling_paabegynd_refusion) afvises, mens en sag holder
-- pengene - sagen skal afgoeres. En refusion, der alligevel sker hos Stripe
-- (charge.refunded, fx fra Stripe Dashboard), afslutter sagen automatisk
-- (betaling_registrer_refunderet).
--
-- Suspenderede brugere kan ikke oprette auktioner eller skrive beskeder i
-- handelschatten (trigger, errcode BHS02). Bud afvises allerede i place_bid.
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
  -- Ankefrist. Hvad der skal ske med pengene efter afgoerelsen
  -- ('refunder' | 'frigiv' | 'ingen'), og hvornaar tidligst (afgjort + 4 dage).
  -- afviklet_kl: pengene er flyttet (refusion claimet / frigivet), eller
  -- frysningen er fjernet ('ingen'). penge_fejl: hvorfor cron ikke kunne
  -- flytte pengene (kun staff), fx 'indsigelse'.
  penge_handling       text,
  penge_flyttes_efter_kl timestamptz,
  afviklet_kl          timestamptz,
  penge_fejl           text,
  -- Sagen er oprettet, foer koeberen trykkede "modtaget" (bortkommet / aldrig
  -- sendt). Staff skal tjekke sporingen hos GLS foer afgoerelsen.
  tjek_sporing         boolean not null default false,
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
    or (afgjort_af is not null and afgjort_kl is not null and begrundelse is not null)),
  constraint sager_penge_handling_check check (
    penge_handling is null or penge_handling in ('refunder', 'frigiv', 'ingen')),
  constraint sager_penge_par check (
    (penge_handling is null) = (penge_flyttes_efter_kl is null)),
  constraint sager_penge_fejl_laengde check (
    penge_fejl is null or char_length(penge_fejl) <= 100)
);

-- Samme kolonner for et miljoe, hvor en tidligere udgave af tabellen findes.
alter table public.sager
  add column if not exists penge_handling         text,
  add column if not exists penge_flyttes_efter_kl timestamptz,
  add column if not exists afviklet_kl            timestamptz,
  add column if not exists penge_fejl             text,
  add column if not exists tjek_sporing           boolean not null default false;

do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'sager_penge_handling_check'
                    and conrelid = 'public.sager'::regclass) then
    alter table public.sager add constraint sager_penge_handling_check check (
      penge_handling is null or penge_handling in ('refunder', 'frigiv', 'ingen'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'sager_penge_par'
                    and conrelid = 'public.sager'::regclass) then
    alter table public.sager add constraint sager_penge_par check (
      (penge_handling is null) = (penge_flyttes_efter_kl is null));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'sager_penge_fejl_laengde'
                    and conrelid = 'public.sager'::regclass) then
    alter table public.sager add constraint sager_penge_fejl_laengde check (
      penge_fejl is null or char_length(penge_fejl) <= 100);
  end if;
end;
$do$;

comment on table public.sager is
  'Sager oprettet af koeberen paa en handel (bortkommet, skadet, ikke som '
  'beskrevet, svindel). Fryser pengene via trades.sag_aaben. Slettes aldrig.';

-- Een aaben sag pr. handel.
create unique index if not exists sager_en_aaben_pr_handel
  on public.sager (trade_id) where status in ('aaben', 'afventer_retur');
create index if not exists sager_trade_idx on public.sager (trade_id);
create index if not exists sager_status_idx on public.sager (status, oprettet_kl desc);
create index if not exists sager_oprettet_af_idx on public.sager (oprettet_af);
-- Cron: afgjorte sager, hvor pengene venter paa ankefristen.
create index if not exists sager_penge_venter_idx
  on public.sager (penge_flyttes_efter_kl)
  where penge_handling is not null and afviklet_kl is null;

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
-- Ikke afgjort_af, intern_note, retur_registreret_af, refusion_oere,
-- penge_fejl eller tjek_sporing (staff). Heller ikke beskyttelse: saelgeren
-- maa ikke se, om koeberen har koebt BidHamr Beskyttelse - koeberen faar den
-- via serveren (hentSagForHandel) eller fra sin egen betaling.
grant select (id, trade_id, type, beskrivelse, status, oprettet_kl,
              afgjort_kl, begrundelse, retur_kraeves, returfragt_betaler,
              retur_afleveret_kl, genaabnet_kl,
              penge_handling, penge_flyttes_efter_kl, afviklet_kl)
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
  or new.tjek_sporing                 is distinct from old.tjek_sporing
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

-- Holder en sag fra koeberen pengene? Ja, mens sagen er aaben/afventer retur,
-- og mens en afgoerelse venter paa ankefristen (penge_handling sat, men ikke
-- afviklet). Intern hjaelper for security definer-funktionerne.
create or replace function public.sag_holder_pengene(p_trade uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.sager s
     where s.trade_id = p_trade
       and (s.status in ('aaben', 'afventer_retur')
            or (s.penge_handling is not null and s.afviklet_kl is null)));
$fn$;

revoke all on function public.sag_holder_pengene(uuid) from public, anon, authenticated;
grant execute on function public.sag_holder_pengene(uuid) to service_role;

-- Mens en sag fra koeberen holder pengene (aaben, afventer retur eller
-- afgjort med ankefrist, der ikke er afviklet), kan trades.sag_aaben ikke
-- fjernes - uanset hvem der proever (admin_frigiv_handel, "Luk sag" i admin,
-- service_role). Undtagelse: handlen annulleres (refusion), saa er pengene paa
-- vej tilbage til koeberen. sag_afvikl saetter afviklet_kl FOER flaget fjernes.
-- (Betingelsen staar direkte her og ikke via sag_holder_pengene, fordi
-- triggeren koerer som den kaldende rolle.)
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
                    and (s.status in ('aaben', 'afventer_retur')
                         or (s.penge_handling is not null and s.afviklet_kl is null))) then
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
    -- Paa 'pakke_sendt' (bortkommet, eller svindel = "aldrig sendt / falsk
    -- sporing") kraeves ingen billeder; i stedet skal staff tjekke sporingen
    -- hos GLS foer afgoerelsen (tjek_sporing).
    insert into public.sager (trade_id, oprettet_af, type, beskrivelse, beskyttelse,
                              handel_status_ved_oprettelse, tjek_sporing)
    values (p_trade, v_bruger, p_type, v_beskr, b.beskyttelse, t.status,
            t.status = 'pakke_sendt')
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
-- Kaldes kun inde fra sag_afvikl (efter ankefristen), som allerede holder
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
    'sag_genaabnet','konto_lukket','sag_afviklet'));

alter table public.moderation_log
  drop constraint if exists moderation_log_maal_type_check;

alter table public.moderation_log
  add constraint moderation_log_maal_type_check check (
    maal_type in ('auktion','anmeldelse','bruger','handel','samtale','sag'));

-- ============================================================ Staff: afgoer

-- p_udfald: 'koeber' | 'saelger' | 'lukket'.
-- ANKEFRIST: ingen penge flyttes her. Afgoerelsen planlaegges til
-- penge_flyttes_efter_kl = nu + 4 dage; sag_afvikl (cron) flytter pengene
-- derefter. trades.sag_aaben forbliver true (frosset) imens, og admin kan
-- genaabne sagen (sag_genaabn), hvilket annullerer den planlagte flytning.
--
-- Returnerer {"kode": "ok", "handling", "penge_flyttes_efter_kl",
-- "advarsel"?, "betaling_id"?, "trade_id", "buyer_id", "seller_id",
-- "auction_id", "type", "version"} hvor handling er:
--   'planlagt_refusion'   - koeberen refunderes efter fristen (svindel/bortkommet,
--                           eller skadet/ikke som beskrevet, hvor returpakken
--                           allerede er registreret som afleveret)
--   'afvent_retur'        - koeberen skal sende varen retur (BidHamr betaler
--                           fragten); refusion naar retur er afleveret OG
--                           fristen er udloebet
--   'planlagt_frigivelse' - saelgeren faar pengene efter fristen
--   'lukket'              - ingen penge flyttes; frysningen fjernes efter fristen
-- advarsel (kun saelger): 'indsigelse' | 'refusion' | 'ikke_betalt' |
--   'ingen_betaling' - frigivelsen vil vaere blokeret, hvis det stadig gaelder
--   naar fristen udloeber (staff skal foelge op).
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
  v_grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_note     text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_frist    timestamptz := now() + interval '4 days';
  v_trade    uuid;
  s          record;
  t          record;
  b          record;
  v_handling text;
  v_advarsel text;
  v_log      text;
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
    -- Tjek allerede nu, at en refusion vil vaere mulig (ingen indsigelse,
    -- intet overfoert). sag_afvikl tjekker igen, naar fristen er udloebet.
    if b.id is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;
    if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
      return jsonb_build_object('kode', 'indsigelse');
    end if;
    if b.status <> 'betalt'
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null then
      return jsonb_build_object('kode', 'ikke_mulig');
    end if;

    if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
      -- Svindel/bortkommet refunderes uden retur. (Er returpakken allerede
      -- registreret - sagen er genaabnet efter retur - venter vi ikke igen.)
      update public.sager
         set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             retur_kraeves = (s.retur_afleveret_kl is not null),
             returfragt_betaler = case when s.retur_afleveret_kl is not null
                                       then 'bidhamr' end,
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'planlagt_refusion';
      v_log := 'Medhold til køber - refusion (alt undtagen BidHamr Beskyttelse) efter ankefristen på 4 dage';
    else
      -- Skadet / ikke som beskrevet: retur foer refusion.
      update public.sager
         set status = 'afventer_retur', retur_kraeves = true,
             returfragt_betaler = 'bidhamr',
             afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'afvent_retur';
      v_log := 'Medhold til køber - varen sendes retur (BidHamr betaler returfragten), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';
    end if;
    -- trades.sag_aaben forbliver true: pengene er frosset til sag_afvikl.

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_koeber', 'sag', s.id, t.buyer_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  elsif p_udfald = 'saelger' then
    update public.sager
       set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'frigiv', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    -- Vil frigivelsen vaere blokeret? (samme regler som sag_afvikl)
    v_advarsel := case
      when b.id is null then 'ingen_betaling'
      when public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then 'indsigelse'
      when b.status = 'refunderet' or b.refusion_anmodet_kl is not null then 'refusion'
      when b.status <> 'betalt' then 'ikke_betalt'
      else null end;

    v_handling := 'planlagt_frigivelse';
    v_log := 'Medhold til sælger - pengene frigives efter ankefristen på 4 dage'
             || coalesce(' (OBS: frigivelsen er blokeret lige nu: ' || v_advarsel || ')', '');

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_saelger', 'sag', s.id, t.seller_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  else
    update public.sager
       set status = 'lukket', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'ingen', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    v_handling := 'lukket';
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', s.id, t.buyer_id,
            left('Sag lukket uden at flytte penge - frysningen fjernes efter ankefristen på 4 dage | Til parterne: '
                 || v_grund || coalesce(' | Intern note: ' || v_note, ''), 4000));
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'penge_flyttes_efter_kl', v_frist,
    'advarsel', v_advarsel, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sag_afgoer(uuid, uuid, text, text, text) to service_role;

-- ============================================================ Intern: afvikl

-- Flytter pengene for EN afgjort sag, naar ankefristen er udloebet. Intern:
-- kaldes af sag_afvikl_forfaldne (cron) og sag_retur_afleveret - aldrig af
-- browseren. Idempotent: afviklet_kl saettes i samme transaktion, og alle
-- raekker laases (betaling, handel, sag - samme raekkefoelge som overalt).
--
-- Returnerer {"kode", "handling", "grund"?, "sag_id", "betaling_id",
-- "trade_id", "buyer_id", "seller_id", "auction_id", "type", "version"}:
--   ok           - gennemfoert. handling 'refunder': refusionen er claimet
--                  (serveren kalder Stripe nu). 'frigiv': frigivet_kl er sat
--                  (serveren overfoerer nu). 'ingen': frysningen er fjernet.
--   venter       - fristen er ikke udloebet
--   venter_retur - returpakken er ikke registreret som afleveret endnu
--   blokeret     - grund: indsigelse | ikke_mulig | refusion | ikke_betalt |
--                  ingen_betaling | handel_status. Betalingen markeres til
--                  admin (een gang pr. grund); cron proever igen.
--   intet        - intet at flytte (afviklet, genaabnet eller ingen handling)
create or replace function public.sag_afvikl(p_sag uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_trade uuid;
  s       record;
  t       record;
  b       record;
  r       record;
  v_grund text;
  v_res   jsonb;
begin
  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  v_res := jsonb_build_object(
    'sag_id', s.id, 'betaling_id', b.id, 'trade_id', t.id,
    'buyer_id', t.buyer_id, 'seller_id', t.seller_id, 'auction_id', t.auction_id,
    'type', s.type, 'version', s.genaabnet_antal, 'handling', s.penge_handling);

  if s.penge_handling is null or s.afviklet_kl is not null
     or s.status not in ('afventer_retur', 'afgjort_koeber', 'afgjort_saelger', 'lukket') then
    return v_res || jsonb_build_object('kode', 'intet');
  end if;
  if s.penge_flyttes_efter_kl > now() then
    return v_res || jsonb_build_object('kode', 'venter');
  end if;

  if s.penge_handling = 'refunder' then
    if s.status <> 'afgjort_koeber' then
      return v_res || jsonb_build_object('kode', 'venter_retur');
    end if;
    if b.id is null then
      v_grund := 'ingen_betaling';
    else
      select * into r from public.sag_claim_refusion(b.id);
      v_grund := r.fejl;
    end if;
    if v_grund is null then
      update public.sager
         set refusion_oere = r.beloeb, afviklet_kl = now(), penge_fejl = null
       where id = s.id;
      -- Sagen er afviklet; handlen annulleres og frysningen fjernes.
      update public.trades
         set status = 'annulleret', sag_aaben = false
       where id = t.id
         and status in ('betaling_modtaget', 'pakke_sendt', 'modtaget', 'leveret', 'annulleret');
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (public.bidhamr_system_id(), 'sag_afviklet', 'sag', s.id, t.buyer_id,
              'Ankefristen er udløbet - refusion til køber sendt til Stripe (alt undtagen BidHamr Beskyttelse)');
      return v_res || jsonb_build_object('kode', 'ok');
    end if;

  elsif s.penge_handling = 'frigiv' then
    v_grund := case
      when b.id is null then 'ingen_betaling'
      when public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then 'indsigelse'
      when b.status = 'refunderet' or b.refusion_anmodet_kl is not null then 'refusion'
      when b.status <> 'betalt' then 'ikke_betalt'
      -- Allerede frigivet (fx sagen genaabnet efter frigivelse): ok - der
      -- overfoeres blot (L3).
      when b.frigivet_kl is null and t.status not in ('pakke_sendt', 'modtaget', 'leveret')
        then 'handel_status'
      else null end;
    if v_grund is null then
      update public.sager set afviklet_kl = now(), penge_fejl = null where id = s.id;
      update public.trades
         set status = case when status in ('pakke_sendt', 'modtaget') then 'leveret' else status end,
             received_at = coalesce(received_at, now()),
             sag_aaben = false
       where id = t.id;
      update public.betalinger
         set frigivet_kl = coalesce(frigivet_kl, now()), opdateret = now()
       where id = b.id;
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (public.bidhamr_system_id(), 'sag_afviklet', 'sag', s.id, t.seller_id,
              'Ankefristen er udløbet - pengene er frigivet til sælger');
      return v_res || jsonb_build_object('kode', 'ok');
    end if;

  else
    -- 'ingen' (lukket): frysningen fjernes; handlen fortsaetter normalt.
    update public.sager set afviklet_kl = now(), penge_fejl = null where id = s.id;
    update public.trades set sag_aaben = false where id = t.id;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (public.bidhamr_system_id(), 'sag_afviklet', 'sag', s.id, t.buyer_id,
            'Ankefristen er udløbet - frysningen er fjernet, og handlen fortsætter');
    return v_res || jsonb_build_object('kode', 'ok');
  end if;

  -- Blokeret. Markeres til admin een gang pr. grund (ingen beloeb i teksten).
  if s.penge_fejl is distinct from v_grund then
    update public.sager set penge_fejl = v_grund where id = s.id;
    if b.id is not null then
      update public.betalinger
         set kraever_opmaerksomhed = true,
             sidste_fejl = left('Sagens afgørelse kan ikke gennemføres efter ankefristen ('
                                || v_grund || ') - se sagen', 500),
             opdateret = now()
       where id = b.id;
    end if;
  end if;
  return v_res || jsonb_build_object('kode', 'blokeret', 'grund', v_grund);
end;
$fn$;

revoke all on function public.sag_afvikl(uuid) from public, anon, authenticated;
grant execute on function public.sag_afvikl(uuid) to service_role;

-- Cron: afvikler alle sager, hvor ankefristen er udloebet. Hver sag i sin
-- egen undertransaktion, saa een fejl ikke stopper resten. Returnerer de
-- gennemfoerte (kode 'ok') som jsonb-array; serveren kalder derefter Stripe
-- (refusion/overfoersel) og sender beskeder. Blokerede proeves igen ved
-- naeste koersel (de nye foerst).
create or replace function public.sag_afvikl_forfaldne()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id  uuid;
  v_res jsonb;
  v_ud  jsonb := '[]'::jsonb;
begin
  for v_id in
    select id from public.sager
     where penge_handling is not null
       and afviklet_kl is null
       and penge_flyttes_efter_kl <= now()
       and status in ('afgjort_koeber', 'afgjort_saelger', 'lukket')
     order by (penge_fejl is not null), penge_flyttes_efter_kl
     limit 100
  loop
    begin
      v_res := public.sag_afvikl(v_id);
      if v_res->>'kode' = 'ok' then
        v_ud := v_ud || jsonb_build_array(v_res);
      end if;
    exception when others then
      raise warning 'sag_afvikl % fejlede: %', v_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.sag_afvikl_forfaldne() from public, anon, authenticated;
grant execute on function public.sag_afvikl_forfaldne() to service_role;

-- ============================================================ Staff: retur afleveret

-- Staff registrerer, at returpakken er afleveret (indtil GLS-sporingen er
-- bygget). Sagen afgoeres til koeberen. Refusionen sker, naar BAADE retur er
-- afleveret OG ankefristen er udloebet: er fristen allerede udloebet, afvikles
-- sagen straks (sag_afvikl), ellers tager cron den.
-- Returnerer {"kode": "ok", "handling", "grund"?, "penge_flyttes_efter_kl",
-- "betaling_id", ...} hvor handling er 'refunder' (claimet - serveren kalder
-- Stripe), 'planlagt_refusion' (venter paa fristen) eller 'refusion_blokeret'
-- (grund som i sag_afvikl). Fejlkoder: ingen_adgang, for_lang_tekst,
-- ikke_fundet, forkert_status.
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
  v_res   jsonb;
  v_handling text;
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

  if s.status <> 'afventer_retur' or s.penge_handling is distinct from 'refunder' then
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  update public.sager
     set status = 'afgjort_koeber',
         retur_afleveret_kl = now(),
         retur_registreret_af = p_medarbejder,
         intern_note = case when v_note is null then intern_note
                            else left(coalesce(intern_note || chr(10), '') || 'Retur: ' || v_note, 4000) end
   where id = s.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_retur_afleveret', 'sag', s.id, t.buyer_id,
          left('Returpakken er afleveret - refusion til køber (alt undtagen BidHamr Beskyttelse)'
               || case when s.penge_flyttes_efter_kl > now()
                       then ', når ankefristen er udløbet' else '' end
               || coalesce(' | ' || v_note, ''), 4000));

  if s.penge_flyttes_efter_kl <= now() then
    v_res := public.sag_afvikl(s.id);
    v_handling := case v_res->>'kode' when 'ok' then 'refunder' else 'refusion_blokeret' end;
  else
    v_handling := 'planlagt_refusion';
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'grund', v_res->>'grund',
    'penge_flyttes_efter_kl', s.penge_flyttes_efter_kl, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_retur_afleveret(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sag_retur_afleveret(uuid, uuid, text) to service_role;

-- ============================================================ Admin: genaabn

-- Admin/chef genaabner en afgjort eller lukket sag (anke-knappen er ikke
-- bygget endnu). Kun naar ingen penge er flyttet: ingen refusion, intet
-- overfoert/paabegyndt, og handlen er ikke annulleret. Inden for ankefristen
-- annulleres den planlagte refusion/frigivelse. Pengene fryses (igen).
-- Returnerer {"kode": "ok", "annulleret_planlagt", ...} eller ingen_adgang,
-- begrundelse_mangler, for_lang_tekst, ikke_fundet, forkert_status,
-- penge_flyttet, findes (en anden aaben sag).
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

  if s.status not in ('afventer_retur', 'afgjort_koeber', 'afgjort_saelger', 'lukket') then
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

-- ============================================================ Automatisk frigivelse

-- Cron. Frigiver pengene til saelgeren (samme sti som handel_godkend /
-- admin_frigiv_handel: trades.status 'leveret' + betalinger.frigivet_kl;
-- serveren overfoerer derefter med overfoerTilSaelger), naar:
--   (a) koeberen trykkede "modtaget" for over 48 timer siden, eller
--   (b) pakken blev sendt for over 14 dage siden (sendt_kl, ellers betalt_kl
--       for handler sendt foer sendt_kl fandtes), og koeberen hverken har
--       trykket "modtaget" eller oprettet en sag (indtil GLS-sporing).
-- Kun naar: betalt, ikke frigivet/refunderet/overfoert, ingen blokerende
-- indsigelse, ingen frysning (sag_aaben) og ingen sag, der holder pengene.
-- Idempotent: raekkerne laases og betingelserne tjekkes igen i samme
-- transaktion; frigivet_kl saettes kun, hvis det er tomt.
-- Returnerer jsonb-array: [{betaling_id, trade_id, buyer_id, seller_id,
-- auction_id, grund: '48_timer' | '14_dage'}].
create or replace function public.handel_auto_frigiv()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  k      record;
  b      record;
  t      record;
  v_grund text;
  v_ud   jsonb := '[]'::jsonb;
begin
  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.trades tr
      join public.betalinger bt on bt.trade_id = tr.id
     where bt.status = 'betalt'
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null
       and not coalesce(tr.sag_aaben, false)
       and ((tr.status = 'modtaget' and tr.received_at < now() - interval '48 hours')
            or (tr.status = 'pakke_sendt'
                and coalesce(tr.sendt_kl, bt.betalt_kl) < now() - interval '14 days'))
     order by tr.id
     limit 200
  loop
    -- Laaseraekkefoelge: betaling, handel. Alt tjekkes igen under laas.
    select * into b from public.betalinger where id = k.betaling_id for update;
    select * into t from public.trades where id = k.trade_id for update;

    if b.status <> 'betalt'
       or b.frigivet_kl is not null
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null
       or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
       or coalesce(t.sag_aaben, false)
       or public.sag_holder_pengene(t.id) then
      continue;
    end if;

    if t.status = 'modtaget' and t.received_at < now() - interval '48 hours' then
      v_grund := '48_timer';
    elsif t.status = 'pakke_sendt'
          and coalesce(t.sendt_kl, b.betalt_kl) < now() - interval '14 days' then
      v_grund := '14_dage';
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
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.handel_auto_frigiv() from public, anon, authenticated;
grant execute on function public.handel_auto_frigiv() to service_role;

-- ============================================================ Refusion og aabne sager

-- Admin-refusion (betaling_paabegynd_refusion) afvises, mens en sag fra
-- koeberen holder pengene: sagen skal afgoeres under Sager, saa refusionen
-- foelger afgoerelsen (delvis - alt undtagen BidHamr Beskyttelse), logges med
-- begrundelse og respekterer ankefristen. Det er det sikreste valg: en fuld
-- admin-refusion uden om sagen ville give koeberen mere end afgoerelsen og
-- efterlade sagen i en forkert tilstand.
-- Ellers uaendret fra 20261002042000.
create or replace function public.betaling_paabegynd_refusion(
  p_trade uuid, p_aarsag text)
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then return null; end if;

  if b.status <> 'betalt'
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or public.sag_holder_pengene(p_trade) then
    return null;
  end if;

  update public.betalinger
     set refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, p_aarsag),
         opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = p_trade
     and status in ('betaling_modtaget','pakke_sendt','modtaget','leveret','annulleret');

  return b.total_oere;
end;
$fn$;

revoke all on function public.betaling_paabegynd_refusion(uuid, text)
  from public, anon, authenticated;
grant execute on function public.betaling_paabegynd_refusion(uuid, text) to service_role;

-- charge.refunded (fuld refusion, eller sagens delvise refusion gennemfoert).
-- Som 20261001020000, men en sag, der stadig holder pengene, afsluttes
-- automatisk: en aaben sag lukkes ("Afsluttet ved refusion"), og en planlagt
-- afgoerelse markeres som afviklet - pengene er jo allerede refunderet. Saa
-- efterlades sagen aldrig aaben, og handlen kan annulleres (frys-triggeren
-- tillader annullering).
create or replace function public.betaling_registrer_refunderet(
  p_payment_intent text,
  p_refund         text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
  s record;
begin
  update public.betaling_afvigelser
     set refunderet_kl = coalesce(refunderet_kl, now()),
         stripe_refund_id = coalesce(p_refund, stripe_refund_id),
         sidste_fejl = null,
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
  if found then return 'afvigelse_refunderet'; end if;

  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then return 'ukendt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  update public.betalinger
     set status = 'refunderet',
         refunderet_kl = now(),
         stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, 'stripe'),
         kraever_opmaerksomhed = kraever_opmaerksomhed
                                 or stripe_transfer_id is not null
                                 or overfoersel_paabegyndt_kl is not null,
         sidste_fejl = case
           when stripe_transfer_id is not null or overfoersel_paabegyndt_kl is not null
             then 'Refunderet EFTER overfoersel til saelger - kontroller hos Stripe'
           else sidste_fejl end,
         opdateret = now()
   where id = b.id;

  -- Sager, der stadig holder pengene (laases efter betaling og handel).
  perform 1 from public.trades where id = b.trade_id for update;
  for s in
    select * from public.sager
     where trade_id = b.trade_id
       and (status in ('aaben', 'afventer_retur')
            or (penge_handling is not null and afviklet_kl is null))
     for update
  loop
    if s.status in ('aaben', 'afventer_retur') then
      update public.sager
         set status = 'lukket',
             afgjort_af = public.bidhamr_system_id(),
             afgjort_kl = now(),
             begrundelse = 'Afsluttet ved refusion',
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = null, penge_flyttes_efter_kl = null,
             afviklet_kl = now(), penge_fejl = null,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Afsluttet automatisk: betalingen er refunderet hos Stripe.', 4000)
       where id = s.id;
    else
      update public.sager
         set afviklet_kl = now(),
             penge_fejl = case when penge_handling = 'refunder' then null
                               else 'refunderet_hos_stripe' end,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Betalingen er refunderet hos Stripe, før ankefristen var udløbet.', 4000)
       where id = s.id;
    end if;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (public.bidhamr_system_id(), 'sag_lukket', 'sag', s.id, b.buyer_id,
            'Afsluttet ved refusion - betalingen er refunderet hos Stripe');
  end loop;

  if coalesce(b.refusion_aarsag, '') <> 'beloeb_afviger' then
    update public.trades
       set status = 'annulleret', sag_aaben = false
     where id = b.trade_id
       and status in ('afventer_betaling','betaling_modtaget','pakke_sendt','modtaget');
  end if;

  return 'refunderet';
end;
$fn$;

revoke all on function public.betaling_registrer_refunderet(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_refunderet(text, text) to service_role;

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

-- ============================================================ Suspension

-- En suspenderet bruger (suspenderet og suspenderet_til tom eller i
-- fremtiden - samme regel som login og place_bid) kan ikke oprette auktioner
-- eller skrive i handelschatten, heller ikke med en session, der var logget
-- ind foer suspensionen, eller direkte fra appen. Bud afvises allerede i
-- place_bid. Staff-chatten (svar til BidHamr) er bevidst ikke blokeret.
-- service_role og postgres (seed, migrationer) er undtaget.
-- TG_ARGV[0] = kolonnen med brugerens id (auctions.bruger_id, messages.sender_id).
create or replace function public.kraev_ikke_suspenderet()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null
     and current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  v_bruger := (to_jsonb(new) ->> tg_argv[0])::uuid;
  if exists (select 1 from public.users u
              where u.id = v_bruger
                and u.suspenderet
                and (u.suspenderet_til is null or u.suspenderet_til > now())) then
    raise exception 'Din konto er suspenderet.' using errcode = 'BHS02';
  end if;
  return new;
end;
$fn$;

revoke all on function public.kraev_ikke_suspenderet() from public, anon, authenticated;

drop trigger if exists auctions_kraev_ikke_suspenderet on public.auctions;
create trigger auctions_kraev_ikke_suspenderet
  before insert on public.auctions
  for each row execute function public.kraev_ikke_suspenderet('bruger_id');

drop trigger if exists messages_kraev_ikke_suspenderet on public.messages;
create trigger messages_kraev_ikke_suspenderet
  before insert on public.messages
  for each row execute function public.kraev_ikke_suspenderet('sender_id');
