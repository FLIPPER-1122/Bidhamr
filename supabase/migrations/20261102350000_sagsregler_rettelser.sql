-- Rettelser til 20261102210000_sagsregler.sql efter review (27.-28. okt. 2026)
-- og Filips afklaringer (ROADMAP-BESLUTNINGER, "Sagsregler – afklaringer
-- (Filip, 27. okt. 2026)").
--
-- KAN KUN KØRES EFTER 20261102210000: alle funktioner, der rettes, tjekkes
-- med md5 ("gammel" = testdatabasen efter 210000, "ny" = efter denne fil).
-- Afviger en krop fra begge, afbrydes migrationen, før noget ændres.
-- Idempotent (kan køres igen). Én transaktion. KØRES IKKE i produktion uden
-- Filips "ja".
--
-- Blokerende fund:
--   B1 sag_returfragt_regning: sælgeren får kun en regning, når der findes en
--      dækket række med betaler 'saelger', hvor returkoden faktisk er lavet
--      (label_klar_kl, eller en forsendelse, der ikke er fejlet/annulleret).
--      Ellers 'ingen_daekning', og staff markeres (sager.kraever_opmaerksomhed).
--      Beløbet er altid den dækkede række (ingen gæt ud fra fragten).
--      sag_retur_afleveret: et svar, der ikke er ok (også en uventet fejl -
--      den ruller ikke returregistreringen tilbage), giver en drift-alarm
--      (drift_fejl_log) og en markering hos staff.
--   B2 sag_ret_type: kun ved status 'aaben' (ikke længere mens en anke
--      venter); samme trinregler som sag_opret (bortkommet kun ved
--      pakke_sendt eller modtaget_kilde 'fragt'; ved pakke_sendt kun
--      bortkommet/svindel); fra 'skadet' til noget andet nulstilles
--      returfragt_betaler.
--   B3 returfragt_start: den dækkede returfragt kun ved type 'skadet'.
-- Småt:
--   S1 sag_afgoer: skadet med retur_afleveret_kl sat -> returfragt_betaler
--      'koeber' (returen er allerede sket; der laves ingen ny regning).
--   S3 sag_opret: indeholder_kontaktinfo på beskrivelsen og forklaringen ved
--      "pakken er smidt ud" (kode 'kontaktinfo').
--   S4 påmindelserne: dem, der allerede har fået beskeden
--      (notifikation_afsendelser.noegle), udelukkes FØR grænsen på 200.
--      Nøglen returneres som kolonnen noegle (serveren bruger den).
--   S5 ekstra_fragt_kraev (BHX01): teksten siger "returfragt", når det er en
--      regning for returfragt, der spærrer (markører
--      ekstra_fragt_ubetalt_returfragt / ekstra_fragt_ubetalt_begge).
--   S7 mine_data: sælgerens egne svar i sager (sag_svar + sag_svar_billeder).
--   S8 sag_genaabn og sag_anke_afgoer (omgør): en regning for returfragt i
--      sagen frafaldes, hvis den ikke er betalt (en åben PaymentIntent
--      annulleres af cron via annuller_pi); er den betalt eller ved at blive
--      betalt, får staff en alarm (drift_fejl_log + markering på sagen og
--      regningen).
-- Filips afklaringer:
--   - Svindel: køberen får kun buddet (uændret - sag_refusion_oere).
--   - Bortkommet pakke: fragtfirmaets erstatning går til sælgeren via den
--     eksisterende reklamation. 210000 rettede kun betingelserne - nu
--     oprettes reklamationen også automatisk: triggeren sager_fragt_reklamation
--     og cron'en (fragt_reklamationer_synkroniser_alle) tager bortkomne
--     pakker med (uden krav om vurderet indpakning). Chefens udbetaling går
--     som før til sælgeren.
--   - Tom pakke: kun billede af pakken med labelen. sag_opret får p_valg
--     (køberens valg fra src/lib/tekster/sagValg.ts, gemt i
--     sager.koeber_valg); ved 'tom' kræves indholdsbilledet ikke, og "pakken
--     er smidt ud" er ikke mulig (så ville der intet bevis være). Ved "pakken
--     er smidt ud" kræves stadig billede af varen og forklaringen.

set local lock_timeout = '5s';

do $do$
begin
  if to_regprocedure('public.sag_ret_type(uuid,uuid,text,text)') is null
     or to_regprocedure('public.sag_returfragt_regning(uuid)') is null
     or to_regclass('public.sag_svar') is null
     or to_regclass('public.notifikation_afsendelser') is null
     or to_regprocedure('public.drift_fejl_log(text,text,text,text,uuid)') is null
     or to_regprocedure('public.mine_data()') is null then
    raise exception 'Forudsætning mangler: kør 20261102210000_sagsregler.sql først';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session) - som i 20261102210000
-- ===========================================================================
create or replace function pg_temp.r_krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

create or replace function pg_temp.r_ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text;
begin
  h := pg_temp.r_krop_md5(p_fn);
  if h = p_ny then return 'allerede'; end if;
  if h is null then raise exception '%: funktionen findes ikke', p_fn; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
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
  h := pg_temp.r_krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- Drift-tjek før en hel funktion erstattes: 'gammel' | 'allerede'. p_ny_fn:
-- den nye signatur (ændres den).
create or replace function pg_temp.r_kraev_md5(p_fn text, p_gammel text, p_ny text, p_ny_fn text default null)
returns text language plpgsql as $f$
declare
  h text;
begin
  if pg_temp.r_krop_md5(coalesce(p_ny_fn, p_fn)) = p_ny
     and (p_ny_fn is null or to_regprocedure(p_fn) is null) then
    return 'allerede';
  end if;
  h := pg_temp.r_krop_md5(p_fn);
  if h is null then raise exception '%: funktionen findes ikke', p_fn; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  if p_ny_fn is not null and to_regprocedure(p_ny_fn) is not null then
    raise exception '%: den nye signatur findes allerede med en anden krop', p_ny_fn;
  end if;
  return 'gammel';
end
$f$;

create or replace function pg_temp.r_kraev_efter(p_fn text, p_ny text)
returns void language plpgsql as $f$
begin
  if pg_temp.r_krop_md5(p_fn) is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, pg_temp.r_krop_md5(p_fn), p_ny;
  end if;
end
$f$;

