-- En skjult auktion sættes på pause, indtil den er oppe igen
-- (Filip, 6. oktober 2026). Tekniske valg markeret "foreslået af Claude" i
-- ROADMAP-BESLUTNINGER.md.
--
-- Før: en skjult, aktiv auktion kørte videre i baggrunden, og
-- afslut_udloebne_auktioner (pg_cron hvert minut) oprettede handel og
-- betaling med vinderen, når tiden løb ud - selvom ingen kunne se den.
--
-- Nu:
--  1. auctions.pauset_kl + auctions.pause_resterende. Når en AKTIV auktion
--     skjules (skjult false -> true), sætter triggeren auctions_pause_skjult
--     pauset_kl = now() og pause_resterende = slutter_kl - now() (mindst 0).
--     Det virker uanset hvilken staff-funktion der skjuler (dsa_indgreb,
--     admin, rapporter). Fjernes auktionen i samme opdatering (status bliver
--     'annulleret'), sættes den ikke på pause - den behandles som i dag.
--  2. Når den vises igen (skjult true -> false, status stadig 'aktiv'),
--     genoptages den: slutter_kl = now() + resterende tid, dog mindst 24
--     timer (foreslået af Claude). Pause-felterne nulstilles. Bud og
--     nuværende_bud røres ikke. redigeret_kl røres ikke (staff-opdateringer
--     springer auctions_beskyt_kolonner over), så bydere ikke får "sælgeren
--     har ændret auktionen".
--  3. afslut_udloebne_auktioner springer pausede og skjulte aktive auktioner
--     over. handle_new_bid afviser allerede bud på skjulte auktioner.
--  4. Fjernes (annulleres) en pauset auktion, beholder den pause-felterne, så
--     et medhold i en klage (dsa_klage_afgoer) eller en genåbnet rapport kan
--     åbne den igen med den resterende tid - også selvom den oprindelige
--     sluttid er passeret imens. Visningen tæller kun en auktion som "på
--     pause", når status = 'aktiv' og pauset_kl ikke er null.
--  5. auktion_pauser: log over pauser (bruges til beskeder til sælger og
--     bydere og som historik). Kun service_role. Slettes aldrig.
--  6. Ny valgfri notifikationstype 'auktion_status' (FLETTES ind i
--     notifikation_kendt_type). HOLD SYNKRON med src/lib/notifikationer/typer.ts.
--  7. pauset_kl/pause_resterende kan kun skrives af systemet
--     (auctions_beskyt_kolonner / auctions_beskyt_ny).
--  8. mine_bud_auktioner viser en pauset auktion med min_status 'pause' (før
--     var skjulte helt skjult for byderen); min_statistik får 'pauset'.
--  9. Engangs-oprydning: eksisterende skjulte, aktive auktioner sættes på
--     pause med deres nuværende resterende tid (0, hvis den allerede er
--     udløbet uden handel - så får den 24 timer, når den genoptages). Tjekket
--     6. okt. 2026: 0 i produktion og 0 i test.
--
-- Kræver DSA-migrationerne (20261009010000 ..) - dsa_klage_afgoer
-- genskrives her.
-- Idempotent: kan køres flere gange.

set lock_timeout = '5s';

-- =====================================================================
-- 1. Kolonner og log
-- =====================================================================
alter table public.auctions add column if not exists pauset_kl timestamptz;
alter table public.auctions add column if not exists pause_resterende interval;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auctions_pause_felter') then
    alter table public.auctions
      add constraint auctions_pause_felter
      check ((pauset_kl is null) = (pause_resterende is null)
             and (pause_resterende is null or pause_resterende >= interval '0'));
  end if;
end $$;

create table if not exists public.auktion_pauser (
  id             uuid primary key default gen_random_uuid(),
  auction_id     uuid not null references public.auctions(id) on delete cascade,
  pauset_kl      timestamptz not null default now(),
  resterende     interval not null,
  genoptaget_kl  timestamptz,
  ny_slutter_kl  timestamptz,
  -- true = sat på pause af engangs-oprydningen i denne migration (byderne
  -- har allerede fået besked om, at auktionen er skjult).
  fra_oprydning  boolean not null default false
);

