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
} from "@/lib/fragt/handlinger";

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

export async function soegPakkeshopsAction(q: {
  postnummer: string;
  adresse?: string | null;
  by?: string | null;
  antal?: number;
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
export async function lavFragtlabel(
  tradeId: string,
  afsender?: AdresseInput | string | null,
): Promise<{ ok: true } | Fejl> {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await bookPakke(tradeId, u.id, typeof afsender === "object" ? afsender : null);
  genindlaes(tradeId);
  return "fejl" in r ? { fejl: r.fejl } : { ok: true };
}

export async function annullerFragtlabel(tradeId: string, forsendelseId: string): Promise<{ ok: true } | Fejl> {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await annullerPakke(tradeId, forsendelseId, u.id);
  genindlaes(tradeId);
  return r;
}

// Kortlivet link (5 min) til label-PDF'en.
export async function hentFragtlabelLink(forsendelseId: string): Promise<{ url: string } | Fejl> {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  const r = await hentLabelLink(forsendelseId, u.id);
  return "fejl" in r ? r : { url: r.url };
}

// Returlabel i en sag (køberen). Slået fra, indtil opkrævningen af
// returfragten er bygget (FRAGT_RETURLABEL_AKTIV).
export async function lavReturlabelAction(tradeId: string, afsender: AdresseInput) {
  const u = await bruger();
  if (!u) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["fragt_handling_bruger", u.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  const r = await lavReturlabel(tradeId, u.id, afsender);
  genindlaes(tradeId);
  return r;
}
