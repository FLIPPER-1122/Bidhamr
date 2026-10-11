import "server-only";

// Ikke-afhentet pakke (ROADMAP fase 2; ROADMAP-BESLUTNINGER afsnit 1,
// "Ikke-afhentet pakke (model 3)"). Fragtfirmaet sender pakken retur til
// sælgeren, når køberen ikke henter den. Sælgeren beholder varen og betaler
// ikke for fragten; køberen refunderes købsbeløbet minus gebyrer og fragt
// begge veje. Der udbetales intet til sælgeren.
//
// Én adapter-neutral indgang: registrerIkkeAfhentet. Den kaldes af
//   - fragtens handelseffekter (webhook/sporing), når adapteren melder
//     'returneret' på en udgående pakke, der aldrig er leveret, og adapteren
//     har returErIkkeAfhentet (src/lib/fragt/types.ts) - kilde 'fragt',
//   - betalings-cron'en (koerIkkeAfhentet) som reserve for samme signal,
//   - staff i admin ("Ikke afhentet" på handlen, med begrundelse - logges i
//     medarbejder-loggen af server action'en) - kilde 'staff'.
//
// Databasen afgør alt atomisk under lås (handel_ikke_afhentet_registrer,
// 20261016030000): hændelsen gemmes med låste beløb (én pr. handel -
// idempotent), handlen annulleres, og refusionen claimes med refusion_oere
// = R og refusion_aarsag 'ikke_afhentet'. Selve refusionen laves af den
// fælles refusionsvej (refunderBetaling -> refusionsplanen i tre trin), og
// betalings-cron'en prøver altid igen (refunderLoveteVentende), til Stripe
// har gennemført den. Aldrig to refusioner: refusionslåsen, idempotency
// keys og opslag af eksisterende refusioner hos Stripe (stripeBetaling.ts).
//
// Beskeder til køber og sælger har faste nøgler (én gang hver), og cron'en
// sender dem, der mangler (fx hvis serveren døde efter registreringen).
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { refunderBetaling } from "@/lib/betaling/stripeBetaling";
import { FRAGTFIRMAER, adapterFor } from "@/lib/fragt";
import { koeberIkkeAfhentetMail, kronerFraOere, saelgerIkkeAfhentetMail } from "@/lib/mails/handel";

type Admin = ReturnType<typeof createAdminClient>;

export type IkkeAfhentetKilde = "fragt" | "staff";

export type IkkeAfhentetInput = {
  tradeId: string;
  kilde: IkkeAfhentetKilde;
  // Staff: medarbejderens id (verificeret af kalderen med assertRole) og
  // begrundelsen (krævet).
  medarbejderId?: string | null;
  begrundelse?: string | null;
  // Fragt: den udgående forsendelse, fragtfirmaet meldte retur (krævet).
  forsendelseId?: string | null;
  // Returfragten i øre. Udeladt = samme som fragten ud (chefens valg).
  returfragtOere?: number | null;
  // Lav refusionen med det samme (staff). Ellers laver betalings-cron'en den
  // (webhooken skal svare hurtigt).
  refunderNu?: boolean;
};

export type IkkeAfhentetKode =
  | "ok"
  | "ok_intet"
  | "allerede"
  | "ingen_adgang"
  | "inhabil"
  | "begrundelse_mangler"
  | "ugyldig"
  | "ikke_fundet"
  | "ingen_betaling"
  | "afhentning"
  | "forkert_status"
  | "gammel_model"
  | "ikke_betalt"
  | "frigivet"
  | "udbetalt"
  | "refusion_i_gang"
  | "indsigelse"
  | "sag"
  | "markeret"
  | "forsendelse_ukendt"
  | "leveret"
  | "ikke_returneret"
  | "kraever_admin";

type RpcSvar = {
  kode: IkkeAfhentetKode;
  betaling_id?: string;
  trade_id?: string;
  buyer_id?: string;
  seller_id?: string;
  auction_id?: string;
  refusion_oere?: number;
  returfragt_oere?: number;
};

export type IkkeAfhentetSvar = {
  kode: IkkeAfhentetKode;
  betalingId?: string;
  refusionOere?: number;
  returfragtOere?: number;
  // Resultatet af refunderBetaling, når refunderNu er sat (fx "refunderet",
  // "refusion_afventer", "refusion_konflikt", "refusion_i_gang", "fejlet").
  refusion?: string;
};

