import "server-only";

// Behandler ét dokument i fakturakøen mod Dinero - trin for trin, så et
// afbrudt forsøg altid kan fortsætte, hvor det slap (Dineros tilstand læses
// før hvert trin). Databasen og Dinero gives udefra (deps), så samme kode
// testes mod sandkassen (se docs/FAKTURA.md "Test").
//
// Faktura / kreditnota:
//   venter   -> (kontakt) -> kladde i Dinero med vores guid -> kontrol af
//               kontakt og beløb -> bogført            => bogfoert
//   bogfoert -> betalingen registreres (faktura: "Betalt via Stripe";
//               kreditnota: refusionen som negativ betaling på fakturaen,
//               som kreditnotaen automatisk er modregnet i) -> PDF gemt
//                                                       => faerdig
// Abonnement (finansbilag i kassekladden, Stripe-fakturaen som bilag):
//   venter   -> kladde med vores id -> sendt til bogføring => kladde
//   kladde   -> Dinero har bogført (asynkront)           => faerdig

import { DineroFejl, type DineroBilag, type DineroBilagModel, type DineroKlient, type DineroLinjeModel } from "./dinero";
import type { FakturaKonti } from "./konfig";

export type FakturaLinje = { kode: string; tekst: string; beloeb_oere: number };

export type FakturaRaekke = {
  id: string;
  dokument: "faktura" | "kreditnota" | "abonnement" | "abonnement_retur";
  part: "koeber" | "saelger" | "firma";
  bruger_id: string;
  betaling_id: string | null;
  trade_id: string | null;
  firma_regning_id: string | null;
  krediterer_id: string | null;
  linjer: FakturaLinje[];
  beloeb_oere: number;
  moms_oere: number;
  betalt_dato: string; // YYYY-MM-DD
  stripe_reference: string | null;
  status: "venter" | "kladde" | "bogfoert" | "faerdig" | "kraever_handling" | "haandteret_manuelt";
  dinero_org: string | null;
  dinero_kontakt_guid: string | null;
  dinero_nummer: number | null;
  dinero_fil_guid: string | null;
  laas_noegle: string | null;
};

export type Fremskridt = {
  status?: "kladde" | "bogfoert" | "faerdig";
  kontakt?: string;
  nummer?: number;
  moms?: number;
  pdfSti?: string;
  fil?: string;
  frigiv?: boolean;
  // Abonnements-modpostering: dato efter Stripes refusion (kun før afsendelse).
  betaltDato?: string;
};

export type FakturaKontekst = {
  // Kommentaren på fakturaen (titel, handels-id, betalingsdato).
  kommentar: string | null;
  // Adresse på fakturaen (firma; privat over 3.000 kr.). null = kontaktens.
  adresse: string | null;
};

export type ProcesDeps = {
  dinero: DineroKlient;
  konti: FakturaKonti;
  // Gem fremskridt under låsen. false = låsen er tabt -> stop.
  registrer: (f: Fremskridt) => Promise<boolean>;
  // Sikrer brugerens kontakt i Dinero og giver dens guid.
  sikrKontakt: (brugerId: string) => Promise<string>;
  kontekst: (r: FakturaRaekke) => Promise<FakturaKontekst>;
  // Gemmer PDF'en privat og giver stien (null = ikke gemt - hentes senere).
  gemPdf: (r: FakturaRaekke, pdf: Uint8Array) => Promise<string | null>;
  // Abonnement: Stripe-fakturaens PDF som bilag (null = ingen).
  hentStripePdf: (r: FakturaRaekke) => Promise<Uint8Array | null>;
  // Abonnement refunderet: hvor meget Stripe faktisk har refunderet (øre),
  // og hvornår (seneste refusion, ISO) - null, hvis ingen refusion.
  stripeRefusion: (r: FakturaRaekke) => Promise<{ oere: number; kl: string | null }>;
  // Gemmer refusionstidspunktet på regningen, hvis det mangler (bagud).
  gemKrediteretKl: (r: FakturaRaekke, kl: string) => Promise<void>;
};

