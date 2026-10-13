import "server-only";

// Vælger fragtfirma. Handelsflowet kalder KUN hentFragtfirma()/adapterFor()
// og typerne i types.ts - aldrig GLS/Shipmondo/DAO direkte.
//
// Env FRAGTFIRMA = test | gls | shipmondo | dao.
//   - Tom i udvikling (NODE_ENV !== "production"): testfragtfirmaet (også på
//     testdatabasen) - så handelsflowet kan testes uden DAO-nøgler.
//   - Tom i produktion: "ikke sat op" - alle kald fejler pænt med
//     "Fragt er ikke sat op endnu." (ingen falske labels).
//   - "test" i produktion: kun hvis det er sat eksplicit.
//   - "dao": DAO direkte (dao.ts). Kræver DAO_KUNDEID og DAO_KODE - mangler de,
//     fejler kaldene pænt med "Fragt er ikke sat op endnu.".
// Shipmondo-adapteren bliver liggende (fx til flere fragtfirmaer senere), og
// forsendelser, der er oprettet hos et andet firma, følges stadig af det firmas
// adapter (adapterFor).
import { daoFirma } from "@/lib/fragt/dao";
import { glsFirma } from "@/lib/fragt/gls";
import { shipmondoFirma } from "@/lib/fragt/shipmondo";
import { testFirma } from "@/lib/fragt/testFirma";
import {
  type Fragtfirma,
  type FragtfirmaNavn,
  FRAGTFIRMAER,
  FragtFejl,
  FRAGT_IKKE_SAT_OP,
} from "@/lib/fragt/types";

export * from "@/lib/fragt/types";

function valgtNavn(): string {
  return (process.env.FRAGTFIRMA ?? "").trim().toLowerCase();
}

// Testfragtfirmaet må kun bruges uden for produktion, eller når
// FRAGTFIRMA=test er sat eksplicit.
export function testErTilladt(): boolean {
  return process.env.NODE_ENV !== "production" || valgtNavn() === "test";
}

// Labels på handelssiden er bag et flag, indtil fragt er klar.
export function fragtLabelsAktiv(): boolean {
  return process.env.FRAGT_LABELS_AKTIV === "true";
}

// Returlabel i sager (køber -> pakkeshop nær sælgeren): køberen betaler selv
// returfragten først (src/lib/betaling/returfragt.ts, ROADMAP-BESLUTNINGER,
// Sager). Slået fra, indtil Filip slår den til. Tjekkes også i
// opretReturForsendelse (server.ts) og startReturfragtBetaling.
export function fragtReturlabelAktiv(): boolean {
  return process.env.FRAGT_RETURLABEL_AKTIV === "true";
}

function ikkeSatOp(): never {
  throw new FragtFejl(FRAGT_IKKE_SAT_OP);
}

const ikkeSatOpFirma: Fragtfirma = {
  // navn bruges ikke til noget, når firmaet ikke er sat op.
  navn: "test",
  visningsnavn: "Ikke sat op",
  async beregnPris() {
    return ikkeSatOp();
  },
  async opretForsendelse() {
    return ikkeSatOp();
  },
  async opretReturforsendelse() {
    return ikkeSatOp();
  },
  async annullerForsendelse() {
    return ikkeSatOp();
  },
  async hentSporing() {
    return ikkeSatOp();
  },
  async fortolkWebhook() {
    return { ok: false, status: 404, fejl: "Fragt er ikke sat op" };
  },
  async soegPakkeshops() {
    return ikkeSatOp();
  },
  async hentPakkeshop() {
    return ikkeSatOp();
  },
};

// Adapteren for et bestemt firma (fx til webhooks og sporing af forsendelser,
// der blev oprettet hos et firma, før FRAGTFIRMA blev skiftet). null, hvis
// firmaet er ukendt, eller det er testfirmaet, og test ikke er tilladt.
export function adapterFor(navn: string): Fragtfirma | null {
  switch (navn) {
    case "test":
      return testErTilladt() ? testFirma : null;
    case "gls":
      return glsFirma;
    case "shipmondo":
      return shipmondoFirma;
    case "dao":
      return daoFirma;
    default:
      return null;
  }
}

export function erFragtfirmaNavn(v: unknown): v is FragtfirmaNavn {
  return typeof v === "string" && (FRAGTFIRMAER as readonly string[]).includes(v);
}

// Er der valgt et fragtfirma, der kan bruges?
export function fragtErSatOp(): boolean {
  const navn = valgtNavn();
  if (navn === "") return process.env.NODE_ENV !== "production";
  return erFragtfirmaNavn(navn);
}

// Det aktive fragtfirma til nye forsendelser.
export function hentFragtfirma(): Fragtfirma {
  const navn = valgtNavn();
  if (navn === "") {
    return process.env.NODE_ENV !== "production" ? testFirma : ikkeSatOpFirma;
  }
  if (!erFragtfirmaNavn(navn)) {
    console.error("FRAGTFIRMA har en ukendt værdi:", navn);
    return ikkeSatOpFirma;
  }
  return adapterFor(navn) ?? ikkeSatOpFirma;
}
