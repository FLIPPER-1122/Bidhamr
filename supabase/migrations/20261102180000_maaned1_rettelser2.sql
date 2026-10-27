-- Rettelser efter review af 20261102150000_maaned1_rettelser.sql (27. okt. 2026).
--
-- Bygger på 20261102150000 (skal være kørt først - md5-drifttjek nedenfor).
-- Rører IKKE grants på users/auctions (20261102060000) og intet fra
-- 120000-160000.
--
-- Indhold:
--   1. Kun kort (laasKunKort): alarmen gives, når forsoeg >= 3 og alarmen
--      endnu ikke er givet for abonnementet (ny kolonne kort_laas_alarm_sub) -
--      ikke kun ved præcis 3. Rækken låses (for update), så samtidige kald
--      (webhook og cron) tæller ét ad gangen, og præcis ét kald får alarmen.
--      Svaret har nu også 'alarm' (true/false). Abonnementer, der allerede er
--      nået til 3 eller flere, regnes for at have fået alarmen (150000 gav den
--      ved 3) - så de ikke får den igen.
--   2. Introrabat, der venter for længe: ny kolonne intro_planlagt_kl (sættes
--      af en trigger, når en aftale bliver 'planlagt' eller får en ny nøgle;
--      null, når den ikke længere er planlagt) og firma_intro_venter_alarm:
--      betalings-cron'en logger ÉN drift-alarm pr. aftale (intro_noegle), når
--      en planlagt introrabat har ventet over 30 minutter på at komme på
--      abonnementet (afvist eller venter), så staff opdager det.
--
-- md5-drift-tjek: firma_kort_laas_fejl skal enten være 20261102150000's eller
-- allerede denne migrations; de nye funktioner må ikke findes med et andet
-- indhold. Ellers afbrydes (intet ændres).
-- Idempotent. Én transaktion. Kør først på testdatabasen. KØRES IKKE i
-- produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Hjælper og drift-tjek
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

do $do$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.firma_kort_laas_opgivet(uuid,text)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'firmaer' and column_name = 'kort_laas_forsoeg') then
    raise exception 'Forudsætning mangler: kør 20261102150000 først';
  end if;
  for r in
    select * from (values
      -- (funktion, forrige migrations (null = ny funktion), denne migrations)
      ('public.firma_kort_laas_fejl(uuid,text)', '1eb1b2e05ef9b377be2e417ba91c5d25', '7e972fdbe2772eeedb5e3bd71bbb3498'),
      ('public.firmaer_intro_planlagt_kl()', null, '2fd118f999994d27b6eb23321da00f07'),
      ('public.firma_intro_venter_alarm(uuid,integer)', null, 'd965f0cfecb5c87ae5313ea1ac5746ed')
    ) as t(fn, gammel, ny)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      if r.gammel is not null then
        raise exception '% findes ikke - kør de tidligere migrationer først', r.fn;
      end if;
    elsif h is distinct from r.gammel and h <> r.ny then
      raise exception '%: md5 % passer hverken med forrige migration (%) eller denne (%) - kontrollér funktionen, før migrationen køres',
        r.fn, h, coalesce(r.gammel, 'ingen'), r.ny;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 1. Kun kort: alarm ved forsoeg >= 3, når den ikke er givet
-- ===========================================================================
alter table public.firmaer add column if not exists kort_laas_alarm_sub text;
comment on column public.firmaer.kort_laas_alarm_sub is
  'Abonnementet, som drift-alarmen om låsen til kun kort er givet for (efter 3 permanente fejl). Intern. 20261102180000.';

-- 150000 gav alarmen ved præcis 3: de, der er nået dertil, har fået den.
update public.firmaer
   set kort_laas_alarm_sub = kort_laas_fejl_sub
 where kort_laas_forsoeg >= 3
   and kort_laas_fejl_sub is not null
   and kort_laas_alarm_sub is distinct from kort_laas_fejl_sub;

