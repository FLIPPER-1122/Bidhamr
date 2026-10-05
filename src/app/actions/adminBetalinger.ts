"use server";

import { assertRole } from "@/lib/adminAuth";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { notificerAdvarsler } from "@/lib/notifikationer/cron";
import {
  indsigelseBlokerer,
  proevRefusionIgen,
  sendUdbetalingskontoNulstillet,
} from "@/lib/betaling/stripeBetaling";

// Admin: betalinger, der kræver handling (betalinger.kraever_opmaerksomhed og
// åbne betaling_afvigelser). Medarbejder og admin ser kun hvem/hvad/status/fejl.
// Beløb hentes KUN fra databasen, når rollen er chef – de må aldrig ende i
// klienten for andre roller.

class BrugerFejl extends Error {}

// Ingen medarbejder må behandle en betaling, hvor han selv er køber eller sælger.
const INHABIL = "Du kan ikke behandle en handel, hvor du selv er køber eller sælger.";

const GENERISK_FEJL = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error(`Admin-handling ${navn} fejlede:`, err);
    return { fejl: GENERISK_FEJL };
  }
}

const PR_SIDE = 25;
const MAX_AFVIGELSER = 50;
const MAX_UDEN_HANDEL = 50;

// sidste_fejl må aldrig vise beløb for andre end chef. Nye tekster skrives
// uden tal, men ældre rækker (og evt. tekster fra Stripe) kan indeholde
// beløb. For ikke-chef fjernes derfor parenteser med tal, og alle øvrige tal
// skjules - bortset fra antal dage/timer/forsøg.
const SKJULT = "[skjult]";
function rensBeloeb(tekst: string | null): string | null {
  if (!tekst) return tekst;
  return tekst
    .replace(/\([^()]*\d[^()]*\)/g, "")
    .replace(/\d[\d.,]*\s*(kr\.?|kroner|øre|oere|dkk)(?![a-zæøå])/gi, SKJULT)
    .replace(/\d[\d.,]*(?![\d.,]|\s*(dage|dag|timer|time|forsøg)(?![a-zæøå]))/gi, SKJULT)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export type Person = { id: string; navn: string | null };

export type BetalingBeloeb = {
  total_oere: number;
  udbetaling_oere: number;
  fragt_oere: number;
  koebergebyr_oere: number;
  saelgergebyr_oere: number;
  beskyttelse_oere: number;
};

// Hvilken slags problem betalingen har. Afgør, hvilke knapper og hvilken
// forklaring kortet på /admin/betalinger viser.
//   afhentning     - afhentningshandel, betalt, ikke frigivet/refunderet
//                    (kodelås eller ikke hentet efter 7 dage).
//   ikke_afsluttet - betalt, men hverken frigivet eller refunderet.
//   overfoersel    - frigivet, men overførslen til sælger er ikke lykkedes.
//   refusion       - refusion til køber er påbegyndt/fejlet.
//   indsigelse     - åben indsigelse hos køberens bank.
//   andet          - alt andet.
export type BetalingProblem =
  | "afhentning"
  | "ikke_afsluttet"
  | "overfoersel"
  | "refusion"
  | "indsigelse"
  | "andet";

export type BetalingTilHandling = {
  id: string;
  trade_id: string;
  auction_id: string;
  auktion_titel: string | null;
  koeber: Person;
  saelger: Person;
  status: string;
  sidste_fejl: string | null;
  dato: string;
  indsigelse_kl: string | null;
  // Admin/chef kan prøve overførslen igen (frigivet, ikke overført, ikke
  // refunderet, ingen blokerende indsigelse, handel ikke annulleret, ingen sag).
  kanProeveOverfoersel: boolean;
  // Admin/chef kan prøve tilbagebetalingen igen (refusion anmodet, ikke
  // gennemført, intet overført til sælger, ingen indsigelse, BidHamrs egen
  // refusion). Serveren og databasen tjekker det igen.
  kanProeveRefusion: boolean;
  problem: BetalingProblem;
  // Admin/chef kan frigive til sælger eller refundere køberen (samme regel som
  // på /admin/handler: rolle admin+ og handlen er aktiv). Kun sat for
  // problemtyperne afhentning og ikke_afsluttet.
  kanFlyttePenge: boolean;
  // Kun for problem "refusion": er tilbagebetalingen gennemført, fejlet eller
  // stadig i gang - afgjort ud fra status/refunderet_kl, ikke fejlteksten
  // (sidste_fejl kan stå tilbage fra et tidligere, fejlet forsøg).
  refusion: {
    tilstand: "gennemfoert" | "fejlet" | "afventer";
    forsoeg: number;
    maksForsoeg: number;
    // Prøver cron selv igen (kun sags- og afsendelsesfristrefusioner, op til
    // maksForsoeg).
    proeverSelv: boolean;
  } | null;
  // Link til betalingen i Stripes dashboard. Kun sat for admin/chef.
  stripeLink: string | null;
  // Handlens status (fx 'annulleret' - så vises fragten som refunderet).
  handel_status: string | null;
  // Kun for løste: hvem/hvornår/note.
  loest?: { kl: string; note: string; af: string | null } | null;
  // Kun sat for chef.
  beloeb?: BetalingBeloeb;
};

export type AfvigelseTilHandling = {
  id: string;
  betaling_id: string;
  trade_id: string;
  auction_id: string | null;
  auktion_titel: string | null;
  koeber: Person | null;
  saelger: Person | null;
  sidste_fejl: string | null;
  refusion_forsoeg: number;
  dato: string;
  // Kun sat for chef.
  beloeb?: { modtaget_oere: number; forventet_oere: number };
};

export type AuktionUdenHandel = {
  id: string;
  titel: string | null;
  slutter_kl: string;
  for_gammel_til_automatik: boolean;
};

// Sælgeres udbetalingskonti, der kræver handling (fejlet udbetaling til bank,
// frakoblet eller afvist konto). Spejlet fra Stripe af webhooken. Ingen beløb.
export type UdbetalingskontoTilHandling = {
  saelger: Person;
  aarsag: string | null;
  dato: string | null;
  frakoblet: boolean;
};

const MAX_UDBETALINGSKONTI = 50;

// Kolonnerne kommer fra 20261003060000_connect_status.sql. Mangler de, vises
// sektionen ikke (og tælles ikke).
async function hentUdbetalingskonti(
  admin: AdminClient,
): Promise<{ raekker: Raekke[]; antal: number }> {
  const { data, count, error } = await admin
    .from("betalingsprofiler")
    .select("user_id, connect_opmaerksomhed_aarsag, connect_opmaerksomhed_kl, connect_frakoblet_kl", {
      count: "exact",
    })
    .eq("connect_kraever_opmaerksomhed", true)
    .order("connect_opmaerksomhed_kl", { ascending: true })
    .limit(MAX_UDBETALINGSKONTI);
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204") {
      console.error("Udbetalingskonti: kør migrationen 20261003060000_connect_status.sql");
      return { raekker: [], antal: 0 };
    }
    throw new Error(error.message);
  }
  return { raekker: (data ?? []) as Raekke[], antal: count ?? 0 };
}

