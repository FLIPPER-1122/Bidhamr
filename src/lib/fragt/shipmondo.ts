import "server-only";

// Shipmondo med DAO, GLS og PostNord (Filip, 15. okt. 2026: fragt via
// Shipmondo igen - køberen vælger selv transportør i checkout). Verificeret
// mod Shipmondos sandbox 9. og 15. okt. 2026 (API v3, shipmondo.dev).
//
// Env:
//   SHIPMONDO_API_URL          sandbox: https://sandbox.shipmondo.com/api/public/v3
//                              produktion: https://app.shipmondo.com/api/public/v3
//   SHIPMONDO_API_BRUGER       API-bruger (Basic auth)
//   SHIPMONDO_API_NOEGLE       API-nøgle (Basic auth)
//   SHIPMONDO_WEBHOOK_NOEGLE   nøglen, der indtastes ved oprettelse af webhooken
//                              (Shipmondo signerer med JWT HS256)
//   SHIPMONDO_EGEN_AFTALE      "true" = book på BidHamrs egne aftaler hos
//                              Shipmondo (own_agreement). Standard: Shipmondos.
//   SHIPMONDO_RETUR_ER_IKKE_AFHENTET  "true" = en udgående pakke, Shipmondo
//                              melder sendt retur (tekst), registreres som
//                              "ikke afhentet" automatisk. Standard: kun
//                              markering til staff (se monitorTilType).
//
// Produkter (GET /products, sandbox 15. okt. 2026):
//   DAO       pakkeshop DAO_STS (daoSHOP drop-off, 15 kg, shop krævet)
//             døren     DAO_STH (daoHOME drop-off, 5 kg)
//             retur     DAO_STS med køberen som afsender og automatisk valgt
//                       daoSHOP nær sælgeren.
//             Labelfri: `labelless_code` i svaret (sandbox: altid 123-456-789).
//             Ingen QR_CODE-service. Annullering: 422 "It's not possible to
//             cancel this shipment." (også 15. okt.) -> FragtAnnulleringIkkeMulig.
//   GLS       pakkeshop GLSDK_SD (ShopDelivery, shop krævet, EMAIL_NT krævet)
//             døren     GLSDK_HD (PrivateDelivery)
//             retur     GLSDK_SR (ShopReturn) + QR_CODE: køberen viser QR'en i
//                       en GLS-pakkeshop, pakken leveres til sælgerens adresse.
//                       Afviser Shipmondo/GLS ShopReturn (422 - fx fordi den
//                       formelt er til erhvervsadresser), bruges GLSDK_SD til en
//                       automatisk valgt GLS-pakkeshop nær sælgeren (PDF-label).
//             Labelfri udgående: FINDES IKKE via Shipmondo (QR_CODE afvises på
//             SD/HD med 422 "Service code QR_CODE is invalid", og intet
//             labelless_code) -> PDF-label.
//             Annullering: { cancelled: true, cancelled_at_carrier: false } i
//             sandboxen.
//   PostNord  pakkeshop PDK_MC (Service Point) + QR_CODE
//             døren     PDK_MH (Home) + QR_CODE
//             retur     PDK_MC + QR_CODE med automatisk valgt pakkeshop nær
//                       sælgeren (PDK_RDO er til erhvervsadresser).
//             QR: GET /shipments/{id}/qr_code?file_format=png -> { qr_codes:
//             [base64 PNG] }. Annullering som GLS.
//   Notifikation: mindst én af EMAIL_NT / SMS_NT (GLS: EMAIL_NT krævet).
//
// Sporing: Shipmondo har intet sporings-endpoint i API v3 (verificeret 15.
// okt.: /shipments/{id}/tracking o.l. findes ikke) - sporingen kommer KUN via
// webhooken "Shipment Monitor" (latest/delivered). Shipment Monitor oversætter
// alle transportørers hændelser til de samme statusser (shipmondo.dev,
// "Resources and actions"), så kortlægningen er fælles for DAO, GLS og
// PostNord - se monitorTilType. hentSporing giver derfor ingen hændelser, og
// fragt-cron'ens polling er kun reserve for andre firmaer. Mister vi en
// webhook (Shipmondo prøver ikke igen), kommer næste "latest" stadig, og
// efterlysningen efter 14 dage fanger en pakke uden leveringsmelding.
import { createHmac, timingSafeEqual } from "node:crypto";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { beregnAfstandKm } from "@/lib/distance";
import {
  type Adresse,
  type ForsendelseInput,
  type ForsendelseKontekst,
  type Fragtfirma,
  type OprettetForsendelse,
  type Pakkeshop,
  type PakkeshopSoegning,
  type Pakkestoerrelse,
  type Sporingshaendelse,
  type SporingsType,
  type Transportoer,
  type UkendtSporingskode,
  type WebhookHaendelse,
  type WebhookResultat,
  FragtAnnulleringIkkeMulig,
  FragtFejl,
  FragtUkendtUdfald,
  FRAGT_IKKE_SAT_OP,
  TRANSPORTOERER,
  erTransportoer,
} from "@/lib/fragt/types";

export const DAO_PAKKESHOP = "DAO_STS";
export const DAO_DOER = "DAO_STH";

type Produkter = {
  // Shipmondos carrier_code.
  carrier: string;
  pakkeshop: string;
  doer: string;
  retur: string;
  // Reserve, hvis returproduktet afvises (4xx - intet oprettet).
  returReserve: string | null;
  // Retur til en automatisk valgt pakkeshop nær sælgeren (ellers hans adresse).
  returTilPakkeshop: boolean;
  // EMAIL_NT er krævet (GLS).
  kraeverEmail: boolean;
};