-- Alle drift-tjek FØR noget ændres.
do $do$
begin
  perform pg_temp.r_kraev_md5('public.sag_opret(uuid,text,text,jsonb,boolean,text)',
    '28ded2d3ab96a1db4e5b8a8b29cdfc53', '5c3d3fd8fa4a1a779d63d55d6e8e7a52', 'public.sag_opret(uuid,text,text,jsonb,boolean,text,text)');
  perform pg_temp.r_kraev_md5('public.sag_ret_type(uuid,uuid,text,text)',
    'fd754128fdbb63bd7a95d59b6ff2f638', 'ac807d49abafc2a8d9f3f9c081ab0a18');
  perform pg_temp.r_kraev_md5('public.sag_returfragt_regning(uuid)',
    '533c95f6bbbd05a9060e4c5076561b97', 'f4a8142f90a12271b55568f00be68c30');
  perform pg_temp.r_kraev_md5('public.sag_svar_paamind_kandidater(integer)',
    'ac002444d9674b9ee95841f2478dc89e', '2ff9e37ecaa7aeb938035a1da58805d6');
  perform pg_temp.r_kraev_md5('public.handel_problem_frist_paamind_kandidater(integer)',
    'f681703df5d3cd1bd8acb3989eebba91', 'a1414406fe1a0d28e83354178469fe3c');
  perform pg_temp.r_kraev_md5('public.ekstra_fragt_kraev(uuid)',
    'f4f411fc61ca9a567efcf1dac7ce239e', '24a967bad58fe832e9daadd525ad58c3');
  -- Rettes med tekststykker (ps_ret tjekker igen).
  perform pg_temp.r_kraev_md5('public.sager_beskyt()', 'ad094742c4b72d32edb12bc07301cd0b', '5053f6e32efa5689927d306c12fcd014');
  perform pg_temp.r_kraev_md5('public.sag_afgoer(uuid,uuid,text,text,text,boolean,text)',
    '6def5cbb98c58e7fefcd899fa1d22141', '938e5dd5c37aa4027eb5610182b5679f');
  perform pg_temp.r_kraev_md5('public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean,text)',
    '0af19871caa67f0136bd9403271081be', '6f56a3e2f6597b7210d564f9c4a90e68');
  perform pg_temp.r_kraev_md5('public.sag_genaabn(uuid,uuid,text)',
    'd32e4ff28c96d5f5c8902b7d133b040b', '122de6271101f457cf1de01db4b96ea2');
  perform pg_temp.r_kraev_md5('public.returfragt_start(uuid,uuid)',
    '14f5e42c1087f803c8704e3aed93fd45', 'b6a2299fad05e880254c470ccf476206');
  perform pg_temp.r_kraev_md5('public.sag_retur_afleveret(uuid,uuid,text)',
    '46c9a06b83f8e8cd0dc87afcf94b93ca', 'b9cdcd97431250992fcb8e93362fdabc');
  perform pg_temp.r_kraev_md5('public.sager_fragt_reklamation()',
    '9277694da37123a94546d80a918862d7', '56c37531eab53fcbcf340b7c3fd21b46');
  perform pg_temp.r_kraev_md5('public.fragt_reklamationer_synkroniser_alle(integer)',
    'e1085f5dc848692f70a2744e932dcfcf', '237df836bb729cd46afae331ee76fec3');
  perform pg_temp.r_kraev_md5('public.fragt_reklamation_synkroniser(uuid)',
    'e7c151db2fd0aeda581737dcc668ce8b', '0a5670e948ef2e54dd1781abea042663');
end $do$;

-- ===========================================================================
-- 1. Kolonner
-- ===========================================================================
alter table public.sager
  add column if not exists kraever_opmaerksomhed boolean not null default false,
  add column if not exists opmaerksomhed_tekst   text,
  add column if not exists koeber_valg           text;

alter table public.sager drop constraint if exists sager_opmaerksomhed_check;
alter table public.sager add constraint sager_opmaerksomhed_check check (
  coalesce(char_length(opmaerksomhed_tekst), 0) <= 4000);
alter table public.sager drop constraint if exists sager_koeber_valg_check;
alter table public.sager add constraint sager_koeber_valg_check check (
  koeber_valg is null or koeber_valg in ('stykker', 'annonce', 'anden_vare', 'tom', 'ikke_kommet', 'andet'));

comment on column public.sager.kraever_opmaerksomhed is
  'Staff skal se på sagen (fx kunne regningen for returfragt ikke oprettes, eller en betalt regning skal håndteres efter genåbning/anke). Tekst i opmaerksomhed_tekst. Lukkes med sag_opmaerksomhed_luk (20261102350000).';
comment on column public.sager.koeber_valg is
  'Køberens valg i "Meld et problem" (src/lib/tekster/sagValg.ts), fx tom = pakken var tom. null = gammel klient. Kan ikke ændres (20261102350000).';

-- Parterne kan se køberens valg (markeringen er kun til staff).
grant select (koeber_valg) on public.sager to authenticated;

-- ===========================================================================
-- 2. Markering hos staff
-- ===========================================================================
-- Intern (kaldes af sagsfunktionerne). Samme tekst tilføjes kun én gang.
create or replace function public.sag_staff_marker(p_sag uuid, p_tekst text)
returns void
language sql
security definer
set search_path = ''
as $f$
  update public.sager
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = case
           when position(p_tekst in coalesce(opmaerksomhed_tekst, '')) > 0 then opmaerksomhed_tekst
           else right(coalesce(opmaerksomhed_tekst || chr(10), '')
                      || to_char(now() at time zone 'Europe/Copenhagen', 'DD-MM-YYYY HH24:MI') || ': ' || p_tekst, 4000) end
   where id = p_sag;
$f$;
revoke all on function public.sag_staff_marker(uuid, text) from public, anon, authenticated;

