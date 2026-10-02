-- Chat mellem staff og brugere (ROADMAP-BESLUTNINGER "Chat mellem staff og
-- brugere", Filip 2. oktober 2026).
--
-- - Kun staff (medarbejder/admin/chef) kan aabne en samtale med en bruger.
--   Brugeren kan foerst skrive, naar samtalen er aaben, og kun indtil staff
--   lukker den. Lukkede samtaler kan stadig laeses.
-- - Een aaben samtale pr. bruger pr. sag (uden sag: een aaben generel
--   samtale pr. bruger). Over tid kan der vaere mange lukkede.
-- - Beskeder slettes og aendres aldrig (logning, bogfoering/sager).
-- - Admin kan skrive en markeret faellesbesked i koeber/saelger-chatten
--   (messages.fra_bidhamr). Kun service_role kan saette markeringen.
--
-- Skriveadgang:
--   bruger: KUN via staff_chat_svar() og staff_chat_marker_laest()
--           (security definer, udleder brugeren af auth.uid()).
--   staff:  KUN via server (service_role) efter assertRole() - funktionerne
--           staff_chat_aabn/send/luk og faellesbesked er lukket for browseren.
--
-- Brugeren maa ikke se, HVILKEN medarbejder der skrev (aabnet_af, lukket_af,
-- afsender_id) - kolonne-grants skjuler dem. Brugeren ser kun fra_staff.
--
-- Idempotent: if not exists / create or replace / drop ... if exists.

-- ============================================================ staff_samtaler

create table if not exists public.staff_samtaler (
  id              uuid primary key default gen_random_uuid(),
  bruger_id       uuid not null references public.users(id) on delete restrict,
  aabnet_af       uuid not null references public.users(id) on delete restrict,
  aabnet_kl       timestamptz not null default now(),
  lukket_af       uuid references public.users(id) on delete restrict,
  lukket_kl       timestamptz,
  emne            text not null,
  -- Til de kommende sager. Ingen FK endnu (sagstabellen findes ikke).
  sag_type        text,
  sag_id          uuid,
  trade_id        uuid references public.trades(id) on delete restrict,
  -- Hvornaar brugeren sidst har laest samtalen (ulaeste-taeller).
  bruger_laest_kl timestamptz,
  constraint staff_samtaler_emne_laengde check (char_length(btrim(emne)) between 1 and 200),
  constraint staff_samtaler_sag_type_format check (sag_type is null or sag_type ~ '^[a-z_]{1,40}$'),
  constraint staff_samtaler_sag_par check ((sag_type is null) = (sag_id is null)),
  constraint staff_samtaler_lukket_par check ((lukket_kl is null) = (lukket_af is null))
);

comment on table public.staff_samtaler is
  'Samtaler mellem BidHamr (staff) og en bruger. Aabnes/lukkes kun af staff via server. Slettes aldrig.';

-- Een aaben samtale pr. bruger pr. sag. Uden sag taeller (null, null) som
-- "den generelle samtale", saa der ogsaa kun er een aaben af den.
create unique index if not exists staff_samtaler_en_aaben_idx
  on public.staff_samtaler (
    bruger_id,
    coalesce(sag_type, ''),
    coalesce(sag_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where lukket_kl is null;

create index if not exists staff_samtaler_bruger_idx
  on public.staff_samtaler (bruger_id, aabnet_kl desc);
create index if not exists staff_samtaler_aabne_idx
  on public.staff_samtaler (aabnet_kl desc) where lukket_kl is null;
create index if not exists staff_samtaler_sag_idx
  on public.staff_samtaler (sag_type, sag_id) where sag_id is not null;
create index if not exists staff_samtaler_trade_idx
  on public.staff_samtaler (trade_id) where trade_id is not null;

alter table public.staff_samtaler enable row level security;

drop policy if exists staff_samtaler_select_egen on public.staff_samtaler;
create policy staff_samtaler_select_egen on public.staff_samtaler
  for select to authenticated using (bruger_id = auth.uid());

revoke all on public.staff_samtaler from anon, authenticated;
-- Ikke aabnet_af/lukket_af: brugeren skal ikke kunne se medarbejderens id.
grant select (id, bruger_id, aabnet_kl, lukket_kl, emne, sag_type, sag_id, trade_id, bruger_laest_kl)
  on public.staff_samtaler to authenticated;
grant all on public.staff_samtaler to service_role;

-- ============================================================ staff_beskeder

create table if not exists public.staff_beskeder (
  id          uuid primary key default gen_random_uuid(),
  samtale_id  uuid not null references public.staff_samtaler(id) on delete restrict,
  afsender_id uuid not null references public.users(id) on delete restrict,
  fra_staff   boolean not null,
  tekst       text not null,
  oprettet_kl timestamptz not null default now(),
  constraint staff_beskeder_tekst_laengde check (
    char_length(tekst) between 1 and 4000 and char_length(btrim(tekst)) >= 1)
);

comment on table public.staff_beskeder is
  'Beskeder i staff_samtaler. fra_staff = skrevet af BidHamr. Slettes og aendres aldrig.';

create index if not exists staff_beskeder_samtale_idx
  on public.staff_beskeder (samtale_id, oprettet_kl desc);
-- Rate limit paa brugersvar.
create index if not exists staff_beskeder_afsender_idx
  on public.staff_beskeder (afsender_id, oprettet_kl desc);

alter table public.staff_beskeder enable row level security;

drop policy if exists staff_beskeder_select_egen on public.staff_beskeder;
create policy staff_beskeder_select_egen on public.staff_beskeder
  for select to authenticated using (
    exists (
      select 1 from public.staff_samtaler s
       where s.id = staff_beskeder.samtale_id and s.bruger_id = auth.uid()
    )
  );

revoke all on public.staff_beskeder from anon, authenticated;
-- Ikke afsender_id: brugeren ser kun fra_staff (egne beskeder = not fra_staff).
grant select (id, samtale_id, fra_staff, tekst, oprettet_kl)
  on public.staff_beskeder to authenticated;
grant all on public.staff_beskeder to service_role;

-- Vaern i bunden: beskeder kan aldrig aendres eller slettes - heller ikke af
-- service_role. Samtaler kan opdateres (lukning, laest), men ikke slettes.
create or replace function public.staff_chat_ingen_sletning()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Samtaler og beskeder med BidHamr kan ikke slettes eller ændres.'
    using errcode = '42501';
end;
$fn$;

revoke execute on function public.staff_chat_ingen_sletning() from public, anon, authenticated;

drop trigger if exists staff_beskeder_ingen_aendring on public.staff_beskeder;
create trigger staff_beskeder_ingen_aendring
  before update or delete on public.staff_beskeder
  for each row execute function public.staff_chat_ingen_sletning();

drop trigger if exists staff_samtaler_ingen_sletning on public.staff_samtaler;
create trigger staff_samtaler_ingen_sletning
  before delete on public.staff_samtaler
  for each row execute function public.staff_chat_ingen_sletning();

-- En lukket samtale kan ikke genaabnes, og faste felter kan ikke aendres.
-- Kun lukning (lukket_af/lukket_kl fra null) og bruger_laest_kl maa aendres.
create or replace function public.staff_samtaler_beskyt()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if new.id          is distinct from old.id
  or new.bruger_id   is distinct from old.bruger_id
  or new.aabnet_af   is distinct from old.aabnet_af
  or new.aabnet_kl   is distinct from old.aabnet_kl
  or new.emne        is distinct from old.emne
  or new.sag_type    is distinct from old.sag_type
  or new.sag_id      is distinct from old.sag_id
  or new.trade_id    is distinct from old.trade_id
  or (old.lukket_kl is not null and (new.lukket_kl is distinct from old.lukket_kl
                                     or new.lukket_af is distinct from old.lukket_af)) then
    raise exception 'Samtalen kan ikke ændres.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.staff_samtaler_beskyt() from public, anon, authenticated;

drop trigger if exists staff_samtaler_beskyt on public.staff_samtaler;
create trigger staff_samtaler_beskyt
  before update on public.staff_samtaler
  for each row execute function public.staff_samtaler_beskyt();

-- Realtime, saa brugeren ser staffs svar med det samme. Realtime respekterer
-- RLS (og kolonne-grants), saa brugeren kun faar egne beskeder.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'staff_beskeder'
  ) then
    alter publication supabase_realtime add table public.staff_beskeder;
  end if;
end $$;

-- ============================================================ moderation_log

-- Bevarer ALLE vaerdier fra 20261002041000_admin_betaling_loest.sql.
alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest',
    'chat_aabnet','chat_lukket','faellesbesked'));

