-- Firmasalg: oplysninger til firmaets egen faktura på varen (Filip, 9. okt.
-- 2026 - "Faktura på varen ved firmasalg"). Firmaet sender selv fakturaen
-- fra sit eget regnskabsprogram; BidHamr giver det oplysningerne i Firma
-- oversigt -> Salg.
--
--   1. firmaer.bruger_brugtmoms - "Vi bruger brugtmomsordningen". Er den
--      slået til, vises momsen af varen ikke (brugtmoms må ikke stå på
--      fakturaen).
--   2. firma_saet_brugtmoms(p_til) - firmaet slår det til/fra for sig selv.
--   3. firma_faktura_salg(...) - købers navn (navnet, køberen gav til
--      handlen, ellers profilens navn - ALDRIG navnet fra MitID, som kun
--      bruges internt), adresse (kun den, køberen gav til handlen ved levering
--      til døren - ingen profiladresse), e-mail, vare, pris inkl. moms, dato
--      og handels-id for hvert BETALT salg. Kun firmaet selv (ikke en lukket
--      eller slettet konto) - eller chef/sælger (erhverv_har_adgang) med
--      p_firma; staffs opslag logges i moderation_log. Aldrig andre.
--   4. Tekst ved frosset sælger (BHU03): ny tekst i budtriggeren (med
--      drift-tjek af den eksisterende krop). Reglen er uændret.
--
-- Idempotent (kan køres igen). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælper: flet værdier ind i en eksisterende CHECK (som 20261013010000).
-- ---------------------------------------------------------------------------
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
  array['firma_faktura_opslag']);

-- ---------------------------------------------------------------------------
-- 1. Brugtmoms
-- ---------------------------------------------------------------------------
alter table public.firmaer
  add column if not exists bruger_brugtmoms boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. firma_saet_brugtmoms
