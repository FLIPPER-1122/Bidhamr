-- =============================================================================
-- Admin: hurtighandlinger (admin-redesign, Filip 12. okt. 2026)
--
-- 1. "Tag sagen" på almindelige sager: sager.behandles_af / behandles_kl og
--    sag_tag() / sag_slip(). Så kan to medarbejdere ikke arbejde på den samme
--    sag uden at vide det. En anden kan overtage sagen, men skal bekræfte det
--    (p_overtag). Ændrer ikke, hvem der må afgøre sagen, og flytter ingen penge.
-- 2. "Notér" på en erhvervshenvendelse: erhverv_henvendelse_tilfoej_note()
--    lægger den NYE note til de gamle i databasen (med tid og navn), så to
--    samtidige noter ikke overskriver hinanden. erhverv_henvendelse_opdater
--    er uændret.
--
-- Kan køres flere gange (if not exists, create or replace, flettede checks).
-- Ingen eksisterende funktioner ændres, så der er intet md5-drifttjek.
-- Funktionerne er security definer og kun for service_role; rollen
-- (staff_chat_har_rolle / erhverv_har_adgang) tjekkes igen her.
-- Køres først på testdatabasen (pjiigmzqwlfepxnjdvug). Produktion kræver
-- Filips ja.
-- =============================================================================

-- Flet nye værdier ind i en check-constraint (samme hjælper som
-- 20261019010000_pengesikkerhed.sql). Midlertidig - droppes nederst.
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
  array['sag_taget', 'sag_sluppet', 'erhverv_henvendelse_note']);
select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_maal_type_check', 'maal_type',
  array['sag', 'erhverv_henvendelse']);

-- ===========================================================================
-- 1. Tag sagen
-- ===========================================================================
alter table public.sager
  add column if not exists behandles_af uuid references public.users(id) on delete restrict,
  add column if not exists behandles_kl timestamptz;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'sager_behandles_par'
                   and conrelid = 'public.sager'::regclass) then
    alter table public.sager add constraint sager_behandles_par
      check ((behandles_af is null) = (behandles_kl is null));
  end if;
end $do$;

comment on column public.sager.behandles_af is
  'Staff, der har taget sagen (sag_tag). Kun til at undgå dobbeltarbejde - giver ingen ekstra rettigheder. Ses kun af staff. Nulstilles, når sagen afsluttes (trigger sager_slip_ved_afslutning).';

-- Køber og sælger læser sager via kolonne-grants (20261003010000_sager.sql).
-- De nye kolonner er staff-data og gives ikke til authenticated.
revoke select (behandles_af, behandles_kl) on public.sager from anon, authenticated;

create index if not exists sager_behandles_af_idx on public.sager (behandles_af) where behandles_af is not null;

-- En afsluttet sag har ingen behandler: "Taget af" nulstilles, når sagen
-- afgøres eller lukkes - uanset hvilken vej (sag_afgoer, anke, retur, cron).
create or replace function public.sager_slip_ved_afslutning()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status not in ('aaben', 'afventer_retur') and new.behandles_af is not null then
    new.behandles_af := null;
    new.behandles_kl := null;
  end if;
  return new;
end;
$$;

revoke all on function public.sager_slip_ved_afslutning() from public, anon, authenticated;

drop trigger if exists sager_slip_ved_afslutning on public.sager;
create trigger sager_slip_ved_afslutning
  before update of status on public.sager
  for each row
  when (new.status is distinct from old.status)
  execute function public.sager_slip_ved_afslutning();

-- Sager, der allerede er afsluttet, men stadig står som taget (fx taget før
-- triggeren fandtes), ryddes.
update public.sager set behandles_af = null, behandles_kl = null
 where behandles_af is not null and status not in ('aaben', 'afventer_retur');