create unique index if not exists auktion_pauser_aaben_idx
  on public.auktion_pauser (auction_id) where genoptaget_kl is null;
create index if not exists auktion_pauser_pauset_idx on public.auktion_pauser (pauset_kl);
create index if not exists auktion_pauser_genoptaget_idx
  on public.auktion_pauser (genoptaget_kl) where genoptaget_kl is not null;

alter table public.auktion_pauser enable row level security;
revoke all on public.auktion_pauser from anon, authenticated;
grant select, insert, update on public.auktion_pauser to service_role;

-- =====================================================================
-- 2. Trigger: pause ved skjul, genoptag ved vis igen
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
  if old.skjult is not distinct from new.skjult then
    return new;
  end if;

  -- Skjules: en igangværende auktion sættes på pause.
  if coalesce(new.skjult, false) and not coalesce(old.skjult, false) then
    if old.status = 'aktiv' and new.status = 'aktiv' and old.pauset_kl is null then
      v_rest := greatest(old.slutter_kl - now(), interval '0');
      new.pauset_kl := now();
      new.pause_resterende := v_rest;
      insert into public.auktion_pauser (auction_id, pauset_kl, resterende)
      values (new.id, new.pauset_kl, v_rest)
      on conflict (auction_id) where genoptaget_kl is null do nothing;
    end if;
    return new;
  end if;

  -- Vises igen: genoptag, hvis den er pauset og stadig (eller igen) aktiv.
  if coalesce(old.skjult, false) and not coalesce(new.skjult, false)
     and old.pauset_kl is not null and new.status = 'aktiv' then
    new.slutter_kl := now() + greatest(coalesce(old.pause_resterende, interval '0'), interval '24 hours');
    new.pauset_kl := null;
    new.pause_resterende := null;
    update public.auktion_pauser
       set genoptaget_kl = now(), ny_slutter_kl = new.slutter_kl
     where auction_id = new.id and genoptaget_kl is null;
  end if;

  return new;
end;
$fn$;

revoke all on function public.auctions_pause_skjult() from public, anon, authenticated;

-- Navnet sorterer efter auctions_beskyt_kolonner, så beskyttelsen ser
-- brugerens egne ændringer, før triggeren selv sætter felterne.
drop trigger if exists auctions_pause_skjult on public.auctions;
create trigger auctions_pause_skjult
  before update of skjult, status on public.auctions
  for each row execute function public.auctions_pause_skjult();