export type BetalingerResultat = {
  ok: true;
  fane: "aaben" | "loest";
  side: number;
  antalSider: number;
  antalAabne: number;
  visBeloeb: boolean;
  kanLoese: boolean;
  betalinger: BetalingTilHandling[];
  afvigelser: AfvigelseTilHandling[];
  udenHandel: AuktionUdenHandel[];
  udbetalingskonti: UdbetalingskontoTilHandling[];
};

const BASIS_KOLONNER =
  "id, trade_id, auction_id, buyer_id, seller_id, status, sidste_fejl, opdateret, frigivet_kl, stripe_transfer_id, refusion_anmodet_kl, refunderet_kl, refusion_forsoeg, refusion_aarsag, stripe_payment_intent_id, overfoersel_paabegyndt_kl, refusion_graense";

// Standardgrænsen, som cron bruger (refunderSagerVentende og
// afsendelsesfristens proevIgen: refusion_forsoeg < refusion_graense, standard
// 5). "Prøv tilbagebetaling igen" hæver grænsen pr. betaling.
const MAKS_REFUSION_FORSOEG = 5;
const CRON_REFUSION_AARSAGER = ["sag", "afsendelsesfrist"];

function stripeBetalingLink(pi: string): string {
  const live = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_");
  return `https://dashboard.stripe.com/${live ? "" : "test/"}payments/${encodeURIComponent(pi)}`;
}
const BELOEB_KOLONNER =
  "total_oere, udbetaling_oere, fragt_oere, koebergebyr_oere, saelgergebyr_oere, beskyttelse_oere";

type Raekke = Record<string, unknown>;
type AdminClient = Awaited<ReturnType<typeof assertRole>>["admin"];

// indsigelse_kl tilføjes af en anden migration. Findes kolonnen ikke endnu
// (Postgres 42703 / PostgREST PGRST204), hentes uden den.
function manglerKolonne(err: { code?: string; message?: string } | null) {
  if (!err) return false;
  return (
    err.code === "42703" ||
    err.code === "PGRST204" ||
    /indsigelse_(kl|status)/.test(err.message ?? "")
  );
}

async function hentBetalingRaekker(
  admin: AdminClient,
  kolonner: string,
  byg: (q: ReturnType<ReturnType<AdminClient["from"]>["select"]>) => PromiseLike<{
    data: unknown;
    count: number | null;
    error: { code?: string; message?: string } | null;
  }>,
): Promise<{ data: Raekke[]; count: number }> {
  const medIndsigelse = await byg(
    admin
      .from("betalinger")
      .select(`${kolonner}, indsigelse_kl, indsigelse_status`, { count: "exact" }),
  );
  if (!medIndsigelse.error) {
    return { data: (medIndsigelse.data ?? []) as Raekke[], count: medIndsigelse.count ?? 0 };
  }
  if (!manglerKolonne(medIndsigelse.error)) throw new Error(medIndsigelse.error.message);
  const uden = await byg(admin.from("betalinger").select(kolonner, { count: "exact" }));
  if (uden.error) throw new Error(uden.error.message);
  return { data: (uden.data ?? []) as Raekke[], count: uden.count ?? 0 };
}