export const PRODUKTER: Record<Transportoer, Produkter> = {
  dao: {
    carrier: "dao",
    pakkeshop: DAO_PAKKESHOP,
    doer: DAO_DOER,
    retur: DAO_PAKKESHOP,
    returReserve: null,
    returTilPakkeshop: true,
    kraeverEmail: false,
  },
  gls: {
    carrier: "gls",
    pakkeshop: "GLSDK_SD",
    doer: "GLSDK_HD",
    retur: "GLSDK_SR",
    returReserve: "GLSDK_SD",
    returTilPakkeshop: false,
    kraeverEmail: true,
  },
  postnord: {
    carrier: "pdk",
    pakkeshop: "PDK_MC",
    doer: "PDK_MH",
    retur: "PDK_MC",
    returReserve: null,
    returTilPakkeshop: true,
    kraeverEmail: false,
  },
};

// Produkter med servicen QR_CODE (labelfri QR i stedet for printet label).
export const QR_PRODUKTER = new Set(["PDK_MC", "PDK_MH", "GLSDK_SR"]);
// Produkter, der leverer til en pakkeshop (service point krævet).
const PAKKESHOP_PRODUKTER = new Set(["DAO_STS", "GLSDK_SD", "PDK_MC"]);

export function transportoerFraCarrier(carrier: unknown): Transportoer | null {
  const c = String(carrier ?? "").toLowerCase();
  for (const t of TRANSPORTOERER) if (PRODUKTER[t].carrier === c) return t;
  return null;
}

// Vægt på labelen, når sælgeren ikke har angivet vægt: pakkestørrelsens
// maksimum (samme som fragt_pakkestoerrelser).
export const MAKS_GRAM: Record<Pakkestoerrelse, number> = {
  lille: 1000,
  mellem: 5000,
  stor: 15000,
};
const DOER_MAKS_GRAM = 5000;

const TIMEOUT_MS = 15_000;
const GENERISK = "Fragtfirmaet svarer ikke lige nu. Prøv igen om lidt.";
// En QR-PNG fra Shipmondo er 0,5-2 KB. Større afvises (gemmes i databasen).
const QR_MAKS_BASE64 = 20_000;

type Konfig = { base: string; auth: string };

function konfig(): Konfig {
  const base = (process.env.SHIPMONDO_API_URL ?? "").trim().replace(/\/+$/, "");
  const bruger = (process.env.SHIPMONDO_API_BRUGER ?? "").trim();
  const noegle = (process.env.SHIPMONDO_API_NOEGLE ?? "").trim();
  if (!/^https:\/\/(sandbox|app)\.shipmondo\.com\/api\/public\/v3$/.test(base) || !bruger || !noegle) {
    throw new FragtFejl(FRAGT_IKKE_SAT_OP, "Shipmondo er ikke sat op (SHIPMONDO_API_URL/BRUGER/NOEGLE).");
  }
  return { base, auth: "Basic " + Buffer.from(`${bruger}:${noegle}`).toString("base64") };
}

function erSatOp(): boolean {
  try {
    konfig();
    return true;
  } catch {
    return false;
  }
}

export class ShipmondoFejl extends Error {
  readonly status: number;
  readonly svar: string | null;
  constructor(status: number, svar: string | null) {
    super(`Shipmondo ${status}: ${svar ?? "ukendt fejl"}`);
    this.name = "ShipmondoFejl";
    this.status = status;
    this.svar = svar;
  }
}

