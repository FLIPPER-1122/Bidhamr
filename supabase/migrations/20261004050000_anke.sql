-- Anke i sager (ROADMAP-BESLUTNINGER "Sager (Filip, 3. oktober 2026)":
-- "Ankefrist" og "Anke").
--
-- Regler:
--   - Den part, der TABER sagen, kan anke:
--       medhold til koeber (afgjort_koeber / afventer_retur, penge_handling
--         'refunder')                          -> saelgeren kan anke
--       medhold til saelger (afgjort_saelger, 'frigiv') -> koeberen kan anke
--     En lukket sag ('lukket', ingen penge flyttes) har ingen taber og kan
--     ikke ankes. Heller ikke sager lukket af systemet ("Afsluttet ved
--     refusion").
--   - Anke-knappen aabner 24 timer efter afgoerelsen (sager.afgjort_kl) og er
--     aaben indtil 4 dage efter afgoerelsen (= ankefristen,
--     sager.penge_flyttes_efter_kl). Een anke pr. sag - nogensinde.
--   - Saelgeren kan ikke anke, naar returpakken allerede er registreret som
--     afleveret: saa har han varen tilbage, og en omgoerelse ville give ham
--     baade varen og pengene.
--   - Begrundelse 20-2000 tegn. Ny dokumentation (billeder, hoejst 10) er
--     valgfri og uploades til bucket 'sag-billeder' i den ankende parts egen
--     mappe (<bruger-id>/<handel-id>/<fil>) - samme moenster som sagen.
--   - Mens anken behandles, flyttes pengene IKKE: sag_afvikl /
--     sag_afvikl_forfaldne springer sagen over (kode 'venter_anke'), og
--     sag_holder_pengene er fortsat sand (afviklet_kl er tom). Staff kan
--     hverken genaabne, afgoere igen eller registrere retur, mens anken venter.
--   - Behandles af admin/chef (sag_anke_afgoer, service_role), som IKKE er den
--     medarbejder, der afgjorde sagen, og ikke er part i handlen (inhabil).
--     Udfald:
--       stadfaest - afgoerelsen staar; pengene flyttes straks
--                   (penge_flyttes_efter_kl = nu). Venter sagen paa retur,
--                   refunderes koeberen, saa snart returpakken er registreret.
--       omgoer    - modsat udfald; pengene flyttes straks efter det nye udfald.
--                   Ingen ny ankefrist.
--     Afgoerelsen paa anken er endelig: ingen ny anke, og sagen kan ikke
--     genaabnes, naar den er anket.
--   - Alt logges i moderation_log (maal_type 'sag').
--
-- Koeres EFTER 20261004040000_oprydning.sql (handel_afsluttet_kl /
-- arkivering bruger sag_holder_pengene, som nu ogsaa er sand, mens en anke
-- venter).
--
-- Nye handlinger i moderation_log_handling_check (ALLE eksisterende vaerdier
-- fra 20261004040000_oprydning.sql er bevaret, inkl. 'rapport_behandlet'):
--   'sag_anke_indgivet', 'sag_anke_stadfaestet', 'sag_anke_omgjort'
--
-- Nye RPC'er:
--   sag_anke_mulighed(p_sag)                         authenticated (app/web)
--   sag_anke_indgiv(p_sag, p_begrundelse, p_billeder) authenticated (app/web)
--   sag_anke_afgoer(p_medarbejder, p_anke, p_udfald, p_begrundelse, p_intern_note)
--                                                     service_role (admin)
--   sag_anke_vurder(p_sag, p_bruger)                  intern (service_role)
--   sag_anke_valider_billeder(...)                    intern (service_role)
--
-- Genskrevet (praecise kopier af seneste definition + anke-tjek):
--   sag_holder_pengene    (20261003010000) - sand, mens en anke venter
--   trades_beskyt_sagsfrys (20261003010000) - ditto
--   sag_afgoer            (20261003013000) - 'anke_afventer'
--   sag_retur_afleveret   (20261003011000) - 'anke_afventer'
--   sag_genaabn           (20261003011000) - 'anket'
--   sag_afvikl            (20261003010000) - 'venter_anke'
--   sag_afvikl_forfaldne  (20261003010000) - springer ventende anker over
--   sag_billede_maa_uploade / sag_billede_maa_laese (20261003010000)
--   antal_aabne_sager     (20261003010000) - taeller ventende anker med
--
-- Anker og ankebilleder slettes aldrig (bogfoeringsloven/DAC7/bevis).
-- Idempotent: if not exists / create or replace / drop ... if exists.
-- Ingen eksisterende data aendres.

-- ============================================================ sag_anker

create table if not exists public.sag_anker (
  id                     uuid primary key default gen_random_uuid(),
  sag_id                 uuid not null references public.sager(id) on delete restrict,
  trade_id               uuid not null references public.trades(id) on delete restrict,
  indgivet_af            uuid not null references public.users(id) on delete restrict,
  -- Hvem ankede: 'koeber' | 'saelger'.
  part                   text not null,
  begrundelse            text not null,
  indgivet_kl            timestamptz not null default now(),
  -- Snapshot af den ankede afgoerelse (sagen kan aendres ved omgoerelse).
  ankede_status          text not null,
  ankede_afgjort_af      uuid not null references public.users(id) on delete restrict,
  ankede_afgjort_kl      timestamptz not null,
  ankede_begrundelse     text not null,
  -- Behandling.
  status                 text not null default 'afventer',
  behandlet_af           uuid references public.users(id) on delete restrict,
  behandlet_kl           timestamptz,
  -- Vises for koeber og saelger. intern_note kun staff.
  afgoerelse_begrundelse text,
  intern_note            text,
  -- Claim for "anke indgivet"-notifikationen (server/cron), saa den ogsaa
  -- sendes for anker indgivet direkte fra appen.
  notificeret_kl         timestamptz,
  opdateret              timestamptz not null default now(),
  constraint sag_anker_part_check check (part in ('koeber', 'saelger')),
  constraint sag_anker_status_check check (status in ('afventer', 'stadfaestet', 'omgjort')),
  constraint sag_anker_ankede_status_check check (
    ankede_status in ('afgjort_koeber', 'afventer_retur', 'afgjort_saelger')),
  constraint sag_anker_begrundelse_laengde check (
    char_length(btrim(begrundelse)) between 20 and 2000),
  constraint sag_anker_afgoerelse_laengde check (
    afgoerelse_begrundelse is null
    or char_length(btrim(afgoerelse_begrundelse)) between 1 and 2000),
  constraint sag_anker_intern_note_laengde check (
    intern_note is null or char_length(intern_note) <= 4000),
  constraint sag_anker_behandlet_par check (
    (status = 'afventer' and behandlet_af is null and behandlet_kl is null
       and afgoerelse_begrundelse is null)
    or (status <> 'afventer' and behandlet_af is not null and behandlet_kl is not null
       and afgoerelse_begrundelse is not null))
);

comment on table public.sag_anker is
  'Anke af en afgoerelse i en sag (een pr. sag). Indgives af den part, der tabte. '
  'Mens anken venter, flyttes pengene ikke. Afgoerelsen paa anken er endelig. Slettes aldrig.';

-- Een anke pr. sag, nogensinde.
create unique index if not exists sag_anker_en_pr_sag on public.sag_anker (sag_id);
create index if not exists sag_anker_trade_idx on public.sag_anker (trade_id);
create index if not exists sag_anker_venter_idx
  on public.sag_anker (indgivet_kl) where status = 'afventer';

alter table public.sag_anker enable row level security;

-- Koeber og saelger paa handlen kan laese anken. Staff bruger service_role.
drop policy if exists sag_anker_select_parter on public.sag_anker;
create policy sag_anker_select_parter on public.sag_anker
  for select to authenticated using (
    exists (select 1 from public.trades t
             where t.id = sag_anker.trade_id
               and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );

revoke all on public.sag_anker from anon, authenticated;
-- Ikke indgivet_af, ankede_afgjort_af, behandlet_af, intern_note eller
-- notificeret_kl (staff/intern).
grant select (id, sag_id, trade_id, part, begrundelse, indgivet_kl, ankede_status,
              ankede_afgjort_kl, status, behandlet_kl, afgoerelse_begrundelse)
  on public.sag_anker to authenticated;
grant all on public.sag_anker to service_role;

-- ============================================================ sag_anke_billeder

create table if not exists public.sag_anke_billeder (
  id          uuid primary key default gen_random_uuid(),
  anke_id     uuid not null references public.sag_anker(id) on delete restrict,
  -- Sti i bucket 'sag-billeder': <ankende parts id>/<handel-id>/<filnavn>
  sti         text not null unique,
  kategori    text not null default 'andet',
  oprettet_kl timestamptz not null default now(),
  constraint sag_anke_billeder_kategori_check check (
    kategori in ('pakke', 'label', 'indhold', 'andet')),
  constraint sag_anke_billeder_sti_format check (
    sti ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$')
);

comment on table public.sag_anke_billeder is
  'Ny dokumentation til en anke. Filen ligger i bucket sag-billeder. Slettes aldrig.';

create index if not exists sag_anke_billeder_anke_idx
  on public.sag_anke_billeder (anke_id, oprettet_kl);

alter table public.sag_anke_billeder enable row level security;

drop policy if exists sag_anke_billeder_select_parter on public.sag_anke_billeder;
create policy sag_anke_billeder_select_parter on public.sag_anke_billeder
  for select to authenticated using (
    exists (select 1 from public.sag_anker a
              join public.trades t on t.id = a.trade_id
             where a.id = sag_anke_billeder.anke_id
               and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );

revoke all on public.sag_anke_billeder from anon, authenticated;
grant select (id, anke_id, sti, kategori, oprettet_kl) on public.sag_anke_billeder to authenticated;
grant all on public.sag_anke_billeder to service_role;

-- ============================================================ Vaern

-- Slettes aldrig (genbruger sager_ingen_sletning fra 20261003010000).
drop trigger if exists sag_anker_ingen_sletning on public.sag_anker;
create trigger sag_anker_ingen_sletning
  before delete on public.sag_anker
  for each row execute function public.sager_ingen_sletning();

drop trigger if exists sag_anke_billeder_ingen_aendring on public.sag_anke_billeder;
create trigger sag_anke_billeder_ingen_aendring
  before update or delete on public.sag_anke_billeder
  for each row execute function public.sager_ingen_sletning();

-- Faste felter kan ikke aendres, og en afgjort anke er endelig.
create or replace function public.sag_anker_beskyt()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if new.id                 is distinct from old.id
  or new.sag_id             is distinct from old.sag_id
  or new.trade_id           is distinct from old.trade_id
  or new.indgivet_af        is distinct from old.indgivet_af
  or new.part               is distinct from old.part
  or new.begrundelse        is distinct from old.begrundelse
  or new.indgivet_kl        is distinct from old.indgivet_kl
  or new.ankede_status      is distinct from old.ankede_status
  or new.ankede_afgjort_af  is distinct from old.ankede_afgjort_af
  or new.ankede_afgjort_kl  is distinct from old.ankede_afgjort_kl
  or new.ankede_begrundelse is distinct from old.ankede_begrundelse then
    raise exception 'Ankens faste oplysninger kan ikke ændres.' using errcode = '42501';
  end if;
  if old.status <> 'afventer'
     and (new.status                 is distinct from old.status
       or new.behandlet_af           is distinct from old.behandlet_af
       or new.behandlet_kl           is distinct from old.behandlet_kl
       or new.afgoerelse_begrundelse is distinct from old.afgoerelse_begrundelse
       or new.intern_note            is distinct from old.intern_note) then
    raise exception 'Afgørelsen på anken er endelig.' using errcode = '42501';
  end if;
  new.opdateret := now();
  return new;
end;
$fn$;

revoke execute on function public.sag_anker_beskyt() from public, anon, authenticated;

drop trigger if exists sag_anker_beskyt on public.sag_anker;
create trigger sag_anker_beskyt
  before update on public.sag_anker
  for each row execute function public.sag_anker_beskyt();

-- ============================================================ moderation_log

-- Bevarer ALLE vaerdier fra 20261004040000_oprydning.sql (= listen fra
-- 20261003061000_connect_rettelser.sql + 'rapport_behandlet') og tilfoejer
-- 'sag_anke_indgivet', 'sag_anke_stadfaestet', 'sag_anke_omgjort'.
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
    'sag_genaabnet','konto_lukket','sag_afviklet',
    'indpakning_paamindelse','konto_lukning_foreslaaet','konto_lukning_afvist',
    'udbetalingskonto_loest',
    'udbetalingskonto_nulstillet',
    'rapport_behandlet',
    'sag_anke_indgivet','sag_anke_stadfaestet','sag_anke_omgjort'));

-- ============================================================ Frys: anke holder pengene

-- Som 20261003010000, men en anke, der venter, holder ogsaa pengene - ogsaa
-- hvis sagen (ved en fejl eller fremtidig aendring) skulle vaere afviklet.
-- Bruges af alle pengeveje (handel_auto_frigiv, betaling_paabegynd_refusion,
-- afsendelsesfrist_annuller) og af oprydningen (handel_afsluttet_kl), saa en
-- anket handel hverken udbetales, refunderes eller arkiveres.
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
            or (s.penge_handling is not null and s.afviklet_kl is null)))
  or exists (
    select 1 from public.sag_anker a
     where a.trade_id = p_trade and a.status = 'afventer');