export type ProcesResultat =
  | { kode: "faerdig" }
  | { kode: "venter"; besked: string }
  | { kode: "kraever_handling"; besked: string }
  | { kode: "laas_tabt" };

class LaasTabt extends Error {}

const kr = (oere: number) => Math.round(oere) / 100;

// ÅÅÅÅ-MM-DD i dansk tid.
export function danskDato(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}
const tilOere = (kroner: number) => Math.round(Number(kroner) * 100);

const ENHED: Record<string, string> = { fragt: "shipment" };

function dineroLinjer(r: FakturaRaekke, konti: FakturaKonti): DineroLinjeModel[] {
  return r.linjer.map((l) => ({
    Description: l.tekst,
    Quantity: 1,
    AccountNumber: l.kode === "fragt" ? konti.fragt : konti.salg,
    BaseAmountValue: kr(Number(l.beloeb_oere)),
    Discount: 0,
    Unit: ENHED[l.kode] ?? "parts",
    LineType: "Product",
  }));
}

export function sumOere(linjer: FakturaLinje[]): number {
  return linjer.reduce((s, l) => s + Number(l.beloeb_oere), 0);
}

// Kontrol af et Dinero-dokument mod vores række. null = passer.
function afvigelse(r: FakturaRaekke, d: DineroBilag, kontakt: string): string | null {
  if (d.DeletedAt) return "dokumentet er slettet i Dinero";
  if ((d.ContactGuid ?? "").toLowerCase() !== kontakt.toLowerCase()) return "kontakten passer ikke";
  if (tilOere(d.TotalInclVat) !== Number(r.beloeb_oere)) return "beløbet passer ikke";
  if (d.Currency && d.Currency !== "DKK") return "valutaen er ikke DKK";
  if ((d.ProductLines ?? []).length !== r.linjer.length) return "linjerne passer ikke";
  if (r.dokument === "kreditnota" && (d.CreditNoteFor ?? "").toLowerCase() !== String(r.krediterer_id).toLowerCase()) {
    return "kreditnotaen er ikke knyttet til fakturaen";
  }
  return null;
}

async function gem(deps: ProcesDeps, f: Fremskridt) {
  if (!(await deps.registrer(f))) throw new LaasTabt();
}

export async function behandlDokument(r: FakturaRaekke, deps: ProcesDeps): Promise<ProcesResultat> {
  try {
    if (r.dokument === "abonnement" || r.dokument === "abonnement_retur") return await behandlKladde(r, deps);
    return await behandlBilag(r, deps);
  } catch (err) {
    if (err instanceof LaasTabt) return { kode: "laas_tabt" };
    throw err;
  }
}

// ---------------------------------------------------------------- faktura / kreditnota

