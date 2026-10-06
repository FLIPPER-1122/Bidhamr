-- Rettelser 2 efter test af pause af skjulte auktioner (6. oktober 2026).
-- Kun til TESTDATABASEN, som allerede har 20261009040000 og 20261009041000.
-- Produktion får det samme via 20261009040000_skjult_auktion_pause.sql
-- (punkt 12-16 i den fil). Slutresultatet er ens.
--
--  1. annuller_egen_auktion afviser (false), mens auktionen er skjult eller
--     på pause. Samme signatur og returtype (Expo-appen). rediger_auktion og
--     saet_spoergsmaal_aktiv afviste allerede skjulte auktioner.
--  2. En fjernet (annulleret) auktion bliver aldrig offentligt synlig igen:
--     medhold (dsa_klage_afgoer), "Vis igen" og en genåbnet rapport ophæver
--     afgørelsen, men skjult forbliver true (auctions_pause_skjult).
--  3. Fjernes/stoppes en skjult auktion (også automatisk efter 14 dages
--     pause), markeres den ældre "Auktion skjult"-afgørelse som ophævet med
--     grunden 'erstattet' (ny værdi, flettet ind i CHECK'en), så klageretten
--     kun gælder den nyeste afgørelse. mine_dsa_afgoerelser returnerer
--     ophaevet_grund, og dsa_rapport tæller ikke 'erstattet' som ophævet.
--
-- Idempotent: kan køres flere gange.

set lock_timeout = '5s';

-- =====================================================================
-- auctions_pause_skjult: en annulleret auktion forbliver skjult
-- =====================================================================
create or replace function public.auctions_pause_skjult()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rest interval;
begin
  -- Annulleret: pausen lukkes. En annulleret auktion genåbnes aldrig
  -- (Filip, 6. okt. 2026), så den resterende tid gemmes ikke.
  if new.status = 'annulleret' then
    if old.pauset_kl is not null or new.pauset_kl is not null then
      new.pauset_kl := null;
      new.pause_resterende := null;
      update public.auktion_pauser
         set annulleret_kl = now()
       where auction_id = new.id and genoptaget_kl is null and annulleret_kl is null;
    end if;
    -- En fjernet (annulleret) auktion bliver aldrig offentligt synlig igen -
    -- heller ikke ved "Vis igen", medhold eller en genåbnet rapport (Filip,
    -- 6. okt. 2026). Den forbliver skjult (kun sælger, deltagere og staff kan
    -- se den), og fjernelsen ophæves i stedet, så sælgeren kan sætte varen
    -- op igen med ét klik. (dsa_klage_afgoer ophæver selv med grunden
    -- 'klage', før den kommer hertil.)
    if coalesce(old.skjult, false) and not coalesce(new.skjult, false) then
      new.skjult := true;
      update public.dsa_afgoerelser
         set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where indhold_type = 'auktion' and indhold_id = new.id
         and handling in ('auktion_fjernet', 'auktion_annulleret')
         and ophaevet_kl is null;
    end if;
    return new;
  end if;

  -- Skjules: en igangværende auktion sættes på pause.
  if coalesce(new.skjult, false) and not coalesce(old.skjult, false)
     and old.status = 'aktiv' and new.status = 'aktiv' and old.pauset_kl is null then
    v_rest := greatest(old.slutter_kl - now(), interval '0');
    new.pauset_kl := now();
    new.pause_resterende := v_rest;
    insert into public.auktion_pauser (auction_id, pauset_kl, resterende)
    values (new.id, new.pauset_kl, v_rest)
    on conflict (auction_id) where genoptaget_kl is null and annulleret_kl is null do nothing;
    return new;
  end if;

  -- Genoptages: pauset, aktiv og synlig - uanset hvilken kolonne der ændrede sig.
  if old.pauset_kl is not null and new.status = 'aktiv' and not coalesce(new.skjult, false) then
    new.slutter_kl := now() + greatest(coalesce(old.pause_resterende, interval '0'), interval '24 hours');
    new.pauset_kl := null;
    new.pause_resterende := null;
    update public.auktion_pauser
       set genoptaget_kl = now(), ny_slutter_kl = new.slutter_kl
     where auction_id = new.id and genoptaget_kl is null and annulleret_kl is null;
  end if;

  return new;
end;
$fn$;

revoke all on function public.auctions_pause_skjult() from public, anon, authenticated;

-- =====================================================================
-- dsa_klage_afgoer: medhold viser ikke en annulleret auktion igen
-- =====================================================================
create or replace function public.dsa_klage_afgoer(p_medarbejder uuid, p_klage uuid, p_udfald text, p_svar text, p_intern_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_svar  text := btrim(coalesce(p_svar, ''));
  v_note  text := nullif(btrim(coalesce(p_intern_note, '')), '');
  k       record;
  af      record;
  an      record;
  v_rolle text := 'medarbejder';
  v_r     jsonb;
  v_genaabnet boolean := true;
  v_bruger uuid;
  v_til    uuid;
  v_saelger uuid;
begin
  if p_udfald is null or p_udfald not in ('medhold', 'fastholdt') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_svar = '' then return jsonb_build_object('kode', 'svar_mangler'); end if;
  if char_length(v_svar) > 2000 or (v_note is not null and char_length(v_note) > 2000) then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select * into k from public.dsa_klager x where x.id = p_klage for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if k.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;

  if k.afgoerelse_id is not null then
    select * into af from public.dsa_afgoerelser x where x.id = k.afgoerelse_id for update;
    v_rolle := public.dsa_min_rolle(af.handling);
    v_bruger := af.bruger_id;
  else
    select * into an from public.dsa_anmeldelser x where x.id = k.anmeldelse_id for update;
    v_bruger := an.anmeldt_bruger_id;
  end if;

  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, v_rolle) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  if k.afgoerelse_id is not null then
    if p_medarbejder is not distinct from af.medarbejder_id
       or p_medarbejder = k.klager_id
       or public.dsa_er_inhabil(p_medarbejder, af.bruger_id)
       or exists (select 1 from public.dsa_anmeldelser x
                   where x.id = af.anmeldelse_id and x.anmelder_id = p_medarbejder) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
    if af.handling in ('bedoemmelse_skjult', 'bedoemmelse_svar_skjult') then
      select r.til_bruger_id into v_til from public.ratings r where r.id = af.indhold_id;
      if public.bedoemmelse_er_inhabil(p_medarbejder, af.indhold_id)
         or public.dsa_er_inhabil(p_medarbejder, v_til) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    elsif af.handling = 'spoergsmaal_skjult' then
      select x.asker_id, au.bruger_id into v_til, v_saelger
        from public.auction_questions x join public.auctions au on au.id = x.auction_id
       where x.id = af.indhold_id;
      if public.dsa_er_inhabil(p_medarbejder, v_til) or public.dsa_er_inhabil(p_medarbejder, v_saelger) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    end if;
  else
    if p_medarbejder is not distinct from an.behandlet_af
       or p_medarbejder is not distinct from an.anmelder_id
       or public.dsa_er_inhabil(p_medarbejder, an.anmeldt_bruger_id) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
  end if;

  if p_udfald = 'medhold' then
    if k.afgoerelse_id is not null then
      -- Fjernet/stoppet: afgørelsen ophæves, men auktionen åbnes ikke igen.
      if af.handling in ('auktion_fjernet', 'auktion_annulleret') then
        v_genaabnet := false;
        perform 1 from public.auctions x where x.id = af.indhold_id for update;
      end if;

      update public.dsa_afgoerelser
         set ophaevet_kl = coalesce(ophaevet_kl, now()), ophaevet_grund = coalesce(ophaevet_grund, 'klage')
       where id = af.id;

      if af.handling = 'auktion_skjult' then
        -- Kun en auktion, der ikke siden er fjernet/stoppet, vises igen.
        update public.auctions set skjult = false
         where id = af.indhold_id and skjult and status <> 'annulleret';
        if exists (select 1 from public.auctions x where x.id = af.indhold_id and x.status = 'annulleret') then
          v_genaabnet := false;
        end if;
      elsif af.handling in ('auktion_fjernet', 'auktion_annulleret') then
        -- En fjernet (annulleret) auktion forbliver skjult (Filip, 6. okt.
        -- 2026): kun sælger, deltagere og staff kan se den med "Annulleret -
        -- du fik medhold, sæt varen op igen". Afgørelsen er ophævet ovenfor.
        null;
      elsif af.handling = 'spoergsmaal_skjult' then
        v_r := public.skjul_spoergsmaal(p_medarbejder, af.indhold_id, false, null);
        if v_r->>'kode' not in ('ok', 'uaendret') then
          raise exception 'skjul_spoergsmaal: %', v_r->>'kode';
        end if;
      elsif af.handling in ('bedoemmelse_skjult', 'bedoemmelse_svar_skjult') then
        v_r := public.skjul_bedoemmelse(p_medarbejder, af.indhold_id,
                 case when af.handling = 'bedoemmelse_skjult' then 'bedoemmelse' else 'svar' end,
                 false, null, left('Medhold i klage ' || k.sagsnummer, 500));
        if v_r->>'kode' not in ('ok', 'uaendret') then
          raise exception 'skjul_bedoemmelse: %', v_r->>'kode';
        end if;
      elsif af.handling = 'konto_suspenderet' then
        if not exists (select 1 from public.dsa_afgoerelser y
                        where y.bruger_id = af.bruger_id and y.id <> af.id
                          and y.handling in ('konto_suspenderet', 'konto_lukket')
                          and y.oprettet_kl > af.oprettet_kl and y.ophaevet_kl is null) then
          update public.users
             set suspenderet = false, suspenderet_aarsag = null, suspenderet_kl = null, suspenderet_til = null
           where id = af.bruger_id and suspenderet and konto_lukket_kl is null;
        end if;
        insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
        values (p_medarbejder, 'ophaev_suspension', 'bruger', af.bruger_id, af.bruger_id,
                left('Suspension ophævet efter medhold i klage ' || k.sagsnummer, 4000));
      elsif af.handling = 'konto_lukket' then
        update public.users
           set konto_lukket_kl = null, konto_lukket_af = null, suspenderet = false,
               suspenderet_aarsag = null, suspenderet_kl = null, suspenderet_til = null
         where id = af.bruger_id and konto_lukket_kl is not null and konto_slettet_kl is null;
        insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
        values (p_medarbejder, 'konto_genaabnet', 'bruger', af.bruger_id, af.bruger_id,
                left('Konto genåbnet efter medhold i klage ' || k.sagsnummer, 4000));
      end if;
    else
      update public.dsa_anmeldelser
         set status = 'ny', udfald = null, behandlet_af = null, behandlet_kl = null,
             genaabnet_kl = now(), frist_kl = now() + interval '7 days', svar_sendt_kl = null
       where id = an.id;
    end if;
  end if;

  update public.dsa_klager
     set status = 'afgjort', udfald = p_udfald, svar = v_svar, intern_note = v_note,
         afgjort_af = p_medarbejder, afgjort_kl = now()
   where id = k.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder,
          case when p_udfald = 'medhold' then 'dsa_klage_medhold' else 'dsa_klage_fastholdt' end,
          'dsa', k.id, v_bruger,
          left('Klage ' || k.sagsnummer || ': ' || case when p_udfald = 'medhold' then 'medhold' else 'afgørelsen fastholdt' end
               || case when p_udfald = 'medhold' and not v_genaabnet then ' (auktionen åbnes ikke igen - sælgeren kan sætte varen op igen)' else '' end
               || ' | ' || coalesce(v_note, v_svar), 4000));

  return jsonb_build_object('kode', 'ok', 'genaabnet', v_genaabnet,
                            'type', case when k.afgoerelse_id is not null then 'afgoerelse' else 'anmeldelse' end);