export async function hentBetalingerTilHandling(side: number, fane: "aaben" | "loest" = "aaben") {
  return koer("hentBetalingerTilHandling", async (): Promise<BetalingerResultat> => {
    const { admin, rolle } = await assertRole("medarbejder");
    const visBeloeb = rolle === "chef";
    const kanLoese = rolle === "chef" || rolle === "admin";
    const kolonner = visBeloeb ? `${BASIS_KOLONNER}, ${BELOEB_KOLONNER}` : BASIS_KOLONNER;
    const s = Math.max(1, Math.floor(Number(side)) || 1);
    const fra = (s - 1) * PR_SIDE;
    const til = s * PR_SIDE - 1;

    let raekker: Raekke[] = [];
    let total = 0;
    const loestMap = new Map<string, { kl: string; note: string; af: string | null }>();

    if (fane === "aaben") {
      const res = await hentBetalingRaekker(admin, kolonner, (q) =>
        q.eq("kraever_opmaerksomhed", true).order("opdateret", { ascending: true }).range(fra, til),
      );
      raekker = res.data;
      total = res.count;
    } else {
      // Løste = betalinger med en 'betaling_loest'-logning (maal_id = trade_id).
      const { data: log, count, error } = await admin
        .from("moderation_log")
        .select("maal_id, aarsag, oprettet_kl, medarbejder_id", { count: "exact" })
        .eq("handling", "betaling_loest")
        .order("oprettet_kl", { ascending: false })
        .range(fra, til);
      if (error) throw new Error(error.message);
      total = count ?? 0;
      const tradeIds = [...new Set((log ?? []).map((l) => l.maal_id as string))];
      const medarbejderIds = [...new Set((log ?? []).map((l) => l.medarbejder_id as string))];
      const { data: medarbejdere } = medarbejderIds.length
        ? await admin.from("users").select("id, navn").in("id", medarbejderIds)
        : { data: [] as { id: string; navn: string | null }[] };
      const mNavn = new Map((medarbejdere ?? []).map((m) => [m.id as string, m.navn as string | null]));
      for (const l of log ?? []) {
        if (loestMap.has(l.maal_id as string)) continue; // nyeste vinder
        loestMap.set(l.maal_id as string, {
          kl: l.oprettet_kl as string,
          note: l.aarsag as string,
          af: mNavn.get(l.medarbejder_id as string) ?? null,
        });
      }
      if (tradeIds.length) {
        const res = await hentBetalingRaekker(admin, kolonner, (q) => q.in("trade_id", tradeIds));
        // Bevar logrækkefølgen (nyeste løst først).
        const efterTrade = new Map(res.data.map((r) => [r.trade_id as string, r]));
        raekker = tradeIds.map((t) => efterTrade.get(t)).filter((r): r is Raekke => !!r);
      }
    }

    // Åbne afvigelser (forkert beløb, venter på refusion) vises kun på fanen
    // "Kræver handling". Der er normalt få; vis højst MAX_AFVIGELSER.
    let afvigRaekker: Raekke[] = [];
    let antalAfvigelser = 0;
    {
      const afvKol = visBeloeb
        ? "id, betaling_id, trade_id, sidste_fejl, refusion_forsoeg, oprettet, modtaget_oere, forventet_oere"
        : "id, betaling_id, trade_id, sidste_fejl, refusion_forsoeg, oprettet";
      const q = admin
        .from("betaling_afvigelser")
        .select(afvKol, { count: "exact", head: fane !== "aaben" })
        .is("refunderet_kl", null);
      const { data, count, error } =
        fane === "aaben" ? await q.order("oprettet", { ascending: true }).limit(MAX_AFVIGELSER) : await q;
      if (error) throw new Error(error.message);
      afvigRaekker = (data ?? []) as unknown as Raekke[];
      antalAfvigelser = count ?? 0;
    }

    // Udbetalingskonti, der kræver handling (vises kun på "Kræver handling",
    // men tælles altid med i fanens antal).
    const konti = await hentUdbetalingskonti(admin);

    // Antal åbne betalinger (til fanen), hvis vi ikke allerede har det.
    let antalAabneBetalinger = fane === "aaben" ? total : 0;
    if (fane !== "aaben") {
      const { count, error } = await admin
        .from("betalinger")
        .select("id", { count: "exact", head: true })
        .eq("kraever_opmaerksomhed", true);
      if (error) throw new Error(error.message);
      antalAabneBetalinger = count ?? 0;
    }

    // Afvigelsernes betalinger (for auktion, køber, sælger).
    const afvBetalingIds = [...new Set(afvigRaekker.map((a) => a.betaling_id as string))];
    const { data: afvBetalinger, error: afvBetErr } = afvBetalingIds.length
      ? await admin
          .from("betalinger")
          .select("id, auction_id, buyer_id, seller_id")
          .in("id", afvBetalingIds)
      : { data: [] as Raekke[], error: null };
    if (afvBetErr) throw new Error(afvBetErr.message);
    const afvBetMap = new Map((afvBetalinger ?? []).map((b) => [b.id as string, b as Raekke]));

    const brugerIds = new Set<string>();
    const auktionIds = new Set<string>();
    for (const r of [...raekker, ...(afvBetalinger ?? [])] as Raekke[]) {
      brugerIds.add(r.buyer_id as string);
      brugerIds.add(r.seller_id as string);
      auktionIds.add(r.auction_id as string);
    }
    if (fane === "aaben") for (const k of konti.raekker) brugerIds.add(k.user_id as string);

    const [{ data: brugere, error: bErr }, { data: auktioner, error: aErr }] = await Promise.all([
      brugerIds.size
        ? admin.from("users").select("id, navn").in("id", [...brugerIds])
        : Promise.resolve({ data: [] as { id: string; navn: string | null }[], error: null }),
      auktionIds.size
        ? admin.from("auctions").select("id, titel").in("id", [...auktionIds])
        : Promise.resolve({ data: [] as { id: string; titel: string }[], error: null }),
    ]);
    if (bErr) throw new Error(bErr.message);
    if (aErr) throw new Error(aErr.message);
    // Handlernes status (til "Prøv overførsel igen").
    const tradeIdsAlle = [...new Set(raekker.map((r) => r.trade_id as string))];
    const { data: handler, error: hErr } = tradeIdsAlle.length
      ? await admin.from("trades").select("id, status, sag_aaben, afhentning").in("id", tradeIdsAlle)
      : {
          data: [] as { id: string; status: string; sag_aaben: boolean | null; afhentning: boolean | null }[],
          error: null,
        };
    if (hErr) throw new Error(hErr.message);
    const handelMap = new Map(
      (handler ?? []).map((h) => [
        h.id as string,
        { status: h.status as string, sag_aaben: !!h.sag_aaben, afhentning: !!h.afhentning },
      ]),
    );

    // Afsluttede auktioner med vinder, men uden handel (kun på fanen "Kræver handling").
    let udenHandel: AuktionUdenHandel[] = [];
    if (fane === "aaben") {
      const { data: uh, error: uhErr } = await admin
        .from("auktioner_uden_handel")
        .select("id, titel, slutter_kl, for_gammel_til_automatik")
        .order("slutter_kl", { ascending: false })
        .limit(MAX_UDEN_HANDEL);
      if (uhErr) {
        // Viewet kommer fra 20261002040000 - mangler det, vises sektionen ikke.
        console.error("auktioner_uden_handel:", uhErr.message);
      } else {
        udenHandel = (uh ?? []).map((a) => ({
          id: a.id as string,
          titel: (a.titel as string | null) ?? null,
          slutter_kl: a.slutter_kl as string,
          for_gammel_til_automatik: !!a.for_gammel_til_automatik,
        }));
      }
    }

    const navn = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? null]));
    const titel = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));
    const person = (id: unknown): Person => ({ id: id as string, navn: navn.get(id as string) ?? null });

    const renset = (t: unknown) => {
      const tekst = (t as string | null) ?? null;
      return visBeloeb ? tekst : rensBeloeb(tekst);
    };
    const kanProeve = (r: Raekke) => {
      const h = handelMap.get(r.trade_id as string);
      return (
        r.status === "betalt" &&
        !!r.frigivet_kl &&
        !r.stripe_transfer_id &&
        !r.refusion_anmodet_kl &&
        !indsigelseBlokerer({
          indsigelse_kl: (r.indsigelse_kl as string | null | undefined) ?? null,
          indsigelse_status: (r.indsigelse_status as string | null | undefined) ?? null,
        }) &&
        !!h &&
        h.status !== "annulleret" &&
        !h.sag_aaben
      );
    };

    const problemFor = (r: Raekke, proeve: boolean): BetalingProblem => {
      const h = handelMap.get(r.trade_id as string);
      const fejl = (r.sidste_fejl as string | null) ?? "";
      if (
        indsigelseBlokerer({
          indsigelse_kl: (r.indsigelse_kl as string | null | undefined) ?? null,
          indsigelse_status: (r.indsigelse_status as string | null | undefined) ?? null,
        })
      ) {
        return "indsigelse";
      }
      if (proeve) return "overfoersel";
      if (r.refusion_anmodet_kl || r.status === "refunderet") return "refusion";
      if (r.status === "betalt" && !r.frigivet_kl) {
        return h?.afhentning || /Afhentning/i.test(fejl) ? "afhentning" : "ikke_afsluttet";
      }
      return "andet";
    };
    const AKTIVE_HANDLER = ["betaling_modtaget", "pakke_sendt", "modtaget"];

    const betalinger: BetalingTilHandling[] = raekker.map((r) => {
      const proeve = kanProeve(r);
      const problem = problemFor(r, proeve);
      const hStatus = handelMap.get(r.trade_id as string)?.status ?? null;
      const b: BetalingTilHandling = {
        id: r.id as string,
        trade_id: r.trade_id as string,
        auction_id: r.auction_id as string,
        auktion_titel: titel.get(r.auction_id as string) ?? null,
        koeber: person(r.buyer_id),
        saelger: person(r.seller_id),
        status: r.status as string,
        sidste_fejl: renset(r.sidste_fejl),
        dato: r.opdateret as string,
        indsigelse_kl: (r.indsigelse_kl as string | null | undefined) ?? null,
        kanProeveOverfoersel: kanLoese && proeve,
        kanProeveRefusion:
          kanLoese &&
          problem === "refusion" &&
          r.status === "betalt" &&
          !!r.refusion_anmodet_kl &&
          !r.refunderet_kl &&
          !r.stripe_transfer_id &&
          !r.overfoersel_paabegyndt_kl &&
          !!r.stripe_payment_intent_id &&
          r.refusion_aarsag !== "delvis_refusion_stripe",
        problem,
        kanFlyttePenge:
          kanLoese &&
          (problem === "afhentning" || problem === "ikke_afsluttet") &&
          !!hStatus &&
          AKTIVE_HANDLER.includes(hStatus),
        refusion:
          problem === "refusion"
            ? (() => {
                const forsoeg = Number(r.refusion_forsoeg ?? 0);
                const graense = Number(r.refusion_graense ?? MAKS_REFUSION_FORSOEG);
                const gennemfoert = r.status === "refunderet" && !!r.refunderet_kl;
                const fejlet =
                  !gennemfoert &&
                  (forsoeg > 0 || /refusion/i.test((r.sidste_fejl as string | null) ?? ""));
                return {
                  tilstand: gennemfoert ? "gennemfoert" : fejlet ? "fejlet" : "afventer",
                  forsoeg,
                  maksForsoeg: graense,
                  proeverSelv:
                    !gennemfoert &&
                    r.status === "betalt" &&
                    !r.stripe_transfer_id &&
                    CRON_REFUSION_AARSAGER.includes((r.refusion_aarsag as string | null) ?? "") &&
                    forsoeg < graense,
                } as const;
              })()
            : null,
        stripeLink:
          kanLoese && r.stripe_payment_intent_id
            ? stripeBetalingLink(r.stripe_payment_intent_id as string)
            : null,
        handel_status: hStatus,
        loest: fane === "loest" ? loestMap.get(r.trade_id as string) ?? null : null,
      };
      if (visBeloeb) {
        b.beloeb = {
          total_oere: Number(r.total_oere),
          udbetaling_oere: Number(r.udbetaling_oere),
          fragt_oere: Number(r.fragt_oere),
          koebergebyr_oere: Number(r.koebergebyr_oere),
          saelgergebyr_oere: Number(r.saelgergebyr_oere),
          beskyttelse_oere: Number(r.beskyttelse_oere),
        };
      }
      return b;
    });

    const afvigelser: AfvigelseTilHandling[] =
      fane === "aaben"
        ? afvigRaekker.map((a) => {
            const bet = afvBetMap.get(a.betaling_id as string);
            const v: AfvigelseTilHandling = {
              id: a.id as string,
              betaling_id: a.betaling_id as string,
              trade_id: a.trade_id as string,
              auction_id: (bet?.auction_id as string | undefined) ?? null,
              auktion_titel: bet ? titel.get(bet.auction_id as string) ?? null : null,
              koeber: bet ? person(bet.buyer_id) : null,
              saelger: bet ? person(bet.seller_id) : null,
              sidste_fejl: renset(a.sidste_fejl),
              refusion_forsoeg: Number(a.refusion_forsoeg ?? 0),
              dato: a.oprettet as string,
            };
            if (visBeloeb) {
              v.beloeb = {
                modtaget_oere: Number(a.modtaget_oere),
                forventet_oere: Number(a.forventet_oere),
              };
            }
            return v;
          })
        : [];

    const udbetalingskonti: UdbetalingskontoTilHandling[] =
      fane === "aaben"
        ? konti.raekker.map((k) => ({
            saelger: person(k.user_id),
            aarsag: (k.connect_opmaerksomhed_aarsag as string | null) ?? null,
            dato: (k.connect_opmaerksomhed_kl as string | null) ?? null,
            frakoblet: !!k.connect_frakoblet_kl,
          }))
        : [];

    return {
      ok: true,
      fane,
      side: s,
      antalSider: Math.max(1, Math.ceil(total / PR_SIDE)),
      antalAabne: antalAabneBetalinger + antalAfvigelser + konti.antal,
      visBeloeb,
      kanLoese,
      betalinger,
      afvigelser,
      udenHandel,
      udbetalingskonti,
    };
  });
}