-- Tag (eller overtag) en sag. Svar: {kode: 'ok' | 'uaendret' | 'taget' |
-- 'ikke_fundet' | 'afsluttet' | 'inhabil', af_navn?, kl?}.
--   'taget': en anden har sagen - kald igen med p_overtag = true for at overtage.
create or replace function public.sag_tag(p_medarbejder uuid, p_sag uuid, p_overtag boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s        public.sager;
  t        public.trades;
  v_forrig text;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  select * into s from public.sager where id = p_sag for update;
  if s.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.status not in ('aaben', 'afventer_retur') then
    return jsonb_build_object('kode', 'afsluttet');
  end if;
  select * into t from public.trades where id = s.trade_id;
  -- Samme inhabilitetsregel som afgørelsen og sagssiden: part i handlen eller
  -- har handlet med en af parterne (penge_inhabil, 20261019010000).
  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if s.behandles_af = p_medarbejder then
    return jsonb_build_object('kode', 'uaendret');
  end if;
  if s.behandles_af is not null and not coalesce(p_overtag, false) then
    return jsonb_build_object(
      'kode', 'taget',
      'af_navn', (select u.navn from public.users u where u.id = s.behandles_af),
      'kl', s.behandles_kl);
  end if;

  v_forrig := (select u.navn from public.users u where u.id = s.behandles_af);
  update public.sager set behandles_af = p_medarbejder, behandles_kl = now() where id = p_sag;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_taget', 'sag', p_sag, null,
          case when s.behandles_af is not null
               then left('Overtaget fra ' || coalesce(v_forrig, 'ukendt'), 1000)
               else 'Tog sagen' end);
  return jsonb_build_object('kode', 'ok');
end;
$$;

revoke all on function public.sag_tag(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.sag_tag(uuid, uuid, boolean) to service_role;

-- Slip en sag. Kun den, der har den, eller admin/chef. Svar: {kode: 'ok' |
-- 'uaendret' | 'ikke_fundet' | 'ikke_din'}.
create or replace function public.sag_slip(p_medarbejder uuid, p_sag uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sager;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  select * into s from public.sager where id = p_sag for update;
  if s.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.behandles_af is null then
    return jsonb_build_object('kode', 'uaendret');
  end if;
  if s.behandles_af <> p_medarbejder and not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ikke_din');
  end if;
  update public.sager set behandles_af = null, behandles_kl = null where id = p_sag;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_sluppet', 'sag', p_sag, null,
          case when s.behandles_af <> p_medarbejder
               then left('Slap sagen for ' || coalesce((select u.navn from public.users u where u.id = s.behandles_af), 'ukendt'), 1000)
               else 'Slap sagen' end);
  return jsonb_build_object('kode', 'ok');
end;
$$;

revoke all on function public.sag_slip(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sag_slip(uuid, uuid) to service_role;

-- ===========================================================================
-- 2. Ny note på en erhvervshenvendelse
-- ===========================================================================
-- Lægger noten til de eksisterende med dato og navn. En ny henvendelse
-- sættes samtidig til 'i_gang'. Svar: {kode: 'ok' | 'ikke_fundet' |
-- 'tom_note' | 'for_lang_note'}.
create or replace function public.erhverv_henvendelse_tilfoej_note(p_staff uuid, p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h      public.erhverv_henvendelser;
  v_note text := btrim(coalesce(p_note, ''));
  v_ny   text;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if v_note = '' then
    return jsonb_build_object('kode', 'tom_note');
  end if;
  if char_length(v_note) > 1000 then
    return jsonb_build_object('kode', 'for_lang_note');
  end if;
  select * into h from public.erhverv_henvendelser where id = p_id for update;
  if h.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  v_ny := concat_ws(E'\n', nullif(btrim(coalesce(h.noter, '')), ''),
                    to_char(now() at time zone 'Europe/Copenhagen', 'DD-MM-YYYY HH24:MI') || ' '
                    || coalesce((select u.navn from public.users u where u.id = p_staff), 'Staff') || ': ' || v_note);
  -- Samme grænse som erhverv_henvendelse_opdater.
  if char_length(v_ny) > 10000 then
    return jsonb_build_object('kode', 'for_lang_note');
  end if;

  update public.erhverv_henvendelser
     set noter        = v_ny,
         status       = case when status = 'ny' then 'i_gang' else status end,
         behandlet_af = p_staff,
         behandlet_kl = now(),
         opdateret_kl = now()
   where id = p_id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_henvendelse_note', 'erhverv_henvendelse', p_id, null,
          left('Note tilføjet; ' || h.firmanavn || ' (CVR ' || h.cvr || ')', 1000));
  return jsonb_build_object('kode', 'ok', 'status', case when h.status = 'ny' then 'i_gang' else h.status end);
end;
$$;

revoke all on function public.erhverv_henvendelse_tilfoej_note(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.erhverv_henvendelse_tilfoej_note(uuid, uuid, text) to service_role;

drop function pg_temp.flet_check(regclass, text, text, text[]);