end;
$fn$;

revoke all on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) to service_role;

-- =====================================================================
-- 13. annuller_egen_auktion: ikke mens auktionen er skjult eller på pause
-- =====================================================================
-- Som 20260930080000_annuller_egen_auktion.sql (samme signatur og
-- returtype - Expo-appen kalder den). NYT: afvis (false), når BidHamr har
-- skjult auktionen, eller den er på pause. Funktionen er security definer og
-- springer derfor auctions_beskyt_kolonner over, så tjekket skal stå her.
-- (rediger_auktion og saet_spoergsmaal_aktiv afviser allerede skjulte.)
create or replace function public.annuller_egen_auktion(p_auktion uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_antal int;
begin
  if v_uid is null then raise exception 'Du skal være logget ind.' using errcode = '42501'; end if;
  update public.auctions a set status = 'annulleret'
   where a.id = p_auktion and a.bruger_id = v_uid and a.status = 'aktiv' and a."nuværende_bud" is null
     and not coalesce(a.skjult, false)
     and a.pauset_kl is null
     and not exists (select 1 from public.bids b where b.auktion_id = a.id);
  get diagnostics v_antal = row_count;
  return v_antal > 0;
end;
$fn$;

revoke all on function public.annuller_egen_auktion(uuid) from public, anon;
grant execute on function public.annuller_egen_auktion(uuid) to authenticated, service_role;

-- =====================================================================
-- 14. "Auktion skjult" erstattes af en nyere fjernelse/stop
-- =====================================================================
-- Skjules en auktion og fjernes/stoppes den bagefter (af en medarbejder
-- eller automatisk efter 14 dages pause), er der to afgørelser om samme sag.
-- Klageretten gælder den nyeste: den ældre "Auktion skjult" markeres som
-- ophævet med ophaevet_grund 'erstattet' (FLETTES ind i CHECK'en), så
-- /konto/afgoerelser og /dsa/afgoerelse ikke tilbyder klage over den.
-- Gennemsigtighedsrapporten tæller ikke 'erstattet' som "ophævet senere".
do $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.dsa_afgoerelser'::regclass
     and c.conname = 'dsa_afgoerelser_ophaevet_grund_check';

  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union select 'klage' union select 'staff' union select 'erstattet'
  ) s;

  if v_def is null or position('''erstattet''' in v_def) = 0 then
    alter table public.dsa_afgoerelser drop constraint if exists dsa_afgoerelser_ophaevet_grund_check;
    execute format(
      'alter table public.dsa_afgoerelser add constraint dsa_afgoerelser_ophaevet_grund_check '
      || 'check (ophaevet_grund is null or ophaevet_grund = any (array[%s]::text[]))',
      (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) v));
  end if;