-- Bevarer vaerdierne fra 20260924000000_sager_admin_indgreb.sql + 'samtale'.
alter table public.moderation_log
  drop constraint if exists moderation_log_maal_type_check;

alter table public.moderation_log
  add constraint moderation_log_maal_type_check check (
    maal_type in ('auktion','anmeldelse','bruger','handel','samtale'));

-- ============================================================ Hjaelper

-- Er p_bruger staff (mindst p_min)? Kun til de interne funktioner herunder.
create or replace function public.staff_chat_har_rolle(p_bruger uuid, p_min text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.users u
     where u.id = p_bruger
       and case p_min
             when 'medarbejder' then u.rolle in ('medarbejder', 'admin', 'chef')
             when 'admin'       then u.rolle in ('admin', 'chef')
             when 'chef'        then u.rolle = 'chef'
             else false
           end
  );
$fn$;

revoke all on function public.staff_chat_har_rolle(uuid, text) from public, anon, authenticated;
grant execute on function public.staff_chat_har_rolle(uuid, text) to service_role;

-- ============================================================ Staff (service_role)

-- Aabner en samtale. Findes der allerede en aaben samtale med brugeren om
-- samme sag (eller en aaben generel samtale), returneres den i stedet
-- (dobbeltklik giver ikke to samtaler). p_besked er valgfri foerste besked.
-- Returnerer {"kode": "ok"|"findes", "samtale_id", "besked_id"?} eller en
-- fejlkode: ingen_adgang, ugyldig_bruger, sig_selv, ugyldigt_emne,
-- ugyldig_sag, ugyldig_handel, ugyldig_tekst.
create or replace function public.staff_chat_aabn(
  p_medarbejder uuid,
  p_bruger      uuid,
  p_emne        text,
  p_trade       uuid,
  p_sag_type    text,
  p_sag_id      uuid,
  p_besked      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_emne    text := btrim(coalesce(p_emne, ''));
  v_besked  text := nullif(btrim(coalesce(p_besked, '')), '');
  v_samtale uuid;
  v_besked_id uuid;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_bruger is null or not exists (select 1 from public.users where id = p_bruger) then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_medarbejder then
    return jsonb_build_object('kode', 'sig_selv');
  end if;
  if char_length(v_emne) not between 1 and 200 then
    return jsonb_build_object('kode', 'ugyldigt_emne');
  end if;
  if (p_sag_type is null) <> (p_sag_id is null)
     or (p_sag_type is not null and p_sag_type !~ '^[a-z_]{1,40}$') then
    return jsonb_build_object('kode', 'ugyldig_sag');
  end if;
  if p_trade is not null and not exists (
    select 1 from public.trades t
     where t.id = p_trade and (t.buyer_id = p_bruger or t.seller_id = p_bruger)
  ) then
    return jsonb_build_object('kode', 'ugyldig_handel');
  end if;
  if v_besked is not null and char_length(v_besked) > 4000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  -- Findes der allerede en aaben?
  select s.id into v_samtale
    from public.staff_samtaler s
   where s.bruger_id = p_bruger
     and s.lukket_kl is null
     and s.sag_type is not distinct from p_sag_type
     and s.sag_id is not distinct from p_sag_id;
  if v_samtale is not null then
    return jsonb_build_object('kode', 'findes', 'samtale_id', v_samtale);
  end if;

  begin
    insert into public.staff_samtaler (bruger_id, aabnet_af, emne, sag_type, sag_id, trade_id)
    values (p_bruger, p_medarbejder, v_emne, p_sag_type, p_sag_id, p_trade)
    returning id into v_samtale;
  exception when unique_violation then
    -- Samtidigt dobbeltklik: den anden vandt.
    select s.id into v_samtale
      from public.staff_samtaler s
     where s.bruger_id = p_bruger
       and s.lukket_kl is null
       and s.sag_type is not distinct from p_sag_type
       and s.sag_id is not distinct from p_sag_id;
    return jsonb_build_object('kode', 'findes', 'samtale_id', v_samtale);
  end;

  if v_besked is not null then
    insert into public.staff_beskeder (samtale_id, afsender_id, fra_staff, tekst)
    values (v_samtale, p_medarbejder, true, v_besked)
    returning id into v_besked_id;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'chat_aabnet', 'samtale', v_samtale, p_bruger,
          'Emne: ' || v_emne
          || coalesce(' | Sag: ' || p_sag_type || ' ' || p_sag_id::text, '')
          || coalesce(' | Handel: ' || p_trade::text, ''));

  return jsonb_build_object('kode', 'ok', 'samtale_id', v_samtale, 'besked_id', v_besked_id);
