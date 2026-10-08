import "server-only";

// Server-only: afhentningsfristen (ROADMAP-BESLUTNINGER afsnit 2,
// "Afhentningsfrist", Filip 5. oktober 2026). Køberen har 7 dage fra
// betalingen til at hente varen; sælgeren kan forlænge til højst 14 dage
// efter betalingen.
//
//   paamindOmAfhentning               påmindelse til køber og sælger 2 døgn
//                                     før fristen (dag 5)
//   notificerAfhentningsfristForlaengelser
//                                     køberen får besked om en ny frist
//   annullerIkkeHentede               automatisk tilbagebetaling af ALLE
//                                     pengene til køberen, når varen ikke er
//                                     hentet, og staff ikke har afgjort
//                                     handlen (14 dage efter betalingen og
//                                     mindst 7 dage efter fristen), og nye
//                                     forsøg på refusioner/beskeder, der
//                                     fejlede
//
// Databasen afgør og claimer atomisk (afhentningsfrist_annuller - låser
// betaling, handel og afhentning). Refusionen laves bagefter af
// refunderBetaling (idempotency key pr. betaling, og en eksisterende refusion
// hos Stripe genbruges). Alle beskeder har idempotente nøgler. Staff får
// besked, når fristen er overskredet (afhentning_marker_ikke_hentet), og igen
// ved den automatiske tilbagebetaling (kraever_opmaerksomhed).
// Kaster aldrig.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { refunderBetaling } from "@/lib/betaling/stripeBetaling";
import {
  afhentningPaamindelseMail,
  afhentningsfristForlaengetMail,
  koeberAfhentningAnnulleretMail,
  kronerFraOere,
  saelgerAfhentningAnnulleretMail,
} from "@/lib/mails/handel";
import { AFHENTNING_PAAMIND_TIMER_FOER, afhentningsfristTekst } from "@/lib/afhentningsfrist";

type Admin = ReturnType<typeof createAdminClient>;

const TIME = 60 * 60 * 1000;
const DAG = 24 * TIME;

async function titler(admin: Admin, auktionIds: string[]): Promise<Map<string, string>> {
  if (auktionIds.length === 0) return new Map();
  const { data } = await admin
    .from("auctions")
    .select("id, titel")
    .in("id", [...new Set(auktionIds)]);
  return new Map((data ?? []).map((a) => [a.id as string, a.titel as string]));
}

async function sendteNoegler(admin: Admin, noegler: string[]): Promise<Set<string> | null> {
  const sendt = new Set<string>();
  for (let i = 0; i < noegler.length; i += 200) {
    const { data, error } = await admin
      .from("notifikation_afsendelser")
      .select("noegle")
      .in("noegle", noegler.slice(i, i + 200));
    if (error) {
      console.error("Opslag af sendte afhentningsbeskeder fejlede:", error.message);
      return null;
    }
    for (const r of data ?? []) sendt.add(r.noegle as string);
  }
  return sendt;
}

const fristMs = (iso: string) => new Date(iso).getTime();

// --- Påmindelse (dag 5) ------------------------------------------------------------

type Kandidat = {
  trade_id: string;
  buyer_id: string;
  seller_id: string;
  auction_id: string;
  frist: string;
  frist_forlaenget_kl: string | null;
};