export async function markerBetalingLøst(betalingId: string, note: string) {
  return koer("markerBetalingLøst", async () => {
    const { admin, userId } = await assertRole("admin");
    const id = (betalingId ?? "").trim();
    const n = (note ?? "").trim();
    if (!id) throw new BrugerFejl("Betalingen blev ikke fundet.");
    if (!n) throw new BrugerFejl("Skriv en note om, hvad der er gjort.");
    if (n.length > 2000) throw new BrugerFejl("Noten er for lang (højst 2000 tegn).");

    const INDSIGELSE_FEJL =
      "Der er en åben indsigelse hos køberens bank. Betalingen kan ikke markeres som løst, før indsigelsen er afgjort.";
    type Indsigelse = { indsigelse_kl: string | null; indsigelse_status: string | null };
    const { data: nu, error: nuErr } = await admin
      .from("betalinger")
      .select("indsigelse_kl, indsigelse_status, buyer_id, seller_id")
      .eq("id", id)
      .maybeSingle<Indsigelse & { buyer_id: string | null; seller_id: string | null }>();
    if (nuErr) throw new Error(nuErr.message);
    if (!nu) throw new BrugerFejl("Betalingen blev ikke fundet.");
    if (userId === nu.buyer_id || userId === nu.seller_id) throw new BrugerFejl(INHABIL);
    if (indsigelseBlokerer(nu)) throw new BrugerFejl(INDSIGELSE_FEJL);

    // Atomisk: kun rækker, der stadig kræver opmærksomhed og ikke har en
    // blokerende indsigelse (samme regel som betaling_indsigelse_blokerer), ændres.
    const { data, error } = await admin
      .from("betalinger")
      .update({ kraever_opmaerksomhed: false })
      .eq("id", id)
      .eq("kraever_opmaerksomhed", true)
      .or("indsigelse_kl.is.null,indsigelse_status.in.(won,warning_closed,prevented)")
      .select("trade_id, buyer_id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      // Enten allerede løst, eller en indsigelse kom imellem.
      const { data: igen } = await admin
        .from("betalinger")
        .select("indsigelse_kl, indsigelse_status")
        .eq("id", id)
        .maybeSingle<Indsigelse>();
      if (igen && indsigelseBlokerer(igen)) throw new BrugerFejl(INDSIGELSE_FEJL);
      throw new BrugerFejl("Betalingen er allerede markeret som løst.");
    }

    const { error: logErr } = await admin.from("moderation_log").insert({
      medarbejder_id: userId,
      handling: "betaling_loest",
      maal_type: "handel",
      maal_id: data.trade_id as string,
      bruger_id: (data.buyer_id as string | null) ?? null,
      aarsag: n,
    });
    revalidatePath("/admin", "layout");
    if (logErr) {
      console.error("Kunne ikke logge betaling_loest:", logErr);
      throw new BrugerFejl("Betalingen er markeret som løst, men noten blev ikke gemt i loggen.");
    }
    return { ok: true as const };
  });
}