async function kald<T>(metode: "GET" | "POST" | "PUT", sti: string, body?: unknown): Promise<T> {
  const k = konfig();
  let svar: Response;
  try {
    svar = await fetch(k.base + sti, {
      method: metode,
      headers: {
        Authorization: k.auth,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    // Netværk/timeout: vi ved ikke, om Shipmondo har udført kaldet.
    throw new FragtUkendtUdfald(`Shipmondo ${metode} ${sti}: ${String(err)}`);
  }
  const tekst = await svar.text();
  // Ukendte stier giver en HTML-side med status 200 - kræv JSON.
  const erJson = (svar.headers.get("content-type") ?? "").includes("application/json");
  let json: unknown = null;
  if (erJson && tekst) {
    try {
      json = JSON.parse(tekst);
    } catch {
      json = null;
    }
  }
  if (!svar.ok || !erJson) {
    const fejl =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? ((json as { error: string }).error)
        : erJson
          ? tekst.slice(0, 300)
          : "Svaret var ikke JSON";
    throw new ShipmondoFejl(svar.ok ? 502 : svar.status, fejl);
  }
  return json as T;
}

// ------------------------------------------------------------ forsendelser

type ShipmondoForsendelse = {
  id: number;
  reference: string | null;
  carrier_code?: string | null;
  product_code: string | null;
  service_codes?: string | null;
  pkg_no: string | null;
  price: string | null;
  labelless_code?: string | null;
  parcels?: { pkg_no?: string | null; labelless_code?: string | null }[];
  labels?: { base64: string; file_format: string }[];
};

function telefon(t: string | null | undefined): string | null {
  const ren = (t ?? "").replace(/[\s-]/g, "");
  if (!/^\+?\d{8,15}$/.test(ren)) return null;
  return ren.startsWith("+") ? ren : ren.length === 8 ? `+45${ren}` : `+${ren}`;
}

function part(type: "sender" | "receiver", a: Adresse) {
  if (!a.adresse || !a.postnummer || !a.by) {
    throw new FragtFejl(
      type === "sender" ? "Udfyld din adresse, før du sender pakken." : "Modtagerens adresse mangler.",
    );
  }
  return {
    type,
    name: a.navn.slice(0, 100),
    address1: a.adresse.slice(0, 100),
    postal_code: a.postnummer,
    city: a.by.slice(0, 60),
    country_code: "DK",
    ...(a.email ? { email: a.email } : {}),
    ...(telefon(a.telefon) ? { phone: telefon(a.telefon) } : {}),
  };
}

// Servicekoder: notifikation (mindst én; GLS kræver e-mail) + QR_CODE på de
// produkter, der har labelfri QR.
export function servicekoder(modtager: Adresse, produkt: string, kraeverEmail: boolean): string {
  const koder: string[] = [];
  if (modtager.email) koder.push("EMAIL_NT");
  else if (kraeverEmail) throw new FragtFejl("Modtagerens e-mail mangler.");
  if (telefon(modtager.telefon)) koder.push("SMS_NT");
  if (koder.length === 0) throw new FragtFejl("Modtagerens e-mail eller telefonnummer mangler.");
  if (QR_PRODUKTER.has(produkt)) koder.push("QR_CODE");
  return koder.join(",");
}

function base64TilBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function prisOere(pris: string | null | undefined): number | null {
  const n = Number(pris);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

async function hentLabel(id: number): Promise<Uint8Array> {
  const labels = await kald<{ base64: string; file_format: string }[]>(
    "GET",
    `/shipments/${id}/labels?label_format=a4_pdf`,
  );
  const pdf = Array.isArray(labels) ? labels.find((l) => l.file_format === "pdf") : null;
  if (!pdf?.base64) throw new Error(`Shipmondo: ingen PDF-label på forsendelse ${id}`);
  return base64TilBytes(pdf.base64);
}

// Gyldig PNG i base64 (starter med PNG-signaturen) og ikke for stor.
export function erQrPng(b64: unknown): b64 is string {
  return (
    typeof b64 === "string" &&
    b64.length > 100 &&
    b64.length <= QR_MAKS_BASE64 &&
    /^iVBORw0KGgo[A-Za-z0-9+/]+=*$/.test(b64)
  );
}

// QR-koden (PNG) for en forsendelse med QR_CODE. Kaster aldrig: uden QR kan
// sælgeren stadig bruge PDF-labelen.
async function hentQr(s: ShipmondoForsendelse): Promise<string | null> {
  if (!s.product_code || !QR_PRODUKTER.has(s.product_code)) return null;
  try {
    const r = await kald<{ qr_codes?: unknown[] }>("GET", `/shipments/${s.id}/qr_code?file_format=png`);
    const qr = Array.isArray(r?.qr_codes) ? r.qr_codes[0] : null;
    return erQrPng(qr) ? qr : null;
  } catch (err) {
    console.error("Shipmondo: QR-koden kunne ikke hentes:", err instanceof Error ? err.message.slice(0, 200) : "ukendt");
    return null;
  }
}

function tilOprettet(s: ShipmondoForsendelse, label: Uint8Array, qrPng: string | null): OprettetForsendelse {
  const sporing = s.pkg_no ?? s.parcels?.[0]?.pkg_no ?? null;
  if (!s.id || !sporing) throw new Error("Shipmondo: svaret mangler id eller pakkenummer");
  const labelfri = s.labelless_code ?? s.parcels?.[0]?.labelless_code ?? null;
  return {
    forsendelsesId: String(s.id),
    sporingsnummer: sporing,
    label: { type: "pdf", data: label },
    qrKode: labelfri ? String(labelfri).slice(0, 100) : null,
    qrPng,
    prisOere: prisOere(s.price),
    produkt: s.product_code,
  };
}

// Referencen hos Shipmondo: BidHamrs forsendelses-id (uuid) UDEN bindestreger
// - PostNord afviser referencer over 35 tegn (sandbox 15. okt. 2026: 422
// "referenceNo cannot be ... longer than 35 characters"). 32 tegn.
export function shipmondoReference(id: string): string {
  return id.replace(/-/g, "");
}

// Tilbage til BidHamrs uuid (til staffs "tilknyt"). Andet returneres uændret.
export function bidhamrReference(ref: string | null): string | null {
  if (!ref) return ref;
  const m = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i.exec(ref);
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase() : ref;
}

// Idempotens: BidHamrs forsendelses-id er referencen. Findes der allerede en
// forsendelse med referencen (genforsøg efter timeout), genbruges den.
async function findMedReference(id: string): Promise<ShipmondoForsendelse | null> {
  const reference = shipmondoReference(id);
  const liste = await kald<ShipmondoForsendelse[]>(
    "GET",
    `/shipments?reference=${encodeURIComponent(reference)}&per_page=50`,
  );
  return (Array.isArray(liste) ? liste : []).find((s) => s.reference === reference || s.reference === id) ?? null;
}

// Hvilket produkt og hvilken pakkeshop? Ren funktion (testes i test:fragt).
export function vaelgProdukt(
  transportoer: Transportoer,
  levering: "pakkeshop" | "doer",
  retur: boolean,
  reserve = false,
): { produkt: string; pakkeshop: "valgt" | "automatisk" | null } {
  const p = PRODUKTER[transportoer];
  if (retur) {
    const produkt = reserve && p.returReserve ? p.returReserve : p.retur;
    return { produkt, pakkeshop: PAKKESHOP_PRODUKTER.has(produkt) ? "automatisk" : null };
  }
  return levering === "doer" ? { produkt: p.doer, pakkeshop: null } : { produkt: p.pakkeshop, pakkeshop: "valgt" };
}

// Fejl fra opret():
//   FragtFejl          kun valideringsfejl FØR ethvert kald og 4xx-svar på
//                      POST /shipments - dér er intet oprettet.
//   FragtUkendtUdfald  alt andet: netværk/timeout/5xx/ikke-JSON på opslaget
//                      efter referencen, på POST eller på hentning af labelen,
//                      og fejl i svaret efter en vellykket POST. Forsendelsen
//                      kan findes hos Shipmondo - næste forsøg genbruger
//                      referencen.
// QR-koden hentes efter oprettelsen; mangler den, bruges PDF'en (ingen fejl).
async function opret(input: ForsendelseInput, retur: boolean): Promise<OprettetForsendelse> {
  // 1. Validering før ethvert kald (FragtFejl).
  const transportoer: Transportoer = input.transportoer ?? "dao";
  if (!erTransportoer(transportoer)) throw new FragtFejl("Ukendt fragtfirma.");
  const levering = retur ? "pakkeshop" : (input.levering ?? "pakkeshop");
  const vaegt = Math.max(1, Math.round(input.vaegtGram ?? MAKS_GRAM[input.pakkestoerrelse]));
  if (vaegt > MAKS_GRAM.stor) throw new FragtFejl("Pakken er for tung til at blive sendt.");
  if (levering === "doer" && vaegt > DOER_MAKS_GRAM) {
    throw new FragtFejl("Levering til døren kan kun bruges op til 5 kg.");
  }
  if (levering === "pakkeshop" && !retur && !input.pakkeshopId) {
    throw new FragtFejl("Køberen har ikke valgt en pakkeshop.");
  }
  const byg = (reserve: boolean) => {
    const valg = vaelgProdukt(transportoer, levering, retur, reserve);
    const body: Record<string, unknown> = {
      own_agreement: process.env.SHIPMONDO_EGEN_AFTALE === "true",
      product_code: valg.produkt,
      service_codes: servicekoder(input.modtager, valg.produkt, PRODUKTER[transportoer].kraeverEmail),
      reference: shipmondoReference(input.reference),
      label_format: "a4_pdf",
      contents: input.handel.titel.slice(0, 60),
      parties: [part("sender", input.afsender), part("receiver", input.modtager)],
      parcels: [{ quantity: 1, weight: vaegt }],
    };
    if (valg.pakkeshop === "valgt") body.service_point_id = input.pakkeshopId;
    // Retur: Shipmondo vælger pakkeshoppen nærmest modtageren (sælgeren).
    if (valg.pakkeshop === "automatisk") body.automatic_select_service_point = true;
    return body;
  };
  const body = byg(false);
  const reserveBody = retur && PRODUKTER[transportoer].returReserve ? byg(true) : null;
  konfig();

  const ukendt = (hvor: string, err: unknown) =>
    err instanceof FragtUkendtUdfald
      ? err
      : new FragtUkendtUdfald(`Shipmondo ${hvor} (${input.reference}): ${err instanceof Error ? err.message : String(err)}`);

  // 2. Findes forsendelsen allerede (genforsøg)?
  let findes: ShipmondoForsendelse | null;
  try {
    findes = await findMedReference(input.reference);
  } catch (err) {
    throw ukendt("opslag på reference", err);
  }
  if (findes) {
    try {
      return tilOprettet(findes, await hentLabel(findes.id), await hentQr(findes));
    } catch (err) {
      throw ukendt("label til eksisterende forsendelse", err);
    }
  }

  // 3. Opret (retur: evt. reserveproduktet, hvis det første afvises).
  type PostSvar = { s: ShipmondoForsendelse; afvist: null } | { s: null; afvist: ShipmondoFejl };
  const post = async (b: Record<string, unknown>): Promise<PostSvar> => {
    try {
      return { s: await kald<ShipmondoForsendelse>("POST", "/shipments", b), afvist: null };
    } catch (err) {
      // Afvist (4xx): intet er oprettet. Undtagen 408 (timeout hos Shipmondo):
      // dér ved vi ikke, om forsendelsen blev oprettet.
      if (err instanceof ShipmondoFejl && err.status >= 400 && err.status < 500 && err.status !== 408) {
        return { s: null, afvist: err };
      }
      throw ukendt("POST /shipments", err);
    }
  };
  let r = await post(body);
  // Reserven (GLS-retur) KUN ved 422: Shipmondo/GLS har afvist netop
  // ShopReturn. Andre 4xx (fx 401/403/429) giver ikke en ny bestilling.
  if (r.afvist && r.afvist.status === 422 && reserveBody) r = await post(reserveBody);
  if (r.afvist) {
    throw new FragtFejl(
      r.afvist.status === 422 ? "Fragtfirmaet kunne ikke oprette pakken. Tjek adresserne og prøv igen." : GENERISK,
      r.afvist.message,
    );
  }
  const s = r.s;
  try {
    const label = s.labels?.find((l) => l.file_format === "pdf")?.base64;
    return tilOprettet(s, label ? base64TilBytes(label) : await hentLabel(s.id), await hentQr(s));
  } catch (err) {
    throw ukendt("svar/label efter oprettelse", err);
  }
}

// Staff: hent en eksisterende forsendelse (fx for at tilknytte en hængende
// claim). Kaster FragtFejl, hvis den ikke findes.
export async function hentEksisterende(
  forsendelsesId: string,
): Promise<OprettetForsendelse & { reference: string | null; vaegtGram: number | null; afsender: Adresse | null }> {
  if (!/^\d{1,20}$/.test(forsendelsesId)) throw new FragtFejl("Ugyldigt Shipmondo-id.");
  let f: ShipmondoForsendelse & {
    sender?: { name?: string; address1?: string; zipcode?: string; city?: string; email?: string; mobile?: string } | null;
    parcels?: { weight?: number; pkg_no?: string | null; labelless_code?: string | null }[];
  };
  try {
    f = await kald("GET", `/shipments/${forsendelsesId}`);
  } catch (err) {
    // En annulleret forsendelse giver 404 hos Shipmondo (verificeret i sandboxen).
    if (err instanceof ShipmondoFejl && err.status === 404) {
      throw new FragtFejl("Forsendelsen findes ikke hos Shipmondo (eller er annulleret).");
    }
    throw err;
  }
  // Ekstra værn, hvis svaret en dag har en annulleringsstatus.
  const r = f as unknown as Record<string, unknown>;
  if (r.cancelled === true || r.cancelled_at || String(r.status ?? "").toLowerCase().includes("cancel")) {
    throw new FragtFejl("Forsendelsen er annulleret hos Shipmondo og kan ikke tilknyttes.");
  }
  const o = tilOprettet(f, await hentLabel(f.id), await hentQr(f));
  const v = f.parcels?.[0]?.weight;
  return {
    ...o,
    reference: bidhamrReference(f.reference),
    vaegtGram: typeof v === "number" ? v : null,
    afsender: f.sender
      ? {
          navn: String(f.sender.name ?? ""),
          adresse: f.sender.address1 ?? null,
          postnummer: f.sender.zipcode ?? null,
          by: f.sender.city ?? null,
          email: f.sender.email ?? null,
          telefon: f.sender.mobile ?? null,
          land: "DK",
        }
      : null,
  };
}

// ------------------------------------------------------------ pakkeshops

type ShipmondoPakkeshop = {
  id: string;
  name: string;
  address: string;
  address2?: string | null;
  zipcode: string;
  city: string;
  distance: number | null;
  latitude: number | null;
  longitude: number | null;
  carrier_code?: string | null;
  opening_hours?: string[];
  pickup_allowed?: boolean;
  drop_off_allowed?: boolean;
};

// DAO skriver "man"/"lor", GLS og PostNord "Monday".
const DAGE: Record<string, string> = {
  man: "Mandag",
  tir: "Tirsdag",
  ons: "Onsdag",
  tor: "Torsdag",
  fre: "Fredag",
  lor: "Lørdag",
  "lør": "Lørdag",
  son: "Søndag",
  "søn": "Søndag",
  monday: "Mandag",
  tuesday: "Tirsdag",
  wednesday: "Onsdag",
  thursday: "Torsdag",
  friday: "Fredag",
  saturday: "Lørdag",
  sunday: "Søndag",
};

export function aabningstider(linjer: string[] | undefined): { dag: string; tider: string }[] {
  return (linjer ?? []).slice(0, 14).flatMap((l) => {
    const m = /^\s*([^:]+):\s*(.+)$/.exec(String(l));
    if (!m) return [];
    const dag = DAGE[m[1].trim().toLowerCase()] ?? m[1].trim();
    return [{ dag: dag.slice(0, 20), tider: m[2].trim().slice(0, 60) }];
  });
}

// PostNord skriver byen med versaler ("ODENSE C").
function paenBy(by: string): string {
  return by === by.toUpperCase() ? by.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : by;
}

function tilPakkeshop(p: ShipmondoPakkeshop, fra: { lat: number; lng: number } | null): Pakkeshop {
  const lat = typeof p.latitude === "number" ? p.latitude : null;
  const lng = typeof p.longitude === "number" ? p.longitude : null;
  let afstand = typeof p.distance === "number" ? Math.round(p.distance) : null;
  if (afstand === null && fra && lat !== null && lng !== null) {
    afstand = Math.round(beregnAfstandKm(fra.lat, fra.lng, lat, lng) * 1000);
  }
  return {
    id: String(p.id).slice(0, 50),
    navn: String(p.name ?? "").slice(0, 120),
    adresse: String(p.address ?? "").slice(0, 200),
    postnummer: String(p.zipcode ?? "").slice(0, 4),
    by: paenBy(String(p.city ?? "")).slice(0, 80),
    lat,
    lng,
    afstandM: afstand,
    aabningstider: aabningstider(p.opening_hours),
  };
}

async function soeg(q: PakkeshopSoegning): Promise<Pakkeshop[]> {
  const opslag = slaaPostnummerOp(q.postnummer);
  if (!opslag) throw new FragtFejl("Ukendt postnummer.");
  const transportoer: Transportoer = q.transportoer ?? "dao";
  if (!erTransportoer(transportoer)) throw new FragtFejl("Ukendt fragtfirma.");
  const p = PRODUKTER[transportoer];
  const params = new URLSearchParams({
    product_code: p.pakkeshop,
    country_code: "DK",
    zipcode: opslag.postnummer,
    city: (q.by ?? opslag.by).slice(0, 60),
    // Shipmondo: højst 20 (422 "Exceeded quantity maximum of 20").
    quantity: String(Math.min(Math.max(q.antal ?? 10, 1), 20)),
  });
  if (q.adresse) params.set("address", q.adresse.slice(0, 100));
  const liste = await kald<ShipmondoPakkeshop[]>("GET", `/service_point/service_points?${params}`);
  return (Array.isArray(liste) ? liste : [])
    .filter((s) => s && s.id)
    // Kun den valgte transportørs shops (værn mod et blandet svar).
    .filter((s) => !s.carrier_code || String(s.carrier_code).toLowerCase() === p.carrier)
    .filter((s) => (q.indlevering ? s.drop_off_allowed !== false : s.pickup_allowed !== false))
    .map((s) => tilPakkeshop(s, { lat: opslag.lat, lng: opslag.lng }))
    .sort((a, b) => (a.afstandM ?? Infinity) - (b.afstandM ?? Infinity));
}

// ------------------------------------------------------------ webhook (JWT HS256)

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Verificerer en JWT signeret med HS256 og nøglen. Kun HS256 accepteres
// (ingen "none", ingen RS/ES - nøglen er en delt hemmelighed). null = ugyldig.
export function verificerJwtHs256(jwt: string, noegle: string): unknown | null {
  const dele = jwt.split(".");
  if (dele.length !== 3 || dele.some((d) => !/^[A-Za-z0-9_-]*$/.test(d)) || !dele[2]) return null;
  let header: unknown;
  try {
    header = JSON.parse(b64url(dele[0]).toString("utf8"));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || (header as { alg?: unknown }).alg !== "HS256") return null;
  const forventet = createHmac("sha256", noegle).update(`${dele[0]}.${dele[1]}`).digest();
  const givet = b64url(dele[2]);
  if (givet.length !== forventet.length || !timingSafeEqual(givet, forventet)) return null;
  try {
    const p = JSON.parse(b64url(dele[1]).toString("utf8"));
    // Shipmondo pakker objektet som en JSON-streng i payloaden (jf. eksemplet
    // "eyJhbGciOiJIUzI1NiJ9.IntcIndlYmhvb2tcIjpc..."). Pak den ud.
    return typeof p === "string" ? JSON.parse(p) : p;
  } catch {
    return null;
  }
}

// Kun til test (sandbox/udvikling): signerer en payload som Shipmondo.
export function signerJwtHs256(payload: unknown, noegle: string): string {
  const enc = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const h = enc(Buffer.from(JSON.stringify({ alg: "HS256" })));
  const p = enc(Buffer.from(JSON.stringify(payload)));
  const s = enc(createHmac("sha256", noegle).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}

function webhookNoegle(): string | null {
  const n = (process.env.SHIPMONDO_WEBHOOK_NOEGLE ?? "").trim();
  return n.length >= 16 ? n : null;
}

type Monitor = {
  shipment_id?: number | string;
  current_status?: string;
  current_state?: string;
  current_status_text?: string | null;
  current_status_registered_at?: string | null;
  carrier_code?: string | null;
  carrier_track_id?: string | null;
  weight?: string | null;
  city?: string | null;
  zipcode?: string | null;
  postal_code?: string | null;
};


// Shipment Monitor-statusser (shipmondo.dev, "Resources and actions"). Samme
// for alle transportører - Shipmondo oversætter DAO's, GLS' og PostNords
// hændelser til dem:
//   INFORMED                 fragtfirmaet har data, men ikke pakken  -> ingen hændelse
//   PICKUP_REQUESTED         afhentning bestilt                      -> ingen hændelse
//   GENERAL                  andet (fx forsinkelse)                  -> ingen hændelse
//   EN_ROUTE                 pakken er i fragtfirmaets net           -> i_transit (sætter også afleveret_kl)
//   AVAILABLE_FOR_DELIVERY   klar i pakkeshoppen                     -> klar_til_afhentning
//   DELIVERED                leveret / hentet i pakkeshoppen         -> leveret
// current_state DANGER (pakken sidder fast, er tabt eller sendes snart
// retur) giver desuden en 'fejl'-hændelse (kun markering til staff).
// Ukendte statusser ændrer aldrig status (gemmes i fragt_ukendte_koder).
export const MONITOR_STATUSSER: Record<string, SporingsType | null> = {
  INFORMED: null,
  PICKUP_REQUESTED: null,
  GENERAL: null,
  EN_ROUTE: "i_transit",
  AVAILABLE_FOR_DELIVERY: "klar_til_afhentning",
  DELIVERED: "leveret",
};
const MONITOR_STATES = new Set(["NEUTRAL", "PROGRESSING", "WARNING", "DANGER", "SUCCESS"]);

// Shipment Monitor har ingen retur-status. Teksten fra transportøren er det
// eneste tegn (DAO/PostNord: "retur", "returneret til afsender"; GLS:
// "return", "returned to sender").
const RETUR_TEKST = /retur|return|til afsender|to sender|back to (the )?sender/i;

// Til fragt_ukendte_koder: kun bogstaver, tal og _ (højst 40 tegn).
function renKode(v: unknown): string {
  return String(v ?? "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
}

// Shipment Monitor-hændelse -> normaliseret type. Ren funktion.
//   { type } kendt status (type kan være null = ingen statusændring)
//   { ukendt } ukendt status eller transportør - ændrer aldrig status
// forsendelseType styrer returteksten:
//   - retur (køber -> sælger): teksten bruges ALDRIG (en returpakke kan hedde
//     "retur" hos fragtfirmaet).
//   - udgående: kun ved DELIVERED - "leveret" med returtekst er leveret
//     tilbage til afsenderen og bliver 'returneret', aldrig 'leveret'.
// leveret_kl styrer frigivelsen af penge; stedet tjekkes desuden i
// vurderMonitorHaendelse.
export function monitorTilType(
  m: Monitor,
  forsendelseType: "udgaaende" | "retur",
): { type: SporingsType | null; ukendt?: undefined } | { ukendt: string; type?: undefined } {
  const status = String(m.current_status ?? "").toUpperCase();
  const tekst = String(m.current_status_text ?? "");
  if (!transportoerFraCarrier(m.carrier_code)) return { ukendt: `carrier:${renKode(m.carrier_code) || "tom"}` };
  if (!Object.hasOwn(MONITOR_STATUSSER, status)) return { ukendt: renKode(status) || "tom" };
  if (forsendelseType === "udgaaende" && status === "DELIVERED" && RETUR_TEKST.test(tekst)) return { type: "returneret" };
  return { type: MONITOR_STATUSSER[status] };
}

// By til sammenligning: første ord, små bogstaver ("ODENSE C" -> "odense",
// "København Ø" -> "københavn").
function byNoegle(by: string | null | undefined): string {
  return String(by ?? "").toLowerCase().replace(/[^a-zæøåäöüé\s-]/g, " ").trim().split(/[\s-]+/)[0] ?? "";
}

// Passer stedet, Shipmondo melder pakken leveret, med hvor den skulle hen?
// Postnummer (hvis Shipmondo sender det) eller byen (første ord - også byen
// fra postnummeret). Uden by fra Shipmondo: nej (staff ser på det).
export function stedPasser(
  monitor: { by: string | null; postnummer: string | null },
  steder: ForsendelseKontekst["steder"],
): boolean {
  const pn = (monitor.postnummer ?? "").trim();
  if (/^\d{4}$/.test(pn) && steder.some((s) => s.postnummer === pn)) return true;
  const mb = byNoegle(monitor.by);
  if (!mb) return false;
  const byer = new Set(
    steder
      .flatMap((s) => [s.by, s.postnummer ? (slaaPostnummerOp(s.postnummer)?.by ?? null) : null])
      .map(byNoegle)
      .filter(Boolean),
  );
  return byer.has(mb);
}

// Hændelserne fra én Shipment Monitor-besked. Statushændelsen er FORELØBIG
// (raa.vurderes = true): webhook-ruten slår forsendelsen op og kalder
// vurderMonitorHaendelse, før noget gemmes. DANGER giver desuden en
// 'fejl'-hændelse (kun markering).
export function monitorHaendelser(m: Monitor): { haendelser: WebhookHaendelse[]; ukendte: UkendtSporingskode[] } {
  const ud = { haendelser: [] as WebhookHaendelse[], ukendte: [] as UkendtSporingskode[] };
  if (m.shipment_id === undefined || m.shipment_id === null) return ud;
  const id = String(m.shipment_id).slice(0, 50);
  if (!/^\d{1,20}$/.test(id)) return ud;
  const status = String(m.current_status ?? "").toUpperCase().slice(0, 40);
  const state = String(m.current_state ?? "").toUpperCase().slice(0, 40);
  const sporingsnummer = m.carrier_track_id ? String(m.carrier_track_id).slice(0, 100) : null;
  const tekst = m.current_status_text ? String(m.current_status_text).slice(0, 300) : null;
  const transportoer = transportoerFraCarrier(m.carrier_code);

  // Kendt status og transportør? (Typen afgøres først med forsendelsen.)
  const r = monitorTilType(m, "retur");
  if (r.ukendt !== undefined) {
    ud.ukendte.push({ kode: r.ukendt, liste: transportoer ?? "", beskrivelse: tekst, sporingsnummer });
    return ud;
  }
  if (state && !MONITOR_STATES.has(state)) {
    // En ukendt state ændrer ikke noget, men registreres.
    ud.ukendte.push({ kode: `state:${renKode(state)}`, liste: transportoer ?? "", beskrivelse: tekst, sporingsnummer });
  }
  const registreret = m.current_status_registered_at ?? null;
  const harTid = !!registreret && !Number.isNaN(Date.parse(registreret));
  const tid = harTid ? new Date(registreret!).toISOString() : new Date().toISOString();
  const maaltVaegt = m.weight && /^\d+(\.\d+)?$/.test(m.weight) ? Math.round(Number(m.weight) * 1000) : null;
  const postnummer = String(m.zipcode ?? m.postal_code ?? "").trim().slice(0, 10) || null;
  const raa = {
    status: status || null,
    state: state || null,
    tekst,
    transportoer,
    // Fragtfirmaets målte vægt i gram (bevis i sager), hvis den er med.
    maalt_vaegt_gram: maaltVaegt,
    by: m.city ? String(m.city).slice(0, 80) : null,
    postnummer,
  };
  const basis = { forsendelsesId: id, sporingsnummer, transportoer, tidspunkt: tid, beskrivelse: tekst };
  if (r.type) {
    // Uden tidspunkt fra Shipmondo: nøglen uden tid, så samme besked to
    // gange stadig er én hændelse.
    const noegle = `shipmondo:${id}:${status}:${state}:${harTid ? tid : "uden-tid"}`;
    ud.haendelser.push({ ...basis, type: r.type, noegle, raa: { ...raa, vurderes: true } });
  }
  // DANGER: markering til staff (ændrer ikke status). Én pr. status.
  if (state === "DANGER") {
    ud.haendelser.push({
      ...basis,
      type: "fejl",
      noegle: `shipmondo:${id}:${status}:DANGER`,
      beskrivelse: `Shipmondo: pakken er forsinket eller sidder fast (${status || "ukendt status"})${tekst ? ` - ${tekst}` : ""}`.slice(0, 300),
      raa,
    });
  }
  return ud;
}

// Den endelige hændelse, når forsendelsen er kendt (webhook-ruten). Ren
// funktion; 0 eller 1 hændelse.
//   - returteksten efter forsendelsens type (monitorTilType)
//   - 'leveret' kun, når stedet passer med pakkeshoppen/modtageren - ellers
//     en 'fejl' (markering til staff), og leveret_kl sættes ikke.
export function vurderMonitorHaendelse(h: WebhookHaendelse, k: ForsendelseKontekst): WebhookHaendelse[] {
  const raa = (h.raa ?? {}) as Record<string, unknown>;
  if (raa.vurderes !== true) return [h];
  const t = erTransportoer(raa.transportoer) ? raa.transportoer : null;
  const r = monitorTilType(
    {
      carrier_code: t ? PRODUKTER[t].carrier : null,
      current_status: typeof raa.status === "string" ? raa.status : "",
      current_status_text: typeof raa.tekst === "string" ? raa.tekst : null,
    },
    k.type,
  );
  if (!r.type) return [];
  const rest: Record<string, unknown> = { ...raa };
  delete rest.vurderes;
  if (r.type === "leveret") {
    const sted = {
      by: typeof raa.by === "string" ? raa.by : null,
      postnummer: typeof raa.postnummer === "string" ? raa.postnummer : null,
    };
    if (!stedPasser(sted, k.steder)) {
      const forventet =
        k.steder.map((s) => [s.postnummer, s.by].filter(Boolean).join(" ")).filter(Boolean).join(" / ") || "ukendt";
      const meldt = [sted.postnummer, sted.by].filter(Boolean).join(" ") || "ukendt by";
      return [
        {
          ...h,
          type: "fejl",
          noegle: `${h.noegle}:sted`,
          beskrivelse: `Shipmondo melder pakken leveret i ${meldt}, men den skulle leveres i ${forventet}. Den er ikke registreret som leveret - tjek sporingen hos fragtfirmaet.`.slice(0, 300),
          raa: rest,
        },
      ];
    }
  }
  return [{ ...h, type: r.type, raa: rest }];
}

async function fortolk(request: Request): Promise<WebhookResultat> {
  const noegle = webhookNoegle();
  // Fail closed: uden nøgle afvises alt.
  if (!noegle) return { ok: false, status: 503, fejl: "Webhook-nøglen er ikke sat op" };
  const body = await request.text();
  // Ruten har allerede et loft på 64 KB; her et ekstra loft for adapteren.
  if (body.length > 64 * 1024) return { ok: false, status: 413, fejl: "For stor" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, fejl: "Ugyldig JSON" };
  }
  const jwt = (json as { data?: unknown })?.data;
  if (typeof jwt !== "string" || jwt.length > 60_000) return { ok: false, status: 400, fejl: "Mangler data" };
  const payload = verificerJwtHs256(jwt, noegle);
  if (!payload || typeof payload !== "object") return { ok: false, status: 401, fejl: "Ugyldig signatur" };

  const ressource = (request.headers.get("smd-resource-type") ?? "").toLowerCase();
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return { ok: true, haendelser: [] };

  // Kun Shipment Monitor giver sporing. Andre ressourcer (fx Shipments
  // create/cancel) kvitteres med 200 uden hændelser.
  const erMonitor =
    ressource.includes("monitor") || ("current_status" in data && "shipment_id" in data);
  if (!erMonitor) return { ok: true, haendelser: [] };
  const r = monitorHaendelser(data as Monitor);
  return { ok: true, haendelser: r.haendelser, ukendte: r.ukendte };
}

// ------------------------------------------------------------ adapter

// GLS er slået fra, indtil Shipmondo har svaret på, om GLS kan sendes
// labelfrit (Filip, 15. okt. 2026). Slås til med SHIPMONDO_GLS_AKTIV=true
// (alt andet = fra; fail closed). Uden flaget kan køberen ikke vælge GLS i
// checkout (hjemmeside og app), og databasen afviser GLS (handel_gem_levering
// kræver gls_aktiv = true fra serveren, 20261024020000). Forsendelser, der
// allerede er lavet med GLS (labels, sporing, retur), virker videre.
export function shipmondoGlsAktiv(): boolean {
  return process.env.SHIPMONDO_GLS_AKTIV === "true";
}

export const shipmondoFirma: Fragtfirma = {
  navn: "shipmondo",
  visningsnavn: "Shipmondo",
  // Transportører, køberen kan vælge nu (uden GLS, medmindre flaget er sat).
  get transportoerer() {
    return shipmondoGlsAktiv() ? TRANSPORTOERER : TRANSPORTOERER.filter((t) => t !== "gls");
  },
  erSatOp,
  // Shipmondo har intet efterlysnings-API: staff efterlyser hos
  // transportøren efter 14 dage uden leveringsmelding.
  efterlysningUdenApi: true,
  // Shipment Monitor har ingen retur-status - 'returneret' gættes ud fra en
  // tekst. Derfor kun automatisk "ikke afhentet", når Filip har slået det
  // til efter at have set det på rigtige pakker.
  get returErIkkeAfhentet() {
    return process.env.SHIPMONDO_RETUR_ER_IKKE_AFHENTET === "true";
  },

  // Købers pris kommer fra databasen (fragt_pakkestoerrelser) - ikke herfra.
  async beregnPris() {
    throw new FragtFejl("Fragtprisen står på auktionen.", "beregnPris bruges ikke for Shipmondo");
  },

  opretForsendelse: (input) => opret(input, false),
  opretReturforsendelse: (input) => opret(input, true),

  // { cancelled: true, cancelled_at_carrier } (GLS/PostNord). DAO: 422.
  async annullerForsendelse(forsendelsesId) {
    if (!/^\d{1,20}$/.test(forsendelsesId)) throw new FragtFejl("Forsendelsen findes ikke hos fragtfirmaet.");
    let r: { cancelled?: boolean; cancelled_at_carrier?: boolean };
    try {
      r = await kald<{ cancelled?: boolean; cancelled_at_carrier?: boolean }>("PUT", `/shipments/${forsendelsesId}/cancel`);
    } catch (err) {
      if (err instanceof ShipmondoFejl && (err.status === 422 || err.status === 404)) {
        throw new FragtAnnulleringIkkeMulig(err.message);
      }
      throw err;
    }
    if (!r?.cancelled) throw new FragtAnnulleringIkkeMulig("Shipmondo annullerede ikke forsendelsen.");
    return { bekraeftet: r.cancelled_at_carrier === true };
  },

  // Shipmondo API v3 har ingen sporing at hente - kun webhooken.
  async hentSporing(): Promise<Sporingshaendelse[]> {
    return [];
  },

  async hentLabel(forsendelsesId) {
    if (!/^\d{1,20}$/.test(forsendelsesId)) throw new FragtFejl("Forsendelsen findes ikke hos fragtfirmaet.");
    return { type: "pdf", data: await hentLabel(Number(forsendelsesId)) };
  },

  fortolkWebhook: fortolk,
  vurderWebhookHaendelse: vurderMonitorHaendelse,
  soegPakkeshops: soeg,

  async hentPakkeshop(id, naer) {
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(id)) return null;
    const liste = await soeg({ ...naer, antal: 20 });
    return liste.find((p) => p.id === id) ?? null;
  },
};
