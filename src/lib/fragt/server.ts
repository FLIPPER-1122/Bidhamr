import "server-only";

// Fragt på serveren: oprettelse/annullering af labels, registrering af
// sporingshændelser og sporings-cron. Bruger service-role (createAdminClient)
// - kaldere SKAL selv have verificeret brugeren med auth først.
//
// Hændelser -> handelsflow (ROADMAP-BESLUTNINGER, "Pakken er kommet frem" og
// "48-timers uret"):
//   afleveret  Handlen flyttes IKKE til 'pakke_sendt' automatisk:
//              pakkebillederne er stadig krævet fra sælgeren, og
//              trade_marker_sendt kræver auth.uid() = sælgeren. Står handlen
//              stadig i 'betaling_modtaget', får sælgeren en påmindelse om at
//              markere pakken sendt med billeder, og forsendelsen markeres
//              til staff (kraever_opmaerksomhed) med afsendelsesfristens dato.
//              Fristen ændres ikke.
//   leveret    Køberen får "Pakken er kommet frem" (pakke_leveret, idempotent
//              nøgle). Ingen penge frigives, og 48-timers uret startes IKKE -
//              det gør stadig køberens "modtaget" / den eksisterende
//              automatiske frigivelse, indtil Filip beslutter andet.
//   returneret Markeres til staff (kraever_opmaerksomhed, sat i SQL).
//   fejl       Markeres til staff.
// Ingen pengeflytning her.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { adapterFor, fragtErSatOp, hentFragtfirma } from "@/lib/fragt";
import { sendSenest, sendSenestTekst } from "@/lib/afsendelsesfrist";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { annullerPaymentIntentForLevering } from "@/lib/betaling/stripeBetaling";
import {
  type Adresse,
  type ForsendelseInput,
  type Fragtfirma,
  type Label,
  type Leveringsmaade,
  type Pakkeshop,
  type Pakkestoerrelse,
  type Sporingshaendelse,
  FragtAnnulleringIkkeMulig,
  FragtFejl,
  FRAGT_IKKE_SAT_OP,
  erLeveringsmaade,
  erSporingsType,
} from "@/lib/fragt/types";

export const FRAGT_LABEL_BUCKET = "fragt-labels";
const LABEL_MAKS_BYTES = 5 * 1024 * 1024;

type Admin = ReturnType<typeof createAdminClient>;

export type HaendelseKilde = "webhook" | "sporing" | "test";

const GENERISK_FEJL = "Noget gik galt. Prøv igen om lidt.";

const CLAIM_FEJL: Record<string, string> = {
  ikke_fundet: "Handlen findes ikke.",
  afhentning: "Handlen er en afhentning - der skal ikke laves fragtlabel.",
  forkert_status: "Der kan kun laves fragtlabel, når køberen har betalt, og pakken ikke er sendt.",
  ingen_retur: "Der er ingen sag, hvor varen skal sendes retur.",
  i_gang: "Fragtlabelen er ved at blive lavet. Vent et øjeblik, og opdatér siden.",
  mangler_levering: "Køberen har ikke valgt levering endnu.",
  ugyldig: "Ugyldigt valg.",
};

function brugerFejl(err: unknown): string {
  return err instanceof FragtFejl ? err.brugerbesked : GENERISK_FEJL;
}