// Til ConfirmDialog. formData: betalingId, note (påkrævet).
export async function markerBetalingLøstForm(formData: FormData) {
  return markerBetalingLøst(
    ((formData.get("betalingId") as string) ?? "").trim(),
    ((formData.get("note") as string) ?? "").trim(),
  );
}

// "Prøv tilbagebetaling igen" (admin/chef). Ingen beløb i teksterne.
const REFUSION_AFVIST: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at prøve tilbagebetalinger igen.",
  inhabil: INHABIL,
  ikke_fundet: "Betalingen blev ikke fundet.",
  allerede_refunderet: "Køberen har allerede fået pengene tilbage.",
  ikke_anmodet: "Der er ingen tilbagebetaling at prøve igen på denne betaling.",
  ikke_bidhamr:
    "Tilbagebetalingen er lavet direkte i Stripe og kan ikke prøves igen herfra. Tjek betalingen i Stripe.",
  overfoert: "Pengene er overført (eller ved at blive overført) til sælger, så der kan ikke tilbagebetales herfra.",
  indsigelse:
    "Der er en åben indsigelse hos køberens bank. Tilbagebetalingen afgøres af indsigelsen.",
  i_gang: "Tilbagebetalingen er i gang lige nu. Vent et par minutter, og opdatér siden.",
  aendret: "Betalingen er ændret i mellemtiden. Opdatér siden, og prøv igen.",
};

