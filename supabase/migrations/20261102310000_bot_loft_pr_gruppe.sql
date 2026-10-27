-- BidHamr-bot: USD-loft pr. gruppe (reviewer B1 efter 20261102290000_bot_rettelser.sql).
--
-- Problemet: USD-loftet var fælles, så nogle få (fx mange besøgende uden
-- login) kunne bruge hele døgnets budget og lukke botten for alle.
--
-- Indhold:
--   1. bot_indstillinger får to nye indstillinger (kun service-role; chefen
--      ændrer dem på /admin/bot):
--        - anon_andel: den andel af doegnloft_usd, som samtaler uden login
--          tilsammen må bruge (standard 0,5 = 50 %). Så har indloggede altid
--          budget tilbage.
--        - bruger_loft_usd: USD pr. indlogget bruger pr. døgn (standard 0,25).
--      Og opdateret_af (hvilken chef der sidst ændrede indstillingerne).
--      Standarden for doegnloft_usd hæves fra 2 til 5 USD. Den eksisterende
--      række hæves kun første gang migrationen køres (når anon_andel
--      tilføjes), så en senere ændring fra chefen aldrig overskrives.
--   2. bot_ny_besked(): ny parameter p_maks_svar_usd (serverens skøn over
--      den højeste pris for ét svar med den valgte model, src/lib/bot/konfig.ts).
--      Svar, der er i gang (brugerbeskeder fra de sidste 60 sekunder uden
--      bot-svar i samme samtale), lægges oven i summen med p_maks_svar_usd
--      pr. stk. Rækkefølgen af lofterne:
--        - pr. bruger:      'loft_bruger_usd'
--        - uden login:      'loft_alle' med grund 'anon_usd'
--        - alle samlet:     'loft_alle' med grund 'usd' (+ alarm som før)
--      Den gamle signatur (5 parametre) fjernes. p_maks_svar_usd har default
--      0, så den nuværende serverkode virker uændret, indtil den nye er ude.
--
-- Idempotent: add column if not exists / drop constraint if exists /
-- drop function if exists / create or replace / create index if not exists.
-- Ingen handelsdata ændres.

-- ============================================================ 1. Indstillinger

do $do$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bot_indstillinger' and column_name = 'anon_andel'
  ) then
    alter table public.bot_indstillinger add column anon_andel numeric(4, 3) not null default 0.5;
    -- Første kørsel: hæv døgnloftet fra den gamle standard (2 USD) til 5 USD.
    update public.bot_indstillinger set doegnloft_usd = 5, opdateret_kl = now()
     where id and doegnloft_usd = 2;
  end if;
end $do$;

alter table public.bot_indstillinger add column if not exists bruger_loft_usd numeric(10, 4) not null default 0.25;
alter table public.bot_indstillinger add column if not exists opdateret_af uuid;
alter table public.bot_indstillinger alter column doegnloft_usd set default 5;

alter table public.bot_indstillinger drop constraint if exists bot_indstillinger_vaerdier;
alter table public.bot_indstillinger add constraint bot_indstillinger_vaerdier check (
  doegnloft_usd between 0 and 1000
  and doegnloft_anon >= 0
  and anon_andel between 0 and 1
  and bruger_loft_usd between 0 and 100);

comment on table public.bot_indstillinger is
  'BidHamr-bot: døgnlofter. Én række. Kun service-role. Chefen ændrer dem på /admin/bot. '
  'doegnloft_usd = alle samlet; anon_andel = andel af doegnloft_usd for alle uden login; '
  'bruger_loft_usd = pr. indlogget bruger; doegnloft_anon = beskeder uden login.';
comment on column public.bot_indstillinger.anon_andel is
  'Andel (0-1) af doegnloft_usd, som samtaler uden login tilsammen må bruge pr. døgn. Standard 0,5.';
comment on column public.bot_indstillinger.bruger_loft_usd is
  'USD pr. indlogget bruger pr. døgn. Standard 0,25.';

insert into public.bot_indstillinger (id) values (true) on conflict (id) do nothing;

revoke all on public.bot_indstillinger from public, anon, authenticated;
grant select, update on public.bot_indstillinger to service_role;

-- ============================================================ 2. Indeks

