"use server";

// Fragt på hjemmesiden: checkout (leveringsvalg før betaling), pakkeshop-
// søgning, fragtlabel ("Send pakke"), annullering, label og sporing.
// Brugeren verificeres altid med auth her (cookie-session); selve logikken
// ligger i src/lib/fragt/handlinger.ts, som appens API også bruger.
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import type { AdresseInput, LeveringsvalgInput } from "@/lib/fragt/server";
import {
  UUID,
  annullerPakke,
  bookPakke,
  fragtpriser,
  gemLevering,
  hentCheckout,
  hentForsendelser,
  hentLabelLink,
  lavReturlabel,
  soegPakkeshops,
  startReturfragt,
} from "@/lib/fragt/handlinger";
import { gemReturAfsenderForHandel } from "@/lib/betaling/returfragt";
import { logDriftFejl } from "@/lib/drift";

type Fejl = { fejl: string };

async function bruger() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return user;
}

function genindlaes(tradeId: string) {
  if (UUID.test(tradeId)) revalidatePath(`/mine-handler/${tradeId}`);
}

// ------------------------------------------------------------ priser og pakkeshops

export async function hentFragtpriser() {
  return fragtpriser();
}

// transportoer: køberens valgte fragtfirma (Shipmondo: "dao" | "gls" |
// "postnord"). indlevering: shops, hvor man kan aflevere en pakke (retur).
export async function soegPakkeshopsAction(q: {
  postnummer: string;
  adresse?: string | null;
  by?: string | null;
  antal?: number;
  transportoer?: string | null;
  indlevering?: boolean;
}) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_pakkeshop_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  return soegPakkeshops(q ?? {});
}

// ------------------------------------------------------------ checkout (køber)

export async function hentCheckoutAction(tradeId: string) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  return hentCheckout(tradeId, u.id);
}

export async function gemLeveringsvalgAction(tradeId: string, valg: LeveringsvalgInput) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await gemLevering(tradeId, u.id, valg ?? {});
  genindlaes(tradeId);
  return r;
}

// ------------------------------------------------------------ fragtlabel

export type MinForsendelse = {
  id: string;
  status: string;
  pakkestoerrelse: string;
  sporingsnummer: string | null;
  // Labelen og labelfri-/QR-koden kan kun ses af den rette part (sælgeren
  // for en udgående).
  har_label: boolean;
  qr_kode: string | null;
  oprettet_kl: string;
  afleveret_kl: string | null;
  klar_til_afhentning_kl: string | null;
  leveret_kl: string | null;
  returneret_kl: string | null;
};

// Den aktive udgående forsendelse på handlen (køber og sælger).
export async function hentMinForsendelse(tradeId: string): Promise<MinForsendelse | null> {
  const u = await bruger();
  if (!u) return null;
  const r = await hentForsendelser(tradeId, u.id);
  if ("fejl" in r) return null;
  const f = r.forsendelser.find((x) => x.type === "udgaaende" && x.status !== "annulleret");
  if (!f) return null;
  return {
    id: f.id,
    status: f.status,
    pakkestoerrelse: f.pakkestoerrelse,
    sporingsnummer: f.sporingsnummer,
    har_label: f.harLabel,
    qr_kode: f.labelfriKode,
    oprettet_kl: f.oprettetKl,
    afleveret_kl: f.afleveretKl,
    klar_til_afhentning_kl: f.klarTilAfhentningKl,
    leveret_kl: f.leveretKl,
    returneret_kl: f.returneretKl,
  };
}

// Alle forsendelser på handlen med sporingstidslinje.
export async function hentForsendelserAction(tradeId: string) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  return hentForsendelser(tradeId, u.id);
}