end;
$fn$;

revoke all on function public.staff_chat_aabn(uuid, uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_chat_aabn(uuid, uuid, text, uuid, text, uuid, text)
  to service_role;

-- Staff skriver i en aaben samtale.
-- Returnerer {"kode": "ok", "besked_id", "bruger_id", "forrige_ulaest_kl"} eller
-- ingen_adgang, ikke_fundet, lukket, ugyldig_tekst.
-- forrige_ulaest_kl: tidspunkt for den seneste tidligere staff-besked, som
-- brugeren ikke har laest (null hvis ingen) - bruges til at undgaa en
-- notifikation pr. besked, naar staff skriver flere i traek.
create or replace function public.staff_chat_send(
  p_medarbejder uuid,
  p_samtale     uuid,
  p_tekst       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_tekst text := btrim(coalesce(p_tekst, ''));
  s       public.staff_samtaler%rowtype;
  v_id    uuid;
  v_forrige timestamptz;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(v_tekst) not between 1 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  -- Laas samtalen, saa en samtidig lukning ikke smutter forbi.
  select * into s from public.staff_samtaler where id = p_samtale for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if s.lukket_kl is not null then return jsonb_build_object('kode', 'lukket'); end if;

  select max(b.oprettet_kl) into v_forrige
    from public.staff_beskeder b
   where b.samtale_id = s.id
     and b.fra_staff
     and (s.bruger_laest_kl is null or b.oprettet_kl > s.bruger_laest_kl);

  insert into public.staff_beskeder (samtale_id, afsender_id, fra_staff, tekst)
  values (s.id, p_medarbejder, true, v_tekst)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'besked_id', v_id, 'bruger_id', s.bruger_id,
                            'forrige_ulaest_kl', v_forrige);
end;
$fn$;

revoke all on function public.staff_chat_send(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.staff_chat_send(uuid, uuid, text) to service_role;

-- Staff lukker en samtale. Altid muligt for staff. Idempotent: en allerede
-- lukket samtale roeres ikke ({"kode": "allerede_lukket"}).
create or replace function public.staff_chat_luk(
  p_medarbejder uuid,
  p_samtale     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  update public.staff_samtaler
     set lukket_kl = now(), lukket_af = p_medarbejder
   where id = p_samtale and lukket_kl is null
  returning bruger_id into v_bruger;

  if v_bruger is null then
    if exists (select 1 from public.staff_samtaler where id = p_samtale) then
      return jsonb_build_object('kode', 'allerede_lukket');
    end if;
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'chat_lukket', 'samtale', p_samtale, v_bruger, 'Chat afsluttet');

  return jsonb_build_object('kode', 'ok', 'bruger_id', v_bruger);
end;
$fn$;

revoke all on function public.staff_chat_luk(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staff_chat_luk(uuid, uuid) to service_role;

-- ============================================================ Bruger (authenticated)

-- Brugeren svarer i sin egen, aabne samtale. Rate limit: hoejst 20 svar pr.
-- 10 minutter pr. bruger (paa tvaers af samtaler).
-- Returnerer {"kode": "ok", "besked_id"} eller ikke_logget_ind, ikke_fundet,
-- lukket, ugyldig_tekst, for_mange.
create or replace function public.staff_chat_svar(p_samtale uuid, p_tekst text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid := auth.uid();
  v_tekst  text := btrim(coalesce(p_tekst, ''));
  v_lukket timestamptz;
  v_antal  integer;
  v_id     uuid;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if char_length(v_tekst) not between 1 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  -- Laas samtalen: lukker staff samtidig, venter vi og ser lukningen.
  select s.lukket_kl into v_lukket
    from public.staff_samtaler s
   where s.id = p_samtale and s.bruger_id = v_bruger
   for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_lukket is not null then return jsonb_build_object('kode', 'lukket'); end if;

  select count(*) into v_antal
    from public.staff_beskeder b
   where b.afsender_id = v_bruger
     and not b.fra_staff
     and b.oprettet_kl > now() - interval '10 minutes';
  if v_antal >= 20 then return jsonb_build_object('kode', 'for_mange'); end if;

  insert into public.staff_beskeder (samtale_id, afsender_id, fra_staff, tekst)
  values (p_samtale, v_bruger, false, v_tekst)
  returning id into v_id;

  -- Har brugeren skrevet, har han ogsaa laest samtalen.
  update public.staff_samtaler set bruger_laest_kl = now() where id = p_samtale;

  return jsonb_build_object('kode', 'ok', 'besked_id', v_id);
end;
$fn$;

revoke all on function public.staff_chat_svar(uuid, text) from public, anon;
grant execute on function public.staff_chat_svar(uuid, text) to authenticated;

-- Brugeren markerer en egen samtale som laest (ogsaa lukkede).
create or replace function public.staff_chat_marker_laest(p_samtale uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then return false; end if;
  update public.staff_samtaler
     set bruger_laest_kl = now()
   where id = p_samtale and bruger_id = auth.uid();
  return found;
end;
$fn$;

revoke all on function public.staff_chat_marker_laest(uuid) from public, anon;
grant execute on function public.staff_chat_marker_laest(uuid) to authenticated;

-- Antal ulaeste beskeder fra BidHamr til den kaldende bruger (badge).
create or replace function public.antal_ulaeste_staff_beskeder()
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select count(*)::integer
    from public.staff_samtaler s
    join public.staff_beskeder b on b.samtale_id = s.id
   where s.bruger_id = auth.uid()
     and b.fra_staff
     and (s.bruger_laest_kl is null or b.oprettet_kl > s.bruger_laest_kl);
$fn$;

revoke all on function public.antal_ulaeste_staff_beskeder() from public, anon;
grant execute on function public.antal_ulaeste_staff_beskeder() to authenticated;

-- ============================================================ Staff-badge

-- Antal aabne samtaler, hvor den seneste besked er fra brugeren (venter paa
-- svar fra BidHamr). Kun staff faar et tal; andre faar 0.
create or replace function public.antal_ubesvarede_staff_samtaler()
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select case when not public.er_staff() then 0 else (
    select count(*)::integer
      from public.staff_samtaler s
      cross join lateral (
        select b.fra_staff
          from public.staff_beskeder b
         where b.samtale_id = s.id
         order by b.oprettet_kl desc, b.id desc
         limit 1
      ) sidste
     where s.lukket_kl is null
       and not sidste.fra_staff
  ) end;
$fn$;

revoke all on function public.antal_ubesvarede_staff_samtaler() from public, anon;
grant execute on function public.antal_ubesvarede_staff_samtaler() to authenticated;

-- ============================================================ Faellesbesked

-- Markering af beskeder fra BidHamr i koeber/saelger-chatten. Appen og
-- hjemmesiden skriver selv i messages (RLS messages_insert_part); kolonnen har
-- default false, saa eksisterende inserts er uberoerte.
alter table public.messages
  add column if not exists fra_bidhamr boolean not null default false;

comment on column public.messages.fra_bidhamr is
  'true = faellesbesked fra BidHamr (admin) til begge parter. sender_id er den admin, der skrev. Kan kun saettes af service_role.';

-- Kun service_role (og databasens egne roller) maa saette fra_bidhamr.
-- For alle andre tvinges den til false (ingen fejl, saa appen aldrig brydes).
create or replace function public.messages_beskyt_fra_bidhamr()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.fra_bidhamr := false;
  else
    new.fra_bidhamr := old.fra_bidhamr;
  end if;
  return new;
end;
$fn$;

revoke execute on function public.messages_beskyt_fra_bidhamr() from public, anon, authenticated;

drop trigger if exists messages_beskyt_fra_bidhamr on public.messages;
create trigger messages_beskyt_fra_bidhamr
  before insert or update on public.messages
  for each row execute function public.messages_beskyt_fra_bidhamr();

-- Admin skriver en faellesbesked til koeber og saelger i deres chat.
-- Teksten faar praefikset "Besked fra BidHamr:", saa den ogsaa er tydeligt
-- markeret i app-versioner, der endnu ikke kender fra_bidhamr.
-- Returnerer {"kode": "ok", "besked_id", "buyer_id", "seller_id", "auction_id"}
-- eller ingen_adgang, ikke_fundet, ugyldig_tekst.
create or replace function public.faellesbesked(
  p_medarbejder uuid,
  p_trade       uuid,
  p_tekst       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_tekst text := btrim(coalesce(p_tekst, ''));
  t       record;
  v_id    uuid;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  -- messages.content maa hoejst vaere 2000 tegn inkl. praefiks.
  if char_length(v_tekst) not between 1 and 1900 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  select id, buyer_id, seller_id, auction_id into t
    from public.trades where id = p_trade;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  insert into public.messages (trade_id, sender_id, content, fra_bidhamr)
  values (t.id, p_medarbejder, 'Besked fra BidHamr:' || chr(10) || v_tekst, true)
  returning id into v_id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'faellesbesked', 'handel', t.id, t.buyer_id, left(v_tekst, 1000));

  return jsonb_build_object('kode', 'ok', 'besked_id', v_id, 'buyer_id', t.buyer_id,
                            'seller_id', t.seller_id, 'auction_id', t.auction_id);
end;
$fn$;

revoke all on function public.faellesbesked(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.faellesbesked(uuid, uuid, text) to service_role;