// Påmindelse til køber og sælger, når der er under 48 timer til fristen.
// Nøglen indeholder fristen, så en forlængelse giver en ny påmindelse til den
// nye frist. Er fristen forlænget, efter påmindelsestidspunktet for den nye
// frist var nået, sendes ingen påmindelse (køberen har lige fået besked om
// den nye frist, og sælgeren har selv valgt den). Kaster aldrig.
export async function paamindOmAfhentning(): Promise<number> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("afhentning_paamind_kandidater");
    if (error) {
      console.error("afhentning_paamind_kandidater fejlede:", error.message);
      return 0;
    }
    const liste = ((data ?? []) as Kandidat[]).filter((k) => {
      const paamindKl = fristMs(k.frist) - AFHENTNING_PAAMIND_TIMER_FOER * TIME;
      return !k.frist_forlaenget_kl || fristMs(k.frist_forlaenget_kl) < paamindKl;
    });
    if (liste.length === 0) return 0;
    const t = await titler(admin, liste.map((k) => k.auction_id));

    let antal = 0;
    for (const k of liste) {
      const titel = t.get(k.auction_id) ?? "din vare";
      const fristTekst = afhentningsfristTekst(k.frist);
      const ms = fristMs(k.frist);
      const link = `/mine-handler/${k.trade_id}`;
      const kb = await send(
        k.buyer_id,
        "betaling_modtaget",
        {
          titel: "Husk at hente varen",
          tekst: `Hent "${titel}" senest ${fristTekst}. Aftal tid og sted med sælgeren i chatten.`,
          link,
          data: { trade_id: k.trade_id },
          mail: afhentningPaamindelseMail("koeber", titel, k.trade_id, fristTekst),
          noegle: `afhentning_paamind_koeber:${k.trade_id}:${ms}`,
        },
        { springOverVedClaimFejl: true },
      );
      const sb = await send(
        k.seller_id,
        "betaling_modtaget",
        {
          titel: "Varen er ikke hentet endnu",
          tekst: `"${titel}" skal hentes senest ${fristTekst}. Har I aftalt en senere dag, kan du forlænge fristen.`,
          link,
          data: { trade_id: k.trade_id },
          mail: afhentningPaamindelseMail("saelger", titel, k.trade_id, fristTekst),
          noegle: `afhentning_paamind_saelger:${k.trade_id}:${ms}`,
        },
        { springOverVedClaimFejl: true },
      );
      for (const r of [kb, sb]) if (!r.dublet && (r.klokke || r.mail || r.push)) antal++;
    }
    return antal;
  } catch (err) {
    console.error("Påmindelse om afhentning fejlede:", err);
    return 0;
  }
}

// --- Ny frist ----------------------------------------------------------------------

export function afhentningsfristForlaengetNoegle(tradeId: string, nyFrist: string): string {
  return `afhentningsfrist_forlaenget:${tradeId}:${fristMs(nyFrist)}`;
}

// Sælgeren har forlænget fristen (afhentning_forlaeng_frist - kaldes både fra
// hjemmesiden og direkte fra appen). Én besked pr. ny frist til køberen. Er
// fristen forlænget igen, eller er afhentningen ikke længere åben, sendes
// intet for den gamle forlængelse. Kaster aldrig (kaldes også fra after()).
export async function notificerAfhentningsfristForlaengelser(): Promise<number> {
  try {
    const admin = createAdminClient();
    const { data: rk, error } = await admin
      .from("afhentningsfrist_forlaengelser")
      .select("trade_id, buyer_id, ny_frist")
      .gte("oprettet", new Date(Date.now() - 48 * TIME).toISOString())
      .order("oprettet", { ascending: false })
      .limit(500);
    if (error) {
      console.error("Afhentningsfrist-forlængelser kunne ikke hentes:", error.message);
      return 0;
    }
    const raekker = (rk ?? []) as { trade_id: string; buyer_id: string; ny_frist: string }[];
    if (raekker.length === 0) return 0;
    const sendt = await sendteNoegler(
      admin,
      raekker.map((r) => afhentningsfristForlaengetNoegle(r.trade_id, r.ny_frist)),
    );
    if (!sendt) return 0;
    const mangler = raekker.filter(
      (r) => !sendt.has(afhentningsfristForlaengetNoegle(r.trade_id, r.ny_frist)),
    );
    if (mangler.length === 0) return 0;

    const ids = [...new Set(mangler.map((r) => r.trade_id))];
    const [{ data: handler }, { data: afh }] = await Promise.all([
      admin.from("trades").select("id, auction_id, status").in("id", ids),
      admin.from("afhentninger").select("trade_id, frist_kl, bekraeftet_kl").in("trade_id", ids),
    ]);
    const hmap = new Map((handler ?? []).map((h) => [h.id as string, h]));
    const amap = new Map((afh ?? []).map((a) => [a.trade_id as string, a]));
    const t = await titler(admin, (handler ?? []).map((h) => h.auction_id as string));

    let antal = 0;
    for (const r of mangler) {
      const h = hmap.get(r.trade_id);
      const a = amap.get(r.trade_id);
      if (!h || !a || h.status !== "betaling_modtaget" || a.bekraeftet_kl) continue;
      // Kun den gældende frist.
      if (!a.frist_kl || fristMs(a.frist_kl as string) !== fristMs(r.ny_frist)) continue;
      const titel = t.get(h.auction_id as string) ?? "din vare";
      const fristTekst = afhentningsfristTekst(r.ny_frist);
      const s = await send(
        r.buyer_id,
        "betaling_modtaget",
        {
          titel: "Ny frist for afhentning",
          tekst: `Sælgeren har givet dig mere tid til at hente "${titel}". Hent varen senest ${fristTekst}.`,
          link: `/mine-handler/${r.trade_id}`,
          data: { trade_id: r.trade_id },
          mail: afhentningsfristForlaengetMail(titel, r.trade_id, fristTekst),
          noegle: afhentningsfristForlaengetNoegle(r.trade_id, r.ny_frist),
        },
        { springOverVedClaimFejl: true },
      );
      if (!s.dublet && !s.sprunget) antal++;
    }
    return antal;
  } catch (err) {
    console.error("Besked om ny afhentningsfrist fejlede:", err);
    return 0;
  }
}

