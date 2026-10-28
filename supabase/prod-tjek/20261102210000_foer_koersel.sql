-- KUN LÆSNING (SELECT). Køres på PRODUKTION (lkifkrexeldimmghnsie) FØR
-- 20261102210000_sagsregler.sql og 20261102350000_sagsregler_rettelser.sql.
-- Ændrer intet.
--
-- 1. md5 af de 18 funktioner, 20261102210000 retter, sammenlignet med de
--    forventede "gamle" værdier (samme normalisering som migrationen:
--    kommentarer og al whitespace fjernet, små bogstaver). Alle rækker skal
--    have ok = true. Er en række false, afbryder migrationen - find ud af,
--    hvad der er ændret, før den køres.
-- 2. md5 af de 5 funktioner, som kun 20261102350000 retter (210000 rører dem
--    ikke) - også alle ok = true.
-- 3. Sager med returfragt_betaler 'bidhamr', hvor returen ikke er afleveret.
--    Efter migrationerne bliver 'bidhamr' en DÆKKET returfragt (køberen
--    betaler intet) - men kun ved type 'skadet' (rettelse B3). Gennemgå
--    rækkerne, før migrationerne køres.

-- 1 + 2
select x.del, x.fn, x.forventet, f.faktisk, f.faktisk is not distinct from x.forventet as ok
  from (values
    (1, 'public.sag_opret(uuid,text,text,jsonb)',                          'a1d9ea08a7f349d523c2e2a8775aa5f8'),
    (1, 'public.sag_afgoer(uuid,uuid,text,text,text,boolean)',             'ea0cd85a0d3c06f363650778ceb414cb'),
    (1, 'public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean)',        '4f00919bdf83d3000f4769431906c5cc'),
    (1, 'public.sag_valider_billeder(uuid,uuid,jsonb)',                    'd298ce4d26b61876759ab35c52129755'),
    (1, 'public.sag_billede_maa_uploade(text)',                            '3ff2a50ca373980ea1a7ec3e0602e43e'),
    (1, 'public.sag_billede_maa_laese(text)',                              '9f4ee9b149ecc5ebbb71696178764a6b'),
    (1, 'public.sager_beskyt()',                                           'd296e8127be8d10feddb49f6b8015789'),
    (1, 'public.sag_claim_refusion(uuid)',                                 'c17fb96d5867012ac791ea7863cbc0d7'),
    (1, 'public.betaling_bidhamr_daekker_claim(uuid,uuid,text,uuid)',      '12bd75266e2ba5b81a586c858586a18e'),
    (1, 'public.handel_auto_frigiv()',                                     'a8da0c29700cd1aca4be80724084e3d3'),
    (1, 'public.handel_leveret_melding_ny(uuid)',                          '11fc30b8ccc0f836ee9532436e131c93'),
    (1, 'public.admin_penge_holdes(integer)',                              '61b21b8c00f3b8740a287ed61b8c02bd'),
    (1, 'public.returfragt_start(uuid,uuid)',                              'bc3a83ee3b3b62baeb34ae2292450717'),
    (1, 'public.returfragt_refusion_claim(uuid,text)',                     '6b9372e438aa614859134d0f078a5b17'),
    (1, 'public.faktura_planlaeg_returfragt(integer)',                     'c0ac0fbe71bda1f5a4d35af706f9b24a'),
    (1, 'public.sag_retur_afleveret(uuid,uuid,text)',                      '8440027ecc71d638bdbf5f8376dc6cb1'),
    (1, 'public.ekstra_fragt_lav_faktura(uuid)',                           '66ff99e11ee26579e0951d84797ead02'),
    (1, 'public.fragt_reklamation_betingelser(uuid)',                      '6a647069eb5996647c89212a6818bff3'),
    (2, 'public.sag_genaabn(uuid,uuid,text)',                              'd32e4ff28c96d5f5c8902b7d133b040b'),
    (2, 'public.ekstra_fragt_kraev(uuid)',                                 'f4f411fc61ca9a567efcf1dac7ce239e'),
    (2, 'public.sager_fragt_reklamation()',                                '9277694da37123a94546d80a918862d7'),
    (2, 'public.fragt_reklamationer_synkroniser_alle(integer)',            'e1085f5dc848692f70a2744e932dcfcf'),
    (2, 'public.fragt_reklamation_synkroniser(uuid)',                      'e7c151db2fd0aeda581737dcc668ce8b')
  ) as x(del, fn, forventet)
  left join lateral (
    select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g'))) as faktisk
      from pg_proc p
     where p.oid = to_regprocedure(x.fn)
  ) f on true
 order by x.del, x.fn;

-- 3
select id, type, status from sager where returfragt_betaler = 'bidhamr' and retur_afleveret_kl is null;