async function medTimeout<T>(p: Promise<T>, ms: number, hvad: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, afvis) => {
        timer = setTimeout(() => afvis(new Error(`${hvad}: timeout efter ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function labelBytes(label: Label): Promise<Uint8Array> {
  if (label.type === "pdf") return label.data;
  // Fragtfirmaets link kan udløbe - hent og gem i vores egen bucket.
  if (!label.url.startsWith("https://")) throw new Error("Label-URL er ikke https");
  const svar = await fetch(label.url, { signal: AbortSignal.timeout(15_000) });
  if (!svar.ok) throw new Error(`Label kunne ikke hentes (${svar.status})`);
  const buf = new Uint8Array(await svar.arrayBuffer());
  if (buf.byteLength > LABEL_MAKS_BYTES) throw new Error("Labelen er for stor");
  return buf;
}

// ------------------------------------------------------------ adresser

export type AdresseInput = {
  navn?: unknown;
  adresse?: unknown;
  postnummer?: unknown;
  by?: unknown;
  telefon?: unknown;
};

function tekst(v: unknown, maks: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, maks) : "";
}

// Dansk telefonnummer: 8 cifre (evt. +45) eller internationalt med +.
export function renTelefon(v: unknown): string | null {
  const t = typeof v === "string" ? v.replace(/[\s().-]/g, "") : "";
  if (/^\d{8}$/.test(t)) return `+45${t}`;
  if (/^(\+|00)\d{8,14}$/.test(t)) return t.startsWith("00") ? `+${t.slice(2)}` : t;
  return null;
}

// Validerer en adresse fra brugeren. kraevAdresse: gade, postnummer og by
// er krævet (levering til døren, afsender, retur). Byen hentes fra
// postnummeret, hvis den mangler.
export function valideerAdresse(
  a: AdresseInput | null | undefined,
  opts: { kraevAdresse: boolean; kraevTelefon: boolean },
): { ok: true; adresse: Adresse } | { fejl: string } {
  const navn = tekst(a?.navn, 100);
  if (navn.length < 2) return { fejl: "Skriv dit fulde navn." };
  const telefon = renTelefon(a?.telefon);
  if (opts.kraevTelefon && !telefon) return { fejl: "Skriv et gyldigt telefonnummer (8 cifre)." };
  const adresse = tekst(a?.adresse, 200);
  const postnummer = tekst(a?.postnummer, 10);
  let by = tekst(a?.by, 80);
  if (opts.kraevAdresse || adresse || postnummer) {
    if (adresse.length < 3) return { fejl: "Skriv vejnavn og husnummer." };
    const opslag = slaaPostnummerOp(postnummer);
    if (!opslag) return { fejl: "Skriv et gyldigt dansk postnummer." };
    by = by || opslag.by;
  }
  return {
    ok: true,
    adresse: {
      navn,
      adresse: adresse || null,
      postnummer: postnummer || null,
      by: by || null,
      telefon,
      land: "DK",
    },
  };
}

async function brugerEmail(admin: Admin, brugerId: string): Promise<string | null> {
  const { data } = await admin.from("users").select("email").eq("id", brugerId).maybeSingle<{ email: string | null }>();
  return data?.email ?? null;
}

// ------------------------------------------------------------ priser

export type Fragtpris = {
  kode: Pakkestoerrelse;
  navn: string;
  maksGram: number;
  pakkeshopOere: number;
  doerOere: number | null;
};

// Pakkestørrelser og købers priser fra databasen (fragt_pakkestoerrelser -
// det ene sted, priserne står). Offentlige data.
export async function hentFragtpriser(): Promise<Fragtpris[]> {
  const { data, error } = await createAdminClient()
    .from("fragt_pakkestoerrelser")
    .select("kode, navn, maks_gram, pakkeshop_oere, doer_oere, sortering")
    .order("sortering", { ascending: true });
  if (error) throw new Error(`fragt_pakkestoerrelser: ${error.message}`);
  return (data ?? []).map((r) => ({
    kode: r.kode as Pakkestoerrelse,
    navn: r.navn as string,
    maksGram: Number(r.maks_gram),
    pakkeshopOere: Number(r.pakkeshop_oere),
    doerOere: r.doer_oere === null ? null : Number(r.doer_oere),
  }));
}

// ------------------------------------------------------------ pakkeshops

// Pakkeshops nær et postnummer/en adresse hos det aktive fragtfirma.
// Kaldere skal have tjekket login og rate limit.
export async function soegPakkeshops(
  q: { postnummer?: unknown; adresse?: unknown; by?: unknown; antal?: unknown },
): Promise<{ ok: true; fragtfirma: string; pakkeshops: Pakkeshop[] } | { fejl: string }> {
  if (!fragtErSatOp()) return { fejl: FRAGT_IKKE_SAT_OP };
  const postnummer = tekst(q.postnummer, 10);
  if (!slaaPostnummerOp(postnummer)) return { fejl: "Skriv et gyldigt dansk postnummer." };
  const antal = typeof q.antal === "number" && Number.isInteger(q.antal) ? Math.min(Math.max(q.antal, 1), 20) : 10;
  const firma = hentFragtfirma();
  try {
    const pakkeshops = await medTimeout(
      firma.soegPakkeshops({
        postnummer,
        adresse: tekst(q.adresse, 100) || null,
        by: tekst(q.by, 60) || null,
        antal,
      }),
      15_000,
      "soegPakkeshops",
    );
    return { ok: true, fragtfirma: firma.navn, pakkeshops: pakkeshops.slice(0, antal) };
  } catch (err) {
    if (!(err instanceof FragtFejl)) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: søg pakkeshops", fejl: err });
    }
    return { fejl: err instanceof FragtFejl ? err.brugerbesked : "Pakkeshops kunne ikke hentes. Prøv igen om lidt." };
  }
}

// ------------------------------------------------------------ leveringsvalg (checkout)

export type LeveringsvalgInput = {
  maade?: unknown;
  // Valgt pakkeshop: id + postnummer (bruges til at slå shoppen op igen hos
  // fragtfirmaet - navn og adresse tages derfra, aldrig fra klienten).
  pakkeshopId?: unknown;
  pakkeshopPostnummer?: unknown;
  // Kun søgehjælp (i tætte byer ligger der over 20 shops i ét postnummer).
  pakkeshopAdresse?: unknown;
  modtager?: AdresseInput | null;
  gemForslag?: unknown;
};

const LEVERING_FEJL: Record<string, string> = {
  ikke_fundet: "Handlen findes ikke.",
  afhentning: "Handlen er en afhentning hos sælgeren - der skal ikke vælges levering.",
  forkert_status: "Leveringen kan ikke ændres længere.",
  laast: "Sælgeren har allerede lavet fragtlabelen, så leveringen kan ikke ændres.",
  ikke_mulig: "Levering til døren er ikke muligt for denne pakkestørrelse. Vælg en pakkeshop.",
  pris_laast: "Du har allerede betalt. Du kan skifte pakkeshop, men ikke leveringsmåde.",
  ugyldig: "Ugyldigt valg.",
};

// Gemmer købers leveringsvalg (checkout før betalingen) og retter
// betalingens fragt. koeberId SKAL være verificeret med auth af kalderen;
// databasen tjekker igen under lås (handel_gem_levering). Ændres beløbet, og
// findes der en PaymentIntent, annulleres den hos Stripe først og nulstilles
// (pi_forsoeg + 1) - næste "Betal" laver en ny med det nye beløb.
export async function gemLeveringsvalg(
  tradeId: string,
  koeberId: string,
  input: LeveringsvalgInput,
): Promise<
  | { ok: true; fragtOere: number; totalOere: number; prisAendret: boolean }
  | { fejl: string }
> {
  if (!fragtErSatOp()) return { fejl: FRAGT_IKKE_SAT_OP };
  if (!erLeveringsmaade(input.maade)) return { fejl: "Vælg pakkeshop eller levering til døren." };
  const maade = input.maade;
  const mod = valideerAdresse(input.modtager, { kraevAdresse: maade === "doer", kraevTelefon: true });
  if ("fejl" in mod) return mod;

  const admin = createAdminClient();
  const firma = hentFragtfirma();

  let pakkeshop: Pakkeshop | null = null;
  if (maade === "pakkeshop") {
    const id = tekst(input.pakkeshopId, 50);
    const postnummer = tekst(input.pakkeshopPostnummer, 10);
    if (!id || !slaaPostnummerOp(postnummer)) return { fejl: "Vælg en pakkeshop." };
    try {
      pakkeshop = await medTimeout(firma.hentPakkeshop(id, { postnummer, adresse: tekst(input.pakkeshopAdresse, 100) || null, antal: 20 }), 15_000, "hentPakkeshop");
    } catch (err) {
      if (!(err instanceof FragtFejl)) await logDriftFejl({ kilde: "server", hvor: "Fragt: hent pakkeshop", fejl: err });
      return { fejl: brugerFejl(err) };
    }
    if (!pakkeshop) return { fejl: "Pakkeshoppen findes ikke længere. Vælg en anden." };
  }

  const valg = {
    maade,
    fragtfirma: firma.navn,
    pakkeshop: pakkeshop
      ? {
          id: pakkeshop.id,
          navn: pakkeshop.navn,
          adresse: pakkeshop.adresse,
          postnummer: /^\d{4}$/.test(pakkeshop.postnummer) ? pakkeshop.postnummer : null,
          by: pakkeshop.by,
          lat: pakkeshop.lat,
          lng: pakkeshop.lng,
        }
      : null,
    modtager: {
      navn: mod.adresse.navn,
      adresse: mod.adresse.adresse,
      postnummer: mod.adresse.postnummer,
      by: mod.adresse.by,
      telefon: mod.adresse.telefon,
      email: await brugerEmail(admin, koeberId),
    },
    gem_forslag: input.gemForslag !== false,
  };

  const kald = (pi: string | null) =>
    admin.rpc("handel_gem_levering", {
      p_trade: tradeId,
      p_bruger: koeberId,
      p_valg: valg,
      p_annulleret_pi: pi,
    });

  try {
    let { data, error } = await kald(null);
    if (error) throw new Error(`handel_gem_levering: ${error.message}`);
    let svar = data as { kode?: string; pi?: string; fragt_oere?: number; total_oere?: number; pris_aendret?: boolean };
    if (svar?.kode === "pi_skal_annulleres" && svar.pi) {
      // Beløbet ændres: den gamle PaymentIntent må aldrig kunne betales.
      const r = await annullerPaymentIntentForLevering(svar.pi);
      if (r === "betalt") {
        return { fejl: "Betalingen er allerede gennemført, så leveringsmåden kan ikke ændres. Genindlæs siden." };
      }
      ({ data, error } = await kald(svar.pi));
      if (error) throw new Error(`handel_gem_levering: ${error.message}`);
      svar = data as typeof svar;
    }
    if (svar?.kode !== "ok") {
      return { fejl: LEVERING_FEJL[svar?.kode ?? ""] ?? GENERISK_FEJL };
    }
    return {
      ok: true,
      fragtOere: Number(svar.fragt_oere),
      totalOere: Number(svar.total_oere),
      prisAendret: Boolean(svar.pris_aendret),
    };
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: gem leveringsvalg", fejl: err, brugerId: koeberId });
    return { fejl: GENERISK_FEJL };
  }
}

type LeveringRaekke = {
  maade: Leveringsmaade;
  fragtfirma: string;
  pakkeshop_id: string | null;
  modtager_navn: string;
  modtager_adresse: string | null;
  modtager_postnummer: string | null;
  modtager_by: string | null;
  modtager_telefon: string;
  modtager_email: string | null;
  pakkeshop_navn: string | null;
  pakkeshop_adresse: string | null;
  pakkeshop_postnummer: string | null;
  pakkeshop_by: string | null;
};

async function hentLevering(admin: Admin, tradeId: string): Promise<LeveringRaekke | null> {
  const { data, error } = await admin
    .from("handel_levering")
    .select(
      "maade, fragtfirma, pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by, " +
        "modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email",
    )
    .eq("trade_id", tradeId)
    .maybeSingle<LeveringRaekke>();
  if (error) throw new Error(`handel_levering: ${error.message}`);
  return data;
}

// Modtageradressen på labelen. Ved pakkeshop uden hjemmeadresse bruges
// pakkeshoppens adresse (Shipmondo kræver en adresse; pakken går til shoppen).
function modtagerFraLevering(l: LeveringRaekke): Adresse {
  const harAdresse = Boolean(l.modtager_adresse && l.modtager_postnummer && l.modtager_by);
  return {
    navn: l.modtager_navn,
    adresse: harAdresse ? l.modtager_adresse : l.pakkeshop_adresse,
    postnummer: harAdresse ? l.modtager_postnummer : l.pakkeshop_postnummer,
    by: harAdresse ? l.modtager_by : l.pakkeshop_by,
    telefon: l.modtager_telefon,
    email: l.modtager_email,
    land: "DK",
  };
}

// ------------------------------------------------------------ oprettelse

const MAKS_GRAM_STANDARD: Record<Pakkestoerrelse, number> = { lille: 1000, mellem: 5000, stor: 15000 };

type ClaimSvar = { kode?: string; id?: string; pakkestoerrelse?: Pakkestoerrelse; levering?: string };

// Fælles: claim -> fragtfirma -> gem label -> gem detaljer. Annullerer hos
// fragtfirmaet, hvis noget fejler efter oprettelsen.
async function opretForsendelse(
  admin: Admin,
  args: {
    tradeId: string;
    brugerId: string;
    type: "udgaaende" | "retur";
    firma: Fragtfirma;
    byg: (claim: Required<Pick<ClaimSvar, "id" | "pakkestoerrelse">>) => Promise<ForsendelseInput>;
  },
): Promise<{ ok: true; forsendelseId: string } | { fejl: string }> {
  const { tradeId, brugerId, type, firma } = args;
  const { data: claim, error: claimFejl } = await admin.rpc("forsendelse_claim", {
    p_trade: tradeId,
    p_bruger: brugerId,
    p_type: type,
    p_fragtfirma: firma.navn,
    p_pakkestoerrelse: null,
  });
  if (claimFejl) {
    console.error("forsendelse_claim fejlede:", claimFejl.message);
    return { fejl: GENERISK_FEJL };
  }
  const svar = claim as ClaimSvar | null;
  if (svar?.kode === "findes" && svar.id) return { ok: true, forsendelseId: svar.id };
  if (svar?.kode !== "ok" || !svar.id || !svar.pakkestoerrelse) {
    return { fejl: CLAIM_FEJL[svar?.kode ?? ""] ?? GENERISK_FEJL };
  }
  const id = svar.id;

  let oprettetHosFirma: string | null = null;
  try {
    const input = await args.byg({ id, pakkestoerrelse: svar.pakkestoerrelse });
    const oprettet = await medTimeout(
      type === "retur" ? firma.opretReturforsendelse(input) : firma.opretForsendelse(input),
      30_000,
      type === "retur" ? "opretReturforsendelse" : "opretForsendelse",
    );
    oprettetHosFirma = oprettet.forsendelsesId;

    const bytes = await labelBytes(oprettet.label);
    const sti = `${tradeId}/${id}.pdf`;
    const { error: upFejl } = await admin.storage
      .from(FRAGT_LABEL_BUCKET)
      .upload(sti, bytes, { contentType: "application/pdf", upsert: false });
    if (upFejl && !/exists|duplicate/i.test(upFejl.message)) {
      throw new Error(`Label kunne ikke gemmes: ${upFejl.message}`);
    }

    const { error: detFejl } = await admin.rpc("forsendelse_gem_detaljer", {
      p_id: id,
      p_produkt: oprettet.produkt ?? null,
      p_vaegt_gram: input.vaegtGram ?? null,
      p_labelfri: Boolean(oprettet.qrKode),
      p_pakkeshop_id: input.pakkeshopId ?? null,
      p_afsender: input.afsender,
      p_modtager: input.modtager,
    });
    if (detFejl) throw new Error(`forsendelse_gem_detaljer: ${detFejl.message}`);

    const { data: gemt, error: gemFejl } = await admin.rpc("forsendelse_gem_oprettet", {
      p_id: id,
      p_forsendelses_id: oprettet.forsendelsesId,
      p_sporingsnummer: oprettet.sporingsnummer,
      p_label_sti: sti,
      p_qr_kode: oprettet.qrKode ?? null,
      p_pris_oere: oprettet.prisOere ?? null,
    });
    if (gemFejl) throw new Error(`forsendelse_gem_oprettet: ${gemFejl.message}`);
    if (!gemt) throw new Error("Forsendelsen var ikke længere claimet");
  } catch (err) {
    console.error("Fragtlabel kunne ikke laves:", err);
    await admin.rpc("forsendelse_marker_fejlet", { p_id: id, p_fejl: renFejltekst(err, 500) });
    // Blev forsendelsen oprettet hos fragtfirmaet, så annullér den igen,
    // så der ikke ligger en betalt label, som ingen kan se.
    if (oprettetHosFirma) {
      try {
        await firma.annullerForsendelse(oprettetHosFirma);
      } catch (annErr) {
        await logDriftFejl({
          kilde: "server",
          hvor: "Fragt: annullér efter fejl",
          fejl: `Forsendelse ${oprettetHosFirma} hos ${firma.navn} (BidHamr ${id}) kunne ikke annulleres - kreditér den hos fragtfirmaet: ${renFejltekst(annErr, 200)}`,
        });
      }
    }
    if (!(err instanceof FragtFejl)) {
      // Ukendt udfald (fx timeout): fragtfirmaet kan have oprettet
      // forsendelsen alligevel. Referencen er BidHamrs forsendelses-id.
      await logDriftFejl({
        kilde: "server",
        hvor: "Fragt: opret label",
        fejl: `${renFejltekst(err, 300)} - tjek hos ${firma.visningsnavn}, om der findes en forsendelse med reference ${id}${oprettetHosFirma ? ` (id ${oprettetHosFirma})` : ""}.`,
      });
    }
    return { fejl: brugerFejl(err) };
  }

  // Første hændelse (oprettet) - giver en tidslinje fra start. Labelen er
  // gemt, så en fejl her må ikke annullere den.
  try {
    await registrerForsendelseshaendelse(id, {
      type: "oprettet",
      tidspunkt: new Date().toISOString(),
      noegle: "bidhamr:oprettet",
      beskrivelse: type === "retur" ? "Returlabel oprettet" : "Fragtlabel oprettet",
    }, "sporing");
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: oprettet-hændelse", fejl: err });
  }
  return { ok: true, forsendelseId: id };
}

async function vaegtOgTitel(admin: Admin, tradeId: string) {
  const { data: handel } = await admin
    .from("trades")
    .select("id, auction_id, buyer_id, seller_id")
    .eq("id", tradeId)
    .single<{ id: string; auction_id: string; buyer_id: string; seller_id: string }>();
  if (!handel) throw new Error("Handlen findes ikke");
  const { data: auktion } = await admin
    .from("auctions")
    .select("titel, vaegt_gram")
    .eq("id", handel.auction_id)
    .maybeSingle<{ titel: string | null; vaegt_gram: number | null }>();
  return { handel, titel: auktion?.titel ?? "Vare fra BidHamr", vaegtGram: auktion?.vaegt_gram ?? null };
}

// Laver den udgående fragtlabel ("Send pakke"). saelgerId SKAL være
// verificeret med auth af kalderen; SQL'en tjekker igen under lås, at han er
// sælger, at handlen er en betalt forsendelseshandel med købers
// leveringsvalg, og at der ikke allerede er en aktiv label (dobbeltklik giver
// samme label). Pakkestørrelsen er auktionens; fragtfirmaet er det, køberen
// valgte pakkeshop hos.
export async function opretUdgaaendeForsendelse(
  tradeId: string,
  saelgerId: string,
  afsenderInput: AdresseInput,
): Promise<{ ok: true; forsendelseId: string } | { fejl: string }> {
  const afs = valideerAdresse(afsenderInput, { kraevAdresse: true, kraevTelefon: false });
  if ("fejl" in afs) return afs;
  const admin = createAdminClient();

  let levering: LeveringRaekke | null;
  try {
    levering = await hentLevering(admin, tradeId);
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: hent leveringsvalg", fejl: err });
    return { fejl: GENERISK_FEJL };
  }
  if (!levering) return { fejl: CLAIM_FEJL.mangler_levering };
  const lev = levering;
  const firma = adapterFor(levering.fragtfirma);
  if (!firma) return { fejl: FRAGT_IKKE_SAT_OP };
  const afsender: Adresse = { ...afs.adresse, email: await brugerEmail(admin, saelgerId) };

  const svar = await opretForsendelse(admin, {
    tradeId,
    brugerId: saelgerId,
    type: "udgaaende",
    firma,
    byg: async ({ id, pakkestoerrelse }) => {
      const { titel, vaegtGram } = await vaegtOgTitel(admin, tradeId);
      return {
        reference: id,
        handel: { id: tradeId, titel },
        afsender,
        modtager: modtagerFraLevering(lev),
        pakkestoerrelse,
        levering: lev.maade,
        pakkeshopId: lev.maade === "pakkeshop" ? lev.pakkeshop_id : null,
        vaegtGram: vaegtGram ?? MAKS_GRAM_STANDARD[pakkestoerrelse],
      };
    },
  });
  if ("ok" in svar) {
    // Forslag til næste gang (ikke kritisk).
    await admin.rpc("leveringsforslag_gem_afsender", { p_bruger: saelgerId, p_afsender: afs.adresse });
  }
  return svar;
}

// Returlabel i en sag (afgjort med retur): køberen sender varen tilbage til
// sælgeren via en pakkeshop tæt på sælgerens adresse (fragtfirmaet vælger
// den). koeberId SKAL være verificeret med auth; SQL'en kræver en sag i
// 'afventer_retur' med retur_kraeves. Sælgerens adresse tages fra den
// udgående label. Bag flaget FRAGT_RETURLABEL_AKTIV, fordi opkrævningen af
// returfragten hos køberen (ROADMAP-BESLUTNINGER, Sager: "køberen betaler selv
// returfragten") ikke er bygget endnu.
export async function opretReturForsendelse(
  tradeId: string,
  koeberId: string,
  afsenderInput: AdresseInput,
): Promise<{ ok: true; forsendelseId: string } | { fejl: string }> {
  if (process.env.FRAGT_RETURLABEL_AKTIV !== "true") {
    return { fejl: "Returlabel via BidHamr er ikke slået til endnu. Skriv til BidHamr i sagen." };
  }
  const afs = valideerAdresse(afsenderInput, { kraevAdresse: true, kraevTelefon: true });
  if ("fejl" in afs) return afs;
  const admin = createAdminClient();

  const { data: ud } = await admin
    .from("forsendelser")
    .select("fragtfirma, afsender, pakkestoerrelse")
    .eq("trade_id", tradeId)
    .eq("type", "udgaaende")
    .not("afsender", "is", null)
    .order("oprettet_kl", { ascending: false })
    .limit(1)
    .maybeSingle<{ fragtfirma: string; afsender: Adresse | null; pakkestoerrelse: Pakkestoerrelse }>();
  if (!ud?.afsender) {
    return { fejl: "Sælgerens adresse mangler, så returlabelen kan ikke laves. Skriv til BidHamr i sagen." };
  }
  const firma = adapterFor(ud.fragtfirma);
  if (!firma) return { fejl: FRAGT_IKKE_SAT_OP };
  const afsender: Adresse = { ...afs.adresse, email: await brugerEmail(admin, koeberId) };

  return opretForsendelse(admin, {
    tradeId,
    brugerId: koeberId,
    type: "retur",
    firma,
    byg: async ({ id, pakkestoerrelse }) => {
      const { titel, vaegtGram } = await vaegtOgTitel(admin, tradeId);
      const t = await admin.from("trades").select("seller_id").eq("id", tradeId).single<{ seller_id: string }>();
      return {
        reference: id,
        handel: { id: tradeId, titel: `Retur: ${titel}` },
        afsender,
        modtager: { ...ud.afsender!, email: t.data ? await brugerEmail(admin, t.data.seller_id) : null },
        pakkestoerrelse,
        levering: "pakkeshop",
        pakkeshopId: null,
        vaegtGram: vaegtGram ?? MAKS_GRAM_STANDARD[pakkestoerrelse],
      };
    },
  });
}

// Annullerer en label hos fragtfirmaet i to trin, så en samtidig "afleveret"
// ikke giver uoverensstemmelse:
//   1. forsendelse_annuller_claim sætter status 'annulleres' FØR fragtfirmaet
//      kaldes (dobbeltklik/cron giver ikke to kald).
//   2. forsendelse_annuller_afslut: 'annulleret' ved succes. Ved fejl rulles
//      status tilbage til 'oprettet' (labelen er stadig aktiv), og staff
//      markeres, når vi ikke ved, hvad fragtfirmaet nåede (ukendt fejl/timeout)
//      eller når det er systemet, der annullerer.
// brugerId: brugeren (SKAL være verificeret med auth af kalderen), eller null
// for systemet (fragt-cron - kun på annullerede handler, tjekkes i SQL).
async function annullerForsendelse(
  admin: Admin,
  forsendelseId: string,
  brugerId: string | null,
): Promise<{ ok: true } | { fejl: string }> {
  const { data: kode, error: claimFejl } = await admin.rpc("forsendelse_annuller_claim", {
    p_id: forsendelseId,
    p_bruger: brugerId,
  });
  if (claimFejl) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: forsendelse_annuller_claim", fejl: claimFejl });
    return { fejl: GENERISK_FEJL };
  }
  if (kode === "ikke_fundet") return { fejl: "Fragtlabelen findes ikke." };
  if (kode === "i_gang") return { fejl: "Labelen er ved at blive annulleret. Opdatér siden om lidt." };
  if (kode !== "ok") return { fejl: "Labelen kan ikke annulleres, når pakken er afleveret." };

  const afslut = async (ok: boolean, note: string | null): Promise<string | null> => {
    const { data, error } = await admin.rpc("forsendelse_annuller_afslut", {
      p_id: forsendelseId,
      p_ok: ok,
      p_note: note,
    });
    if (error) {
      // Status bliver stående i 'annulleres'; fragt-cron rydder op efter 15 min.
      await logDriftFejl({ kilde: "server", hvor: "Fragt: forsendelse_annuller_afslut", fejl: error });
      return null;
    }
    return data as string;
  };

  const { data: f } = await admin
    .from("forsendelser")
    .select("fragtfirma, forsendelses_id")
    .eq("id", forsendelseId)
    .maybeSingle<{ fragtfirma: string; forsendelses_id: string | null }>();
  const adapter = f ? adapterFor(f.fragtfirma) : null;
  if (!f?.forsendelses_id || !adapter) {
    await afslut(
      false,
      brugerId === null
        ? "Handlen er annulleret, men fragtfirmaet er ikke sat op her, så labelen kunne ikke annulleres. Annullér den manuelt hos fragtfirmaet."
        : null,
    );
    return { fejl: FRAGT_IKKE_SAT_OP };
  }

  try {
    await medTimeout(adapter.annullerForsendelse(f.forsendelses_id), 20_000, "annullerForsendelse");
  } catch (err) {
    // Fragtfirmaet kan ikke annullere (DAO via Shipmondo): labelen annulleres
    // hos BidHamr (sælgeren kan ikke længere se den), og staff får besked,
    // så de kan bede fragtfirmaet kreditere den. Bruges labelen alligevel,
    // markeres forsendelsen til staff (hændelse på annulleret label).
    if (err instanceof FragtAnnulleringIkkeMulig) {
      const svar = await afslut(true, null);
      await admin.rpc("forsendelse_marker_opmaerksomhed", {
        p_id: forsendelseId,
        p_note:
          `Labelen er annulleret i BidHamr, men fragtfirmaet kan ikke annullere den selv (${f.fragtfirma} ${f.forsendelses_id}). ` +
          "Bed fragtfirmaet kreditere den, hvis den ikke bliver brugt.",
      });
      if (svar === "aendret") {
        return { fejl: "Fragtfirmaet har netop meldt pakken indleveret. BidHamr kigger på forsendelsen." };
      }
      return { ok: true };
    }
    const kendt = err instanceof FragtFejl;
    const detalje = renFejltekst(err, 200);
    let note: string | null = null;
    if (brugerId === null) {
      note = `Handlen er annulleret, men labelen kunne ikke annulleres hos fragtfirmaet (${detalje}). Annullér den manuelt hos fragtfirmaet, eller kontakt sælgeren.`;
    } else if (!kendt) {
      note = `Sælgeren prøvede at annullere labelen, men fragtfirmaet svarede ikke korrekt (${detalje}). Tjek hos fragtfirmaet, om labelen er annulleret.`;
    }
    await afslut(false, note);
    if (!kendt) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: annullér label", fejl: err });
    }
    return { fejl: brugerFejl(err) };
  }

  const svar = await afslut(true, null);
  if (svar === "aendret") {
    return { fejl: "Fragtfirmaet har netop meldt pakken indleveret. BidHamr kigger på forsendelsen." };
  }
  return { ok: true };
}

// Annullerer en udgående label, før pakken er afleveret. saelgerId SKAL være
// verificeret med auth af kalderen (SQL tjekker igen, at han er sælgeren).
export async function annullerUdgaaendeForsendelse(
  forsendelseId: string,
  saelgerId: string,
): Promise<{ ok: true } | { fejl: string }> {
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("type")
    .eq("id", forsendelseId)
    .maybeSingle<{ type: string }>();
  if (!f || f.type !== "udgaaende") return { fejl: "Fragtlabelen findes ikke." };
  return annullerForsendelse(admin, forsendelseId, saelgerId);
}

// ------------------------------------------------------------ hændelser

// Gemmer en hændelse idempotent (samme nøgle = ingen ny række) og udfører
// derefter handelseffekterne (beskeder/markeringer). Kaster ved databasefejl.
// effekter: false = kun gem (webhooken skal svare inden for 3 sekunder; den
// kører effekterne bagefter med after(), og fragt-cron'en sender beskeder,
// der mangler).
export async function registrerForsendelseshaendelse(
  forsendelseId: string,
  h: Sporingshaendelse,
  kilde: HaendelseKilde,
  opts: { effekter?: boolean } = {},
): Promise<{ ny: boolean }> {
  if (!erSporingsType(h.type)) throw new Error(`Ukendt hændelsestype: ${String(h.type)}`);
  const tid = Number.isNaN(Date.parse(h.tidspunkt)) ? new Date().toISOString() : h.tidspunkt;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("forsendelse_registrer_haendelse", {
    p_forsendelse: forsendelseId,
    p_type: h.type,
    p_tidspunkt: tid,
    p_noegle: h.noegle.slice(0, 200),
    p_beskrivelse: h.beskrivelse?.slice(0, 300) ?? null,
    p_raa: h.raa ?? null,
    p_kilde: kilde,
  });
  if (error) throw new Error(`forsendelse_registrer_haendelse: ${error.message}`);
  const ny = Boolean((data as { ny?: boolean } | null)?.ny);
  if (ny && opts.effekter !== false) await udfoerHandelseffekter(admin, forsendelseId);
  return { ny };
}

// Beskeder/markeringer for en forsendelse (fx efter webhooken). Kaster aldrig.
export async function udfoerHandelseffekterFor(forsendelseId: string): Promise<number> {
  return udfoerHandelseffekter(createAdminClient(), forsendelseId);
}

type ForsendelseFuld = {
  id: string;
  trade_id: string;
  type: "udgaaende" | "retur";
  status: string;
  sporingsnummer: string | null;
  afleveret_kl: string | null;
  leveret_kl: string | null;
  afleveret_besked_kl: string | null;
  leveret_besked_kl: string | null;
};

// Beskeder ud fra forsendelsens tilstand. Idempotent: hver besked har en
// fast nøgle, og *_besked_kl sættes bagefter, så cron kan prøve igen, hvis
// serveren døde imellem. Kaster aldrig.
async function udfoerHandelseffekter(admin: Admin, forsendelseId: string): Promise<number> {
  let sendt = 0;
  try {
    const { data: f } = await admin
      .from("forsendelser")
      .select("id, trade_id, type, status, sporingsnummer, afleveret_kl, leveret_kl, afleveret_besked_kl, leveret_besked_kl")
      .eq("id", forsendelseId)
      .maybeSingle<ForsendelseFuld>();
    if (!f || f.type !== "udgaaende") return 0;
    if (["opretter", "annulleret", "fejlet"].includes(f.status)) return 0;
    const mangler =
      (f.afleveret_kl && !f.afleveret_besked_kl) || (f.leveret_kl && !f.leveret_besked_kl);
    if (!mangler) return 0;

    const { data: t } = await admin
      .from("trades")
      .select("id, auction_id, buyer_id, seller_id, status")
      .eq("id", f.trade_id)
      .maybeSingle<{ id: string; auction_id: string; buyer_id: string; seller_id: string; status: string }>();
    if (!t) return 0;
    const { data: a } = await admin
      .from("auctions")
      .select("titel")
      .eq("id", t.auction_id)
      .maybeSingle<{ titel: string | null }>();
    const titel = a?.titel ?? "din vare";
    const link = `/mine-handler/${t.id}`;

    // Pakken er indleveret, men sælgeren har ikke markeret den sendt: sælgeren
    // får en påmindelse, og forsendelsen markeres til staff, så de kan
    // kontakte sælgeren. Afsendelsesfristen ændres IKKE (ROADMAP-BESLUTNINGER,
    // "Sælger markerer selv pakken sendt") - handlen annulleres stadig, hvis
    // pakken ikke er markeret sendt, når fristen udløber.
    if (f.afleveret_kl && !f.afleveret_besked_kl) {
      let note: string | null = null;
      if (t.status === "betaling_modtaget") {
        const { data: b } = await admin
          .from("betalinger")
          .select("betalt_kl")
          .eq("trade_id", t.id)
          .not("betalt_kl", "is", null)
          .order("betalt_kl", { ascending: false })
          .limit(1)
          .maybeSingle<{ betalt_kl: string }>();
        const frist = sendSenest(b?.betalt_kl);
        note =
          "Fragtfirmaet har pakken, men sælger har ikke trykket Send pakke – afsendelsesfristen annullerer handlen " +
          (frist ? sendSenestTekst(frist) : "når fristen udløber") +
          ". Kontakt sælgeren.";
        await send(t.seller_id, "betaling_modtaget", {
          titel: "Pakken er indleveret",
          tekst: `Fragtfirmaet har modtaget pakken med "${titel}". Har du ikke allerede gjort det, så markér pakken sendt med de to pakkebilleder på handelssiden - ellers bliver handlen annulleret, når fristen for afsendelse udløber.`,
          link,
          data: { trade_id: t.id },
          noegle: `fragt_afleveret:${f.id}`,
        });
        sendt++;
      } else if (t.status === "annulleret") {
        note = "Fragtfirmaet har modtaget pakken, men handlen er annulleret. Tjek, om pakken skal sendes retur til sælgeren.";
      }
      await admin.rpc("forsendelse_marker_besked", { p_id: f.id, p_felt: "afleveret", p_note: note });
    }

    // Pakken er kommet frem. Ingen penge flyttes, og 48-timers uret startes
    // ikke - køberen trykker stadig "modtaget".
    if (f.leveret_kl && !f.leveret_besked_kl) {
      let note: string | null = null;
      if (t.status === "betaling_modtaget" || t.status === "pakke_sendt") {
        await send(t.buyer_id, "pakke_leveret", {
          titel: "Pakken er kommet frem",
          tekst:
            t.status === "pakke_sendt"
              ? `Fragtfirmaet melder, at "${titel}" er leveret. Tryk "Jeg har modtaget pakken" på handelssiden, når du har den, og tjek varen.`
              : `Fragtfirmaet melder, at "${titel}" er leveret. Tjek varen, når du har den.`,
          link,
          data: { trade_id: t.id },
          noegle: `fragt_leveret:${t.id}`,
        });
        sendt++;
        if (t.status === "betaling_modtaget") {
          note = "Fragtfirmaet melder pakken leveret, men sælgeren har ikke markeret den sendt med pakkebilleder.";
        }
      } else if (t.status === "annulleret") {
        note = "Fragtfirmaet melder pakken leveret, men handlen er annulleret. Tjek handlen og pengene.";
      }
      await admin.rpc("forsendelse_marker_besked", { p_id: f.id, p_felt: "leveret", p_note: note });
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: handelseffekter", fejl: err });
  }
  return sendt;
}

// Finder BidHamrs forsendelse ud fra fragtfirmaets id eller sporingsnummer.
export async function findForsendelse(
  fragtfirma: string,
  ref: { forsendelsesId?: string | null; sporingsnummer?: string | null },
): Promise<string | null> {
  const admin = createAdminClient();
  if (ref.forsendelsesId) {
    const { data } = await admin
      .from("forsendelser")
      .select("id")
      .eq("fragtfirma", fragtfirma)
      .eq("forsendelses_id", ref.forsendelsesId)
      .maybeSingle<{ id: string }>();
    if (data) return data.id;
  }
  if (ref.sporingsnummer) {
    // Nyeste først: en annulleret label og en ny kan i teorien dele nummer.
    const { data } = await admin
      .from("forsendelser")
      .select("id")
      .eq("fragtfirma", fragtfirma)
      .eq("sporingsnummer", ref.sporingsnummer)
      .order("oprettet_kl", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0].id as string;
  }
  return null;
}

// ------------------------------------------------------------ cron

const POLL_INTERVAL_MIN = 20;
const POLL_MAKS = 20;
const CRON_BUDGET_MS = 25_000;

const ANNULLER_MAKS = 10;

// Henter sporing for aktive forsendelser (højst 20 pr. kørsel, hver højst hvert
// 20. minut) og sender beskeder, der mangler. Annullerer desuden labels på
// annullerede handler. Let og begrænset - kaldes fra betalings-cron-ruten.
// Kaster aldrig.
export async function koerFragtCron(): Promise<{
  sporet: number;
  nyeHaendelser: number;
  beskeder: number;
  annulleret: number;
  fejl: number;
}> {
  const r = { sporet: 0, nyeHaendelser: 0, beskeder: 0, annulleret: 0, fejl: 0 };
  const start = Date.now();
  const admin = createAdminClient();

  // Handlen er annulleret (afsendelsesfrist, afhentningsfrist, ubetalt, admin,
  // sag - uanset grund): annullér udgående labels, der ikke er afleveret, hos
  // fragtfirmaet. De eksisterende annulleringsfunktioner røres ikke - cron
  // finder dem her. Fejler annulleringen, markeres forsendelsen til staff
  // (højst 3 forsøg, 1 time imellem - se fragt_cron_annulleringer).
  const { data: annuller, error: annFejl } = await admin.rpc("fragt_cron_annulleringer", {
    p_graense: ANNULLER_MAKS,
  });
  if (annFejl) {
    r.fejl++;
    await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: find annulleringer", fejl: annFejl });
  } else {
    for (const a of (annuller ?? []) as { id: string; trade_id: string }[]) {
      if (Date.now() - start > CRON_BUDGET_MS / 2) break;
      const svar = await annullerForsendelse(admin, a.id, null);
      if ("ok" in svar) r.annulleret++;
      else r.fejl++;
    }
  }

  const graense = new Date(Date.now() - POLL_INTERVAL_MIN * 60_000).toISOString();
  const aeldst = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString();
  const { data: aktive, error } = await admin
    .from("forsendelser")
    .select("id, fragtfirma, sporingsnummer")
    .in("status", ["oprettet", "annulleres", "afleveret", "i_transit", "klar_til_afhentning"])
    .gte("oprettet_kl", aeldst)
    .or(`sidst_polled_kl.is.null,sidst_polled_kl.lt.${graense}`)
    .order("sidst_polled_kl", { ascending: true, nullsFirst: true })
    .limit(POLL_MAKS);
  if (error) {
    r.fejl++;
    await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: hent aktive", fejl: error });
    return r;
  }

  for (const f of aktive ?? []) {
    if (Date.now() - start > CRON_BUDGET_MS) break;
    // Markér altid som hentet, så en fejlende forsendelse ikke blokerer køen.
    await admin
      .from("forsendelser")
      .update({ sidst_polled_kl: new Date().toISOString() })
      .eq("id", f.id);
    const adapter = adapterFor(f.fragtfirma as string);
    if (!adapter || !f.sporingsnummer) continue;
    try {
      const haendelser = await medTimeout(
        adapter.hentSporing(f.sporingsnummer as string),
        10_000,
        "hentSporing",
      );
      r.sporet++;
      for (const h of haendelser.slice(0, 100)) {
        const { ny } = await registrerForsendelseshaendelse(f.id as string, h, "sporing");
        if (ny) r.nyeHaendelser++;
      }
    } catch (err) {
      r.fejl++;
      if (!(err instanceof FragtFejl)) {
        await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: hent sporing", fejl: err });
      }
    }
  }

  // Beskeder, der mangler (fx serveren døde mellem hændelse og besked).
  if (Date.now() - start < CRON_BUDGET_MS) {
    const { data: mangler } = await admin
      .from("forsendelser")
      .select("id")
      .eq("type", "udgaaende")
      .not("status", "in", "(opretter,annulleret,fejlet)")
      .or(
        "and(afleveret_kl.not.is.null,afleveret_besked_kl.is.null)," +
          "and(leveret_kl.not.is.null,leveret_besked_kl.is.null)",
      )
      .limit(20);
    for (const m of mangler ?? []) {
      if (Date.now() - start > CRON_BUDGET_MS) break;
      r.beskeder += await udfoerHandelseffekter(admin, m.id as string);
    }
  }

  return r;
}