-- Summen pr. bruger og uden login (bot-svar).
create index if not exists bot_beskeder_bot_bruger_tid_idx
  on public.bot_beskeder (bruger_id, oprettet_kl) where rolle = 'bot';
create index if not exists bot_beskeder_bot_anon_tid_idx
  on public.bot_beskeder (oprettet_kl) where rolle = 'bot' and bruger_id is null;
-- Svar i gang (alle brugerbeskeder de sidste 60 sekunder).
create index if not exists bot_beskeder_bruger_tid_idx
  on public.bot_beskeder (oprettet_kl) where rolle = 'bruger';

-- ============================================================ 3. Loftet

drop function if exists public.bot_ny_besked(uuid, uuid, text, text, text);

-- Som i 20261102290000, plus USD-loft pr. bruger, for alle uden login samlet
-- og et skøn for svar i gang (se toppen).
create or replace function public.bot_ny_besked(
  p_samtale        uuid,
  p_bruger         uuid,
  p_ip_hash        text,
  p_kilde          text,
  p_tekst          text,
  p_maks_svar_usd  numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c_maks_bruger   constant integer := 30;
  c_maks_ip_anon  constant integer := 30;
  c_maks_ip       constant integer := 100;
  c_maks_samtale  constant integer := 40;
  c_maks_alle     constant integer := 5000;
  c_maks_tegn     constant integer := 1000;
  v_fra     timestamptz := now() - interval '24 hours';
  v_igang_fra timestamptz := now() - interval '60 seconds';
  v_samtale uuid := p_samtale;
  v_tekst   text := btrim(coalesce(p_tekst, ''));
  -- Skønnet pr. svar i gang. Aldrig negativt, og højst 10 USD (værn mod
  -- en fejl i serveren).
  v_maks    numeric := least(greatest(coalesce(p_maks_svar_usd, 0), 0), 10);
  v_id      uuid;
  v_usd     numeric;
  v_igang   integer;
  v_alarm   boolean := false;
  s         record;
  ind       record;
  n         integer;
begin
  if char_length(v_tekst) = 0 or char_length(v_tekst) > c_maks_tegn then
    return jsonb_build_object('kode', 'ugyldig_laengde');
  end if;
  if p_ip_hash is null or char_length(p_ip_hash) not between 16 and 128 then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if p_kilde is null or p_kilde not in ('web', 'app') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  perform pg_advisory_xact_lock(hashtext('bidhamr_bot_loft'));

  select coalesce(i.doegnloft_usd, 5) as usd,
         coalesce(i.doegnloft_anon, 2000) as anon,
         coalesce(i.anon_andel, 0.5) as anon_andel,
         coalesce(i.bruger_loft_usd, 0.25) as bruger_usd
    into ind
    from (select 1) x left join public.bot_indstillinger i on i.id;

  if v_samtale is not null then
    select t.bruger_id, t.ip_hash, t.renset_kl into s from public.bot_samtaler t where t.id = v_samtale;
    if not found
       or s.bruger_id is distinct from p_bruger
       or s.renset_kl is not null
       or (p_bruger is null and s.ip_hash is distinct from p_ip_hash) then
      return jsonb_build_object('kode', 'ukendt_samtale');
    end if;
    select count(*) into n from public.bot_beskeder b
     where b.samtale_id = v_samtale and b.rolle = 'bruger';
    if n >= c_maks_samtale then
      return jsonb_build_object('kode', 'samtale_fuld');
    end if;
  end if;

  if p_bruger is not null then
    select count(*) into n from public.bot_beskeder b
     where b.bruger_id = p_bruger and b.rolle = 'bruger' and b.oprettet_kl > v_fra;
    if n >= c_maks_bruger then
      return jsonb_build_object('kode', 'loft_bruger');
    end if;
  else
    select count(*) into n from public.bot_beskeder b
     where b.ip_hash = p_ip_hash and b.rolle = 'bruger' and b.bruger_id is null
       and b.oprettet_kl > v_fra;
    if n >= c_maks_ip_anon then
      return jsonb_build_object('kode', 'loft_ip');
    end if;
  end if;

  select count(*) into n from public.bot_beskeder b
   where b.ip_hash = p_ip_hash and b.rolle = 'bruger' and b.oprettet_kl > v_fra;
  if n >= c_maks_ip then
    return jsonb_build_object('kode', 'loft_ip');
  end if;

  -- Alle uden login samlet (antal beskeder).
  if p_bruger is null then
    select count(*) into n from public.bot_beskeder b
     where b.rolle = 'bruger' and b.bruger_id is null and b.oprettet_kl > v_fra;
    if n >= ind.anon then
      return jsonb_build_object('kode', 'loft_alle', 'grund', 'anon');
    end if;
  end if;

  select count(*) into n from public.bot_beskeder b
   where b.rolle = 'bruger' and b.oprettet_kl > v_fra;
  if n >= c_maks_alle then
    return jsonb_build_object('kode', 'loft_alle', 'grund', 'antal');
  end if;

  -- USD pr. bruger (indlogget).
  if p_bruger is not null then
    select coalesce(sum(b.pris_usd), 0) into v_usd from public.bot_beskeder b
     where b.rolle = 'bot' and b.bruger_id = p_bruger and b.oprettet_kl > v_fra;
    select count(*) into v_igang from public.bot_beskeder b
     where b.rolle = 'bruger' and b.bruger_id = p_bruger and b.oprettet_kl > v_igang_fra
       and not exists (select 1 from public.bot_beskeder r
                        where r.samtale_id = b.samtale_id and r.rolle = 'bot' and r.oprettet_kl >= b.oprettet_kl);
    if v_usd + v_igang * v_maks >= ind.bruger_usd then
      return jsonb_build_object('kode', 'loft_bruger_usd');
    end if;
  end if;

  -- USD for alle uden login samlet: højst anon_andel af døgnloftet.
  if p_bruger is null then
    select coalesce(sum(b.pris_usd), 0) into v_usd from public.bot_beskeder b
     where b.rolle = 'bot' and b.bruger_id is null and b.oprettet_kl > v_fra;
    select count(*) into v_igang from public.bot_beskeder b
     where b.rolle = 'bruger' and b.bruger_id is null and b.oprettet_kl > v_igang_fra
       and not exists (select 1 from public.bot_beskeder r
                        where r.samtale_id = b.samtale_id and r.rolle = 'bot' and r.oprettet_kl >= b.oprettet_kl);
    if v_usd + v_igang * v_maks >= ind.usd * ind.anon_andel then
      return jsonb_build_object('kode', 'loft_alle', 'grund', 'anon_usd');
    end if;
  end if;

  -- Loftet over hele regningen (alle samlet).
  select coalesce(sum(b.pris_usd), 0) into v_usd from public.bot_beskeder b
   where b.rolle = 'bot' and b.oprettet_kl > v_fra;
  select count(*) into v_igang from public.bot_beskeder b
   where b.rolle = 'bruger' and b.oprettet_kl > v_igang_fra
     and not exists (select 1 from public.bot_beskeder r
                      where r.samtale_id = b.samtale_id and r.rolle = 'bot' and r.oprettet_kl >= b.oprettet_kl);
  if v_usd + v_igang * v_maks >= ind.usd then
    update public.bot_indstillinger
       set usd_alarm_kl = now()
     where id and (usd_alarm_kl is null or usd_alarm_kl < now() - interval '24 hours');
    get diagnostics n = row_count;
    v_alarm := n > 0;
    return jsonb_build_object('kode', 'loft_alle', 'grund', 'usd', 'alarm', v_alarm,
                              'usd', round(v_usd, 4), 'loft_usd', ind.usd);
  end if;

  if v_samtale is null then
    insert into public.bot_samtaler (bruger_id, ip_hash, kilde)
    values (p_bruger, p_ip_hash, p_kilde)
    returning id into v_samtale;
  else
    update public.bot_samtaler set opdateret_kl = now(), ip_hash = p_ip_hash where id = v_samtale;
  end if;

  insert into public.bot_beskeder (samtale_id, rolle, tekst, bruger_id, ip_hash)
  values (v_samtale, 'bruger', v_tekst, p_bruger, p_ip_hash)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'samtale_id', v_samtale, 'besked_id', v_id);
end;
$fn$;

revoke all on function public.bot_ny_besked(uuid, uuid, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.bot_ny_besked(uuid, uuid, text, text, text, numeric) to service_role;
