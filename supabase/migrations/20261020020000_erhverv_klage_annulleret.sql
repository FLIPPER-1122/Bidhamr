-- Klager over firmaer på annullerede handler (Filip, 12. okt. 2026).
--
-- En køber må kun klage over et firma (erhverv_klage_opret) på en
-- annulleret handel, når betalingens refusion_aarsag er:
--   'afsendelsesfrist' - firmaet sendte ikke varen i tide (automatisk
--                        annulleret, køber refunderet), eller
--   'sag'              - køberen fik medhold i en sag mod firmaet.
-- Alle andre årsager afvises med errcode BHE11 og præfikset
-- 'erhverv_klage_annulleret:' - også null (fx ubetalt), 'admin', 'stripe',
-- 'sen_betaling', 'ikke_afhentet', 'afhentningsfrist' og tabt indsigelse
-- (indsigelse_tabt_kl sat). Klager på handler, der ikke er annulleret, er
-- uændrede.
--
-- Kun erhverv_klage_opret ændres (erhverv_klage_adgang og dermed
-- klage-knappen/billed-upload er uændrede). Rettelsen sker på stedet i
-- funktionens definition, så search_path = '' og grants bevares.
--
-- Kan køres flere gange: md5-drift-tjek (normaliseret krop som
-- 20261019010000: CR fjernet, kommentarer fjernet, al whitespace fjernet,
-- små bogstaver). "gammel" = prod og test før denne migration (hentet med
-- SELECT 12. okt. 2026), "ny" = efter denne. Andet afbryder migrationen
-- (intet ændres). KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Retter en funktion på stedet: md5 før (gammel) eller allerede rettet (ny);
-- hvert mønster skal findes præcis det forventede antal gange; md5 bagefter
-- skal være "ny". Ellers afbrydes migrationen (som 20261019010000).
create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke - kør 20261016020000 først', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  -- Mønstrene renses også for CR (filen kan have CRLF-linjeskift).
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

do $do$
begin
  raise notice 'erhverv_klage_opret: %', pg_temp.ps_ret(
    'public.erhverv_klage_opret(uuid,text,text,jsonb)',
    'f87efb0b5fcbc355dc431e5cd9674985',
    'e18b75852357d855a43456901e81ea51',
    jsonb_build_array(jsonb_build_array(
$g$  elsif v_grund = 'for_sent' then
    raise exception 'erhverv_klage_ikke_tilladt: Fristen for at klage over handlen er udløbet.' using errcode = 'BHE11';
  end if;
$g$,
$n$  elsif v_grund = 'for_sent' then
    raise exception 'erhverv_klage_ikke_tilladt: Fristen for at klage over handlen er udløbet.' using errcode = 'BHE11';
  end if;

  -- Annulleret handel (Filip, 12. okt. 2026): kun når firmaet ikke sendte
  -- varen (afsendelsesfrist) eller køberen fik medhold i en sag - og ikke
  -- efter en tabt indsigelse. Adgangen er tjekket ovenfor (købers handel).
  if exists (select 1 from public.trades tr
              where tr.id = p_trade and tr.status = 'annulleret')
     and not exists (select 1 from public.betalinger bt
                      where bt.trade_id = p_trade
                        and bt.refusion_aarsag in ('afsendelsesfrist', 'sag')
                        and bt.indsigelse_tabt_kl is null) then
    raise exception 'erhverv_klage_annulleret: Du kan kun klage over firmaet på en annulleret handel, hvis firmaet ikke sendte varen, eller hvis du har fået medhold i en sag.' using errcode = 'BHE11';
  end if;
$n$, 1)));
end $do$;

-- Grants som 20261016020000 (uændrede af rettelsen på stedet - gentages for
-- en sikkerheds skyld).
revoke all on function public.erhverv_klage_opret(uuid, text, text, jsonb) from public, anon;
grant execute on function public.erhverv_klage_opret(uuid, text, text, jsonb) to authenticated;

drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.krop_md5(text);
