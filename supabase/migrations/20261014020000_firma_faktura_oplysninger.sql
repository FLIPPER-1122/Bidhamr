-- Firmasalg: oplysninger til firmaets egen faktura på varen (Filip, 9. okt.
-- 2026 - "Faktura på varen ved firmasalg"). Firmaet sender selv fakturaen
-- fra sit eget regnskabsprogram; BidHamr giver det oplysningerne i Firma
-- oversigt -> Salg.
--
--   1. firmaer.bruger_brugtmoms - "Vi bruger brugtmomsordningen". Er den
--      slået til, vises momsen af varen ikke (brugtmoms må ikke stå på
--      fakturaen).
--   2. firma_saet_brugtmoms(p_til) - firmaet slår det til/fra for sig selv.
--   3. firma_faktura_salg(...) - købers navn (juridisk navn fra MitID, ellers
--      profilnavn), adresse, e-mail, vare, pris inkl. moms, moms-andel, dato
--      og handels-id for hvert BETALT salg. Kun firmaet selv - eller chef/
--      sælger (erhverv_har_adgang) med p_firma. Aldrig andre.
--   4. Tekst ved frosset sælger (BHU03): ny tekst i budtriggeren. Reglen er
--      uændret.
--
-- Idempotent. Kør først på testdatabasen.

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
  if p_til is null then
    raise exception 'Ugyldigt valg.' using errcode = '22023';
  end if;
  update public.firmaer f
     set bruger_brugtmoms = p_til,
         opdateret_kl = now()
   where f.bruger_id = v_uid
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
-- én handel. p_firma: firmaets bruger-id - kun for chef/sælger i admin;
-- ellers altid den indloggede firmakonto selv.
-- Kun salg, køberen har betalt (adresse og e-mail kendes først da).
-- Returnerer null, hvis brugeren ikke er en firmakonto.
create or replace function public.firma_faktura_salg(
  p_fra   date default null,
  p_til   date default null,
  p_trade uuid default null,
  p_firma uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid;
  f       record;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  if p_firma is null or p_firma = v_uid then
    v_firma := v_uid;
  elsif public.erhverv_har_adgang(v_uid) then
    v_firma := p_firma;
  else
    raise exception 'Ingen adgang.' using errcode = '42501';
  end if;

  select fm.firmanavn, fm.cvr, fm.bruger_brugtmoms
    into f
    from public.firmaer fm
   where fm.bruger_id = v_firma;
  if not found then
    return null;
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
                   'koeber_navn', coalesce(
                     (select nullif(btrim(m.juridisk_navn), '')
                        from public.mitid_verificeringer m
                       where m.bruger_id = t.buyer_id
                         and m.juridisk_navn is not null
                       order by (m.status = 'aktiv') desc, m.verificeret_kl desc
                       limit 1),
                     nullif(btrim(concat_ws(' ', u.fornavn, u.efternavn)), ''),
                     nullif(btrim(u.navn), ''),
                     nullif(btrim(hl.modtager_navn), '')),
                   'koeber_navn_mitid', exists (
                     select 1 from public.mitid_verificeringer m
                      where m.bruger_id = t.buyer_id
                        and nullif(btrim(m.juridisk_navn), '') is not null),
                   'koeber_email', coalesce(
                     nullif(btrim(hl.modtager_email), ''),
                     nullif(btrim(u.email), ''),
                     (select au.email::text from auth.users au where au.id = t.buyer_id)),
                   -- Hjemlevering: adressen fra handlen. Pakkeshop/afhentning:
                   -- købers adresse fra profilen (fritekst), hvis den findes.
                   'adresse', case when hl.maade = 'doer'
                                   then nullif(btrim(hl.modtager_adresse), '')
                                   else nullif(btrim(u.adresse), '') end,
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
grant execute on function public.firma_faktura_salg(date, date, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Frosset sælger: ny tekst (BHU03). Reglen er uændret.
-- ---------------------------------------------------------------------------
-- Gælder KUN en frosset sælger (en auktion er annulleret, fordi Stripe ikke
-- godkendte kontoen i tide). Normalt kan man godt byde, mens Stripe godkender.
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
