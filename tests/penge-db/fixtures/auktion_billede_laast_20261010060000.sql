-- auktion_billede_laast(text) som i produktion og test FØR 20261025010000_app_endpoints.sql
-- (pg_get_functiondef, hentet med SELECT 16. okt. 2026, md5 274d77676c299040c5661c7e68637893).
-- Bruges af tests/penge-db/appEndpoints.test.ts til md5-drift-tjekket.
CREATE OR REPLACE FUNCTION public.auktion_billede_laast(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_name is not null
     and exists (
       select 1
         from public.auctions a
        where a.bruger_id::text = split_part(p_name, '/', 1)
          and exists (
            select 1 from unnest(a.billeder) as u(url)
             where right(split_part(u.url, '?', 1), char_length(p_name) + 18)
                   = '/auktion-billeder/' || p_name
          )
          and (
            exists (select 1 from public.bids b where b.auktion_id = a.id)
            or exists (select 1 from public.trades t where t.auction_id = a.id)
          )
     );
$function$;