// Danske fejltekster til staff (admin). Koderne er databasens.
export const IKKE_AFHENTET_FEJL: Partial<Record<IkkeAfhentetKode, string>> = {
  ingen_adgang: "Du har ikke adgang til at markere handlen som ikke afhentet.",
  inhabil: "Du kan ikke behandle en handel, hvor du selv er køber eller sælger. Bed en kollega om det.",
  begrundelse_mangler: "Skriv en begrundelse.",
  ugyldig: "Ugyldigt valg.",
  ikke_fundet: "Handlen findes ikke.",
  ingen_betaling: "Handlen har ingen betaling.",
  afhentning: "Handlen er en afhentning hos sælger - brug afhentningsfristen i stedet.",
  forkert_status: "Det kan kun markeres, når pakken er sendt, og handlen ikke er afsluttet.",
  gammel_model: "Betalingen er fra den gamle betalingsmodel - håndtér den manuelt i Stripe.",
  ikke_betalt: "Handlen er ikke betalt.",
  frigivet: "Pengene er allerede frigivet til sælgeren. Kontakt en admin.",
  udbetalt: "Pengene er allerede udbetalt til sælgeren. Kontakt en admin.",
  refusion_i_gang: "Der er allerede en tilbagebetaling i gang for handlen.",
  indsigelse: "Der er en indsigelse hos køberens bank. Pengene afgøres af indsigelsen.",
  sag: "Køberen har en sag på handlen. Afgør sagen under Sager.",
  markeret: "Handlen er markeret til opfølgning.",
  forsendelse_ukendt: "Forsendelsen hører ikke til handlen.",
  leveret: "Pakken er leveret (fragtfirmaet melder den leveret, eller køberen har trykket modtaget) - den kan ikke markeres som ikke afhentet.",
  kraever_admin: "Fragtfirmaet har ikke meldt pakken retur. Uden en returmelding kan kun en admin eller chef markere handlen som ikke afhentet.",
  ikke_returneret: "Fragtfirmaet har ikke meldt pakken retur.",
};

const NOEGLE_KOEBER = (tradeId: string) => `ikke_afhentet_koeber:${tradeId}`;
const NOEGLE_SAELGER = (tradeId: string) => `ikke_afhentet_saelger:${tradeId}`;

async function titel(admin: Admin, auktionId: string | undefined): Promise<string> {
  if (!auktionId) return "din vare";
  const { data } = await admin.from("auctions").select("titel").eq("id", auktionId).maybeSingle<{ titel: string | null }>();
  return data?.titel ?? "din vare";
}

type Haendelse = {
  trade_id: string;
  betaling_id: string;
  total_oere: number;
  koebergebyr_oere: number;
  beskyttelse_oere: number;
  fragt_oere: number;
  returfragt_oere: number;
  refusion_oere: number;
};

// Beskeder til køber og sælger (faste nøgler - én gang hver). Kaster aldrig.
async function sendBeskeder(
  admin: Admin,
  h: Haendelse,
  parter: { buyer_id: string; seller_id: string; auction_id: string },
  mangler: { koeber: boolean; saelger: boolean } = { koeber: true, saelger: true },
): Promise<void> {
  try {
    const t = await titel(admin, parter.auction_id);
    const link = `/mine-handler/${h.trade_id}`;
    const R = Number(h.refusion_oere);
    if (mangler.koeber) {
      await send(parter.buyer_id, "betaling_modtaget", {
        titel: "Pakken blev ikke hentet",
        tekst:
          R > 0
            ? `Du hentede ikke "${t}" i tide, så pakken er sendt retur til sælgeren, og handlen er annulleret. Du får ${kronerFraOere(R)} kr tilbage – købsbeløbet minus gebyrerne og fragten begge veje. Betalingen håndteres af vores betalingspartner Stripe.`
            : `Du hentede ikke "${t}" i tide, så pakken er sendt retur til sælgeren, og handlen er annulleret. Købsbeløbet minus gebyrerne og fragten begge veje bliver 0 kr., så du får ikke noget tilbage – og du skylder heller ikke noget.`,
        link,
        data: { trade_id: h.trade_id },
        mail: koeberIkkeAfhentetMail(
          t,
          {
            totalOere: Number(h.total_oere),
            koebergebyrOere: Number(h.koebergebyr_oere),
            beskyttelseOere: Number(h.beskyttelse_oere),
            fragtOere: Number(h.fragt_oere),
            returfragtOere: Number(h.returfragt_oere),
            refusionOere: R,
          },
          h.trade_id,
        ),
        noegle: NOEGLE_KOEBER(h.trade_id),
      });
    }
    if (mangler.saelger) {
      await send(parter.seller_id, "betaling_modtaget", {
        titel: "Pakken kommer retur til dig",
        tekst: `Køberen hentede ikke "${t}", så pakken er på vej retur til dig. Handlen er annulleret, og du beholder varen. Du betaler ikke for fragten, og der udbetales ikke penge for handlen.`,
        link,
        data: { trade_id: h.trade_id },
        mail: saelgerIkkeAfhentetMail(t, h.trade_id),
        noegle: NOEGLE_SAELGER(h.trade_id),
      });
    }
  } catch (err) {
    console.error("Beskeder om ikke-afhentet pakke fejlede (cron prøver igen):", h.trade_id, err);
  }
}