const REFUSION_UDFALD: Record<string, { gennemfoert: boolean; besked: string }> = {
  refunderet: { gennemfoert: true, besked: "Køberen har fået pengene tilbage." },
  allerede_refunderet: { gennemfoert: true, besked: "Køberen har allerede fået pengene tilbage." },
  refusion_afventer: {
    gennemfoert: true,
    besked:
      "Tilbagebetalingen er sendt til Stripe og afventer bekræftelse. Markeringen forsvinder af sig selv, når Stripe bekræfter den.",
  },
  refusion_i_gang: {
    gennemfoert: false,
    besked: "Tilbagebetalingen er i gang lige nu. Vent et par minutter, og opdatér siden.",
  },
  refusion_failed: {
    gennemfoert: false,
    besked: "Stripe afviste tilbagebetalingen igen. Tjek årsagen i Stripe, og kontakt køberen.",
  },
  refusion_canceled: {
    gennemfoert: false,
    besked: "Tilbagebetalingen blev annulleret hos Stripe. Tjek årsagen i Stripe.",
  },
  refusion_konflikt: {
    gennemfoert: false,
    besked:
      "Der findes allerede en anden tilbagebetaling på betalingen hos Stripe. Der er ikke sendt flere penge - tjek betalingen i Stripe.",
  },
};

// Admin/chef: giv en fejlet tilbagebetaling til køberen et nyt forsøg og prøv
// med det samme. Rolle, inhabilitet og tilstand tjekkes igen atomisk i
// betaling_refusion_proev_igen (som også logger 'refusion_proevet_igen').
// Dobbelt refusion forhindres i refunderBetaling (lås + opslag hos Stripe).
export async function proevTilbagebetalingIgen(betalingId: string) {
  return koer("proevTilbagebetalingIgen", async () => {
    const { admin, userId } = await assertRole("admin");
    const id = (betalingId ?? "").trim();
    if (!id) throw new BrugerFejl(REFUSION_AFVIST.ikke_fundet);

    const { data: nu, error: nuErr } = await admin
      .from("betalinger")
      .select("buyer_id, seller_id, trade_id, indsigelse_kl, indsigelse_status")
      .eq("id", id)
      .maybeSingle<{
        buyer_id: string | null;
        seller_id: string | null;
        trade_id: string;
        indsigelse_kl: string | null;
        indsigelse_status: string | null;
      }>();
    if (nuErr) throw new Error(nuErr.message);
    if (!nu) throw new BrugerFejl(REFUSION_AFVIST.ikke_fundet);
    if (userId === nu.buyer_id || userId === nu.seller_id) throw new BrugerFejl(INHABIL);
    if (indsigelseBlokerer(nu)) throw new BrugerFejl(REFUSION_AFVIST.indsigelse);

    let r: string;
    try {
      r = await proevRefusionIgen(id, userId);
    } catch (err) {
      console.error("Admin: tilbagebetaling fejlede igen:", id, err);
      revalidatePath("/admin", "layout");
      throw new BrugerFejl(
        "Tilbagebetalingen fejlede igen hos Stripe. Betalingen forbliver markeret - se fejlen på betalingen.",
      );
    }
    revalidatePath("/admin", "layout");

    if (!r.startsWith("ok:") && REFUSION_AFVIST[r]) throw new BrugerFejl(REFUSION_AFVIST[r]);
    const udfald = REFUSION_UDFALD[r.replace(/^ok:/, "")];
    if (!udfald) {
      console.error("Admin: uventet udfald af tilbagebetaling:", id, r);
      throw new BrugerFejl("Tilbagebetalingen blev ikke gennemført. Betalingen forbliver markeret.");
    }
    return { ok: true as const, gennemfoert: udfald.gennemfoert, besked: udfald.besked };
  });
}