-- =====================================================================
-- 3. Beskyttelse: pause-felterne må kun skrives af systemet
-- =====================================================================
create or replace function public.auctions_beskyt_kolonner()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  -- Felter brugeren aldrig maa aendre.
  if new.id               is distinct from old.id
  or new.bruger_id        is distinct from old.bruger_id
  or new.status           is distinct from old.status
  or new.vinder_id        is distinct from old.vinder_id
  or new.slutter_kl       is distinct from old.slutter_kl
  or new.varighed_dage    is distinct from old.varighed_dage
  or new."nuværende_bud"  is distinct from old."nuværende_bud"
  or new.skjult           is distinct from old.skjult
  or new.pauset_kl        is distinct from old.pauset_kl
  or new.pause_resterende is distinct from old.pause_resterende
  or new.oprettet         is distinct from old.oprettet then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;

  if public.jeg_er_suspenderet() then
    raise exception 'Din konto er suspenderet.' using errcode = 'BHS02';
  end if;

  -- Indholdsfelter og startpris: kun paa en igangvaerende auktion uden bud.
  if old.status <> 'aktiv'
     or old.slutter_kl <= now()
     or old."nuværende_bud" is not null
     or public.auktion_har_bud(old.id) then
    raise exception 'Auktionen kan ikke redigeres, efter der er budt.'
      using errcode = '42501';
  end if;

  if new.startpris is distinct from old.startpris
     and (new.startpris is null or new.startpris < 0 or new.startpris > 9999999999
          or new.startpris <> trunc(new.startpris)) then
    raise exception 'Startprisen skal være et helt antal kroner.'
      using errcode = '22023';
  end if;

  -- Mindste startpris 1 kr - kun naar startprisen aendres, saa en gammel
  -- auktion med startpris 0 stadig kan faa rettet andre felter.
  if new.startpris is distinct from old.startpris and new.startpris < 1 then
    raise exception 'Startprisen skal være mindst 1 kr.'
      using errcode = '22023';
  end if;

  if new.billeder is distinct from old.billeder
     and not public.auktion_billeder_gyldige(auth.uid(), new.billeder) then
    raise exception 'Tilføj mellem 1 og 10 billeder, uploadet til BidHamr.'
      using errcode = 'BHA01';
  end if;

  if new.kategori is distinct from old.kategori
     and not public.er_gyldig_auktionskategori(new.kategori) then
    raise exception 'Vælg en kategori.' using errcode = 'BHA02';
  end if;

  new.redigeret_kl := date_trunc('milliseconds', clock_timestamp());
  return new;
end;
$fn$;

create or replace function public.auctions_beskyt_ny()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    if new.redigeret_kl is null then
      new.redigeret_kl := date_trunc('milliseconds', now());
    end if;
    return new;
  end if;

  new.status           := 'aktiv';
  new.vinder_id        := null;
  new."nuværende_bud"  := null;
  new.skjult           := false;
  new.pauset_kl        := null;
  new.pause_resterende := null;
  new.oprettet         := now();
  new.redigeret_kl     := date_trunc('milliseconds', now());

  if new.varighed_dage is null then
    new.varighed_dage := public.varighed_fra_slutter_kl(new.slutter_kl);
  end if;

  if not public.er_gyldig_varighed(new.varighed_dage) then
    raise exception 'Vælg en varighed på 3, 5, 7 eller 10 dage.'
      using errcode = '22023';
  end if;

  new.slutter_kl := now() + make_interval(days => new.varighed_dage);

  if new.startpris is null or new.startpris < 0 or new.startpris > 9999999999
     or new.startpris <> trunc(new.startpris) then
    raise exception 'Startprisen skal være et helt antal kroner.'
      using errcode = '22023';
  end if;

  -- Mindste startpris 1 kr (Filip, 5. oktober 2026).
  if new.startpris < 1 then
    raise exception 'Startprisen skal være mindst 1 kr.'
      using errcode = '22023';
  end if;

  -- Billederne skal ligge i den indloggede brugers egen mappe.
  if not public.auktion_billeder_gyldige(auth.uid(), new.billeder) then
    raise exception 'Tilføj mellem 1 og 10 billeder, uploadet til BidHamr.'
      using errcode = 'BHA01';
  end if;

  if not public.er_gyldig_auktionskategori(new.kategori) then
    raise exception 'Vælg en kategori.' using errcode = 'BHA02';
  end if;

  return new;
end;
$fn$;

-- =====================================================================
-- 4. afslut_udloebne_auktioner: pausede og skjulte afsluttes ikke
-- =====================================================================
create or replace function public.afslut_udloebne_auktioner()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  antal integer;
  r     record;
  bud   bigint;
  koeb  bigint;
  saelg bigint;
  fragt bigint;
  besk_valg boolean;
  besk  bigint;
  t_id  uuid;