async function hentHaendelse(admin: Admin, tradeId: string): Promise<Haendelse | null> {
  const { data, error } = await admin
    .from("handel_ikke_afhentet")
    .select("trade_id, betaling_id, total_oere, koebergebyr_oere, beskyttelse_oere, fragt_oere, returfragt_oere, refusion_oere")
    .eq("trade_id", tradeId)
    .maybeSingle<Haendelse>();
  if (error) throw new Error(`handel_ikke_afhentet: ${error.message}`);
  return data;
}

// Registrerer "returneret - ikke afhentet". Kaster kun ved databasefejl.
export async function registrerIkkeAfhentet(input: IkkeAfhentetInput): Promise<IkkeAfhentetSvar> {
  const admin = createAdminClient();
  const retur =
    input.returfragtOere === undefined || input.returfragtOere === null ? null : Math.round(Number(input.returfragtOere));
  if (retur !== null && (!Number.isSafeInteger(retur) || retur < 0)) return { kode: "ugyldig" };

  const { data, error } = await admin.rpc("handel_ikke_afhentet_registrer", {
    p_trade: input.tradeId,
    p_kilde: input.kilde,
    p_medarbejder: input.medarbejderId ?? null,
    p_begrundelse: input.begrundelse ?? null,
    p_forsendelse: input.forsendelseId ?? null,
    p_returfragt_oere: retur,
  });
  if (error) throw new Error(`handel_ikke_afhentet_registrer: ${error.message}`);
  const r = data as RpcSvar;
  const svar: IkkeAfhentetSvar = {
    kode: r.kode,
    betalingId: r.betaling_id,
    refusionOere: r.refusion_oere === undefined ? undefined : Number(r.refusion_oere),
    returfragtOere: r.returfragt_oere === undefined ? undefined : Number(r.returfragt_oere),
  };
  if (r.kode !== "ok" && r.kode !== "ok_intet") return svar;

  // Nyregistreret: beskeder først (handlen er annulleret og refusionen
  // claimet, også hvis Stripe-kaldet nedenfor fejler og prøves igen).
  // Fejler opslaget, sender cron'en beskederne (koerIkkeAfhentet).
  const h = await hentHaendelse(admin, input.tradeId).catch((err) => {
    console.error("Hændelsen kunne ikke hentes efter registreringen (cron sender beskederne):", input.tradeId, err);
    return null;
  });
  if (h && r.buyer_id && r.seller_id && r.auction_id) {
    await sendBeskeder(admin, h, { buyer_id: r.buyer_id, seller_id: r.seller_id, auction_id: r.auction_id });
  }

  // ok_intet (R = 0, Filip 10. okt. 2026): køberen får 0 kr. og skylder
  // intet; refunderBetaling tilbagefører kun sælgerens del (X = U).
  if (input.refunderNu && r.betaling_id) {
    try {
      svar.refusion = await refunderBetaling(r.betaling_id);
    } catch (err) {
      console.error("Refusion efter ikke-afhentet pakke fejlede (cron prøver igen):", input.tradeId, err);
      svar.refusion = "fejlet";
    }
  }
  return svar;
}