// --- Automatisk tilbagebetaling -----------------------------------------------

type Annulleret = {
  betaling_id: string;
  trade_id: string;
  buyer_id: string;
  seller_id: string;
  auction_id: string;
  total_oere: number;
};

const NOEGLE_KOEBER = (tradeId: string) => `afhentningsfrist_koeber:${tradeId}`;
const NOEGLE_SAELGER = (tradeId: string) => `afhentningsfrist_saelger:${tradeId}`;

async function sendAnnulleringsbeskeder(
  a: Pick<Annulleret, "trade_id" | "buyer_id" | "seller_id" | "total_oere">,
  titel: string,
  mangler: { koeber: boolean; saelger: boolean } = { koeber: true, saelger: true },
): Promise<void> {
  const link = `/mine-handler/${a.trade_id}`;
  if (mangler.koeber) {
    await send(a.buyer_id, "betaling_modtaget", {
      titel: "Du får alle pengene tilbage",
      tekst: `Varen blev ikke hentet, og du får alle pengene tilbage (${kronerFraOere(Number(a.total_oere))} kr) for "${titel}" på den betalingsmetode, du betalte med. Der kan gå nogle dage, før pengene står på din konto. Betalingen håndteres af vores betalingspartner Stripe.`,
      link,
      data: { trade_id: a.trade_id },
      mail: koeberAfhentningAnnulleretMail(titel, Number(a.total_oere), a.trade_id),
      noegle: NOEGLE_KOEBER(a.trade_id),
    });
  }
  if (mangler.saelger) {
    await send(a.seller_id, "betaling_modtaget", {
      titel: "Handlen er annulleret",
      tekst: `Handlen er annulleret, fordi varen ikke blev hentet. Du beholder varen ("${titel}").`,
      link,
      data: { trade_id: a.trade_id },
      mail: saelgerAfhentningAnnulleretMail(titel, a.trade_id),
      noegle: NOEGLE_SAELGER(a.trade_id),
    });
  }
}

// Cron-trin. Returnerer antal annullerede handler og antal refusioner, der
// gik igennem hos Stripe i denne kørsel (nye og gentagne forsøg).
export async function annullerIkkeHentede(): Promise<{ annulleret: number; refunderet: number }> {
  let annulleret = 0;
  let refunderet = 0;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("afhentningsfrist_annuller");
    if (error) console.error("afhentningsfrist_annuller fejlede:", error.message);
    const liste = (Array.isArray(data) ? data : []) as Annulleret[];
    annulleret = liste.length;

    if (liste.length > 0) {
      const t = await titler(admin, liste.map((a) => a.auction_id));
      for (const a of liste) {
        // Beskeder først: handlen er annulleret og refusionen claimet, også
        // hvis Stripe-kaldet nedenfor fejler og prøves igen. Kaster aldrig.
        await sendAnnulleringsbeskeder(a, t.get(a.auction_id) ?? "din vare");
        try {
          if ((await refunderBetaling(a.betaling_id)) === "refunderet") refunderet++;
        } catch (err) {
          console.error("Refusion efter afhentningsfrist fejlede (cron prøver igen):", a.trade_id, err);
        }
      }
    }

    refunderet += await proevIgen(admin);
  } catch (err) {
    console.error("Automatisk tilbagebetaling efter afhentningsfrist fejlede:", err);
  }
  return { annulleret, refunderet };
}