-- Staff lukker markeringen (teksten bevares, og lukningen noteres i den
-- interne note). Koder: ok | ingen_adgang | ikke_fundet | inhabil |
-- ikke_markeret | for_lang_tekst
create or replace function public.sag_opmaerksomhed_luk(p_medarbejder uuid, p_sag uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  s      record;
  t      record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(coalesce(v_note, '')) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  select * into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select buyer_id, seller_id into t from public.trades where id = s.trade_id;
  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if not s.kraever_opmaerksomhed then return jsonb_build_object('kode', 'ikke_markeret'); end if;
  update public.sager
     set kraever_opmaerksomhed = false,
         intern_note = left(coalesce(intern_note || chr(10), '') || 'Markering lukket'
                            || coalesce(': ' || v_note, '') , 4000)
   where id = s.id;
  return jsonb_build_object('kode', 'ok', 'trade_id', s.trade_id);
end;
$f$;
revoke all on function public.sag_opmaerksomhed_luk(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sag_opmaerksomhed_luk(uuid, uuid, text) to service_role;

-- Drift-alarm, der aldrig vælter kalderen.
create or replace function public.sag_drift_alarm(p_sag uuid, p_besked text, p_digest text)
returns void
language plpgsql
security definer
set search_path = ''
as $f$
begin
  begin
    perform public.drift_fejl_log('server', '/admin/sager', left(p_besked, 1000), left(p_digest, 100));
  exception when others then
    raise warning 'sag_drift_alarm: kunne ikke logge (%) for sag %', sqlerrm, p_sag;
  end;
end;
$f$;
revoke all on function public.sag_drift_alarm(uuid, text, text) from public, anon, authenticated;

-- ===========================================================================
-- 3. sager_beskyt: køberens valg kan ikke ændres
-- ===========================================================================
do $do$
begin
  raise notice 'sager_beskyt: %', pg_temp.r_ps_ret(
    'public.sager_beskyt()',
    'ad094742c4b72d32edb12bc07301cd0b',
    '5053f6e32efa5689927d306c12fcd014',
    jsonb_build_array(
      jsonb_build_array(
$g$  or new.beskrivelse                  is distinct from old.beskrivelse$g$,
$n$  or new.beskrivelse                  is distinct from old.beskrivelse
  -- 20261102350000: køberens valg (sagValg.ts) er fast.
  or new.koeber_valg                  is distinct from old.koeber_valg$n$, 1)));
end $do$;

-- ===========================================================================
-- 4. sag_opret: p_valg (tom pakke), kontaktinfo (S3)
-- ===========================================================================
create or replace function public.sag_opret(p_trade uuid, p_type text, p_beskrivelse text, p_billeder jsonb,
  p_pakke_smidt_ud boolean default false, p_smidt_ud_begrundelse text default null,
  p_valg text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bruger   uuid := auth.uid();
  v_beskr    text := btrim(coalesce(p_beskrivelse, ''));
  v_billeder jsonb := coalesce(p_billeder, '[]'::jsonb);
  v_smidt    boolean := coalesce(p_pakke_smidt_ud, false);
  v_smidt_gr text := nullif(btrim(coalesce(p_smidt_ud_begrundelse, '')), '');
  v_valg     text := nullif(btrim(coalesce(p_valg, '')), '');
  v_tom      boolean;
  b          record;
  t          record;
  v_sendt    timestamptz;
  v_frist    timestamptz;
  v_fejl     text;
  v_sag      uuid;
  v_pakke    boolean;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if p_type is null or p_type not in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  -- Køberens valg skal passe til typen (samme tabel som sagValg.ts).
  if v_valg is not null and (v_valg not in ('stykker', 'annonce', 'anden_vare', 'tom', 'ikke_kommet', 'andet')
     or p_type is distinct from case v_valg when 'stykker' then 'skadet' when 'annonce' then 'ikke_som_beskrevet'
                                            when 'anden_vare' then 'svindel' when 'tom' then 'svindel'
                                            when 'ikke_kommet' then 'bortkommet' else 'andet' end) then
    return jsonb_build_object('kode', 'ugyldigt_valg');
  end if;
  v_tom := coalesce(v_valg = 'tom', false);
  if char_length(v_beskr) not between 10 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  -- Sælgeren kan læse beskrivelsen: ingen kontaktoplysninger.
  if public.indeholder_kontaktinfo(v_beskr) then
    return jsonb_build_object('kode', 'kontaktinfo');
  end if;

  if not exists (select 1 from public.trades
                  where id = p_trade and buyer_id = v_bruger) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select * into b from public.betalinger where trade_id = p_trade for update;
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or t.buyer_id <> v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if exists (select 1 from public.sager s where s.trade_id = p_trade) then
    return jsonb_build_object('kode', 'findes');
  end if;

  if b.id is null
     or b.status <> 'betalt'
     or b.frigivet_kl is not null
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then
    return jsonb_build_object('kode', 'ikke_betalt');
  end if;

  if p_type in ('skadet', 'ikke_som_beskrevet', 'andet') and not b.beskyttelse then
    return jsonb_build_object('kode', 'kraever_beskyttelse');
  end if;

  if t.status = 'modtaget' then
    if p_type = 'bortkommet' and t.modtaget_kilde is distinct from 'fragt' then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    v_frist := coalesce(t.problem_frist_kl, t.received_at + interval '48 hours');
    if t.received_at is null or v_frist is null or v_frist < now() then
      return jsonb_build_object('kode', 'for_sent');
    end if;
  elsif t.status = 'pakke_sendt' then
    if p_type not in ('bortkommet', 'svindel') then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    v_sendt := coalesce(t.sendt_kl, b.betalt_kl);
    if v_sendt is null or v_sendt > now() - interval '7 days' then
      return jsonb_build_object('kode', 'for_tidligt');
    end if;
  else
    return jsonb_build_object('kode', 'forkert_trin');
  end if;

  -- Pakken er smidt ud (regel 2): kun hvor pakkebilledet ellers kræves, ikke
  -- ved en tom pakke (så er pakken selve beviset), og kun med en forklaring
  -- på mindst 20 tegn uden kontaktoplysninger.
  if v_smidt then
    if not (t.status = 'modtaget' and p_type <> 'bortkommet') or v_tom then
      return jsonb_build_object('kode', 'smidt_ud_ikke_mulig');
    end if;
    if v_smidt_gr is null or char_length(v_smidt_gr) not between 20 and 2000 then
      return jsonb_build_object('kode', 'smidt_ud_begrundelse');
    end if;
    if public.indeholder_kontaktinfo(v_smidt_gr) then
      return jsonb_build_object('kode', 'kontaktinfo');
    end if;
  else
    v_smidt_gr := null;
  end if;

  v_fejl := public.sag_valider_billeder(v_bruger, p_trade, v_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  -- Regel 1: pakken (med labelen) + indholdet. 'pakke_label' eller 'pakke'
  -- tæller som pakken; ved "smidt ud" kræves kun indholdet (billede af
  -- varen); ved en tom pakke kræves kun pakken med labelen (Filip, 27. okt.).
  if t.status = 'modtaget' and p_type <> 'bortkommet' then
    v_pakke := v_smidt or exists (select 1 from jsonb_array_elements(v_billeder) e
                                   where e->>'kategori' in ('pakke_label', 'pakke'));
    if not v_pakke
       or (not v_tom
           and not exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'indhold')) then
      return jsonb_build_object('kode', 'billeder_kraeves');
    end if;
  end if;

  begin
    insert into public.sager (trade_id, oprettet_af, type, beskrivelse, beskyttelse,
                              handel_status_ved_oprettelse, tjek_sporing,
                              pakke_smidt_ud, pakke_smidt_ud_begrundelse, koeber_valg)
    values (p_trade, v_bruger, p_type, v_beskr, b.beskyttelse, t.status,
            t.status = 'pakke_sendt' or p_type = 'bortkommet',
            v_smidt, v_smidt_gr, v_valg)
    returning id into v_sag;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  insert into public.sag_billeder (sag_id, sti, kategori)
  select v_sag, e->>'sti', e->>'kategori'
    from jsonb_array_elements(v_billeder) e;

  update public.trades
     set sag_aaben = true,
         sag_note = 'Sag fra køberen: ' || case
                      when v_valg = 'tom' then 'pakken var tom'
                      when v_valg = 'anden_vare' then 'det er ikke den vare, køberen købte'
                      when p_type = 'bortkommet' then 'pakken er ikke kommet frem'
                      when p_type = 'skadet' then 'varen er skadet'
                      when p_type = 'ikke_som_beskrevet' then 'varen er ikke som beskrevet'
                      when p_type = 'andet' then 'andet problem'
                      else 'svindel' end
                    || case when v_smidt then ' (pakken er smidt ud - vurdér forklaringen)' else '' end,
         sag_aabnet_af = v_bruger,
         sag_aabnet_at = now()
   where id = p_trade;

  return jsonb_build_object('kode', 'ok', 'sag_id', v_sag);
end;
$function$;

drop function if exists public.sag_opret(uuid, text, text, jsonb, boolean, text);
revoke all on function public.sag_opret(uuid, text, text, jsonb, boolean, text, text) from public, anon;
grant execute on function public.sag_opret(uuid, text, text, jsonb, boolean, text, text) to authenticated, service_role;

-- ===========================================================================
-- 5. sag_ret_type (B2)
-- ===========================================================================
-- Koder: ok (+ gammel_type, ny_type) | ingen_adgang | ugyldig_type |
-- begrundelse_mangler | for_lang_tekst | ikke_fundet | inhabil | uaendret |
-- afviklet | forkert_status | forkert_trin | kraever_beskyttelse
create or replace function public.sag_ret_type(p_medarbejder uuid, p_sag uuid, p_type text, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_trade uuid;
  b       record;
  t       record;
  s       record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_type is null or p_type not in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Låserækkefølge: betaling, handel, sag.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if s.type = p_type then return jsonb_build_object('kode', 'uaendret'); end if;
  if s.afviklet_kl is not null then return jsonb_build_object('kode', 'afviklet'); end if;
  -- 20261102350000: kun før afgørelsen (ikke mens en anke venter - den
  -- afgøres med den type, sagen blev afgjort med).
  if s.status <> 'aaben' then
    return jsonb_build_object('kode', 'forkert_status');
  end if;
  -- Samme trinregler som sag_opret.
  if t.status = 'modtaget' then
    if p_type = 'bortkommet' and t.modtaget_kilde is distinct from 'fragt' then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
  elsif t.status = 'pakke_sendt' then
    if p_type not in ('bortkommet', 'svindel') then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
  else
    return jsonb_build_object('kode', 'forkert_trin');
  end if;
  -- Retur ved skade/"ikke som beskrevet" kræver BidHamr Beskyttelse.
  if p_type in ('skadet', 'ikke_som_beskrevet', 'andet') and not coalesce(s.beskyttelse, false) then
    return jsonb_build_object('kode', 'kraever_beskyttelse');
  end if;

  perform set_config('bidhamr.sag_ret_type', 'ja', true);
  update public.sager
     set type = p_type,
         oprindelig_type = coalesce(oprindelig_type, s.type),
         type_rettet_kl = now(),
         type_rettet_af = p_medarbejder,
         tjek_sporing = tjek_sporing or p_type = 'bortkommet',
         -- Kun transportskade kan have sælger/BidHamr som betaler.
         returfragt_betaler = case when s.type = 'skadet' and p_type <> 'skadet' then null
                                   else returfragt_betaler end
   where id = s.id;
  perform set_config('bidhamr.sag_ret_type', '', true);

  update public.trades
     set sag_note = 'Sag fra køberen: ' || case p_type
                      when 'bortkommet' then 'pakken er ikke kommet frem'
                      when 'skadet' then 'varen er skadet'
                      when 'ikke_som_beskrevet' then 'varen er ikke som beskrevet'
                      when 'andet' then 'andet problem'
                      else 'svindel' end
   where id = t.id and coalesce(sag_aaben, false);

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_type_rettet', 'sag', s.id, t.buyer_id,
          left('Sagstypen er rettet fra ' || s.type || ' til ' || p_type || ' | Begrundelse: ' || v_grund, 4000));

  return jsonb_build_object('kode', 'ok', 'gammel_type', s.type, 'ny_type', p_type, 'trade_id', t.id);
end;
$f$;
revoke all on function public.sag_ret_type(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.sag_ret_type(uuid, uuid, text, text) to service_role;

-- ===========================================================================
-- 6. Påmindelser (S4): allerede sendte udelukkes før grænsen
-- ===========================================================================
-- Returtypen får kolonnen noegle (samme nøgle som serveren claimer i
-- notifikation_afsendelser) - derfor drop og create.
drop function if exists public.sag_svar_paamind_kandidater(integer);
create function public.sag_svar_paamind_kandidater(p_timer integer default 12)
returns table (sag_id uuid, trade_id uuid, saelger_id uuid, auction_id uuid, frist_kl timestamptz, noegle text)
language sql
stable
security definer
set search_path = ''
as $f$
  select s.id, t.id, t.seller_id, t.auction_id,
         s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer()),
         'sag_svar_paamind:' || s.id::text
    from public.sager s
    join public.trades t on t.id = s.trade_id
   where s.status = 'aaben'
     and s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer()) > now()
     and s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer())
         <= now() + make_interval(hours => greatest(1, least(coalesce(p_timer, 12), 48)))
     and not exists (select 1 from public.sag_svar v where v.sag_id = s.id)
     and not exists (select 1 from public.notifikation_afsendelser n
                      where n.noegle = 'sag_svar_paamind:' || s.id::text)
   order by s.oprettet_kl
   limit 200;
$f$;
revoke all on function public.sag_svar_paamind_kandidater(integer) from public, anon, authenticated;
grant execute on function public.sag_svar_paamind_kandidater(integer) to service_role;

-- Nøglen: problem_frist_paamind:<handel>:<fristen i millisekunder> (som
-- Date.parse i serveren).
drop function if exists public.handel_problem_frist_paamind_kandidater(integer);
create function public.handel_problem_frist_paamind_kandidater(p_timer integer default 6)
returns table (trade_id uuid, buyer_id uuid, auction_id uuid, frist_kl timestamptz, noegle text)
language sql
stable
security definer
set search_path = ''
as $f$
  select x.id, x.buyer_id, x.auction_id, x.problem_frist_kl, x.noegle
    from (
      select t.id, t.buyer_id, t.auction_id, t.problem_frist_kl,
             'problem_frist_paamind:' || t.id::text || ':'
               || floor(extract(epoch from t.problem_frist_kl) * 1000)::bigint::text as noegle
        from public.trades t
        join public.betalinger b on b.trade_id = t.id
       where t.status = 'modtaget'
         and t.problem_frist_kl is not null
         and t.problem_frist_kl > now()
         and t.problem_frist_kl <= now() + make_interval(hours => greatest(1, least(coalesce(p_timer, 6), 72)))
         and not coalesce(t.afhentning, false)
         and not coalesce(t.sag_aaben, false)
         and b.status = 'betalt'
         and b.frigivet_kl is null
         and b.refusion_anmodet_kl is null
         and not exists (select 1 from public.sager s where s.trade_id = t.id)) x
   where not exists (select 1 from public.notifikation_afsendelser n where n.noegle = x.noegle)
   order by x.problem_frist_kl
   limit 200;
$f$;
revoke all on function public.handel_problem_frist_paamind_kandidater(integer) from public, anon, authenticated;
grant execute on function public.handel_problem_frist_paamind_kandidater(integer) to service_role;

-- ===========================================================================
-- 7. Regningen for returfragt (B1)
-- ===========================================================================
-- Oprettes, når returpakken er registreret afleveret. Kun når BidHamr faktisk
-- har lavet returkoden for sælgerens regning (dækket række, betaler
-- 'saelger', status 'betalt', label lavet). Beløbet = den dækkede række.
-- Svar: { kode: ok (+ id) | ikke_saelger | findes | ingen_daekning |
--         ingen_forsendelse | ingen_betaling | ugyldigt_beloeb | ikke_fundet }
-- Ved ingen_daekning, ingen_forsendelse, ingen_betaling og ugyldigt_beloeb
-- markeres staff på sagen.
create or replace function public.sag_returfragt_regning(p_sag uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $f$
declare
  s        record;
  t        record;
  rf       record;
  v_bet    uuid;
  v_fo     uuid;
  v_str    text;
  v_trans  text;
  v_spor   text;
  v_id     uuid;
  v_kode   text;
begin
  select * into s from public.sager where id = p_sag;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if s.returfragt_betaler is distinct from 'saelger' then return jsonb_build_object('kode', 'ikke_saelger'); end if;
  if exists (select 1 from public.ekstra_fragt_regninger x
              where x.sag_id = s.id and x.slags = 'returfragt_sag' and x.status <> 'frafaldet') then
    return jsonb_build_object('kode', 'findes');
  end if;
  select tr.id, tr.seller_id, tr.auction_id into t from public.trades tr where tr.id = s.trade_id;
  if t.id is null or t.seller_id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Den dækkede returfragt, hvor returkoden er lavet.
  select r.id, r.beloeb_oere, r.forsendelse_id, r.pakkestoerrelse into rf
    from public.returfragt_betalinger r
   where r.sag_id = s.id and r.betaler = 'saelger' and r.status = 'betalt'
     and (r.label_klar_kl is not null
          or exists (select 1 from public.forsendelser fo
                      where fo.id = r.forsendelse_id
                        and fo.status not in ('opretter', 'fejlet', 'annulleret')))
   order by r.oprettet_kl desc limit 1;

  if rf.id is null then
    v_kode := 'ingen_daekning';
  else
    select b.id into v_bet from public.betalinger b
     where b.trade_id = t.id and b.betalt_kl is not null order by b.betalt_kl desc limit 1;
    if v_bet is null then
      v_kode := 'ingen_betaling';
    elsif rf.beloeb_oere is null or rf.beloeb_oere < 300 or rf.beloeb_oere > 1000000 then
      v_kode := 'ugyldigt_beloeb';
    end if;
  end if;

  if v_kode is null then
    -- Forsendelsen: returpakken - ellers (ingen forsendelse på rækken) den
    -- udgående pakke.
    select fo.id, fo.pakkestoerrelse,
           coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end),
           fo.sporingsnummer
      into v_fo, v_str, v_trans, v_spor
      from public.forsendelser fo
     where fo.trade_id = t.id
       and (fo.id = rf.forsendelse_id
            or (rf.forsendelse_id is null and fo.type = 'udgaaende'
                and fo.status not in ('opretter', 'fejlet', 'annulleret')))
     order by (fo.id = rf.forsendelse_id) desc nulls last, fo.oprettet_kl desc
     limit 1;
    if v_fo is null then v_kode := 'ingen_forsendelse'; end if;
  end if;

  if v_kode is not null then
    perform public.sag_staff_marker(s.id,
      case v_kode
        when 'ingen_daekning' then 'Sælgeren skal betale returfragten, men BidHamr har ikke lavet en returkode i sagen - der er ikke oprettet en regning. Vurdér, om sælgeren skal opkræves.'
        else 'Regningen for returfragt til sælgeren kunne ikke oprettes (' || v_kode || '). Vurdér, om sælgeren skal opkræves.' end);
    return jsonb_build_object('kode', v_kode);
  end if;

  v_str := coalesce(v_str, rf.pakkestoerrelse, (select a.pakkestoerrelse from public.auctions a where a.id = t.auction_id), 'mellem');
  if v_str not in ('lille', 'mellem', 'stor') then v_str := 'mellem'; end if;

  insert into public.ekstra_fragt_regninger (
    trade_id, forsendelse_id, saelger_id, betaling_id, transportoer, sporingsnummer,
    valgt_stoerrelse, beloeb_oere, forklaring, frist, oprettet_af, slags, sag_id)
  values (
    t.id, v_fo, t.seller_id, v_bet, left(v_trans, 20), left(v_spor, 100),
    v_str, rf.beloeb_oere,
    'Returfragt i sagen: varen blev skadet under fragten, og billederne viser, at den ikke var pakket forsvarligt. Køberen har sendt varen retur til dig.',
    now() + interval '14 days', public.bidhamr_system_id(), 'returfragt_sag', s.id)
  returning id into v_id;

  perform public.ekstra_fragt_log(public.bidhamr_system_id(), 'ekstra_fragt_oprettet', t.id, t.seller_id,
    'Returfragt i sag ' || s.id::text || ' opkræves hos sælgeren (dårlig indpakning): '
    || public.ekstra_fragt_kr(rf.beloeb_oere));
  return jsonb_build_object('kode', 'ok', 'id', v_id);
end;
$f$;
revoke all on function public.sag_returfragt_regning(uuid) from public, anon, authenticated;
grant execute on function public.sag_returfragt_regning(uuid) to service_role;

-- S8: frafald sagens regning for returfragt (genåbning / omgjort anke).
-- Ubetalt (afventer_betaling, indsigelse) -> frafaldet (en åben PaymentIntent
-- kasseres via annuller_pi - cron annullerer den hos Stripe). Behandles eller
-- betalt -> alarm til staff (drift_fejl_log + markering på sagen og
-- regningen). Intern. Svar: { frafaldet: antal, alarm: antal }.
create or replace function public.sag_returfragt_regning_frafald(p_sag uuid, p_medarbejder uuid, p_grund text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $f$
declare
  r      record;
  v_fra  integer := 0;
  v_alm  integer := 0;
  v_tekst text;
begin
  for r in
    select * from public.ekstra_fragt_regninger x
     where x.sag_id = p_sag and x.slags = 'returfragt_sag' and x.status not in ('frafaldet', 'refunderet')
     order by x.oprettet_kl
     for update
  loop
    if r.status in ('afventer_betaling', 'indsigelse') then
      update public.ekstra_fragt_regninger
         set status = 'frafaldet', frafaldet_kl = now(), frafaldet_af = p_medarbejder, frafald_grund = left(p_grund, 1000),
             afgoerelse = case when status = 'indsigelse' then 'frafaldet' else afgoerelse end,
             afgoerelse_begrundelse = case when status = 'indsigelse' then left(p_grund, 2000) else afgoerelse_begrundelse end,
             afgjort_kl = case when status = 'indsigelse' then now() else afgjort_kl end,
             afgjort_af = case when status = 'indsigelse' then p_medarbejder else afgjort_af end,
             tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                              else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
             annuller_pi = coalesce(stripe_payment_intent_id, annuller_pi),
             pi_forsoeg = pi_forsoeg + case when stripe_payment_intent_id is null then 0 else 1 end,
             stripe_payment_intent_id = null
       where id = r.id and status in ('afventer_betaling', 'indsigelse');
      perform public.ekstra_fragt_log(p_medarbejder, 'ekstra_fragt_frafaldet', r.trade_id, r.saelger_id,
        'Regning for returfragt ' || public.ekstra_fragt_kr(r.beloeb_oere) || ' frafaldet automatisk (status var '
        || r.status || ') | Til sælgeren: ' || p_grund);
      v_fra := v_fra + 1;
    else
      v_tekst := 'Regningen for returfragt (' || public.ekstra_fragt_kr(r.beloeb_oere) || ', status ' || r.status
                 || ') er ikke frafaldet, fordi den er betalt eller ved at blive betalt, men sagen er ændret ('
                 || p_grund || '). Vurdér, om sælgeren skal have pengene tilbage.';
      update public.ekstra_fragt_regninger
         set kraever_opmaerksomhed = true,
             opmaerksomhed_tekst = right(coalesce(opmaerksomhed_tekst || chr(10), '') || v_tekst, 4000)
       where id = r.id;
      perform public.sag_staff_marker(p_sag, v_tekst);
      perform public.sag_drift_alarm(p_sag,
        'Sag ' || p_sag::text || ': ' || v_tekst, 'sag_returfragt_betalt:' || r.id::text);
      v_alm := v_alm + 1;
    end if;
  end loop;
  return jsonb_build_object('frafaldet', v_fra, 'alarm', v_alm);
end;
$f$;
revoke all on function public.sag_returfragt_regning_frafald(uuid, uuid, text) from public, anon, authenticated;

-- ===========================================================================
-- 8. Afgørelse, anke, genåbning, retur
-- ===========================================================================
do $do$
begin
  -- S1: returen er allerede sket - køberen står som betaler (ingen ny regning).
  raise notice 'sag_afgoer: %', pg_temp.r_ps_ret(
    'public.sag_afgoer(uuid,uuid,text,text,text,boolean,text)',
    '6def5cbb98c58e7fefcd899fa1d22141',
    '938e5dd5c37aa4027eb5610182b5679f',
    jsonb_build_array(
      jsonb_build_array(
$g$             returfragt_betaler = case when s.retur_afleveret_kl is not null
                                       then coalesce(case when s.type = 'skadet'
                                                          and v_rf_betaler in ('saelger', 'bidhamr')
                                                          then v_rf_betaler end, 'koeber') end,$g$,
$n$             -- 20261102350000: returen er sket - ingen ny regning.
             returfragt_betaler = case when s.retur_afleveret_kl is not null then 'koeber' end,$n$, 1)));

  -- S8: omgjort anke frafalder en ubetalt regning for returfragt.
  raise notice 'sag_anke_afgoer: %', pg_temp.r_ps_ret(
    'public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean,text)',
    '0af19871caa67f0136bd9403271081be',
    '6f56a3e2f6597b7210d564f9c4a90e68',
    jsonb_build_array(
      jsonb_build_array(
$g$  v_rf_betaler text := nullif(btrim(coalesce(p_returfragt_betaler, '')), '');
begin$g$,
$n$  v_rf_betaler text := nullif(btrim(coalesce(p_returfragt_betaler, '')), '');
  -- 20261102350000: regningen for returfragt ved omgørelse.
  v_rf         jsonb;
begin$n$, 1),
      jsonb_build_array(
$g$        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Refusion (alt undtagen BidHamr Beskyttelse) nu';$g$,
$n$        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Refusion nu';$n$, 1),
      jsonb_build_array(
$g$        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Varen sendes retur (køberen betaler selv returfragten); refusion, så snart returpakken er registreret';$g$,
$n$        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Varen sendes retur ('
                 || case when s.type <> 'skadet' then 'køberen betaler selv returfragten'
                         when v_rf_betaler = 'saelger' then 'sælgeren betaler returfragten - dårlig indpakning'
                         else 'BidHamr betaler returfragten og reklamerer hos fragtfirmaet - god indpakning' end
                 || '); refusion, så snart returpakken er registreret';$n$, 1),
      jsonb_build_array(
$g$    update public.sag_anker
       set status = 'omgjort', behandlet_af = p_medarbejder, behandlet_kl = now(),$g$,
$n$    v_rf := public.sag_returfragt_regning_frafald(s.id, p_medarbejder,
      'Afgørelsen i sagen er ændret ved en anke, så du skal ikke betale returfragten.');

    update public.sag_anker
       set status = 'omgjort', behandlet_af = p_medarbejder, behandlet_kl = now(),$n$, 1),
      jsonb_build_array(
$g$    'anke_id', a.id, 'part', a.part, 'sag_id', s.id,$g$,
$n$    'anke_id', a.id, 'part', a.part, 'sag_id', s.id, 'returfragt_regning', v_rf,$n$, 1)));

  -- S8: genåbning frafalder en ubetalt regning for returfragt.
  raise notice 'sag_genaabn: %', pg_temp.r_ps_ret(
    'public.sag_genaabn(uuid,uuid,text)',
    'd32e4ff28c96d5f5c8902b7d133b040b',
    '122de6271101f457cf1de01db4b96ea2',
    jsonb_build_array(
      jsonb_build_array(
$g$  v_retur_frist    timestamptz;
begin$g$,
$n$  v_retur_frist    timestamptz;
  -- 20261102350000: regningen for returfragt ved genåbning.
  v_rf             jsonb;
begin$n$, 1),
      jsonb_build_array(
$g$  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_genaabnet',$g$,
$n$  v_rf := public.sag_returfragt_regning_frafald(s.id, p_medarbejder,
    'Sagen er genåbnet, så du skal ikke betale returfragten.');

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_genaabnet',$n$, 1),
      jsonb_build_array(
$g$    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal + 1);$g$,
$n$    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal + 1,
    'returfragt_regning', v_rf);$n$, 1)));

  -- B3: den dækkede returfragt kun ved transportskade.
  raise notice 'returfragt_start: %', pg_temp.r_ps_ret(
    'public.returfragt_start(uuid,uuid)',
    '14f5e42c1087f803c8704e3aed93fd45',
    'b6a2299fad05e880254c470ccf476206',
    jsonb_build_array(
      jsonb_build_array(
$g$  select s.returfragt_betaler into v_betaler from public.sager s where s.id = (v_sag->>'sag_id')::uuid;$g$,
$n$  select s.returfragt_betaler into v_betaler from public.sager s
   where s.id = (v_sag->>'sag_id')::uuid and s.type = 'skadet';$n$, 1)));

  -- B1: regningen kan ikke oprettes -> drift-alarm og markering hos staff.
  -- En uventet fejl ruller ikke returregistreringen tilbage.
  raise notice 'sag_retur_afleveret: %', pg_temp.r_ps_ret(
    'public.sag_retur_afleveret(uuid,uuid,text)',
    '46c9a06b83f8e8cd0dc87afcf94b93ca',
    'b9cdcd97431250992fcb8e93362fdabc',
    jsonb_build_array(
      jsonb_build_array(
$g$  if s.returfragt_betaler = 'saelger' then
    v_regning := public.sag_returfragt_regning(s.id);
  end if;$g$,
$n$  if s.returfragt_betaler = 'saelger' then
    begin
      v_regning := public.sag_returfragt_regning(s.id);
    exception when others then
      v_regning := jsonb_build_object('kode', 'fejl', 'fejl', left(sqlstate || ': ' || sqlerrm, 300));
    end;
    -- 20261102350000: ikke ok -> drift-alarm og markering hos staff.
    if coalesce(v_regning->>'kode', '') <> 'ok' then
      perform public.sag_staff_marker(s.id,
        'Regningen for returfragt til sælgeren blev ikke oprettet, da returen blev registreret ('
        || coalesce(v_regning->>'kode', '?') || '). Vurdér, om sælgeren skal opkræves.');
      perform public.sag_drift_alarm(s.id,
        'Sag ' || s.id::text || ': regningen for returfragt til sælgeren blev ikke oprettet, da returen blev registreret ('
        || coalesce(v_regning->>'kode', '?') || coalesce(' - ' || (v_regning->>'fejl'), '')
        || '). Sagen er markeret til staff.',
        'sag_returfragt_regning:' || s.id::text);
    end if;
  end if;$n$, 1),
      jsonb_build_array(
$g$          left('Returpakken er afleveret - refusion til køber (alt undtagen BidHamr Beskyttelse)'$g$,
$n$          left('Returpakken er afleveret - refusion til køber'$n$, 1)));
end $do$;

-- ===========================================================================
-- 9. Bortkommet pakke: reklamationen oprettes også automatisk
-- ===========================================================================
do $do$
begin
  raise notice 'sager_fragt_reklamation: %', pg_temp.r_ps_ret(
    'public.sager_fragt_reklamation()',
    '9277694da37123a94546d80a918862d7',
    '56c37531eab53fcbcf340b7c3fd21b46',
    jsonb_build_array(
      jsonb_build_array(
$g$  if new.type = 'skadet' then$g$,
$n$  -- 20261102350000: også bortkommet pakke (erstatningen går til sælgeren).
  if new.type in ('skadet', 'bortkommet') then$n$, 1)));

  raise notice 'fragt_reklamationer_synkroniser_alle: %', pg_temp.r_ps_ret(
    'public.fragt_reklamationer_synkroniser_alle(integer)',
    'e1085f5dc848692f70a2744e932dcfcf',
    '237df836bb729cd46afae331ee76fec3',
    jsonb_build_array(
      jsonb_build_array(
$g$    select o.sag_id
      from public.indpakning_ordentlig o
      join public.sager s on s.id = o.sag_id
      join public.trades t on t.id = s.trade_id
     where o.tilbagekaldt_kl is null and s.type = 'skadet'$g$,
$n$    -- 20261102350000: også bortkommet pakke (ingen indpakning at vurdere).
    select s.id
      from public.sager s
      join public.trades t on t.id = s.trade_id
     where ((s.type = 'skadet'
             and exists (select 1 from public.indpakning_ordentlig o
                          where o.sag_id = s.id and o.tilbagekaldt_kl is null))
            or s.type = 'bortkommet')$n$, 1),
      jsonb_build_array(
$g$       and not exists (select 1 from public.fragt_reklamationer r where r.sag_id = o.sag_id)$g$,
$n$       and not exists (select 1 from public.fragt_reklamationer r where r.sag_id = s.id)$n$, 1)));

  raise notice 'fragt_reklamation_synkroniser: %', pg_temp.r_ps_ret(
    'public.fragt_reklamation_synkroniser(uuid)',
    'e7c151db2fd0aeda581737dcc668ce8b',
    '0a5670e948ef2e54dd1781abea042663',
    jsonb_build_array(
      jsonb_build_array(
$g$        'Reklamation hos ' || upper(c.transportoer) || ' oprettet automatisk (skadet under fragten, ordentlig '
        || 'indpakning, køberen er refunderet, og afgørelsen er endelig). BidHamr anmelder - kravbeløb '$g$,
$n$        'Reklamation hos ' || upper(c.transportoer) || ' oprettet automatisk ('
        || case when (select s2.type from public.sager s2 where s2.id = p_sag) = 'bortkommet'
                then 'pakken er bortkommet' else 'skadet under fragten, ordentlig indpakning' end
        || ', køberen er refunderet, og afgørelsen er endelig). BidHamr anmelder - kravbeløb '$n$, 1)));
end $do$;

-- ===========================================================================
-- 10. BHX01: "returfragt", når det er en regning for returfragt (S5)
-- ===========================================================================
create or replace function public.ekstra_fragt_kraev(p_bruger uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_retur  boolean;
  v_ekstra boolean;
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then return; end if;
  if public.ekstra_fragt_spaerret(p_bruger) then
    select coalesce(bool_or(r.slags = 'returfragt_sag'), false), coalesce(bool_or(r.slags <> 'returfragt_sag'), false)
      into v_retur, v_ekstra
      from public.ekstra_fragt_regninger r
     where r.saelger_id = p_bruger and r.status = 'afventer_betaling'
       and public.ekstra_fragt_regning_spaerrer(r.status, r.frist);
    if v_retur and not v_ekstra then
      raise exception 'ekstra_fragt_ubetalt_returfragt: Du har en ubetalt regning for returfragt, og betalingsfristen er overskredet. Betal regningen på handlen under Mine handler, før du kan sætte flere varer til salg eller tilbyde en vare til næste byder.'
        using errcode = 'BHX01';
    elsif v_retur then
      raise exception 'ekstra_fragt_ubetalt_begge: Du har ubetalte regninger for ekstra fragt og returfragt, og betalingsfristen er overskredet. Betal regningerne på handlen under Mine handler, før du kan sætte flere varer til salg eller tilbyde en vare til næste byder.'
        using errcode = 'BHX01';
    end if;
    raise exception 'ekstra_fragt_ubetalt: Du har en ubetalt regning for ekstra fragt, og betalingsfristen er overskredet. Betal regningen på handlen under Mine handler, før du kan sætte flere varer til salg eller tilbyde en vare til næste byder.'
      using errcode = 'BHX01';
  end if;
end;
$fn$;
revoke all on function public.ekstra_fragt_kraev(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 11. mine_data: sælgerens egne svar i sager (S7)
-- ===========================================================================
create or replace function public.mine_data_sag_svar(p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'handel_id', v.trade_id,
           'tekst', v.tekst,
           'oprettet_kl', v.oprettet_kl,
           'billeder', coalesce((
             select jsonb_agg(jsonb_build_object('sti', b.sti, 'kategori', b.kategori, 'oprettet_kl', b.oprettet_kl)
                              order by b.oprettet_kl)
               from public.sag_svar_billeder b where b.svar_id = v.id), '[]'::jsonb))
           order by v.oprettet_kl), '[]'::jsonb)
    from public.sag_svar v
   where p_uid is not null and v.saelger_id = p_uid;
$fn$;
revoke all on function public.mine_data_sag_svar(uuid) from public, anon, authenticated, service_role;

-- Flettes ind i den NUVÆRENDE mine_data lige efter "v := public.mine_data_grund()"
-- (som 20261102290000). Allerede med: intet sker.
create or replace function pg_temp.sag_flet_mine_data()
returns void language plpgsql as $$
declare
  v_def text := replace(pg_get_functiondef('public.mine_data()'::regprocedure), E'\r\n', E'\n');
  v_gl  text := E'  v := public.mine_data_grund()';
  v_n   integer;
begin
  if position('public.mine_data_sag_svar(' in v_def) > 0 then
    return;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
  if v_n <> 1 then
    raise exception 'mine_data: "%" fundet % gange (skal være 1) - flet sagssvar ind manuelt', v_gl, v_n;
  end if;
  execute replace(v_def, v_gl,
    v_gl || E'\n       || jsonb_build_object(''sag_svar'', public.mine_data_sag_svar(v_uid))');
end $$;

select pg_temp.sag_flet_mine_data();

do $$
begin
  if position('public.mine_data_sag_svar(v_uid)' in pg_get_functiondef('public.mine_data()'::regprocedure)) = 0 then
    raise exception 'mine_data mangler sagssvar efter fletningen';
  end if;
end $$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated, service_role;

-- ===========================================================================
-- 12. Kontrol efter migrationen
-- ===========================================================================
do $do$
begin
  perform pg_temp.r_kraev_efter('public.sag_opret(uuid,text,text,jsonb,boolean,text,text)', '5c3d3fd8fa4a1a779d63d55d6e8e7a52');
  perform pg_temp.r_kraev_efter('public.sag_ret_type(uuid,uuid,text,text)', 'ac807d49abafc2a8d9f3f9c081ab0a18');
  perform pg_temp.r_kraev_efter('public.sag_returfragt_regning(uuid)', 'f4a8142f90a12271b55568f00be68c30');
  perform pg_temp.r_kraev_efter('public.sag_svar_paamind_kandidater(integer)', '2ff9e37ecaa7aeb938035a1da58805d6');
  perform pg_temp.r_kraev_efter('public.handel_problem_frist_paamind_kandidater(integer)', 'a1414406fe1a0d28e83354178469fe3c');
  perform pg_temp.r_kraev_efter('public.ekstra_fragt_kraev(uuid)', '24a967bad58fe832e9daadd525ad58c3');
  if to_regprocedure('public.sag_opret(uuid,text,text,jsonb,boolean,text)') is not null then
    raise exception 'sag_opret: den gamle signatur (6 parametre) findes stadig';
  end if;
end $do$;