// --- Fragt: automatisk registrering -------------------------------------------

// Udgående forsendelse meldt 'returneret' (aldrig 'leveret') af en adapter,
// hvor det sikkert betyder "ikke afhentet". Kaldes fra fragtens
// handelseffekter (webhook/sporing) og af cron'en. Kaster aldrig.
export async function ikkeAfhentetFraFragt(forsendelseId: string): Promise<IkkeAfhentetKode | null> {
  try {
    const admin = createAdminClient();
    const { data: f } = await admin
      .from("forsendelser")
      .select("id, trade_id, type, fragtfirma, returneret_kl, leveret_kl")
      .eq("id", forsendelseId)
      .maybeSingle<{
        id: string;
        trade_id: string;
        type: string;
        fragtfirma: string;
        returneret_kl: string | null;
        leveret_kl: string | null;
      }>();
    if (!f || f.type !== "udgaaende" || !f.returneret_kl || f.leveret_kl) return null;
    if (!adapterFor(f.fragtfirma)?.returErIkkeAfhentet) return null;
    const svar = await registrerIkkeAfhentet({ tradeId: f.trade_id, kilde: "fragt", forsendelseId: f.id });
    // Noten står på forsendelsen under Admin -> Handler -> Fragt (sporingen
    // har allerede markeret den til staff ved 'returneret').
    const note =
      svar.kode === "ok"
        ? "Registreret som ikke afhentet: handlen er annulleret, og køberen refunderes automatisk (minus gebyrer og fragt begge veje). Sælgeren får pakken retur."
        : svar.kode === "ok_intet"
          ? "Registreret som ikke afhentet: handlen er annulleret. Køberen får 0 kr. (returfragten er mindst buddet), og sælgerens del tilbageføres automatisk. Sælgeren får pakken retur."
          : svar.kode === "allerede"
            ? null
            : `Pakken er meldt retur (ikke afhentet), men handlen kunne ikke annulleres automatisk: ${IKKE_AFHENTET_FEJL[svar.kode] ?? svar.kode} Afgør handlen.`;
    if (note) {
      const { error } = await admin.rpc("forsendelse_note_til_staff", { p_id: f.id, p_note: note });
      if (error) console.error("forsendelse_note_til_staff:", f.id, error.message);
    }
    return svar.kode;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: ikke afhentet", fejl: err });
    return null;
  }
}

// --- Cron ------------------------------------------------------------------------

const DAG = 24 * 60 * 60 * 1000;