begin
  update public.auctions a
     set status = 'afsluttet',
         vinder_id = (
           select b.bruger_id
             from public.bids b
            where b.auktion_id = a.id
            order by b."beløb" desc, b.oprettet asc
            limit 1
         )
   where a.status = 'aktiv'
     and a.slutter_kl <= now()
     -- NYT: en skjult (pauset) auktion afsluttes ikke (Filip, 6. okt. 2026).
     and a.pauset_kl is null
     and not coalesce(a.skjult, false);

  get diagnostics antal = row_count;

  for r in
    select a.id, a.bruger_id, a.vinder_id, a.forsendelse_mulig
      from public.auctions a
     where a.status = 'afsluttet'
       and a.vinder_id is not null
       and a.slutter_kl >= now() - interval '7 days'
       and not exists (select 1 from public.trades t where t.auction_id = a.id)
  loop
    begin
      t_id := null;
      select round(max(b."beløb") * 100)::bigint into bud
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id;

      if bud is null or bud <= 0 then
        raise warning 'ingen gyldigt vinderbud for auktion %', r.id;
        continue;
      end if;

      select coalesce(b.beskyttelse, false) into besk_valg
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id
       order by b.oprettet desc, b."beløb" desc
       limit 1;
      besk_valg := coalesce(besk_valg, false);

      koeb  := round(bud * 5 / 100.0)::bigint;
      saelg := round(bud * 5 / 100.0)::bigint;
      fragt := case when coalesce(r.forsendelse_mulig, false) then 3500 else 0 end;
      besk  := case when besk_valg then public.beregn_beskyttelse_oere(bud) else 0 end;

      insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
      values (r.id, r.bruger_id, r.vinder_id, bud / 100.0, 'afventer_betaling')
      on conflict (auction_id) where status <> 'annulleret' do nothing
      returning id into t_id;

      if t_id is null then continue; end if;

      insert into public.betalinger (
        trade_id, auction_id, buyer_id, seller_id,
        bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
        total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
      values (
        t_id, r.id, r.vinder_id, r.bruger_id,
        bud, koeb, fragt, besk_valg, besk,
        bud + koeb + fragt + besk, saelg, bud - saelg,
        now() + interval '48 hours')
      on conflict (trade_id) do nothing;
    exception when others then
      raise warning 'handel/betaling fejlede for auktion %: %', r.id, sqlerrm;
    end;
  end loop;

  return antal;
end;
$fn$;

revoke all on function public.afslut_udloebne_auktioner() from public, anon, authenticated;
grant execute on function public.afslut_udloebne_auktioner() to service_role;

-- =====================================================================
-- 5. dsa_klage_afgoer: en pauset, fjernet auktion kan åbnes igen
-- =====================================================================
-- Eneste ændring: "udløbet" tæller ikke for en auktion, der var på pause
-- (v_pauset). Triggeren genoptager den med den resterende tid.
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
  v_status text;
  v_slut   timestamptz;
  v_pauset boolean := false;
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
      if af.handling in ('auktion_fjernet', 'auktion_annulleret') then
        select x.status, x.slutter_kl, x.pauset_kl is not null
          into v_status, v_slut, v_pauset
          from public.auctions x where x.id = af.indhold_id for update;
        v_pauset := coalesce(v_pauset, false);
        v_genaabnet := (v_status = 'annulleret' and af.foer_status = 'aktiv' and (v_slut > now() or v_pauset))
                    or (af.handling = 'auktion_fjernet' and v_status = 'annulleret' and af.foer_status = 'annulleret');
      end if;

      if v_genaabnet then
        update public.dsa_afgoerelser
           set ophaevet_kl = coalesce(ophaevet_kl, now()), ophaevet_grund = coalesce(ophaevet_grund, 'klage')
         where id = af.id;
      end if;

      if af.handling = 'auktion_skjult' then
        update public.auctions set skjult = false where id = af.indhold_id and skjult;
      elsif af.handling in ('auktion_fjernet', 'auktion_annulleret') then
        if v_status = 'annulleret' and af.foer_status = 'aktiv' and (v_slut > now() or v_pauset) then
          update public.auctions set status = 'aktiv', skjult = false, arkiveret_kl = null where id = af.indhold_id;
        elsif v_genaabnet then
          update public.auctions set skjult = false where id = af.indhold_id;
        end if;
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
               || case when p_udfald = 'medhold' and not v_genaabnet then ' (auktionen er udløbet og kan ikke åbnes igen)' else '' end
               || ' | ' || coalesce(v_note, v_svar), 4000));

  return jsonb_build_object('kode', 'ok', 'genaabnet', v_genaabnet,
                            'type', case when k.afgoerelse_id is not null then 'afgoerelse' else 'anmeldelse' end);