async function behandlBilag(r: FakturaRaekke, deps: ProcesDeps): Promise<ProcesResultat> {
  const { dinero } = deps;
  const kredit = r.dokument === "kreditnota";
  if (!(Number(r.beloeb_oere) > 0) || sumOere(r.linjer) !== Number(r.beloeb_oere)) {
    return { kode: "kraever_handling", besked: "Fakturaens linjer passer ikke med beløbet." };
  }
  if (kredit && !r.krediterer_id) return { kode: "kraever_handling", besked: "Kreditnotaen mangler fakturaen." };

  const hent = (guid: string) => (kredit ? dinero.hentKreditnota(guid) : dinero.hentFaktura(guid));
  let status = r.status;

  let kontakt = r.dinero_kontakt_guid;
  if (!kontakt) {
    kontakt = await deps.sikrKontakt(r.bruger_id);
    await gem(deps, { kontakt });
  }

  if (status === "venter") {
    let d = await hent(r.id);
    if (!d) {
      const k = await deps.kontekst(r);
      const model: DineroBilagModel = {
        ContactGuid: kontakt,
        ShowLinesInclVat: true,
        Currency: "DKK",
        Language: "da-DK",
        ExternalReference: `bidhamr-${r.dokument}-${r.id}`,
        Comment: k.kommentar,
        Date: r.betalt_dato,
        ...(k.adresse ? { Address: k.adresse } : {}),
        ProductLines: dineroLinjer(r, deps.konti),
      };
      if (kredit) {
        await dinero.opretKreditnota({ ...model, Guid: r.id, CreditNoteFor: String(r.krediterer_id) });
      } else {
        await dinero.opretFaktura({ ...model, Guid: r.id, PaymentConditionType: "Paid" });
      }
      d = await hent(r.id);
      if (!d) throw new DineroFejl("Dokumentet er oprettet, men kan ikke hentes endnu", { status: 404, forbigaaende: true });
    }
    const afv = afvigelse(r, d, kontakt);
    if (afv) {
      return {
        kode: "kraever_handling",
        besked: `Dinero-dokumentet passer ikke med fakturaen (${afv}) - kontrollér det i Dinero (${d.Status}).`,
      };
    }
    if (d.Status === "Draft") {
      try {
        d = kredit ? await dinero.bogfoerKreditnota(r.id, d.TimeStamp) : await dinero.bogfoerFaktura(r.id, d.TimeStamp);
      } catch (err) {
        // Fx bogført af et samtidigt forsøg: læs tilstanden igen.
        if (!(err instanceof DineroFejl) || err.status !== 400) throw err;
        const igen = await hent(r.id);
        if (!igen || igen.Status !== "Booked") throw err;
        d = igen;
      }
    }
    if (d.Status !== "Booked") {
      throw new DineroFejl(`Dokumentet er ikke bogført i Dinero (${d.Status})`, { status: 200, forbigaaende: true });
    }
    await gem(deps, { status: "bogfoert", nummer: Number(d.Number), moms: tilOere(d.TotalVat) });
    status = "bogfoert";
  }

  if (status !== "bogfoert") return { kode: "kraever_handling", besked: `Uventet status '${status}'.` };

  // Betalingen. Fakturaen: købers betaling (sælgergebyret er trukket i samme
  // betaling). Kreditnotaen er modregnet i fakturaen; refusionen registreres
  // som en negativ betaling på fakturaen, så den står som betalt (netto).
  const fakturaGuid = kredit ? String(r.krediterer_id) : r.id;
  const reference = `bidhamr-${kredit ? "refusion" : "betaling"}-${r.id}`;
  const betalinger = await dinero.hentFakturaBetalinger(fakturaGuid);
  if (!(betalinger.Payments ?? []).some((p) => p.ExternalReference === reference)) {
    const rest = tilOere(betalinger.RemainingAmount);
    const forventet = kredit ? -Number(r.beloeb_oere) : Number(r.beloeb_oere);
    if (rest !== forventet) {
      return {
        kode: "kraever_handling",
        besked: `Restbeløbet på fakturaen i Dinero (${kr(rest)} kr.) passer ikke med ${
          kredit ? "refusionen" : "betalingen"
        } (${kr(forventet)} kr.) - registrér betalingen manuelt i Dinero.`,
      };
    }
    const faktura = await dinero.hentFaktura(fakturaGuid);
    if (!faktura) throw new DineroFejl("Fakturaen kan ikke hentes", { status: 404, forbigaaende: true });
    await dinero.registrerFakturaBetaling(fakturaGuid, {
      Timestamp: faktura.TimeStamp,
      DepositAccountNumber: deps.konti.indbetaling,
      RemainderIsFee: false,
      ExternalReference: reference,
      PaymentDate: r.betalt_dato,
      Description: (kredit ? "Refunderet via Stripe" : "Betalt via Stripe") + (r.stripe_reference ? ` (${r.stripe_reference})` : ""),
      Amount: kr(forventet),
    });
  }

  // PDF'en gemmes privat, så brugeren kan hente den uden et kald til Dinero.
  // Fejler det, hentes den første gang, brugeren åbner den.
  let pdfSti: string | undefined;
  try {
    const pdf = kredit ? await dinero.hentKreditnotaPdf(r.id) : await dinero.hentFakturaPdf(r.id);
    if (pdf) pdfSti = (await deps.gemPdf(r, pdf)) ?? undefined;
  } catch (err) {
    console.error("Faktura-PDF kunne ikke gemmes nu (hentes senere):", r.id, err instanceof Error ? err.message : err);
  }
  await gem(deps, { status: "faerdig", ...(pdfSti ? { pdfSti } : {}) });
  return { kode: "faerdig" };
}