end $$;

create or replace function public.dsa_afgoerelse_erstat_skjult()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.dsa_afgoerelser
     set ophaevet_kl = now(), ophaevet_grund = 'erstattet'
   where indhold_type = 'auktion' and indhold_id = new.indhold_id
     and handling = 'auktion_skjult'
     and id <> new.id
     and oprettet_kl <= new.oprettet_kl
     and ophaevet_kl is null;
  return null;
end;
$fn$;

revoke all on function public.dsa_afgoerelse_erstat_skjult() from public, anon, authenticated;

drop trigger if exists dsa_afgoerelse_erstat_skjult on public.dsa_afgoerelser;
create trigger dsa_afgoerelse_erstat_skjult
  after insert on public.dsa_afgoerelser
  for each row
  when (new.indhold_type = 'auktion' and new.handling in ('auktion_fjernet', 'auktion_annulleret'))
  execute function public.dsa_afgoerelse_erstat_skjult();

-- Engangs-oprydning: eksisterende "Auktion skjult", som en nyere
-- fjernelse/stop allerede har afløst.
update public.dsa_afgoerelser s
   set ophaevet_kl = coalesce(
         (select min(n.oprettet_kl) from public.dsa_afgoerelser n
           where n.indhold_type = 'auktion' and n.indhold_id = s.indhold_id
             and n.handling in ('auktion_fjernet', 'auktion_annulleret')
             and n.oprettet_kl >= s.oprettet_kl and n.id <> s.id), now()),
       ophaevet_grund = 'erstattet'
 where s.indhold_type = 'auktion' and s.handling = 'auktion_skjult' and s.ophaevet_kl is null
   and exists (select 1 from public.dsa_afgoerelser n
                where n.indhold_type = 'auktion' and n.indhold_id = s.indhold_id
                  and n.handling in ('auktion_fjernet', 'auktion_annulleret')
                  and n.oprettet_kl >= s.oprettet_kl and n.id <> s.id);

