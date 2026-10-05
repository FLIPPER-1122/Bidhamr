-- Rettelser til medarbejder-loggen (20261005050000_admin_brugere_log.sql)
-- efter review.
--
-- admin_medarbejder_log: et bruger-id i p_bruger matcher nu bruger_id ELLER
-- maal_id paa poster, hvor maalet er en bruger (maal_type = 'bruger'). Saa kan
-- indekset moderation_log_maal_idx (maal_type, maal_id) bruges sammen med
-- moderation_log_bruger_idx, i stedet for at scanne hele loggen. Samme regel
-- som brugerens historik (admin_bruger_historik i 050000). Et id paa en handel,
-- auktion eller sag matcher derfor ikke laengere maal_id her (feltet er til en
-- bruger).
--
-- Alt andet er uaendret i forhold til 050000 (samme signatur, kolonner og
-- rettigheder: kun service_role). Idempotent: create or replace.

-- p_bruger: bruger-id (eksakt, matcher bruger_id eller maal_id) eller fritekst
-- paa den beroerte brugers navn/e-mail. p_til er eksklusiv.
-- total_antal: antal poster i alt med filtrene (samme i alle raekker).
-- p_vis_saldo: fritekst for saldo_*-handlinger (gammel wallet; kan indeholde
-- beloeb) vises kun, naar den er sand (chef).
create or replace function public.admin_medarbejder_log(
  p_medarbejder uuid        default null,
  p_handling    text        default null,
  p_fra         timestamptz default null,
  p_til         timestamptz default null,
  p_bruger      text        default null,
  p_graense     integer     default 50,
  p_offset      integer     default 0,
  p_vis_saldo   boolean     default false)
returns table (
  id               uuid,
  oprettet_kl      timestamptz,
  medarbejder_id   uuid,
  medarbejder_navn text,
  er_system        boolean,
  handling         text,
  maal_type        text,
  maal_id          uuid,
  bruger_id        uuid,
  bruger_navn      text,
  bruger_email     text,
  aarsag           text,
  total_antal      bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  with s as (
    select nullif(btrim(coalesce(p_bruger, '')), '') as tekst
  ), b as (
    select s.tekst,
           case when s.tekst is null then null else public.admin_like_moenster(s.tekst) end as moenster,
           case when s.tekst ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then s.tekst::uuid end as uid
      from s
  )
  select l.id, l.oprettet_kl, l.medarbejder_id, m.navn,
         l.medarbejder_id = '00000000-0000-4000-8000-0000000b1d00'::uuid,
         l.handling, l.maal_type, l.maal_id, l.bruger_id, u.navn, u.email,
         case when l.handling like 'saldo\_%' and not coalesce(p_vis_saldo, false)
              then null else l.aarsag end,
         count(*) over ()
    from public.moderation_log l
    cross join b
    left join public.users m on m.id = l.medarbejder_id
    left join public.users u on u.id = l.bruger_id
   where (p_medarbejder is null or l.medarbejder_id = p_medarbejder)
     and (p_handling is null or l.handling = p_handling)
     and (p_fra is null or l.oprettet_kl >= p_fra)
     and (p_til is null or l.oprettet_kl < p_til)
     and (b.tekst is null
          or (b.uid is not null
              and (l.bruger_id = b.uid
                   or (l.maal_type = 'bruger' and l.maal_id = b.uid)))
          or (b.uid is null and (u.navn ilike b.moenster or u.email ilike b.moenster)))
   order by l.oprettet_kl desc, l.id desc
   limit least(greatest(coalesce(p_graense, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$fn$;

revoke all on function public.admin_medarbejder_log(uuid, text, timestamptz, timestamptz, text, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_medarbejder_log(uuid, text, timestamptz, timestamptz, text, integer, integer, boolean)
  to service_role;