end;
$fn$;

revoke all on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) to service_role;

-- =====================================================================
-- 6. Mine bud og statistik: pausede vises som "På pause"
-- =====================================================================
-- Før var en skjult auktion helt væk fra byderens liste. En pauset auktion
-- (status 'aktiv', pauset_kl sat) vises nu med min_status 'pause' og
-- sorteres sammen med de igangværende. Andre skjulte (fjernede) er stadig
-- væk.
create or replace function public.mine_bud_auktioner(p_graense integer default 100)
returns table(auktion_id uuid, titel text, billede text, slutter_kl timestamptz, nuvaerende_bud numeric,
              mit_bud numeric, antal_bud integer, min_status text, sidste_bud_kl timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  with mine as (
    select bi.auktion_id, max(bi."beløb") as mit_bud, max(bi.oprettet) as sidste_bud_kl
      from public.bids bi
     where bi.bruger_id = auth.uid()
     group by bi.auktion_id
  )
  select a.id,
         a.titel,
         a.billeder[1],
         a.slutter_kl,
         coalesce(a."nuværende_bud", a.startpris),
         m.mit_bud,
         coalesce(a.antal_bud, 0),
         case
           when a.status = 'annulleret' then 'annulleret'
           when a.status = 'aktiv' and a.pauset_kl is not null then 'pause'
           when a.status = 'aktiv' and a.slutter_kl > now() then
             case when f.bruger_id = auth.uid() then 'foerer' else 'overbudt' end
           when coalesce(a.vinder_id, case when a.status = 'aktiv' then f.bruger_id end) = auth.uid()
             then 'vundet'
           else 'tabt'
         end,
         m.sidste_bud_kl
    from mine m
    join public.auctions a on a.id = m.auktion_id
    left join lateral (
      select bi.bruger_id from public.bids bi
       where bi.auktion_id = a.id
       order by bi."beløb" desc, bi.oprettet asc
       limit 1
    ) f on true
   where not coalesce(a.skjult, false)
      or (a.status = 'aktiv' and a.pauset_kl is not null)
   order by (a.status = 'aktiv' and (a.slutter_kl > now() or a.pauset_kl is not null)) desc,
            case when a.status = 'aktiv' and a.pauset_kl is null and a.slutter_kl > now() then a.slutter_kl end asc,
            m.sidste_bud_kl desc
   limit least(greatest(coalesce(p_graense, 100), 1), 200);
$fn$;

revoke all on function public.mine_bud_auktioner(integer) from public, anon;
grant execute on function public.mine_bud_auktioner(integer) to authenticated, service_role;

create or replace function public.min_statistik()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_nu    timestamp := (now() at time zone 'Europe/Copenhagen');
  v_uge   timestamptz := (date_trunc('week', v_nu)  at time zone 'Europe/Copenhagen');
  v_md    timestamptz := (date_trunc('month', v_nu) at time zone 'Europe/Copenhagen');
  v_aar   timestamptz := (date_trunc('year', v_nu)  at time zone 'Europe/Copenhagen');
  v_auk   jsonb;
  v_ind   jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  select jsonb_build_object(
           'i_alt',   count(*),
           -- En pauset auktion tælles under 'pauset', ikke 'aktive'.
           'aktive',  count(*) filter (where a.status = 'aktiv' and a.pauset_kl is null and a.slutter_kl > now()),
           'pauset',  count(*) filter (where a.status = 'aktiv' and a.pauset_kl is not null),
           'solgte',  count(*) filter (where exists (
                        select 1 from public.betalinger b
                         where b.auction_id = a.id
                           and b.status in ('betalt', 'frigivet')
                           and b.refunderet_kl is null and b.annulleret_kl is null
                           and (b.overfoert_kl is not null
                                or (b.refusion_anmodet_kl is null
                                    and b.afsendelsesfrist_annulleret_kl is null
                                    and b.afhentningsfrist_annulleret_kl is null)))))
    into v_auk
    from public.auctions a
   where a.bruger_id = v_uid;

  select jsonb_build_object(
           'uge',      coalesce(sum(b.udbetaling_oere) filter (where b.betalt_kl >= v_uge), 0),
           'maaned',   coalesce(sum(b.udbetaling_oere) filter (where b.betalt_kl >= v_md), 0),
           'aar',      coalesce(sum(b.udbetaling_oere) filter (where b.betalt_kl >= v_aar), 0),
           'i_alt',    coalesce(sum(b.udbetaling_oere), 0),
           'udbetalt', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl is not null), 0),
           'paa_vej',  coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl is null), 0),
           'antal_handler', count(*))
    into v_ind
    from public.betalinger b
   where b.seller_id = v_uid
     and b.status in ('betalt', 'frigivet')
     and b.betalt_kl is not null
     and b.refunderet_kl is null
     and b.annulleret_kl is null
     and (b.overfoert_kl is not null
          or (b.refusion_anmodet_kl is null
              and b.afsendelsesfrist_annulleret_kl is null
              and b.afhentningsfrist_annulleret_kl is null));

  return jsonb_build_object(
    'auktioner', v_auk,
    'indtjening_oere', v_ind,
    'bud_paa', (select count(distinct bi.auktion_id)
                  from public.bids bi
                  join public.auctions a on a.id = bi.auktion_id
                 where bi.bruger_id = v_uid
                   and (not coalesce(a.skjult, false)
                        or (a.status = 'aktiv' and a.pauset_kl is not null))));