// Nye forsøg (som afsendelsesfristen):
//   - Refusioner, der er claimet for mindst 10 minutter siden (så cron ikke
//     kører samtidig med første forsøg ovenfor), men ikke gennemført hos
//     Stripe. refunderBetaling er idempotent. Højst 5 forsøg - derefter ser
//     staff på den (kraever_opmaerksomhed er sat).
//   - Beskeder, der ikke blev sendt (fx hvis serveren døde efter
//     annulleringen). Forsøges i 2 dage efter annulleringen.
async function proevIgen(admin: Admin): Promise<number> {
  let antal = 0;
  const { data: ventende, error } = await admin
    .from("betalinger")
    .select("id, trade_id")
    .eq("status", "betalt")
    .eq("refusion_aarsag", "afhentningsfrist")
    .not("afhentningsfrist_annulleret_kl", "is", null)
    .not("refusion_anmodet_kl", "is", null)
    .lt("refusion_anmodet_kl", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .is("stripe_transfer_id", null)
    .is("overfoersel_paabegyndt_kl", null)
    // refusion_forsoeg < refusion_graense (standard 5).
    .eq("refusion_opbrugt", false)
    // Backoff efter en fejlet refusion (20261010070000).
    .or(`refusion_naeste_forsoeg_kl.is.null,refusion_naeste_forsoeg_kl.lte.${new Date().toISOString()}`)
    .limit(50);
  if (error) {
    console.error("Hentning af ventende afhentningsrefusioner fejlede:", error.message);
  }
  for (const b of (ventende ?? []) as { id: string; trade_id: string }[]) {
    try {
      if ((await refunderBetaling(b.id)) === "refunderet") antal++;
    } catch (err) {
      console.error("Afhentningsrefusion fejlede (prøves igen):", b.trade_id, err);
    }
  }

  const { data: nye, error: nFejl } = await admin
    .from("betalinger")
    .select("trade_id, buyer_id, seller_id, auction_id, total_oere")
    .not("afhentningsfrist_annulleret_kl", "is", null)
    .gte("afhentningsfrist_annulleret_kl", new Date(Date.now() - 2 * DAG).toISOString())
    .limit(200);
  if (nFejl) {
    console.error("Hentning af afhentningsannulleringer fejlede:", nFejl.message);
    return antal;
  }
  const raekker = (nye ?? []) as Omit<Annulleret, "betaling_id">[];
  if (raekker.length === 0) return antal;
  const sendt = await sendteNoegler(
    admin,
    raekker.flatMap((r) => [NOEGLE_KOEBER(r.trade_id), NOEGLE_SAELGER(r.trade_id)]),
  );
  if (!sendt) return antal;
  const mangler = raekker.filter(
    (r) => !sendt.has(NOEGLE_KOEBER(r.trade_id)) || !sendt.has(NOEGLE_SAELGER(r.trade_id)),
  );
  if (mangler.length === 0) return antal;
  const t = await titler(admin, mangler.map((r) => r.auction_id));
  for (const r of mangler) {
    await sendAnnulleringsbeskeder(r, t.get(r.auction_id) ?? "din vare", {
      koeber: !sendt.has(NOEGLE_KOEBER(r.trade_id)),
      saelger: !sendt.has(NOEGLE_SAELGER(r.trade_id)),
    });
  }
  return antal;
}

// --- Visning på handelssiden -------------------------------------------------------

export type AfhentningsfristAnnullering = {
  annulleretKl: string;
  // Stripe har gennemført refusionen (spejlet i databasen).
  refunderet: boolean;
};

// Blev handlen annulleret, fordi varen ikke blev hentet? Kun til køber og
// sælger på handlen (brugerId er den indloggede bruger, verificeret af
// kalderen). Kolonnen kan ikke læses med brugerens JWT, så service-role
// bruges med eksplicit partsfilter.
export async function hentAfhentningsfristAnnullering(
  tradeId: string,
  brugerId: string,
): Promise<AfhentningsfristAnnullering | null> {
  try {
    const { data } = await createAdminClient()
      .from("betalinger")
      .select("afhentningsfrist_annulleret_kl, status")
      .eq("trade_id", tradeId)
      .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
      .not("afhentningsfrist_annulleret_kl", "is", null)
      .maybeSingle<{ afhentningsfrist_annulleret_kl: string; status: string }>();
    if (!data) return null;
    return {
      annulleretKl: data.afhentningsfrist_annulleret_kl,
      refunderet: data.status === "refunderet",
    };
  } catch (err) {
    console.error("hentAfhentningsfristAnnullering fejlede:", err);
    return null;
  }
}