-- En permanent fejl: tæller op (nulstilles for et nyt abonnement). Svar:
-- forsoeg (antal nu), opgivet (forsoeg >= 3) og alarm (true for præcis ét
-- kald: det første, der når 3 eller flere, uden at alarmen er givet for
-- abonnementet).
create or replace function public.firma_kort_laas_fejl(p_firma uuid, p_subscription_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_forsoeg integer;
  v_fejl_sub text;
  v_alarm_sub text;
  v_antal integer;
  v_alarm boolean;
begin
  select f.kort_laas_forsoeg, f.kort_laas_fejl_sub, f.kort_laas_alarm_sub
    into v_forsoeg, v_fejl_sub, v_alarm_sub
    from public.firmaer f
   where f.id = p_firma and f.stripe_subscription_id = p_subscription_id
     for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  v_antal := case when v_fejl_sub is not distinct from p_subscription_id then v_forsoeg + 1 else 1 end;
  v_alarm := v_antal >= 3 and v_alarm_sub is distinct from p_subscription_id;
  update public.firmaer f
     set kort_laas_forsoeg = v_antal,
         kort_laas_fejl_sub = left(p_subscription_id, 255),
         kort_laas_alarm_sub = case when v_alarm then left(p_subscription_id, 255) else f.kort_laas_alarm_sub end
   where f.id = p_firma;
  return jsonb_build_object('kode', 'ok', 'forsoeg', v_antal, 'opgivet', v_antal >= 3, 'alarm', v_alarm);
end $$;
revoke all on function public.firma_kort_laas_fejl(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_kort_laas_fejl(uuid, text) to service_role;
comment on function public.firma_kort_laas_fejl(uuid, text) is
  'Permanent fejl ved låsen til kun kort: tæller op pr. abonnement; alarm=true for præcis ét kald, når forsoeg >= 3 og alarmen ikke er givet (kort_laas_alarm_sub). 20261102180000.';

-- ===========================================================================
-- 2. Introrabat, der venter for længe
-- ===========================================================================
alter table public.firmaer add column if not exists intro_planlagt_kl timestamptz;
alter table public.firmaer add column if not exists intro_venter_alarm_noegle text;
comment on column public.firmaer.intro_planlagt_kl is
  'Hvornår den nuværende introrabat-aftale blev planlagt (intro_status planlagt / ny intro_noegle). Null, når den ikke er planlagt. Sættes af triggeren firmaer_intro_planlagt_kl. Intern. 20261102180000.';
comment on column public.firmaer.intro_venter_alarm_noegle is
  'Aftalen (intro_noegle), som drift-alarmen "introrabatten venter" er givet for (højst én pr. aftale). Intern. 20261102180000.';

-- Eksisterende planlagte aftaler: bedste bud er seneste ændring.
update public.firmaer
   set intro_planlagt_kl = opdateret_kl
 where intro_status = 'planlagt'
   and intro_planlagt_kl is null;

create or replace function public.firmaer_intro_planlagt_kl()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.intro_status = 'planlagt' then
    if tg_op = 'INSERT'
       or old.intro_status is distinct from 'planlagt'
       or old.intro_noegle is distinct from new.intro_noegle
       or new.intro_planlagt_kl is null then
      new.intro_planlagt_kl := now();
    end if;
  else
    new.intro_planlagt_kl := null;
  end if;
  return new;
end $$;
revoke all on function public.firmaer_intro_planlagt_kl() from public, anon, authenticated;

drop trigger if exists firmaer_intro_planlagt_kl on public.firmaer;
create trigger firmaer_intro_planlagt_kl
  before insert or update of intro_status, intro_noegle on public.firmaer
  for each row execute function public.firmaer_intro_planlagt_kl();

-- Har firmaets planlagte introrabat ventet over p_minutter (standard 30) på
-- at komme på abonnementet, og er alarmen ikke givet for netop denne aftale?
-- Så markeres den som givet, og svaret er alarm=true (præcis ét kald pr.
-- aftale) med ventet_min. Ellers alarm=false.
create or replace function public.firma_intro_venter_alarm(p_firma uuid, p_minutter integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_kl timestamptz;
begin
  update public.firmaer f
     set intro_venter_alarm_noegle = f.intro_noegle
   where f.id = p_firma
     and f.intro_status = 'planlagt'
     and f.intro_noegle is not null
     and f.intro_planlagt_kl is not null
     and f.intro_planlagt_kl < now() - make_interval(mins => greatest(coalesce(p_minutter, 30), 1))
     and f.intro_venter_alarm_noegle is distinct from f.intro_noegle
  returning f.intro_planlagt_kl into v_kl;
  if v_kl is null then
    return jsonb_build_object('alarm', false);
  end if;
  return jsonb_build_object('alarm', true, 'ventet_min', floor(extract(epoch from now() - v_kl) / 60)::integer);
end $$;
revoke all on function public.firma_intro_venter_alarm(uuid, integer) from public, anon, authenticated;
grant execute on function public.firma_intro_venter_alarm(uuid, integer) to service_role;
comment on function public.firma_intro_venter_alarm(uuid, integer) is
  'Betalings-cron: alarm=true én gang pr. aftale (intro_noegle), når en planlagt introrabat har ventet over p_minutter (30) på abonnementet. 20261102180000.';

notify pgrst, 'reload schema';
