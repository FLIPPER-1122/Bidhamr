-- firma_oversigt(): visninger tælles fra auction_views.
--
-- 20261010030000 summerede auctions.visninger, men den kolonne findes kun i
-- testdatabasen - produktionen tæller visninger i auction_views (én række pr.
-- seer pr. auktion). Uden denne rettelse fejler firma_oversigt() i
-- produktionen, hver gang den kaldes. Rettes på stedet i den nuværende
-- definition (tekst-erstatning, afbryder hvis teksten ikke findes). Idempotent.

set local lock_timeout = '5s';

do $do$
declare
  v_def text := pg_get_functiondef('public.firma_oversigt()'::regprocedure);
  v_gl1 constant text := $t$'visninger', coalesce(sum(a.visninger), 0),$t$;
  v_gl2 constant text := $t$'visninger_aktive', coalesce(sum(a.visninger) filter (where a.status = 'aktiv'), 0),$t$;
  v_ny1 constant text := $t$'visninger', (select count(*) from public.auction_views v
                       join public.auctions a2 on a2.id = v.auktion_id
                      where a2.bruger_id = v_uid),$t$;
  v_ny2 constant text := $t$'visninger_aktive', (select count(*) from public.auction_views v
                              join public.auctions a2 on a2.id = v.auktion_id
                             where a2.bruger_id = v_uid and a2.status = 'aktiv'),$t$;
begin
  if position('public.auction_views' in v_def) > 0 then
    return;
  end if;
  if position(v_gl1 in v_def) = 0 or position(v_gl2 in v_def) = 0 then
    raise exception 'firma_oversigt: forventede tekst om visninger blev ikke fundet';
  end if;
  execute replace(replace(v_def, v_gl1, v_ny1), v_gl2, v_ny2);
end;
$do$;
