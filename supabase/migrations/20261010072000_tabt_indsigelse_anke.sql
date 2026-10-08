-- Rettelse efter review af 20261010071000_niels_rettelser_review.sql (8. okt. 2026).
--
-- betaling_indsigelse_tabt_luk fejlede med BHS01 (trades_beskyt_sagsfrys),
-- når en anke ventede på handlen: flaget trades.sag_aaben blev fjernet, mens
-- sag_anker.status stadig var 'afventer'. Staff kunne derfor hverken "Luk
-- handlen" eller "Giv advarsel" (som lukker bagefter) på en tabt indsigelse
-- med en ventende anke.
--
-- Nu:
--   - Ventende anker på handlen lukkes i samme funktion. sag_anker_status_check
--     tillader kun 'afventer' | 'stadfaestet' | 'omgjort', og en behandlet anke
--     kræver behandlet_af/behandlet_kl/afgoerelse_begrundelse
--     (sag_anker_behandlet_par). Anken sættes til 'stadfaestet' (afgørelsen
--     ændres ikke) med en begrundelse, der siger, at anken er lukket uden
--     afgørelse, fordi køberens bank har afgjort betalingen. Ingen penge
--     flyttes (sagen er afviklet / lukket; anken rører ikke penge_handling).
--     Logges som 'sag_lukket' (maal_type 'sag').
--   - Rækkefølge: sager og anker lukkes først, derefter annulleres handlen
--     (hvis intet er overført), og først til sidst fjernes sag_aaben på en
--     handel, der ikke er annulleret.
--   - Svaret indeholder sag_ids og begrundelse, så serveren kan give køber og
--     sælger besked.
--
-- Kun service role (ingen nye rettigheder til anon/authenticated). Idempotent.

set local lock_timeout = '5s';

create or replace function public.betaling_indsigelse_tabt_luk(
  p_medarbejder uuid, p_betaling uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b            record;
  s            record;
  a            record;
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
  v_handel     text := 'uaendret';
  v_sager      integer := 0;
  v_anker      integer := 0;
  v_sag_ids    uuid[] := '{}';
  v_grund      constant text := 'Sagen er lukket, fordi køberens bank har afgjort betalingen. BidHamr flytter ikke flere penge på handlen.';
  v_anke_grund constant text := 'Anken er lukket uden afgørelse, fordi køberens bank har afgjort betalingen. BidHamr flytter ikke flere penge på handlen.';
begin
  if not exists (select 1 from public.users where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is null then return jsonb_build_object('kode', 'note_mangler'); end if;
  if char_length(v_note) > 2000 then return jsonb_build_object('kode', 'note_for_lang'); end if;

  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if coalesce(b.indsigelse_status, '') <> 'lost' then
    return jsonb_build_object('kode', 'ikke_tabt');
  end if;
  if b.indsigelse_lukket_kl is not null then
    return jsonb_build_object('kode', 'allerede_lukket');
  end if;

  update public.betalinger
     set indsigelse_lukket_kl = now(), indsigelse_lukket_af = p_medarbejder,
         kraever_opmaerksomhed = false,
         -- Cron skal ikke markere den igen som "ikke afsluttet".
         ikke_afsluttet_markeret_kl = coalesce(ikke_afsluttet_markeret_kl, now()),
         opdateret = now()
   where id = b.id;

  perform 1 from public.trades where id = b.trade_id for update;

  -- 1. Sager, der stadig holder pengene (åben, afventer retur, eller afgjort
  --    men ikke afviklet), lukkes: pengene kan ikke flyttes efter en tabt
  --    indsigelse (køberens bank har afgjort betalingen).
  for s in
    select * from public.sager
     where trade_id = b.trade_id
       and (status in ('aaben', 'afventer_retur')
            or (penge_handling is not null and afviklet_kl is null))
     for update
  loop
    if s.status in ('aaben', 'afventer_retur') then
      update public.sager
         set status = 'lukket',
             afgjort_af = p_medarbejder,
             afgjort_kl = now(),
             begrundelse = v_grund,
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = null, penge_flyttes_efter_kl = null,
             afviklet_kl = now(), penge_fejl = null,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Lukket ved tabt indsigelse (dispute lost): ' || v_note, 4000)
       where id = s.id;
    else
      update public.sager
         set afviklet_kl = now(),
             penge_fejl = 'indsigelse_tabt',
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Afgørelsen er ikke gennemført: indsigelsen er tabt, og pengene flyttes ikke. ' || v_note, 4000)
       where id = s.id;
    end if;
    v_sager := v_sager + 1;
    v_sag_ids := v_sag_ids || s.id;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', s.id, b.buyer_id,
            'Lukket ved tabt indsigelse - pengene flyttes ikke');
  end loop;

  -- 2. Ventende anker på handlen lukkes (ellers kan frysningen ikke fjernes:
  --    trades_beskyt_sagsfrys / BHS01). Afgørelsen ændres ikke, og ingen
  --    penge flyttes.
  for a in
    select * from public.sag_anker
     where trade_id = b.trade_id and status = 'afventer'
     for update
  loop
    update public.sag_anker
       set status = 'stadfaestet',
           behandlet_af = p_medarbejder,
           behandlet_kl = now(),
           afgoerelse_begrundelse = v_anke_grund,
           intern_note = left(coalesce(intern_note || chr(10), '')
                              || 'Lukket ved tabt indsigelse (dispute lost): ' || v_note, 4000)
     where id = a.id;
    v_anker := v_anker + 1;
    if not (a.sag_id = any (v_sag_ids)) then
      v_sag_ids := v_sag_ids || a.sag_id;
    end if;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', a.sag_id, a.indgivet_af,
            'Anke lukket ved tabt indsigelse - pengene flyttes ikke');
  end loop;

  -- 3. Intet overført til sælger: handlen annulleres (sælgeren får ikke
  --    udbetalt; køberens bank har givet køberen pengene). Er der overført,
  --    bærer BidHamr tabet, og handlen står, som den er.
  if b.stripe_transfer_id is null and b.overfoersel_paabegyndt_kl is null then
    update public.trades set status = 'annulleret', sag_aaben = false
     where id = b.trade_id and status <> 'annulleret';
    if found then v_handel := 'annulleret'; end if;
  end if;

  -- 4. Frysningen fjernes til sidst (sager og anker er lukket nu).
  if v_sager > 0 or v_anker > 0 then
    update public.trades set sag_aaben = false where id = b.trade_id and sag_aaben;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'betaling_loest', 'handel', b.trade_id, b.buyer_id,
          left('Tabt indsigelse lukket' ||
               case when v_handel = 'annulleret' then ' (handlen annulleret)' else '' end ||
               case when v_sager > 0 then ' (sag lukket)' else '' end ||
               case when v_anker > 0 then ' (anke lukket)' else '' end ||
               ': ' || v_note, 2000));

  return jsonb_build_object('kode', 'ok', 'handel', v_handel, 'trade_id', b.trade_id,
                            'overfoert', b.stripe_transfer_id is not null,
                            'sager_lukket', v_sager, 'anker_lukket', v_anker,
                            'sag_ids', to_jsonb(v_sag_ids),
                            'begrundelse', v_grund);
end $$;

revoke all on function public.betaling_indsigelse_tabt_luk(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tabt_luk(uuid, uuid, text) to service_role;