// Til ConfirmDialog. formData: betalingId. Er tilbagebetalingen ikke sendt
// afsted, returneres udfaldet som { fejl }, så dialogen bliver stående.
export async function proevTilbagebetalingIgenForm(formData: FormData) {
  const res = await proevTilbagebetalingIgen(((formData.get("betalingId") as string) ?? "").trim());
  if ("fejl" in res) return res;
  if (!res.gennemfoert) return { fejl: res.besked };
  return { ok: true as const };
}

const ADVARSEL_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at give advarsler.",
  ugyldig_modtager: "Vælg, om advarslen gives til køber eller sælger.",
  begrundelse_bruger_mangler: "Skriv en begrundelse til brugeren. Den vises for brugeren.",
  begrundelse_bruger_for_lang: "Begrundelsen til brugeren er for lang (højst 1000 tegn).",
  begrundelse_for_lang: "Den interne note er for lang (højst 2000 tegn).",
  ikke_fundet: "Betalingen blev ikke fundet.",
  indsigelse:
    "Der er en åben indsigelse hos køberens bank. Der kan ikke gives advarsel, før indsigelsen er afgjort.",
  allerede_loest: "Betalingen er allerede markeret som løst.",
  inhabil: INHABIL,
};

// "Giv advarsel": advarsel til køber eller sælger (tæller med i
// 3-advarsler-reglen), logges og lukker sagen. Atomisk i admin_advarsel_betaling.
// begrundelseBruger vises for brugeren (påkrævet, højst 1000 tegn).
// internNote ser kun staff (valgfri, højst 2000 tegn).
export async function givAdvarselBetaling(
  betalingId: string,
  modtager: string,
  begrundelseBruger: string,
  internNote: string,
) {
  return koer("givAdvarselBetaling", async () => {
    const { admin, userId } = await assertRole("admin");
    const id = (betalingId ?? "").trim();
    const m = (modtager ?? "").trim();
    const tilBruger = (begrundelseBruger ?? "").trim();
    const note = (internNote ?? "").trim();
    if (!id) throw new BrugerFejl(ADVARSEL_FEJL.ikke_fundet);
    if (m !== "koeber" && m !== "saelger") throw new BrugerFejl(ADVARSEL_FEJL.ugyldig_modtager);
    if (!tilBruger) throw new BrugerFejl(ADVARSEL_FEJL.begrundelse_bruger_mangler);
    if (tilBruger.length > 1000) throw new BrugerFejl(ADVARSEL_FEJL.begrundelse_bruger_for_lang);
    if (note.length > 2000) throw new BrugerFejl(ADVARSEL_FEJL.begrundelse_for_lang);

    // Inhabilitet tjekkes også i admin_advarsel_betaling (20261003012000_inhabil_handel.sql).
    const { data: parter, error: parterErr } = await admin
      .from("betalinger")
      .select("buyer_id, seller_id")
      .eq("id", id)
      .maybeSingle<{ buyer_id: string | null; seller_id: string | null }>();
    if (parterErr) throw new Error(parterErr.message);
    if (!parter) throw new BrugerFejl(ADVARSEL_FEJL.ikke_fundet);
    if (userId === parter.buyer_id || userId === parter.seller_id) throw new BrugerFejl(INHABIL);

    const { data, error } = await admin.rpc("admin_advarsel_betaling", {
      p_betaling: id,
      p_medarbejder: userId,
      p_modtager: m,
      p_begrundelse: note || null,
      p_begrundelse_bruger: tilBruger,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") {
      if (kode && ADVARSEL_FEJL[kode]) throw new BrugerFejl(ADVARSEL_FEJL[kode]);
      throw new Error(`admin_advarsel_betaling returnerede ${kode}`);
    }
    after(() => notificerAdvarsler());
    revalidatePath("/admin", "layout");
    return { ok: true as const };
  });
}

// Til ConfirmDialog. formData: betalingId, modtager ('koeber'|'saelger'),
// begrundelse_bruger (påkrævet), begrundelse (intern note, valgfri).
export async function givAdvarselBetalingForm(formData: FormData) {
  return givAdvarselBetaling(
    ((formData.get("betalingId") as string) ?? "").trim(),
    ((formData.get("modtager") as string) ?? "").trim(),
    ((formData.get("begrundelse_bruger") as string) ?? "").trim(),
    ((formData.get("begrundelse") as string) ?? "").trim(),
  );
}

// Antal betalinger + åbne afvigelser + udbetalingskonti, der kræver handling
// (badge i menuen).
export async function hentAntalBetalingerTilHandling() {
  return koer("hentAntalBetalingerTilHandling", async () => {
    const { admin } = await assertRole("medarbejder");
    const [b, a, k] = await Promise.all([
      admin
        .from("betalinger")
        .select("id", { count: "exact", head: true })
        .eq("kraever_opmaerksomhed", true),
      admin
        .from("betaling_afvigelser")
        .select("id", { count: "exact", head: true })
        .is("refunderet_kl", null),
      admin
        .from("betalingsprofiler")
        .select("user_id", { count: "exact", head: true })
        .eq("connect_kraever_opmaerksomhed", true),
    ]);
    if (b.error) throw new Error(b.error.message);
    if (a.error) throw new Error(a.error.message);
    // Kolonnen findes først efter 20261003060000 - mangler den, tælles 0.
    if (k.error && k.error.code !== "42703" && k.error.code !== "PGRST204") {
      throw new Error(k.error.message);
    }
    return {
      ok: true as const,
      antal: (b.count ?? 0) + (a.count ?? 0) + (k.error ? 0 : (k.count ?? 0)),
    };
  });
}

const UDBETALINGSKONTO_FEJL: Record<string, string> = {
  note_mangler: "Skriv en note om, hvad der er gjort.",
  note_for_lang: "Noten er for lang (højst 2000 tegn).",
  inhabil: "Du kan ikke behandle din egen udbetalingskonto.",
  ikke_fundet: "Udbetalingskontoen blev ikke fundet.",
  allerede_loest: "Udbetalingskontoen er allerede markeret som løst.",
};

// Admin: markér en sælgers udbetalingskonto som løst (fx efter kontakt med
// sælgeren om en fejlet udbetaling). Atomisk opdatering + log i databasen.
export async function markerUdbetalingskontoLøst(brugerId: string, note: string) {
  return koer("markerUdbetalingskontoLøst", async () => {
    const { admin, userId } = await assertRole("admin");
    const id = (brugerId ?? "").trim();
    const n = (note ?? "").trim();
    if (!id) throw new BrugerFejl(UDBETALINGSKONTO_FEJL.ikke_fundet);
    if (!n) throw new BrugerFejl(UDBETALINGSKONTO_FEJL.note_mangler);
    if (n.length > 2000) throw new BrugerFejl(UDBETALINGSKONTO_FEJL.note_for_lang);
    if (id === userId) throw new BrugerFejl(UDBETALINGSKONTO_FEJL.inhabil);

    const { data, error } = await admin.rpc("udbetalingskonto_loest", {
      p_bruger: id,
      p_medarbejder: userId,
      p_note: n,
    });
    if (error) throw new Error(error.message);
    const kode = String(data);
    if (kode !== "ok") {
      if (UDBETALINGSKONTO_FEJL[kode]) throw new BrugerFejl(UDBETALINGSKONTO_FEJL[kode]);
      throw new Error(`udbetalingskonto_loest returnerede ${kode}`);
    }
    revalidatePath("/admin", "layout");
    return { ok: true as const };
  });
}

// Til ConfirmDialog. formData: brugerId, note (påkrævet).
export async function markerUdbetalingskontoLøstForm(formData: FormData) {
  return markerUdbetalingskontoLøst(
    ((formData.get("brugerId") as string) ?? "").trim(),
    ((formData.get("note") as string) ?? "").trim(),
  );
}

const NULSTIL_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at nulstille udbetalingskonti.",
  begrundelse_mangler: "Skriv en begrundelse.",
  begrundelse_for_lang: "Begrundelsen er for lang (højst 2000 tegn).",
  inhabil: "Du kan ikke nulstille din egen udbetalingskonto.",
  ikke_fundet: "Udbetalingskontoen blev ikke fundet.",
  ikke_frakoblet:
    "Kun en udbetalingskonto, som sælgeren har lukket eller frakoblet hos Stripe, kan nulstilles.",
  afvist_af_stripe:
    "Vores betalingspartner Stripe har afvist denne udbetalingskonto, så den kan ikke nulstilles.",
};