// ---------------------------------------------------------------- abonnement (kassekladde)

async function behandlKladde(r: FakturaRaekke, deps: ProcesDeps): Promise<ProcesResultat> {
  const { dinero } = deps;
  const retur = r.dokument === "abonnement_retur";
  const linje = r.linjer[0];
  if (r.linjer.length !== 1 || !linje || Number(linje.beloeb_oere) !== Number(r.beloeb_oere) || !(Number(r.beloeb_oere) > 0)) {
    return { kode: "kraever_handling", besked: "Abonnementsbilaget har ikke præcis én linje med beløbet." };
  }

  let st = await dinero.kladdeStatus(r.id);
  let dato = r.betalt_dato;
  if (!st && retur) {
    // Kun en fuld refusion bogføres automatisk (M5). Delvis -> staff.
    const ref = await deps.stripeRefusion(r);
    if (ref.oere !== Number(r.beloeb_oere) || !ref.kl) {
      return {
        kode: "kraever_handling",
        besked: `Stripe har refunderet ${kr(ref.oere)} kr. af abonnementsfakturaen (${kr(Number(r.beloeb_oere))} kr.) - bogfør refusionen manuelt i Dinero.`,
      };
    }
    // Modposteringen dateres refusionsdagen hos Stripe (dansk tid) - også for
    // regninger krediteret før krediteret_kl fandtes.
    await deps.gemKrediteretKl(r, ref.kl);
    // Datoen rettes kun på et ikke-bogført bilag i 'venter' (databasen);
    // ellers bruges den gemte, så Dinero og databasen altid er enige.
    if (r.status === "venter" && r.dinero_nummer === null) {
      dato = danskDato(ref.kl);
      if (dato !== r.betalt_dato) await gem(deps, { betaltDato: dato });
    }
  }
  if (!st) {
    if (r.status !== "venter") {
      return { kode: "kraever_handling", besked: "Bilaget er sendt til Dinero, men findes ikke i kassekladden - kontrollér i Dinero." };
    }
    let fil = r.dinero_fil_guid;
    if (!fil && !retur) {
      const pdf = await deps.hentStripePdf(r);
      if (pdf) {
        fil = await dinero.uploadPdf(`stripe-${(r.stripe_reference ?? r.id).replace(/[^A-Za-z0-9_-]/g, "")}.pdf`, pdf);
        await gem(deps, { fil });
      }
    }
    await dinero.opretKladde({
      Id: r.id,
      VoucherDate: dato,
      FileGuid: fil ?? null,
      Lines: [
        {
          Description: (retur ? "Refunderet: " : "") + linje.tekst,
          // Indbetaling (debet) mod salg m/moms (kredit). Negativt = refusion.
          Amount: kr(retur ? -Number(r.beloeb_oere) : Number(r.beloeb_oere)),
          AccountNumber: deps.konti.indbetaling,
          BalancingAccountNumber: deps.konti.salg,
        },
      ],
    });
    st = await dinero.kladdeStatus(r.id);
    if (!st) throw new DineroFejl("Bilaget er oprettet, men kan ikke findes endnu", { status: 404, forbigaaende: true });
  }

  if (st.Status === "Booked") {
    await gem(deps, { status: "faerdig", ...(st.VoucherNumber ? { nummer: Number(st.VoucherNumber) } : {}) });
    return { kode: "faerdig" };
  }
  if (st.Status === "Draft") {
    if (!st.Version) throw new DineroFejl("Bilaget mangler version i Dinero", { status: 200, forbigaaende: true });
    await dinero.bogfoerKladde(r.id, st.Version);
  }
  // Dinero bogfører asynkront - næste kørsel ser efter.
  await gem(deps, { ...(r.status === "venter" ? { status: "kladde" as const } : {}), frigiv: true });
  return { kode: "venter", besked: "Venter på Dineros bogføring" };
}