$fn$;

revoke all on function public.sag_holder_pengene(uuid) from public, anon, authenticated;
grant execute on function public.sag_holder_pengene(uuid) to service_role;

-- Som 20261003010000, men frysningen (trades.sag_aaben) kan heller ikke
-- fjernes, mens en anke venter.
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
     and (exists (select 1 from public.sager s
                   where s.trade_id = new.id
                     and (s.status in ('aaben', 'afventer_retur')
                          or (s.penge_handling is not null and s.afviklet_kl is null)))
          or exists (select 1 from public.sag_anker a
                      where a.trade_id = new.id and a.status = 'afventer')) then
    raise exception 'Handlen har en åben sag fra køberen. Afgør sagen først.'
      using errcode = 'BHS01';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.trades_beskyt_sagsfrys() from public, anon, authenticated;

-- ============================================================ Intern: vurder

-- Kan p_bruger anke sagen lige nu? Intern (kaldes af sag_anke_mulighed,
-- sag_anke_indgiv og storage-policyen via sag_billede_maa_uploade).
-- Returnerer {"kode", "part"?, "fra_kl"?, "til_kl"?}:
--   kan_anke        - knappen er aaben (fra_kl <= nu < til_kl)
--   for_tidligt     - aabner fra_kl (24 timer efter afgoerelsen)
--   for_sent        - ankefristen er udloebet, eller pengene er flyttet
--   findes          - sagen er allerede anket (anke_status medsendes)
--   vandt           - brugeren fik medhold og kan ikke anke
--   ingen_anke      - sagen er ikke afgjort, er lukket, eller er lukket af systemet
--   retur_afleveret - (saelger) returpakken er allerede registreret
--   ikke_fundet     - sagen findes ikke, eller brugeren er ikke part
create or replace function public.sag_anke_vurder(p_sag uuid, p_bruger uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  s       record;
  t       record;
  a       record;
  v_part  text;
  v_taber text;
  v_fra   timestamptz;
  v_til   timestamptz;
begin
  if p_sag is null or p_bruger is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  select * into s from public.sager where id = p_sag;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select buyer_id, seller_id into t from public.trades where id = s.trade_id;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  if p_bruger = t.buyer_id then v_part := 'koeber';
  elsif p_bruger = t.seller_id then v_part := 'saelger';
  else return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select status into a from public.sag_anker where sag_id = s.id;
  if found then
    return jsonb_build_object('kode', 'findes', 'part', v_part, 'anke_status', a.status);
  end if;

  v_taber := case
    when s.penge_handling = 'refunder' and s.status in ('afgjort_koeber', 'afventer_retur') then 'saelger'
    when s.penge_handling = 'frigiv' and s.status = 'afgjort_saelger' then 'koeber'
    else null end;
  if v_taber is null or s.afgjort_kl is null or s.afgjort_af is null
     or s.afgjort_af = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ingen_anke', 'part', v_part);
  end if;
  if v_taber <> v_part then
    return jsonb_build_object('kode', 'vandt', 'part', v_part);
  end if;

  v_fra := s.afgjort_kl + interval '24 hours';
  v_til := s.afgjort_kl + interval '4 days';

  if s.afviklet_kl is not null or now() >= v_til then
    return jsonb_build_object('kode', 'for_sent', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
  end if;
  if v_taber = 'saelger' and s.retur_afleveret_kl is not null then
    return jsonb_build_object('kode', 'retur_afleveret', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
  end if;
  if now() < v_fra then
    return jsonb_build_object('kode', 'for_tidligt', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
  end if;
  return jsonb_build_object('kode', 'kan_anke', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
end;
$fn$;

revoke all on function public.sag_anke_vurder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sag_anke_vurder(uuid, uuid) to service_role;

-- Til appen/hjemmesiden: kan den indloggede bruger anke sagen? Samme svar som
-- sag_anke_vurder, for auth.uid(). Afsloerer intet for andre end parterne.
create or replace function public.sag_anke_mulighed(p_sag uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select case when auth.uid() is null then jsonb_build_object('kode', 'ikke_logget_ind')
              else public.sag_anke_vurder(p_sag, auth.uid()) end;
$fn$;

revoke all on function public.sag_anke_mulighed(uuid) from public, anon;
grant execute on function public.sag_anke_mulighed(uuid) to authenticated;

-- ============================================================ Intern: billeder

-- Validerer ankens billeder: [{ "sti": "...", "kategori"?: "..." }] (hoejst
-- 10). Hver sti skal ligge i den ankende parts mappe for handlen, findes i
-- storage og ikke vaere brugt foer (hverken i sagen eller en anke).
-- Returnerer null hvis ok, ellers ugyldige_billeder | billede_mangler |
-- for_mange_billeder.
create or replace function public.sag_anke_valider_billeder(
  p_bruger uuid, p_trade uuid, p_billeder jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  e       jsonb;
  v_sti   text;
  v_kat   text;
  v_stier text[] := '{}';
begin
  if p_billeder is null or jsonb_typeof(p_billeder) <> 'array' then
    return 'ugyldige_billeder';
  end if;
  if jsonb_array_length(p_billeder) > 10 then return 'for_mange_billeder'; end if;

  for e in select * from jsonb_array_elements(p_billeder) loop
    if jsonb_typeof(e) <> 'object' then return 'ugyldige_billeder'; end if;
    v_sti := e->>'sti';
    v_kat := coalesce(e->>'kategori', 'andet');
    if v_sti is null or v_kat not in ('pakke', 'label', 'indhold', 'andet') then
      return 'ugyldige_billeder';
    end if;
    if split_part(v_sti, '/', 1) <> p_bruger::text
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
    if exists (select 1 from public.sag_billeder b where b.sti = v_sti)
       or exists (select 1 from public.sag_anke_billeder b where b.sti = v_sti) then
      return 'ugyldige_billeder';
    end if;
  end loop;

  return null;
end;
$fn$;

revoke all on function public.sag_anke_valider_billeder(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sag_anke_valider_billeder(uuid, uuid, jsonb) to service_role;

-- ============================================================ Part: indgiv anke

-- Den part, der tabte sagen, anker afgoerelsen (auth.uid()).
-- Returnerer {"kode": "ok", "anke_id"} eller en fejlkode:
--   ikke_logget_ind, ugyldig_begrundelse (20-2000 tegn), ikke_fundet,
--   for_tidligt (+ fra_kl), for_sent, findes, vandt, ingen_anke,
--   retur_afleveret, ugyldige_billeder, billede_mangler, for_mange_billeder.
-- Laaseraekkefoelge som overalt: betaling, handel, sag. Dermed kan anken og
-- afviklingen efter fristen (sag_afvikl) aldrig krydse hinanden: enten er
-- pengene flyttet (for_sent), eller anken er registreret, og sag_afvikl
-- venter.
create or replace function public.sag_anke_indgiv(
  p_sag         uuid,
  p_begrundelse text,
  p_billeder    jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger   uuid := auth.uid();
  v_grund    text := btrim(coalesce(p_begrundelse, ''));
  v_billeder jsonb := coalesce(p_billeder, '[]'::jsonb);
  v_trade    uuid;
  s          record;
  t          record;
  v_vurd     jsonb;
  v_fejl     text;
  v_anke     uuid;
  v_hvem     text;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if char_length(v_grund) not between 20 and 2000 then
    return jsonb_build_object('kode', 'ugyldig_begrundelse');
  end if;

  -- Ikke part: samme svar som en ukendt sag. Tjekkes foer laasene, saa
  -- uvedkommende ikke kan laase fremmede raekker.
  select s2.trade_id into v_trade
    from public.sager s2 join public.trades t2 on t2.id = s2.trade_id
   where s2.id = p_sag and (t2.buyer_id = v_bruger or t2.seller_id = v_bruger);
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  perform 1 from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  v_vurd := public.sag_anke_vurder(s.id, v_bruger);
  if v_vurd->>'kode' <> 'kan_anke' then
    return jsonb_build_object('kode', v_vurd->>'kode', 'fra_kl', v_vurd->'fra_kl',
                              'til_kl', v_vurd->'til_kl');
  end if;

  v_fejl := public.sag_anke_valider_billeder(v_bruger, v_trade, v_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  begin
    insert into public.sag_anker (sag_id, trade_id, indgivet_af, part, begrundelse,
                                  ankede_status, ankede_afgjort_af, ankede_afgjort_kl,
                                  ankede_begrundelse)
    values (s.id, v_trade, v_bruger, v_vurd->>'part', v_grund,
            s.status, s.afgjort_af, s.afgjort_kl, s.begrundelse)
    returning id into v_anke;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  insert into public.sag_anke_billeder (anke_id, sti, kategori)
  select v_anke, e->>'sti', coalesce(e->>'kategori', 'andet')
    from jsonb_array_elements(v_billeder) e;

  v_hvem := case v_vurd->>'part' when 'koeber' then 'køberen' else 'sælgeren' end;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (public.bidhamr_system_id(), 'sag_anke_indgivet', 'sag', s.id, v_bruger,
          left('Afgørelsen er anket af ' || v_hvem
               || ' - pengene flyttes ikke, før anken er afgjort'
               || case when jsonb_array_length(v_billeder) > 0
                       then ' (' || jsonb_array_length(v_billeder) || ' billeder)' else '' end
               || ' | ' || v_grund, 4000));

  return jsonb_build_object('kode', 'ok', 'anke_id', v_anke);
end;
$fn$;

revoke all on function public.sag_anke_indgiv(uuid, text, jsonb) from public, anon;
grant execute on function public.sag_anke_indgiv(uuid, text, jsonb) to authenticated;

-- ============================================================ Intern: afvikl

-- Som 20261003010000, men en sag med en anke, der venter, afvikles ikke
-- (kode 'venter_anke'): pengene flyttes ikke, mens anken behandles. Ellers
-- uaendret.
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
  -- Anke venter: pengene flyttes ikke, foer anken er afgjort.
  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return v_res || jsonb_build_object('kode', 'venter_anke');
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

-- Som 20261003010000, men sager med en anke, der venter, frasorteres
-- allerede i kandidat-forespoergslen (de fylder ellers de 100 pladser).
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
    select s.id from public.sager s
     where s.penge_handling is not null
       and s.afviklet_kl is null
       and s.penge_flyttes_efter_kl <= now()
       and s.status in ('afgjort_koeber', 'afgjort_saelger', 'lukket')
       and not exists (select 1 from public.sag_anker a
                        where a.sag_id = s.id and a.status = 'afventer')
     order by (s.penge_fejl is not null), s.penge_flyttes_efter_kl
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

-- ============================================================ Staff: afgoer anke

-- Admin/chef afgoer en anke. p_udfald: 'stadfaest' | 'omgoer'.
--   stadfaest - afgoerelsen staar. penge_flyttes_efter_kl = nu, og sagen
--               afvikles straks (sag_afvikl). Venter sagen paa retur, sker
--               refusionen, saa snart returpakken er registreret.
--   omgoer    - modsat udfald, afgjort af behandleren (sager.afgjort_af/kl/
--               begrundelse = ankens afgoerelse; den oprindelige afgoerelse er
--               gemt i sag_anker.ankede_*). Pengene flyttes straks - ingen ny
--               ankefrist:
--                 saelgeren ankede -> medhold til saelger (frigivelse)
--                 koeberen ankede  -> medhold til koeber: svindel/bortkommet
--                     refunderes straks; skadet/ikke som beskrevet -> varen
--                     sendes retur (koeberen betaler selv returfragten), og
--                     refusionen sker, saa snart returpakken er registreret.
-- Afgoerelsen er endelig (sag_anker_beskyt).
-- Returnerer {"kode": "ok", "udfald", "handling", "afvikling"?, "anke_id",
-- "part", "sag_id", "trade_id", "buyer_id", "seller_id", "auction_id",
-- "type", "version"} hvor handling er:
--   'refunder' | 'frigiv'  - sag_afvikl gennemfoerte (afvikling.kode = 'ok');
--                            serveren kalder Stripe (udfoerSagAfvikling)
--   'afvent_retur'         - venter paa returpakken
--   'blokeret'             - afvikling.grund (fx indsigelse); cron proever igen
--   'allerede_afviklet'    - pengene var allerede flyttet (fx refunderet hos
--                            Stripe imens) - kun ved stadfaest
-- Fejlkoder: ingen_adgang (kun admin/chef), ugyldigt_udfald,
-- begrundelse_mangler, for_lang_tekst, ikke_fundet, behandlet, inhabil,
-- samme_medarbejder, penge_flyttet, retur_afleveret, indsigelse, ikke_mulig.
create or replace function public.sag_anke_afgoer(
  p_medarbejder uuid,
  p_anke        uuid,
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
  v_sag      uuid;
  v_trade    uuid;
  a          record;
  s          record;
  t          record;
  b          record;
  v_res      jsonb;
  v_handling text;
  v_hvem     text;
  v_log      text;
  v_retur    boolean := false;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('stadfaest', 'omgoer') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select sag_id, trade_id into v_sag, v_trade from public.sag_anker where id = p_anke;
  if v_sag is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag, anke.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = v_sag for update;
  select * into a from public.sag_anker where id = p_anke for update;

  if a.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;
  -- Ingen maa behandle en anke, hvor han selv er part.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  -- En anden end den, der afgjorde sagen.
  if p_medarbejder = a.ankede_afgjort_af or p_medarbejder = s.afgjort_af then
    return jsonb_build_object('kode', 'samme_medarbejder');
  end if;

  v_hvem := case a.part when 'koeber' then 'køberens' else 'sælgerens' end;

  if p_udfald = 'stadfaest' then
    update public.sag_anker
       set status = 'stadfaestet', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_stadfaestet', 'sag', s.id, a.indgivet_af,
            left('Anken (' || v_hvem || ') er afvist - afgørelsen står og er endelig. Pengene flyttes nu'
                 || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if s.afviklet_kl is not null or s.penge_handling is null then
      v_handling := 'allerede_afviklet';
    else
      update public.sager set penge_flyttes_efter_kl = now() where id = s.id;
      if s.status = 'afventer_retur' then
        v_handling := 'afvent_retur';
      else
        v_res := public.sag_afvikl(s.id);
        v_handling := case v_res->>'kode' when 'ok' then s.penge_handling else 'blokeret' end;
      end if;
    end if;

  else
    -- Omgoer: kun hvis pengene ikke er flyttet.
    if s.afviklet_kl is not null
       or b.id is null
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null
       or b.status <> 'betalt' then
      return jsonb_build_object('kode', 'penge_flyttet');
    end if;

    if a.part = 'saelger' then
      -- Saelgeren faar medhold. Har han allerede faaet varen retur, ville han
      -- faa baade varen og pengene.
      if s.retur_afleveret_kl is not null then
        return jsonb_build_object('kode', 'retur_afleveret');
      end if;
      update public.sager
         set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund,
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = 'frigiv', penge_flyttes_efter_kl = now(),
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_log := 'Anken (sælgerens) er godkendt - afgørelsen er ændret til medhold til sælger og er endelig. Pengene frigives til sælger nu';
    else
      -- Koeberen faar medhold. Samme forhaandstjek som sag_afgoer.
      if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
        return jsonb_build_object('kode', 'indsigelse');
      end if;
      if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
        update public.sager
           set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = (s.retur_afleveret_kl is not null),
               returfragt_betaler = case when s.retur_afleveret_kl is not null then 'koeber' end,
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Refusion (alt undtagen BidHamr Beskyttelse) nu';
      else
        v_retur := true;
        update public.sager
           set status = 'afventer_retur', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = true, returfragt_betaler = 'koeber',
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Varen sendes retur (køberen betaler selv returfragten); refusion, så snart returpakken er registreret';
      end if;
    end if;

    update public.sag_anker
       set status = 'omgjort', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_omgjort', 'sag', s.id, a.indgivet_af,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if v_retur then
      v_handling := 'afvent_retur';
    else
      v_res := public.sag_afvikl(s.id);
      v_handling := case v_res->>'kode'
                      when 'ok' then case a.part when 'saelger' then 'frigiv' else 'refunder' end
                      else 'blokeret' end;
    end if;
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'udfald', p_udfald, 'handling', v_handling, 'afvikling', v_res,
    'anke_id', a.id, 'part', a.part, 'sag_id', s.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_anke_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sag_anke_afgoer(uuid, uuid, text, text, text) to service_role;

-- ============================================================ Staff: afgoer (anke-tjek)

-- Som 20261003013000, men afviser med 'anke_afventer', mens en anke venter
-- (en ny afgoerelse ville omgaa anken). Ellers uaendret.
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

  -- Ingen maa afgoere en sag, hvor han selv er part.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- En anke venter: den skal afgoeres foerst.
  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'anke_afventer');
  end if;

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
                                       then 'koeber' end,
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'planlagt_refusion';
      v_log := 'Medhold til køber - refusion (alt undtagen BidHamr Beskyttelse) efter ankefristen på 4 dage';
    else
      -- Skadet / ikke som beskrevet: retur foer refusion.
      update public.sager
         set status = 'afventer_retur', retur_kraeves = true,
             returfragt_betaler = 'koeber',
             afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'afvent_retur';
      v_log := 'Medhold til køber - varen sendes retur (køberen betaler selv returfragten), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';
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

-- ============================================================ Staff: retur afleveret (anke-tjek)

-- Som 20261003011000, men afviser med 'anke_afventer', mens en anke venter
-- (saelgeren har anket medholdet til koeberen - anken afgoeres foerst).
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

  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'anke_afventer');
  end if;

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

-- ============================================================ Admin: genaabn (anke-tjek)

-- Som 20261003011000, men en anket sag kan ikke genaabnes ('anket'): mens
-- anken venter, skal den afgoeres; og afgoerelsen paa anken er endelig.
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

  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if exists (select 1 from public.sag_anker a where a.sag_id = s.id) then
    return jsonb_build_object('kode', 'anket');
  end if;

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

-- ============================================================ Storage

-- Som 20261003010000, men ogsaa den part, der kan anke sagen lige nu
-- (sag_anke_vurder = 'kan_anke'), maa uploade i sin egen mappe paa handlen
-- (ny dokumentation til anken). Stadig hoejst 30 filer pr. bruger pr. handel.
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
  ) and not exists (
    select 1 from public.sager s
     where s.trade_id = v_trade
       and public.sag_anke_vurder(s.id, v_bruger)->>'kode' = 'kan_anke'
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

-- Som 20261003010000, men parterne kan ogsaa laese ankens billeder.
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
    or exists (
         select 1 from public.sag_anke_billeder ab
           join public.sag_anker a on a.id = ab.anke_id
           join public.trades t on t.id = a.trade_id
          where ab.sti = p_sti
            and (t.seller_id = auth.uid() or t.buyer_id = auth.uid()))
  );
$fn$;

revoke all on function public.sag_billede_maa_laese(text) from public, anon;
grant execute on function public.sag_billede_maa_laese(text) to authenticated;

-- ============================================================ Staff-badge

-- Antal sager, der venter paa staff: aabne sager + anker, der venter. Kun
-- staff faar et tal; andre faar 0.
create or replace function public.antal_aabne_sager()
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select case when not public.er_staff() then 0 else (
    (select count(*)::integer from public.sager where status = 'aaben')
    + (select count(*)::integer from public.sag_anker where status = 'afventer')
  ) end;
$fn$;

revoke all on function public.antal_aabne_sager() from public, anon;
grant execute on function public.antal_aabne_sager() to authenticated;