// Admin: nulstil en sælgers lukkede (frakoblede) udbetalingskonto, så sælgeren
// kan oprette en ny hos Stripe. Atomisk i udbetalingskonto_nulstil (rolle,
// inhabilitet, log i moderation_log, nye overførselsforsøg for ventende
// betalinger). Pengene overføres, når den nye konto er klar (account.updated
// -> overfoerVentende) - der flyttes ingen penge her.
export async function nulstilUdbetalingskonto(brugerId: string, begrundelse: string) {
  return koer("nulstilUdbetalingskonto", async () => {
    const { admin, userId } = await assertRole("admin");
    const id = (brugerId ?? "").trim();
    const n = (begrundelse ?? "").trim();
    if (!id) throw new BrugerFejl(NULSTIL_FEJL.ikke_fundet);
    if (!n) throw new BrugerFejl(NULSTIL_FEJL.begrundelse_mangler);
    if (n.length > 2000) throw new BrugerFejl(NULSTIL_FEJL.begrundelse_for_lang);
    if (id === userId) throw new BrugerFejl(NULSTIL_FEJL.inhabil);

    const { data, error } = await admin.rpc("udbetalingskonto_nulstil", {
      p_medarbejder: userId,
      p_bruger: id,
      p_begrundelse: n,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? {}) as { kode?: string; nulstillet_antal?: number };
    if (svar.kode !== "ok") {
      if (svar.kode && NULSTIL_FEJL[svar.kode]) throw new BrugerFejl(NULSTIL_FEJL[svar.kode]);
      throw new Error(`udbetalingskonto_nulstil returnerede ${svar.kode}`);
    }
    const antal = Number(svar.nulstillet_antal ?? 0);
    // Sælgeren har ingen konto endnu, så der er intet at overføre nu.
    after(() => sendUdbetalingskontoNulstillet(id, antal));
    revalidatePath("/admin", "layout");
    return { ok: true as const };
  });
}

// Til ConfirmDialog. formData: brugerId, begrundelse (påkrævet).
export async function nulstilUdbetalingskontoForm(formData: FormData) {
  return nulstilUdbetalingskonto(
    ((formData.get("brugerId") as string) ?? "").trim(),
    ((formData.get("begrundelse") as string) ?? "").trim(),
  );
}