-- ---------------------------------------------------------------------------
create or replace function public.firma_saet_brugtmoms(p_til boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ny  boolean;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  -- Kræver et eksplicit ja/nej.
  if p_til is null then
    raise exception 'Ugyldigt valg.' using errcode = '22023';
  end if;
  update public.firmaer f
     set bruger_brugtmoms = p_til,
         opdateret_kl = now()
   where f.bruger_id = v_uid
     and exists (select 1 from public.users u
                  where u.id = v_uid
                    and u.konto_lukket_kl is null
                    and u.konto_slettet_kl is null)
  returning f.bruger_brugtmoms into v_ny;
  if not found then
    raise exception 'Kun firmakonti kan ændre dette.' using errcode = '42501';
  end if;
  return v_ny;
end;
$$;

revoke all on function public.firma_saet_brugtmoms(boolean) from public, anon;
grant execute on function public.firma_saet_brugtmoms(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. firma_faktura_salg
-- ---------------------------------------------------------------------------
-- p_fra/p_til: periode (salgsdato, dansk tid, begge dage med). p_trade: kun
-- én handel. p_firma: firmaets bruger-id - kun for chef/sælger i admin
-- (logges); ellers altid den indloggede firmakonto selv.
-- Kun salg, køberen har betalt (adresse og e-mail kendes først da).
-- Returnerer null, hvis brugeren ikke er en firmakonto.
-- Ikke stable: staffs opslag logges (insert). Den gamle stable-udgave
-- erstattes (samme signatur).
create or replace function public.firma_faktura_salg(
  p_fra   date default null,
  p_til   date default null,
  p_trade uuid default null,
  p_firma uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid;
  v_staff boolean := false;
  f       record;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  if p_firma is null or p_firma = v_uid then
    v_firma := v_uid;
    -- En lukket eller slettet firmakonto får ingen købsoplysninger.
    if not exists (select 1 from public.users u
                    where u.id = v_uid
                      and u.konto_lukket_kl is null
                      and u.konto_slettet_kl is null) then
      raise exception 'Ingen adgang.' using errcode = '42501';
    end if;
  elsif public.erhverv_har_adgang(v_uid) then
    v_firma := p_firma;
    v_staff := true;
  else
    raise exception 'Ingen adgang.' using errcode = '42501';
  end if;

  select fm.id, fm.firmanavn, fm.cvr, fm.bruger_brugtmoms
    into f
    from public.firmaer fm
   where fm.bruger_id = v_firma;
  if not found then
    return null;
  end if;

  -- Staff (chef/sælger) slår et firmas købsoplysninger op: logges.
  if v_staff then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (v_uid, 'firma_faktura_opslag', 'firma', f.id, v_firma,
            left(concat_ws('; ',
                           'Oplysninger til faktura (købere) slået op',
                           case when p_trade is not null then 'Handel ' || p_trade::text end,
                           case when p_fra is not null or p_til is not null
                                then 'Periode ' || coalesce(p_fra::text, '…') || ' - ' || coalesce(p_til::text, '…') end,
                           f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));
  end if;

  return jsonb_build_object(
    'firma', jsonb_build_object(
      'firmanavn', f.firmanavn,
      'cvr', f.cvr,
      'brugtmoms', f.bruger_brugtmoms),
    'salg', coalesce((
      select jsonb_agg(r.data order by r.solgt desc)
        from (
          select t.created_at as solgt,
                 jsonb_build_object(
                   'trade_id', t.id,
                   'solgt_kl', t.created_at,
                   'betalt_kl', b.betalt_kl,
                   'refunderet_kl', b.refunderet_kl,
                   'titel', a.titel,
                   'stand', a.stand,
                   'pris_oere', coalesce(b.bud_oere, round(t.amount * 100)::bigint),
                   'afhentning', coalesce(t.afhentning, false),
                   'levering', hl.maade,
                   -- Aldrig navnet fra MitID (kun internt).
                   'koeber_navn', coalesce(
                     nullif(btrim(hl.modtager_navn), ''),
                     nullif(btrim(concat_ws(' ', u.fornavn, u.efternavn)), ''),
                     nullif(btrim(u.navn), '')),
                   'koeber_email', coalesce(
                     nullif(btrim(hl.modtager_email), ''),
                     nullif(btrim(u.email), ''),
                     (select au.email::text from auth.users au where au.id = t.buyer_id)),
                   -- Kun adressen, køberen gav til handlen (levering til
                   -- døren). Ingen profiladresse.
                   'adresse', case when hl.maade = 'doer'
                                   then nullif(btrim(hl.modtager_adresse), '') end,
                   'postnummer', case when hl.maade = 'doer'
                                      then nullif(btrim(hl.modtager_postnummer), '') end,
                   'by', case when hl.maade = 'doer'
                              then nullif(btrim(hl.modtager_by), '') end
                 ) as data
            from public.trades t
            join public.betalinger b on b.trade_id = t.id and b.betalt_kl is not null
            left join public.auctions a on a.id = t.auction_id
            left join public.users u on u.id = t.buyer_id
            left join public.handel_levering hl on hl.trade_id = t.id
           where t.seller_id = v_firma
             and (p_trade is null or t.id = p_trade)
             and (p_fra is null or t.created_at >= (p_fra::timestamp at time zone 'Europe/Copenhagen'))
             and (p_til is null or t.created_at < ((p_til + 1)::timestamp at time zone 'Europe/Copenhagen'))
           order by t.created_at desc
           limit 2000
        ) r), '[]'::jsonb));
end;
$$;

revoke all on function public.firma_faktura_salg(date, date, uuid, uuid) from public, anon;
-- authenticated skal kunne kalde den: adgangen afgøres af auth.uid() i
-- funktionen (firmaet selv eller chef/sælger).
grant execute on function public.firma_faktura_salg(date, date, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Frosset sælger: ny tekst (BHU03). Reglen er uændret.
-- ---------------------------------------------------------------------------
-- Gælder KUN en frosset sælger (en auktion er annulleret, fordi Stripe ikke
-- godkendte kontoen i tide). Normalt kan man godt byde, mens Stripe godkender.
--
-- Drift-tjek: kroppen skal være den fra 20261011020000 (gammel) eller den
-- herunder (ny - så filen kan køres igen). md5 af prosrc med LF-linjeskift
-- (produktionen har den gamle krop med CRLF).
do $$
declare
  v_md5 text;
begin
  select md5(replace(p.prosrc, E'\r\n', E'\n')) into v_md5
    from pg_proc p
   where p.oid = 'public.bids_kraev_saelger_ikke_frosset()'::regprocedure;
  if v_md5 is distinct from 'e9cadf6d5b52771d1ae91f5f4e925d3a'
     and v_md5 is distinct from '8247fab8702abdaee1c66bcabeaf78e9' then
    raise exception 'bids_kraev_saelger_ikke_frosset er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
end $$;

create or replace function public.bids_kraev_saelger_ikke_frosset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (
    select 1
      from public.auctions a
      join public.betalingsprofiler bp on bp.user_id = a.bruger_id
     where a.id = new.auktion_id
       and bp.saelger_frosset_kl is not null) then
    raise exception 'saelger_frosset: Sælgeren skal have godkendt sin udbetalingskonto hos Stripe, før der kan bydes på sælgerens auktioner igen.'
      using errcode = 'BHU03';
  end if;
  return new;
end;
$fn$;

revoke all on function public.bids_kraev_saelger_ikke_frosset() from public, anon, authenticated;
