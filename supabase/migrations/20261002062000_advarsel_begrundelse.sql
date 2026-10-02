-- Advarsler: begrundelse til brugeren (ROADMAP-BESLUTNINGER, "Advarsler og
-- begrundelse", Filip 2. oktober 2026).
--
-- Når staff giver en advarsel, skrives to tekster:
--   * aarsag             = intern note. Kun staff ser den. Nu valgfri.
--   * begrundelse_bruger = begrundelse til brugeren. Kræves (1-1000 tegn) for
--                          nye advarsler. Vises i notifikationen og på /konto.
--
-- Brugeren læser sine egne advarsler via mine_advarsler(), som kun returnerer
-- id, begrundelse_bruger og oprettet_kl. Tabellen har stadig INGEN policies,
-- så aarsag og oprettet_af kan aldrig læses fra browseren.
--
-- Idempotent: kan køres flere gange.

-- ============================================================ 1. Kolonne

alter table public.advarsler
  add column if not exists begrundelse_bruger text;

-- Gamle advarsler har ingen begrundelse til brugeren (null). Nye skal have en.
alter table public.advarsler
  drop constraint if exists advarsler_begrundelse_bruger_laengde;
alter table public.advarsler
  add constraint advarsler_begrundelse_bruger_laengde check (
    begrundelse_bruger is null
    or (char_length(btrim(begrundelse_bruger)) between 1 and 1000));

-- Den interne note er nu valgfri.
alter table public.advarsler
  alter column aarsag drop not null;

comment on column public.advarsler.aarsag is
  'Intern note - kun staff. Må aldrig vises for brugeren.';
comment on column public.advarsler.begrundelse_bruger is
  'Begrundelse til brugeren (1-1000 tegn). Vises i notifikation og på /konto.';

-- Fortsat ingen policies paa advarsler (se 20260727000000). Sikrer at ingen
-- tidligere grants giver browseren direkte adgang.
alter table public.advarsler enable row level security;
revoke all on public.advarsler from anon, authenticated;

-- ============================================================ 2. Brugerens egne advarsler

create or replace function public.mine_advarsler()
returns table (id uuid, begrundelse_bruger text, oprettet_kl timestamptz)
language sql stable security definer set search_path = public as $fn$
  select a.id, a.begrundelse_bruger, a.oprettet_kl
    from public.advarsler a
   where a.bruger_id = auth.uid()
   order by a.oprettet_kl desc;
$fn$;

revoke all on function public.mine_advarsler() from public, anon;
grant execute on function public.mine_advarsler() to authenticated, service_role;

-- ============================================================ 3. advarsel_ubetalt

-- Ny parameter p_begrundelse_bruger (kræves, når p_giv = true). p_begrundelse
-- er nu den interne note ved advarsel (valgfri) og begrundelsen for at afvise
-- sagen ved afvisning (påkrævet, som før).
-- Defaulten gør, at gamle kald stadig rammer funktionen, men de afvises med
-- 'begrundelse_bruger_mangler' i stedet for at oprette en advarsel uden
-- begrundelse til brugeren.
-- Koder: ok, ikke_fundet, ingen_adgang, behandlet, begrundelse_mangler,
-- begrundelse_for_lang, begrundelse_bruger_mangler, begrundelse_bruger_for_lang.
drop function if exists public.advarsel_ubetalt(uuid, uuid, boolean, text);

create or replace function public.advarsel_ubetalt(
  p_sag uuid, p_medarbejder uuid, p_giv boolean, p_begrundelse text,
  p_begrundelse_bruger text default null)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  s       record;
  grund   text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  bruger  text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  standard constant text := 'Betalte ikke for vundet auktion';
begin
  if not exists (select 1 from public.users
                  where id = p_medarbejder and rolle in ('medarbejder', 'admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  if grund is not null and char_length(grund) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;
  if p_giv then
    if bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
    if char_length(bruger) > 1000 then
      return jsonb_build_object('kode', 'begrundelse_bruger_for_lang');
    end if;
  elsif grund is null then
    return jsonb_build_object('kode', 'begrundelse_mangler');
  end if;

  select * into s from public.ubetalte_vindere where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if s.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;

  -- Idempotent: kun en sag, der stadig afventer, behandles.
  update public.ubetalte_vindere
     set status       = case when p_giv then 'advarsel_givet' else 'afvist' end,
         behandlet_af = p_medarbejder,
         behandlet_kl = now(),
         begrundelse  = case when p_giv then coalesce(grund, standard) else grund end
   where id = s.id and status = 'afventer';
  if not found then return jsonb_build_object('kode', 'behandlet'); end if;

  if p_giv then
    insert into public.advarsler (bruger_id, oprettet_af, aarsag, begrundelse_bruger)
    values (s.buyer_id, p_medarbejder, coalesce(grund, standard), bruger);

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'advarsel', 'handel', s.trade_id, s.buyer_id,
            standard || coalesce(': ' || grund, '') || ' | Til brugeren: ' || bruger);
  else
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'ubetalt_afvist', 'handel', s.trade_id, s.buyer_id, grund);
  end if;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.advarsel_ubetalt(uuid, uuid, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.advarsel_ubetalt(uuid, uuid, boolean, text, text)
  to service_role;

-- ============================================================ 4. admin_advarsel_betaling

-- p_begrundelse er nu den interne note (valgfri, højst 2000 tegn).
-- p_begrundelse_bruger kræves (1-1000 tegn). Default null af samme grund som
-- ovenfor: gamle kald afvises med 'begrundelse_bruger_mangler'.
-- Koder: ok, ingen_adgang, ugyldig_modtager, begrundelse_for_lang,
-- begrundelse_bruger_mangler, begrundelse_bruger_for_lang, ikke_fundet,
-- indsigelse, allerede_loest.
drop function if exists public.admin_advarsel_betaling(uuid, uuid, text, text);

create or replace function public.admin_advarsel_betaling(
  p_betaling uuid, p_medarbejder uuid, p_modtager text, p_begrundelse text,
  p_begrundelse_bruger text default null)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b        record;
  grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  bruger   text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  modtager uuid;
  hvem     text;
begin
  if not exists (select 1 from public.users
                  where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_modtager is null or p_modtager not in ('koeber', 'saelger') then
    return jsonb_build_object('kode', 'ugyldig_modtager');
  end if;
  if bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
  if char_length(bruger) > 1000 then
    return jsonb_build_object('kode', 'begrundelse_bruger_for_lang');
  end if;
  if grund is not null and char_length(grund) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;

  select id, trade_id, buyer_id, seller_id, kraever_opmaerksomhed,
         indsigelse_kl, indsigelse_status
    into b
    from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;

  -- Idempotent: kun en raekke, der stadig kraever opmaerksomhed, aendres.
  update public.betalinger
     set kraever_opmaerksomhed = false
   where id = b.id and kraever_opmaerksomhed;
  if not found then return jsonb_build_object('kode', 'allerede_loest'); end if;

  if p_modtager = 'koeber' then
    modtager := b.buyer_id; hvem := 'køber';
  else
    modtager := b.seller_id; hvem := 'sælger';
  end if;
  if modtager is null then
    raise exception 'Betalingen mangler %', hvem;
  end if;

  insert into public.advarsler (bruger_id, oprettet_af, aarsag, begrundelse_bruger)
  values (modtager, p_medarbejder, grund, bruger);

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'advarsel', 'handel', b.trade_id, modtager,
          coalesce(grund || ' | ', '') || 'Til brugeren: ' || bruger);

  -- Samme logning som "Markér som løst", saa sagen vises under "Løste".
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'betaling_loest', 'handel', b.trade_id, b.buyer_id,
          'Advarsel givet til ' || hvem || ': ' || coalesce(grund, bruger));

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.admin_advarsel_betaling(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_advarsel_betaling(uuid, uuid, text, text, text)
  to service_role;