end;
$fn$;

revoke all on function public.min_statistik() from public, anon;
grant execute on function public.min_statistik() to authenticated, service_role;

-- =====================================================================
-- 7. Notifikationstype 'auktion_status' (valgfri) - FLETTES ind
-- =====================================================================
do $$
declare
  v_src  text;
  v_vals text[];
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = 'public.notifikation_kendt_type(text)'::regprocedure;

  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x
      from regexp_matches(coalesce(v_src, ''), '''([^'']+)''', 'g') as m
    union
    select 'auktion_status'
  ) s;

  execute format($f$
    create or replace function public.notifikation_kendt_type(p_type text)
    returns boolean
    language sql immutable set search_path = '' as $fn$
      select public.notifikation_paakraevet(p_type) or p_type = any (array[%s]::text[]);
    $fn$;$f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) v));
end $$;

grant execute on function public.notifikation_kendt_type(text) to anon, authenticated, service_role;

-- =====================================================================
-- 8. Engangs-oprydning: skjulte, aktive auktioner sættes på pause
-- =====================================================================
-- Resterende tid = slutter_kl - now() (0, hvis den allerede er udløbet uden
-- handel - så får den 24 timer, når den vises igen). Ingen beskeder: byderne
-- har allerede fået at vide, at auktionen er skjult.
with nye as (
  update public.auctions a
     set pauset_kl = now(),
         pause_resterende = greatest(a.slutter_kl - now(), interval '0')
   where a.skjult and a.status = 'aktiv' and a.pauset_kl is null
     and not exists (select 1 from public.trades t where t.auction_id = a.id)
  returning a.id, a.pauset_kl, a.pause_resterende
)
insert into public.auktion_pauser (auction_id, pauset_kl, resterende, fra_oprydning)
select id, pauset_kl, pause_resterende, true from nye
on conflict (auction_id) where genoptaget_kl is null do nothing;