// Betalings-cron'en (før den automatiske frigivelse):
//   1) reserve for fragtens signal: returnerede, aldrig leverede udgående
//      pakker (seneste 30 dage) uden registrering - fx hvis webhooken døde,
//   2) beskeder, der mangler (registreret de seneste 2 dage).
// Refusionen prøves af refunderLoveteVentende (alle årsager). Kaster aldrig.
export async function koerIkkeAfhentet(): Promise<{ registreret: number; beskeder: number }> {
  const res = { registreret: 0, beskeder: 0 };
  try {
    const admin = createAdminClient();
    // Kun fragtfirmaer, hvor 'returneret' sikkert betyder "ikke afhentet".
    // Databasen sorterer allerede registrerede (og handler, der ikke kan
    // registreres nu) fra, før der tages 20 - så reserven aldrig går i stå.
    const firmaer = FRAGTFIRMAER.filter((n) => adapterFor(n)?.returErIkkeAfhentet);
    if (firmaer.length > 0) {
      const { data: kandidater, error } = await admin.rpc("ikke_afhentet_fragt_kandidater", {
        p_fragtfirmaer: firmaer,
        p_graense: 20,
      });
      if (error) throw new Error(`ikke_afhentet_fragt_kandidater: ${error.message}`);
      for (const k of (kandidater ?? []) as { forsendelse_id: string; trade_id: string }[]) {
        const kode = await ikkeAfhentetFraFragt(k.forsendelse_id);
        if (kode === "ok" || kode === "ok_intet") res.registreret++;
      }
    }

    // Beskeder, der mangler.
    const { data: nye, error: nFejl } = await admin
      .from("handel_ikke_afhentet")
      .select("trade_id, betaling_id, total_oere, koebergebyr_oere, beskyttelse_oere, fragt_oere, returfragt_oere, refusion_oere")
      .gte("registreret_kl", new Date(Date.now() - 2 * DAG).toISOString())
      .limit(200);
    if (nFejl) throw new Error(`handel_ikke_afhentet: ${nFejl.message}`);
    const raekker = (nye ?? []) as Haendelse[];
    if (raekker.length === 0) return res;
    const noegler = raekker.flatMap((r) => [NOEGLE_KOEBER(r.trade_id), NOEGLE_SAELGER(r.trade_id)]);
    const sendt = new Set<string>();
    for (let i = 0; i < noegler.length; i += 200) {
      const { data, error: sFejl } = await admin
        .from("notifikation_afsendelser")
        .select("noegle")
        .in("noegle", noegler.slice(i, i + 200));
      if (sFejl) throw new Error(`notifikation_afsendelser: ${sFejl.message}`);
      for (const x of data ?? []) sendt.add(x.noegle as string);
    }
    const mangler = raekker.filter((r) => !sendt.has(NOEGLE_KOEBER(r.trade_id)) || !sendt.has(NOEGLE_SAELGER(r.trade_id)));
    if (mangler.length === 0) return res;
    const { data: parter } = await admin
      .from("trades")
      .select("id, buyer_id, seller_id, auction_id")
      .in("id", mangler.map((r) => r.trade_id));
    const pmap = new Map((parter ?? []).map((p) => [p.id as string, p as { buyer_id: string; seller_id: string; auction_id: string }]));
    for (const r of mangler) {
      const p = pmap.get(r.trade_id);
      if (!p) continue;
      await sendBeskeder(admin, r, p, {
        koeber: !sendt.has(NOEGLE_KOEBER(r.trade_id)),
        saelger: !sendt.has(NOEGLE_SAELGER(r.trade_id)),
      });
      res.beskeder++;
    }
  } catch (err) {
    console.error("Ikke-afhentet-trinnet fejlede:", err);
    await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Ikke-afhentet pakke", fejl: err });
  }
  return res;
}

// --- Visning på handelssiden -------------------------------------------------------

export type IkkeAfhentetVisning = {
  registreretKl: string;
  refusionOere: number;
  returfragtOere: number;
  fragtOere: number;
  koebergebyrOere: number;
  beskyttelseOere: number;
  // Stripe har gennemført refusionen (spejlet i databasen).
  refunderet: boolean;
};

// Er pakken registreret som ikke afhentet? Kun til køber og sælger på
// handlen (brugerId er den indloggede bruger, verificeret af kalderen).
// Tabellen kan kun læses af service role, så der filtreres eksplicit på
// parterne. null = nej (eller fejl).
export async function hentIkkeAfhentet(tradeId: string, brugerId: string): Promise<IkkeAfhentetVisning | null> {
  try {
    const admin = createAdminClient();
    const { data: t } = await admin
      .from("trades")
      .select("id")
      .eq("id", tradeId)
      .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
      .maybeSingle<{ id: string }>();
    if (!t) return null;
    const { data: h } = await admin
      .from("handel_ikke_afhentet")
      .select("registreret_kl, refusion_oere, returfragt_oere, fragt_oere, koebergebyr_oere, beskyttelse_oere, betaling_id")
      .eq("trade_id", tradeId)
      .maybeSingle<{
        registreret_kl: string;
        refusion_oere: number;
        returfragt_oere: number;
        fragt_oere: number;
        koebergebyr_oere: number;
        beskyttelse_oere: number;
        betaling_id: string;
      }>();
    if (!h) return null;
    const { data: b } = await admin
      .from("betalinger")
      .select("status")
      .eq("id", h.betaling_id)
      .maybeSingle<{ status: string }>();
    return {
      registreretKl: h.registreret_kl,
      refusionOere: Number(h.refusion_oere),
      returfragtOere: Number(h.returfragt_oere),
      fragtOere: Number(h.fragt_oere),
      koebergebyrOere: Number(h.koebergebyr_oere),
      beskyttelseOere: Number(h.beskyttelse_oere),
      refunderet: b?.status === "refunderet",
    };
  } catch (err) {
    console.error("hentIkkeAfhentet fejlede:", err);
    return null;
  }
}
