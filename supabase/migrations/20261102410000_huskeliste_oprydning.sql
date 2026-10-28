-- =============================================================================
-- Småting fra HUSKELISTE.md og PLAN-MOD-LANCERING.md (review 27.-28. okt.
-- 2026). Idempotent: kan køres flere gange (create ... if not exists, create
-- or replace, md5-drifttjek før hver rettelse af en eksisterende funktion).
-- Køres først på testdatabasen (pjiigmzqwlfepxnjdvug). Produktion kræver
-- Filips "ja".
--
-- Filen er delt i afsnit (linjerne "-- @afsnit <navn>"), så penge-db-testene
-- kan køre hvert afsnit for sig mod deres egne stubs. I drift køres hele
-- filen. Afsnittet "faelles" (hjælpere) og "slut" (oprydning) hører til
-- alle afsnit.
--
--   email   Skift af e-mail, småt 1-2 (review 27. okt.):
--           - Outbox: når login-adressen faktisk skifter (email_skift ->
--             'gennemfoert' i samme transaktion som Supabase Auth' ændring),
--             oprettes en række i email_skift_outbox. Serveren behandler den
--             med det samme, og betalings-cron'en (hvert 5. minut) tager de
--             rækker, der ikke blev færdige (serveren døde midt i skiftet).
--             Trinnene: log ud af andre enheder (sessioner fra FØR skiftet,
--             undtagen den enhed, der skiftede - email_skift.behold_session),
--             mail til den gamle adresse og Stripe.
--           - Recovery-token ryddes IGEN efter skiftet (en "Glemt
--             adgangskode"-token fra før skiftet, som Supabase Auth har
--             skrevet tilbage efter triggeren auth_users_email_ryd_tokens).
--             En token til den NYE adresse (efter skiftet) røres ikke.
--   bot     BidHamr-bot:
--           - bot_ny_besked: 'svar_i_gang', når der er en brugerbesked fra
--             de sidste 60 sekunder uden bot-svar i samme samtale (så skønnet
--             for svar i gang passer).
--           - Ændringer af lofterne (bot_indstillinger) logges i
--             moderation_log ('bot_lofter_aendret', maal_type 'system') med
--             gamle og nye værdier - trigger, så ingen ændring slipper uden om.
--   sag     Sagsregler:
--           - sag_indpakning_ved_afgoerelse: 'billeder_mangler', når staff
--             vælger "sælgeren betaler returfragten", og sagen ikke har et
--             billede af pakken eller labelen fra køberen (pakke, label,
--             pakke_label). Ellers kunne sælgeren få en regning uden bevis.
--           - sag_returfragt_regning_frafald: når sælgerens regning for
--             returfragt frafaldes (genåbning eller omgjort anke), markeres
--             sagen hos staff: BidHamr kan stå med returfragten.
--   faktura Firmafaktura:
--           - firma_faktura_send låser firmaets indstillinger FØR fakturaen -
--             samme rækkefølge som ændring af standard-momsordningen
--             (indstillinger -> kladder, triggeren
--             firma_faktura_indst_standard_synk), så de to ikke deadlocker.
--           - "Send mailen igen": firma_faktura_mail_tag låser mailen (5
--             minutter) under rækkelåsen på fakturaen, så to samtidige tryk
--             ikke giver to mails. firma_faktura_mail_frigiv slipper låsen,
--             når forsøget er slut.
--
-- Ingen handelsdata slettes eller ændres. Ingen eksisterende signaturer
-- ændres; den nuværende serverkode virker uændret mod databasen efter
-- migrationen (ny kode bruger de nye funktioner).
-- =============================================================================

-- @afsnit faelles
create or replace function pg_temp.ho_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Funktionen skal findes med en af de forventede kroppe.
create or replace function pg_temp.ho_kraev(p_fn text, variadic p_ok text[])
returns void language plpgsql as $f$
declare
  h text := pg_temp.ho_md5(p_fn);
begin
  if h is null then
    raise exception '%: findes ikke - kør de tidligere migrationer først', p_fn;
  end if;
  if not (h = any (p_ok)) then
    raise exception '%: md5 % er ingen af de forventede (%) - kontrollér funktionen, før migrationen køres',
      p_fn, h, array_to_string(p_ok, ', ');
  end if;
end $f$;

-- Tekst-erstatning i en eksisterende funktion: hvert stykke skal findes
-- præcis det angivne antal gange, og kroppen skal have md5 p_gammel før og
-- p_ny efter. Allerede rettet ('allerede') springes over.
create or replace function pg_temp.ho_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
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
  h := pg_temp.ho_md5(p_fn);
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
  h := pg_temp.ho_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- Nye værdier i en check-constraint af formen "kolonne = any (array[...])"
-- på moderation_log (de gamle værdier bevares).
create or replace function pg_temp.ho_flet_check(p_navn text, p_kol text, p_nye text[])
returns void language plpgsql as $f$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = p_navn;
  if v_def is null then
    raise exception '% findes ikke', p_navn;
  end if;
  if (select bool_and(v_def like '%''' || x || '''%' or v_def like '%,' || x || ',%' or v_def like '%{' || x || ',%'
                      or v_def like '%,' || x || '}%' or v_def like '%{' || x || '}%') from unnest(p_nye) x) then
    return;
  end if;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m
      union select unnest(p_nye)) s
    where x <> '' order by 1);
  if cardinality(v_vals) <= cardinality(p_nye) then
    raise exception 'Kunne ikke læse %: %', p_navn, v_def;
  end if;
  execute format('alter table public.moderation_log drop constraint %I', p_navn);
  execute format('alter table public.moderation_log add constraint %I check (%I = any (%L::text[]))', p_navn, p_kol, v_vals);
end $f$;

-- @afsnit email
-- ===========================================================================
-- E-mail: outbox for advarslen til den gamle adresse og log-ud
-- ===========================================================================
do $do$
begin
  if to_regclass('public.email_skift') is null then
    raise exception 'public.email_skift findes ikke - kør 20261102120000 og 20261102160000 først';
  end if;
  -- Spejlingen sætter 'gennemfoert' (uændret fra 20261102120000).
  perform pg_temp.ho_kraev('public.auth_users_email_spejl()', '78bb6ea71c8392bc99e7779da24962b7');
  perform pg_temp.ho_kraev('public.email_skift_tjek(uuid,text)', 'ca71c5a322a133e6e07b8eab33dffc68');
end $do$;

-- Den enhed (Supabase-session), der skiftede e-mailen. Den logges ikke ud.
-- null = ukendt: så logges alle sessioner fra før skiftet ud.
alter table public.email_skift add column if not exists behold_session uuid;

create table if not exists public.email_skift_outbox (
  id             uuid primary key default gen_random_uuid(),
  email_skift_id uuid not null unique references public.email_skift(id) on delete restrict,
  bruger_id      uuid not null references public.users(id) on delete restrict,
  -- Tidspunktet for skiftet (samme transaktion som Supabase Auth' ændring).
  -- Sessioner og tokens fra FØR dette tidspunkt ryddes.
  skiftet_kl     timestamptz not null default now(),
  log_ud_kl      timestamptz,
  mail_kl        timestamptz,
  stripe_kl      timestamptz,
  udfoert_kl     timestamptz,
  forsoeg        integer not null default 0 check (forsoeg between 0 and 1000),
  laast_til      timestamptz,
  sidste_fejl    text check (sidste_fejl is null or char_length(sidste_fejl) <= 1000),
  oprettet_kl    timestamptz not null default now()
);
create index if not exists email_skift_outbox_aaben_idx
  on public.email_skift_outbox (oprettet_kl) where udfoert_kl is null;

comment on table public.email_skift_outbox is
  'Skift af e-mail: det, der skal ske efter skiftet (log ud af andre enheder, ryd gamle recovery-tokens, mail til den gamle adresse, Stripe). Oprettes i samme transaktion som skiftet (trigger på email_skift), behandles af serveren og af betalings-cron''en. Ingen e-mailadresser her (de står i email_skift og fjernes ved sletning). Kun service_role. 20261102410000.';

alter table public.email_skift_outbox enable row level security;
revoke all on table public.email_skift_outbox from public, anon, authenticated;
grant select on table public.email_skift_outbox to service_role;

-- Serveren gemmer den kaldende enheds session, efter koden er godkendt
-- (status 'bekraeftet') og FØR Supabase Auth opdateres. Kun service_role.
create or replace function public.email_skift_behold_session(p_id uuid, p_bruger uuid, p_session uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.email_skift s
     set behold_session = p_session
   where s.id = p_id and s.bruger_id = p_bruger and s.status = 'bekraeftet';
  return found;
end
$fn$;
revoke execute on function public.email_skift_behold_session(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_skift_behold_session(uuid, uuid, uuid) to service_role;

-- Skiftet er sket (spejlingen sætter 'bekraeftet' -> 'gennemfoert' i samme
-- transaktion som Supabase Auth' ændring): outbox-rækken oprettes. Kun
-- brugerens eget skift (kilde 'bruger').
create or replace function public.email_skift_outbox_ny()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status = 'gennemfoert' and old.status is distinct from 'gennemfoert' and new.kilde = 'bruger' then
    insert into public.email_skift_outbox (email_skift_id, bruger_id, skiftet_kl)
    values (new.id, new.bruger_id, coalesce(new.gennemfoert_kl, now()))
    on conflict (email_skift_id) do nothing;
  end if;
  return null;
end
$fn$;
revoke execute on function public.email_skift_outbox_ny() from public, anon, authenticated;

drop trigger if exists email_skift_outbox_ny on public.email_skift;
create trigger email_skift_outbox_ny
  after update of status on public.email_skift
  for each row execute function public.email_skift_outbox_ny();

-- Tag op til p_graense åbne rækker (eller netop skiftet p_skift) i 2
-- minutter. En række, der er taget af en anden, springes over. Højst 12
-- forsøg (en time med cron hvert 5. minut) - så står den til /admin/drift.
-- Svar: jsonb-array med { id, bruger_id, skiftet_kl, gammel_email,
-- ny_email, log_ud, mail, stripe, forsoeg }.
create or replace function public.email_skift_outbox_tag(p_skift uuid default null, p_graense integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v jsonb;
begin
  with valgt as (
    select o.id from public.email_skift_outbox o
     where o.udfoert_kl is null
       and o.forsoeg < 12
       and (o.laast_til is null or o.laast_til < now())
       and (p_skift is null or o.email_skift_id = p_skift)
     order by o.oprettet_kl
     limit least(greatest(coalesce(p_graense, 20), 1), 100)
     for update skip locked
  ), taget as (
    update public.email_skift_outbox o
       set laast_til = now() + interval '2 minutes', forsoeg = o.forsoeg + 1
      from valgt
     where o.id = valgt.id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'bruger_id', t.bruger_id, 'skiftet_kl', t.skiftet_kl,
           'gammel_email', s.gammel_email, 'ny_email', s.ny_email,
           'log_ud', t.log_ud_kl is not null, 'mail', t.mail_kl is not null,
           'stripe', t.stripe_kl is not null, 'forsoeg', t.forsoeg) order by t.oprettet_kl), '[]'::jsonb)
    into v
    from taget t join public.email_skift s on s.id = t.email_skift_id;
  return v;
end
$fn$;
revoke execute on function public.email_skift_outbox_tag(uuid, integer) from public, anon, authenticated;
grant execute on function public.email_skift_outbox_tag(uuid, integer) to service_role;

-- Log ud af andre enheder og ryd gamle recovery-tokens - kun det, der er
-- fra FØR skiftet. Idempotent (log_ud_kl). Sletningen i auth.sessions er
-- den samme som Supabase' "log ud andre steder" (refresh tokens følger med).
-- Svar: { kode: 'ok' | 'allerede' | 'ukendt', sessioner, tokens }.
create or replace function public.email_skift_outbox_log_ud(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  o  record;
  v_sess integer := 0;
  v_tok  integer := 0;
  n      integer;
begin
  select x.id, x.bruger_id, x.skiftet_kl, x.log_ud_kl, s.behold_session
    into o
    from public.email_skift_outbox x
    join public.email_skift s on s.id = x.email_skift_id
   where x.id = p_id
   for update of x;
  if not found then return jsonb_build_object('kode', 'ukendt'); end if;
  if o.log_ud_kl is not null then return jsonb_build_object('kode', 'allerede'); end if;

  delete from auth.sessions a
   where a.user_id = o.bruger_id
     and a.created_at < o.skiftet_kl
     and a.id is distinct from o.behold_session;
  get diagnostics v_sess = row_count;

  -- "Glemt adgangskode" fra før skiftet (til den gamle adresse) virker ikke.
  update auth.users a
     set recovery_token = ''
   where a.id = o.bruger_id
     and coalesce(a.recovery_token, '') <> ''
     and (a.recovery_sent_at is null or a.recovery_sent_at < o.skiftet_kl);
  get diagnostics n = row_count;
  v_tok := v_tok + n;
  delete from auth.one_time_tokens t
   where t.user_id = o.bruger_id
     and t.token_type = 'recovery_token'
     and t.created_at < o.skiftet_kl;
  get diagnostics n = row_count;
  v_tok := v_tok + n;

  update public.email_skift_outbox x
     set log_ud_kl = now(),
         udfoert_kl = case when x.mail_kl is not null and x.stripe_kl is not null then now() end
   where x.id = p_id and x.log_ud_kl is null;
  return jsonb_build_object('kode', 'ok', 'sessioner', v_sess, 'tokens', v_tok);
end
$fn$;
revoke execute on function public.email_skift_outbox_log_ud(uuid) from public, anon, authenticated;
grant execute on function public.email_skift_outbox_log_ud(uuid) to service_role;

-- Et trin er gjort ('mail' eller 'stripe'). Rækken er færdig, når alle tre
-- trin er gjort. Idempotent.
create or replace function public.email_skift_outbox_trin(p_id uuid, p_trin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_trin not in ('mail', 'stripe') then return false; end if;
  update public.email_skift_outbox x
     set mail_kl   = case when p_trin = 'mail' then coalesce(x.mail_kl, now()) else x.mail_kl end,
         stripe_kl = case when p_trin = 'stripe' then coalesce(x.stripe_kl, now()) else x.stripe_kl end
   where x.id = p_id;
  if not found then return false; end if;
  update public.email_skift_outbox x
     set udfoert_kl = now(), laast_til = null, sidste_fejl = null
   where x.id = p_id and x.udfoert_kl is null
     and x.log_ud_kl is not null and x.mail_kl is not null and x.stripe_kl is not null;
  return true;
end
$fn$;
revoke execute on function public.email_skift_outbox_trin(uuid, text) from public, anon, authenticated;
grant execute on function public.email_skift_outbox_trin(uuid, text) to service_role;

-- Et forsøg fejlede: fejlen gemmes, og låsen slippes, så cron'en prøver igen.
create or replace function public.email_skift_outbox_fejl(p_id uuid, p_fejl text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.email_skift_outbox x
     set sidste_fejl = left(coalesce(p_fejl, 'Ukendt fejl'), 1000), laast_til = null
   where x.id = p_id and x.udfoert_kl is null;
  return found;
end
$fn$;
revoke execute on function public.email_skift_outbox_fejl(uuid, text) from public, anon, authenticated;
grant execute on function public.email_skift_outbox_fejl(uuid, text) to service_role;

-- @afsnit bot
-- ===========================================================================
-- BidHamr-bot: svar_i_gang og log over ændrede lofter
-- ===========================================================================
do $do$
begin
  perform pg_temp.ho_kraev('public.bot_ny_besked(uuid,uuid,text,text,text,numeric)',
    'bd3f53afd739b0c5b4181c9d68b4a272', 'e7e9578f0311f63b2ab4d8f662849746');
  if to_regclass('public.bot_indstillinger') is null or to_regclass('public.moderation_log') is null then
    raise exception 'bot_indstillinger eller moderation_log findes ikke - kør de tidligere migrationer først';
  end if;
end $do$;

do $do$
begin
  raise notice 'bot_ny_besked: %', pg_temp.ho_ret(
    'public.bot_ny_besked(uuid,uuid,text,text,text,numeric)',
    'bd3f53afd739b0c5b4181c9d68b4a272',
    'e7e9578f0311f63b2ab4d8f662849746',
    jsonb_build_array(
      jsonb_build_array(
$g$    if n >= c_maks_samtale then
      return jsonb_build_object('kode', 'samtale_fuld');
    end if;$g$,
$n$    if n >= c_maks_samtale then
      return jsonb_build_object('kode', 'samtale_fuld');
    end if;
    -- 20261102410000: et svar er i gang i samme samtale (en brugerbesked fra
    -- de sidste 60 sekunder uden bot-svar). Den nye besked afvises, så
    -- skønnet for svar i gang passer. Låsen ovenfor gør tjekket atomisk.
    if exists (select 1 from public.bot_beskeder b
                where b.samtale_id = v_samtale and b.rolle = 'bruger' and b.oprettet_kl > v_igang_fra
                  and not exists (select 1 from public.bot_beskeder r
                                   where r.samtale_id = b.samtale_id and r.rolle = 'bot'
                                     and r.oprettet_kl >= b.oprettet_kl)) then
      return jsonb_build_object('kode', 'svar_i_gang');
    end if;$n$, 1)));
end $do$;

select pg_temp.ho_flet_check('moderation_log_handling_check', 'handling', array['bot_lofter_aendret']);
select pg_temp.ho_flet_check('moderation_log_maal_type_check', 'maal_type', array['system']);

-- Ændrede lofter logges i moderation_log med gamle og nye værdier, i samme
-- transaktion som ændringen. Medarbejderen er opdateret_af (chefen, der
-- gemte på /admin/bot); mangler den, står BidHamr-systembrugeren.
create or replace function public.bot_indstillinger_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_af uuid := coalesce(new.opdateret_af, '00000000-0000-4000-8000-0000000b1d00'::uuid);
  v_tekst text;
begin
  v_tekst := left(
    'Lofter for BidHamr-bot ændret: '
    || 'døgnloft ' || old.doegnloft_usd::text || ' -> ' || new.doegnloft_usd::text || ' USD; '
    || 'andel uden login ' || round(old.anon_andel * 100, 1)::text || ' -> ' || round(new.anon_andel * 100, 1)::text || ' %; '
    || 'pr. bruger ' || old.bruger_loft_usd::text || ' -> ' || new.bruger_loft_usd::text || ' USD; '
    || 'beskeder uden login ' || old.doegnloft_anon::text || ' -> ' || new.doegnloft_anon::text
    || ' | ' || jsonb_build_object(
         'gammel', jsonb_build_object('doegnloft_usd', old.doegnloft_usd, 'anon_andel', old.anon_andel,
                                      'bruger_loft_usd', old.bruger_loft_usd, 'doegnloft_anon', old.doegnloft_anon),
         'ny', jsonb_build_object('doegnloft_usd', new.doegnloft_usd, 'anon_andel', new.anon_andel,
                                  'bruger_loft_usd', new.bruger_loft_usd, 'doegnloft_anon', new.doegnloft_anon))::text,
    4000);
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (v_af, 'bot_lofter_aendret', 'system', v_af, null, v_tekst);
  return null;
end
$fn$;
revoke execute on function public.bot_indstillinger_log() from public, anon, authenticated;

drop trigger if exists bot_indstillinger_log on public.bot_indstillinger;
create trigger bot_indstillinger_log
  after update on public.bot_indstillinger
  for each row
  when ((old.doegnloft_usd, old.anon_andel, old.bruger_loft_usd, old.doegnloft_anon)
        is distinct from (new.doegnloft_usd, new.anon_andel, new.bruger_loft_usd, new.doegnloft_anon))
  execute function public.bot_indstillinger_log();

-- @afsnit sag
-- ===========================================================================
-- Sagsregler: billede af pakken/labelen før sælgerens regning, og markering
-- ved frafaldet regning
-- ===========================================================================
do $do$
begin
  perform pg_temp.ho_kraev('public.sag_indpakning_ved_afgoerelse(uuid,uuid,uuid,uuid,text)',
    '6bbc7d5dd9c8cae0ab8b4fdcfe437c91', 'c0ac7bef444eb2003b0f14c6bc3075cd');
  perform pg_temp.ho_kraev('public.sag_returfragt_regning_frafald(uuid,uuid,text)',
    '0cd180530a8a12cfbde34ac620246c27', 'bed74bb500467563138003ab4692064c');
  perform pg_temp.ho_kraev('public.sag_staff_marker(uuid,text)', 'd13cd8a58f2f52e14a9210630ed98003');
end $do$;

do $do$
begin
  raise notice 'sag_indpakning_ved_afgoerelse: %', pg_temp.ho_ret(
    'public.sag_indpakning_ved_afgoerelse(uuid,uuid,uuid,uuid,text)',
    '6bbc7d5dd9c8cae0ab8b4fdcfe437c91',
    'c0ac7bef444eb2003b0f14c6bc3075cd',
    jsonb_build_array(
      jsonb_build_array(
$g$      return jsonb_build_object('kode', 'indpakning_ordentlig');
    end if;
    return jsonb_build_object('kode', 'ok');$g$,
$n$      return jsonb_build_object('kode', 'indpakning_ordentlig');
    end if;
    -- 20261102410000: sælgeren får kun en regning med bevis - køberens
    -- billede af pakken eller labelen i sagen.
    if not exists (select 1 from public.sag_billeder b
                    where b.sag_id = p_sag and b.kategori in ('pakke', 'label', 'pakke_label')) then
      return jsonb_build_object('kode', 'billeder_mangler');
    end if;
    return jsonb_build_object('kode', 'ok');$n$, 1)));

  raise notice 'sag_returfragt_regning_frafald: %', pg_temp.ho_ret(
    'public.sag_returfragt_regning_frafald(uuid,uuid,text)',
    '0cd180530a8a12cfbde34ac620246c27',
    'bed74bb500467563138003ab4692064c',
    jsonb_build_array(
      jsonb_build_array(
$g$        || r.status || ') | Til sælgeren: ' || p_grund);
      v_fra := v_fra + 1;$g$,
$n$        || r.status || ') | Til sælgeren: ' || p_grund);
      -- 20261102410000: returen er sket eller i gang, og sælgeren betaler
      -- ikke - staff skal vide, at BidHamr kan stå med returfragten.
      perform public.sag_staff_marker(p_sag,
        'Sælgerens regning for returfragt (' || public.ekstra_fragt_kr(r.beloeb_oere)
        || ') er frafaldet (' || p_grund || '). BidHamr kan stå med returfragten - vurdér, om den skal dækkes på anden måde.');
      v_fra := v_fra + 1;$n$, 1)));
end $do$;

-- @afsnit faktura
-- ===========================================================================
-- Firmafaktura: låserækkefølge i send og lås på "Send mailen igen"
-- ===========================================================================
do $do$
begin
  perform pg_temp.ho_kraev('public.firma_faktura_send(uuid)', 'ea408de9f2edc17ed055df244921cd48', '2ee2057fd47ae5797924d02ad76ef036');
  perform pg_temp.ho_kraev('public.firma_faktura_mail_resultat(uuid,boolean,text)', '432cecb767a9a3d5b825b2a8381bf5fa');
end $do$;

do $do$
begin
  raise notice 'firma_faktura_send: %', pg_temp.ho_ret(
    'public.firma_faktura_send(uuid)',
    'ea408de9f2edc17ed055df244921cd48',
    '2ee2057fd47ae5797924d02ad76ef036',
    jsonb_build_array(
      jsonb_build_array(
$g$  -- Lås fakturaen (dobbeltklik venter her).
  select * into x from public.firma_fakturaer f$g$,
$n$  -- 20261102410000: firmaets indstillinger låses FØR fakturaen - samme
  -- rækkefølge som en ændring af standard-momsordningen (indstillinger ->
  -- kladder), så de to ikke kan deadlocke.
  perform public.firma_faktura_indstillinger_sikr(v_firma);
  perform 1 from public.firma_faktura_indstillinger s where s.firma_id = v_firma for update;
  -- Lås fakturaen (dobbeltklik venter her).
  select * into x from public.firma_fakturaer f$n$, 1)));
end $do$;

-- Lås på mailen til køberen (én pr. faktura). Ikke handelsdata - kun en
-- kortvarig lås; rækken bliver stående.
create table if not exists public.firma_faktura_mail_laas (
  faktura_id  uuid primary key references public.firma_fakturaer(id) on delete restrict,
  laast_til   timestamptz,
  opdateret_kl timestamptz not null default now()
);
comment on table public.firma_faktura_mail_laas is
  'Lås på mailen med en sendt faktura til køberen, så to samtidige tryk på "Send mailen igen" ikke giver to mails (firma_faktura_mail_tag / _frigiv). Kun service role. 20261102410000.';
alter table public.firma_faktura_mail_laas enable row level security;
revoke all on public.firma_faktura_mail_laas from public, anon, authenticated;
grant select on public.firma_faktura_mail_laas to service_role;

-- true = kalderen må sende mailen nu (låst i 5 minutter). false = mailen er
-- allerede sendt, fakturaen er ikke sendt, eller et andet forsøg er i gang.
-- Rækkelåsen på fakturaen gør det atomisk.
create or replace function public.firma_faktura_mail_tag(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f record;
  n integer;
begin
  select x.id, x.status, x.mail_sendt_kl into f from public.firma_fakturaer x where x.id = p_id for update;
  if not found or f.status <> 'sendt' or f.mail_sendt_kl is not null then
    return false;
  end if;
  insert into public.firma_faktura_mail_laas (faktura_id, laast_til, opdateret_kl)
  values (p_id, now() + interval '5 minutes', now())
  on conflict (faktura_id) do update
     set laast_til = excluded.laast_til, opdateret_kl = now()
   where firma_faktura_mail_laas.laast_til is null or firma_faktura_mail_laas.laast_til < now();
  get diagnostics n = row_count;
  return n = 1;
end
$fn$;
revoke execute on function public.firma_faktura_mail_tag(uuid) from public, anon, authenticated;
grant execute on function public.firma_faktura_mail_tag(uuid) to service_role;

create or replace function public.firma_faktura_mail_frigiv(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.firma_faktura_mail_laas l set laast_til = null, opdateret_kl = now() where l.faktura_id = p_id;
  return found;
end
$fn$;
revoke execute on function public.firma_faktura_mail_frigiv(uuid) from public, anon, authenticated;
grant execute on function public.firma_faktura_mail_frigiv(uuid) to service_role;

-- @afsnit slut
drop function if exists pg_temp.ho_flet_check(text, text, text[]);
drop function if exists pg_temp.ho_ret(text, text, text, jsonb);
drop function if exists pg_temp.ho_kraev(text, text[]);
drop function if exists pg_temp.ho_md5(text);