-- =====================================================================
-- 15. mine_dsa_afgoerelser: ophaevet_grund med (sidste kolonne)
-- =====================================================================
-- Som 20261009010000_dsa.sql. NYT: ophaevet_grund til sidst, så siden kan
-- vise "Erstattet" i stedet for "Ophævet". Kolonnen er tilføjet til sidst,
-- så eksisterende kaldere (også appen) ikke påvirkes.
do $$
begin
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.mine_dsa_afgoerelser()'::regprocedure
       and 'ophaevet_grund' = any (p.proargnames)) then
    drop function public.mine_dsa_afgoerelser();
  end if;
end $$;

create or replace function public.mine_dsa_afgoerelser()
returns table(id uuid, sagsnummer text, indhold_type text, indhold_id uuid, auktion_id uuid, indhold_tekst text,
              handling text, regel_tekst text, grundlag text, fakta text, automatisk_opdaget boolean,
              automatisk_afgjort boolean, efter_anmeldelse boolean, varighed_til timestamptz, oprettet_kl timestamptz,
              klage_frist_kl timestamptz, ophaevet_kl timestamptz, klage_status text, klage_udfald text,
              klage_svar text, klage_oprettet_kl timestamptz, klage_afgjort_kl timestamptz, ophaevet_grund text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id, a.sagsnummer, a.indhold_type, a.indhold_id, a.auktion_id, a.indhold_tekst, a.handling,
         a.regel_tekst, a.grundlag, a.fakta, a.automatisk_opdaget, a.automatisk_afgjort,
         a.anmeldelse_id is not null, a.varighed_til, a.oprettet_kl, a.klage_frist_kl, a.ophaevet_kl,
         k.status, k.udfald, k.svar, k.oprettet_kl, k.afgjort_kl, a.ophaevet_grund
    from public.dsa_afgoerelser a
    left join public.dsa_klager k on k.afgoerelse_id = a.id
   where auth.uid() is not null and a.bruger_id = auth.uid()
   order by a.oprettet_kl desc
   limit 200;
$fn$;

revoke all on function public.mine_dsa_afgoerelser() from public, anon;
grant execute on function public.mine_dsa_afgoerelser() to authenticated, service_role;

-- =====================================================================
-- 16. dsa_rapport: 'erstattet' tæller ikke som "ophævet senere"
-- =====================================================================
-- Rettes i den eksisterende definition (20261009010000_dsa.sql), så resten
-- af rapporten er uændret.
do $$
declare
  v_def text := pg_get_functiondef('public.dsa_rapport(timestamptz, timestamptz)'::regprocedure);
  v_fra text := 'from afg where ophaevet_kl is not null)';
  v_til text := 'from afg where ophaevet_kl is not null and ophaevet_grund is distinct from ''erstattet'')';
begin
  if position(v_til in v_def) = 0 then
    if position(v_fra in v_def) = 0 then
      raise exception 'dsa_rapport: den forventede tekst blev ikke fundet - ret migrationen';
    end if;
    execute replace(v_def, v_fra, v_til);
  end if;
end $$;