// "Send pakke". afsender: sælgerens adresse (navn, adresse, postnummer, by,
// telefon). Udelades den (eller sendes den gamle pakkestørrelse som tekst),
// bruges sælgerens sidst brugte afsenderadresse. Pakkestørrelsen er altid
// auktionens.
// accepterDaoBetingelser: fluebenet ved DAO's handelsbetingelser (kræves før
// første DAO-label). Svaret har kode 'dao_betingelser', når det mangler.
export async function lavFragtlabel(
  tradeId: string,
  afsender?: AdresseInput | string | null,
  accepterDaoBetingelser?: boolean,
): Promise<{ ok: true } | (Fejl & { kode?: string })> {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await bookPakke(
    tradeId,
    u.id,
    typeof afsender === "object" ? afsender : null,
    accepterDaoBetingelser === true,
  );
  genindlaes(tradeId);
  if ("fejl" in r) return r.kode ? { fejl: r.fejl, kode: r.kode } : { fejl: r.fejl };
  return { ok: true };
}

export async function annullerFragtlabel(tradeId: string, forsendelseId: string): Promise<{ ok: true } | Fejl> {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await annullerPakke(tradeId, forsendelseId, u.id);
  genindlaes(tradeId);
  return r;
}

// Kortlivet link (5 min) til label-PDF'en. Grænse pr. bruger, fordi linket kan
// udløse et kald til fragtfirmaet (DAO: PDF'en hentes, hvis den manglede).
export async function hentFragtlabelLink(forsendelseId: string): Promise<{ url: string } | Fejl> {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await hentLabelLink(forsendelseId, u.id);
  return "fejl" in r ? r : { url: r.url };
}

// Returfragt i en sag (køberen): starter betalingen og giver Payment
// Elements client_secret. Returkoden laves først, når webhooken har bekræftet
// betalingen (src/lib/betaling/returfragt.ts). Bag FRAGT_RETURLABEL_AKTIV.
export async function startReturfragtAction(tradeId: string) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await startReturfragt(tradeId, u.id, null);
  if ("fejl" in r) return r;
  // Dækket returfragt (sælgeren/BidHamr betaler): ingen betaling - brug
  // lavDaekketReturlabelAction med adressen.
  if (r.daekket) return { fejl: "Du betaler ikke returfragten. Skriv din adresse, så laver vi returkoden.", daekket: true as const };
  // Payment Element bruger ikke Stripe-kunden (kun appens PaymentSheet).
  return {
    ok: true as const,
    clientSecret: r.clientSecret,
    beloebOere: r.beloebOere,
    customerSessionClientSecret: r.customerSessionClientSecret,
  };
}

// Transportskade med medhold (20261102210000): sælgeren eller BidHamr betaler
// returfragten. Køberen giver kun adresse og mobil, og returkoden laves med
// det samme (ingen betaling). Bag FRAGT_RETURLABEL_AKTIV.
export async function lavDaekketReturlabelAction(tradeId: string, afsender: AdresseInput) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await startReturfragt(tradeId, u.id, afsender ?? null);
  genindlaes(tradeId);
  if ("fejl" in r) return { fejl: r.fejl };
  if (!r.daekket) return { fejl: "Returfragten skal betales. Opdatér siden." };
  if (r.label && "fejl" in r.label) return { fejl: r.label.fejl };
  return { ok: true as const };
}

// Køberens adresse og mobil til returkoden - gemmes lige før betalingen.
export async function gemReturAfsenderAction(tradeId: string, afsender: AdresseInput): Promise<{ ok: true } | Fejl> {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  try {
    return await gemReturAfsenderForHandel(tradeId, u.id, afsender ?? {});
  } catch (err) {
    await logDriftFejl({ kilde: "action", sti: "fragt", hvor: "Returfragt: gem adresse", fejl: err, brugerId: u.id });
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
}

// Returlabel i en sag (køberen) EFTER betalt returfragt: ny/rettet adresse og
// nyt forsøg. Bag FRAGT_RETURLABEL_AKTIV.
export async function lavReturlabelAction(tradeId: string, afsender: AdresseInput) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await lavReturlabel(tradeId, u.id, afsender);
  genindlaes(tradeId);
  return r;
}
