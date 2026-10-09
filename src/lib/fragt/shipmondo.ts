import "server-only";

// Shipmondo med DAO som fragtfirma (Filip, 9. okt. 2026). Verificeret mod
// Shipmondos sandbox 9. okt. 2026 (API v3, shipmondo.dev).
//
// Env:
//   SHIPMONDO_API_URL          sandbox: https://sandbox.shipmondo.com/api/public/v3
//                              produktion: https://app.shipmondo.com/api/public/v3
//   SHIPMONDO_API_BRUGER       API-bruger (Basic auth)
//   SHIPMONDO_API_NOEGLE       API-nøgle (Basic auth)
//   SHIPMONDO_WEBHOOK_NOEGLE   nøglen, der indtastes ved oprettelse af webhooken
//                              (Shipmondo signerer med JWT HS256)
//   SHIPMONDO_EGEN_AFTALE      "true" = book på BidHamrs egen DAO-aftale hos
//                              Shipmondo (own_agreement). Standard: Shipmondos aftale.
//
// DAO-produkter (GET /products?carrier_code=dao, sandbox 9. okt. 2026):
//   DAO_STS  daoSHOP (drop-off)  = Shop2Shop: indlevering i pakkeshop, levering
//            til pakkeshop. service_point krævet. Vægttrin 250 g - 15 kg.
//   DAO_STH  daoHOME (drop-off)  = Shop2Home: indlevering i pakkeshop, levering
//            til døren. Vægttrin 250 g - 5 kg.
//   (DAO_P / DAO_H er med afhentning hos afsender, DAO_R "daoRETURN" kun til
//   erhvervsadresser - bruges ikke.)
//   Notifikation: mindst én af EMAIL_NT / SMS_NT er krævet.
//   Labelfri: svaret har `labelless_code` (DAO's kode, der skrives på pakken).
//   QR-kode (GET /shipments/{id}/qr_code) findes kun med servicen QR_CODE, som
//   DAO ikke har - derfor PDF-label + labelfri-kode.
//   Annullering (PUT /shipments/{id}/cancel): DAO svarer 422 "It's not
//   possible to cancel this shipment." - se FragtAnnulleringIkkeMulig.
//   Sporing: Shipmondo har intet sporings-endpoint i API v3 - sporingen kommer
//   KUN via webhooken "Shipment Monitor" (latest/delivered). hentSporing
//   returnerer derfor ingen hændelser (cron kan ikke hente sporing).
import { createHmac, timingSafeEqual } from "node:crypto";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { beregnAfstandKm } from "@/lib/distance";
import {
  type Adresse,
  type ForsendelseInput,
  type Fragtfirma,
  type OprettetForsendelse,
  type Pakkeshop,
  type PakkeshopSoegning,
  type Pakkestoerrelse,
  type Sporingshaendelse,
  type SporingsType,
  type WebhookHaendelse,
  type WebhookResultat,
  FragtAnnulleringIkkeMulig,
  FragtFejl,
  FragtUkendtUdfald,
  FRAGT_IKKE_SAT_OP,
} from "@/lib/fragt/types";

export const DAO_PAKKESHOP = "DAO_STS";
export const DAO_DOER = "DAO_STH";

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
  product_code: string | null;
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

function notifikationer(modtager: Adresse): string {
  const koder: string[] = [];
  if (modtager.email) koder.push("EMAIL_NT");
  if (telefon(modtager.telefon)) koder.push("SMS_NT");
  if (koder.length === 0) throw new FragtFejl("Modtagerens e-mail eller telefonnummer mangler.");
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

function tilOprettet(s: ShipmondoForsendelse, label: Uint8Array): OprettetForsendelse {
  const sporing = s.pkg_no ?? s.parcels?.[0]?.pkg_no ?? null;
  if (!s.id || !sporing) throw new Error("Shipmondo: svaret mangler id eller pakkenummer");
  const labelfri = s.labelless_code ?? s.parcels?.[0]?.labelless_code ?? null;
  return {
    forsendelsesId: String(s.id),
    sporingsnummer: sporing,
    label: { type: "pdf", data: label },
    qrKode: labelfri ? String(labelfri).slice(0, 100) : null,
    prisOere: prisOere(s.price),
    produkt: s.product_code,
  };
}

// Idempotens: BidHamrs forsendelses-id er referencen. Findes der allerede en
// forsendelse med referencen (genforsøg efter timeout), genbruges den.
async function findMedReference(reference: string): Promise<ShipmondoForsendelse | null> {
  const liste = await kald<ShipmondoForsendelse[]>(
    "GET",
    `/shipments?reference=${encodeURIComponent(reference)}&per_page=5`,
  );
  return (Array.isArray(liste) ? liste : []).find((s) => s.reference === reference) ?? null;
}

// Fejl fra opret():
//   FragtFejl          kun valideringsfejl FØR ethvert kald og 4xx-svar på
//                      POST /shipments - dér er intet oprettet.
//   FragtUkendtUdfald  alt andet: netværk/timeout/5xx/ikke-JSON på opslaget
//                      efter referencen, på POST eller på hentning af labelen,
//                      og fejl i svaret efter en vellykket POST. Forsendelsen
//                      kan findes hos Shipmondo - næste forsøg genbruger
//                      referencen.
async function opret(input: ForsendelseInput, retur: boolean): Promise<OprettetForsendelse> {
  // 1. Validering før ethvert kald (FragtFejl).
  const levering = retur ? "pakkeshop" : (input.levering ?? "pakkeshop");
  const vaegt = Math.max(1, Math.round(input.vaegtGram ?? MAKS_GRAM[input.pakkestoerrelse]));
  if (vaegt > MAKS_GRAM.stor) throw new FragtFejl("Pakken er for tung til at blive sendt.");
  if (levering === "doer" && vaegt > DOER_MAKS_GRAM) {
    throw new FragtFejl("Levering til døren kan kun bruges op til 5 kg.");
  }
  if (levering === "pakkeshop" && !retur && !input.pakkeshopId) {
    throw new FragtFejl("Køberen har ikke valgt en pakkeshop.");
  }
  const body: Record<string, unknown> = {
    own_agreement: process.env.SHIPMONDO_EGEN_AFTALE === "true",
    product_code: levering === "doer" ? DAO_DOER : DAO_PAKKESHOP,
    service_codes: notifikationer(input.modtager),
    reference: input.reference,
    label_format: "a4_pdf",
    contents: input.handel.titel.slice(0, 60),
    parties: [part("sender", input.afsender), part("receiver", input.modtager)],
    parcels: [{ quantity: 1, weight: vaegt }],
  };
  if (levering === "pakkeshop") {
    if (input.pakkeshopId) body.service_point_id = input.pakkeshopId;
    // Retur: Shipmondo vælger pakkeshoppen nærmest sælgerens adresse.
    else body.automatic_select_service_point = true;
  }
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
      return tilOprettet(findes, await hentLabel(findes.id));
    } catch (err) {
      throw ukendt("label til eksisterende forsendelse", err);
    }
  }

  // 3. Opret.
  let s: ShipmondoForsendelse;
  try {
    s = await kald<ShipmondoForsendelse>("POST", "/shipments", body);
  } catch (err) {
    // Afvist (4xx): intet er oprettet.
    if (err instanceof ShipmondoFejl && err.status >= 400 && err.status < 500) {
      throw new FragtFejl(
        err.status === 422
          ? "Fragtfirmaet kunne ikke oprette pakken. Tjek adresserne og prøv igen."
          : GENERISK,
        err.message,
      );
    }
    throw ukendt("POST /shipments", err);
  }
  try {
    const label = s.labels?.find((l) => l.file_format === "pdf")?.base64;
    return tilOprettet(s, label ? base64TilBytes(label) : await hentLabel(s.id));
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
    if (err instanceof ShipmondoFejl && err.status === 404) throw new FragtFejl("Forsendelsen findes ikke hos Shipmondo.");
    throw err;
  }
  const o = tilOprettet(f, await hentLabel(f.id));
  const v = f.parcels?.[0]?.weight;
  return {
    ...o,
    reference: f.reference,
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
  opening_hours?: string[];
  pickup_allowed?: boolean;
  drop_off_allowed?: boolean;
};

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
};

function aabningstider(linjer: string[] | undefined): { dag: string; tider: string }[] {
  return (linjer ?? []).slice(0, 14).flatMap((l) => {
    const m = /^\s*([^:]+):\s*(.+)$/.exec(String(l));
    if (!m) return [];
    const dag = DAGE[m[1].trim().toLowerCase()] ?? m[1].trim();
    return [{ dag: dag.slice(0, 20), tider: m[2].trim().slice(0, 60) }];
  });
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
    by: String(p.city ?? "").slice(0, 80),
    lat,
    lng,
    afstandM: afstand,
    aabningstider: aabningstider(p.opening_hours),
  };
}

async function soeg(q: PakkeshopSoegning): Promise<Pakkeshop[]> {
  const opslag = slaaPostnummerOp(q.postnummer);
  if (!opslag) throw new FragtFejl("Ukendt postnummer.");
  const params = new URLSearchParams({
    product_code: DAO_PAKKESHOP,
    country_code: "DK",
    zipcode: opslag.postnummer,
    city: (q.by ?? opslag.by).slice(0, 60),
    // Shipmondo: højst 20 (422 "Exceeded quantity maximum of 20").
    quantity: String(Math.min(Math.max(q.antal ?? 10, 1), 20)),
  });
  if (q.adresse) params.set("address", q.adresse.slice(0, 100));
  const liste = await kald<ShipmondoPakkeshop[]>("GET", `/service_point/service_points?${params}`);
  return (Array.isArray(liste) ? liste : [])
    .filter((p) => p && p.id && p.pickup_allowed !== false)
    .map((p) => tilPakkeshop(p, { lat: opslag.lat, lng: opslag.lng }))
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
};

// Shipment Monitor-status -> normaliseret type. null = ingen hændelse.
export function monitorTilType(m: Monitor): SporingsType | null {
  const status = String(m.current_status ?? "").toUpperCase();
  const state = String(m.current_state ?? "").toUpperCase();
  const tekst = String(m.current_status_text ?? "");
  if (status === "DELIVERED") return "leveret";
  // Shipment Monitor har ingen retur-status. Teksten fra DAO bruges som tegn;
  // staff vurderer altid (returneret markeres kun til staff).
  if (/retur/i.test(tekst)) return "returneret";
  if (state === "DANGER") return "fejl";
  if (status === "AVAILABLE_FOR_DELIVERY") return "klar_til_afhentning";
  if (status === "EN_ROUTE") return "i_transit";
  return null;
}

function monitorHaendelse(m: Monitor): WebhookHaendelse | null {
  const type = monitorTilType(m);
  if (!type || m.shipment_id === undefined || m.shipment_id === null) return null;
  const id = String(m.shipment_id).slice(0, 50);
  if (!/^\d{1,20}$/.test(id)) return null;
  const tid =
    m.current_status_registered_at && !Number.isNaN(Date.parse(m.current_status_registered_at))
      ? new Date(m.current_status_registered_at).toISOString()
      : new Date().toISOString();
  const maaltVaegt = m.weight && /^\d+(\.\d+)?$/.test(m.weight) ? Math.round(Number(m.weight) * 1000) : null;
  return {
    forsendelsesId: id,
    sporingsnummer: m.carrier_track_id ? String(m.carrier_track_id).slice(0, 100) : null,
    type,
    tidspunkt: tid,
    noegle: `shipmondo:${id}:${String(m.current_status ?? "")}:${String(m.current_state ?? "")}:${tid}`,
    beskrivelse: m.current_status_text ? String(m.current_status_text).slice(0, 300) : null,
    raa: {
      status: m.current_status ?? null,
      state: m.current_state ?? null,
      tekst: m.current_status_text ? String(m.current_status_text).slice(0, 300) : null,
      // Fragtfirmaets målte vægt i gram (bevis i sager), hvis den er med.
      maalt_vaegt_gram: maaltVaegt,
      by: m.city ? String(m.city).slice(0, 80) : null,
    },
  };
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
  const h = monitorHaendelse(data as Monitor);
  return { ok: true, haendelser: h ? [h] : [] };
}

// ------------------------------------------------------------ adapter

export const shipmondoFirma: Fragtfirma = {
  navn: "shipmondo",
  visningsnavn: "DAO",

  // Købers pris kommer fra databasen (fragt_pakkestoerrelser) - ikke herfra.
  async beregnPris() {
    throw new FragtFejl("Fragtprisen står på auktionen.", "beregnPris bruges ikke for Shipmondo");
  },

  opretForsendelse: (input) => opret(input, false),
  opretReturforsendelse: (input) => opret(input, true),

  async annullerForsendelse(forsendelsesId) {
    if (!/^\d{1,20}$/.test(forsendelsesId)) throw new FragtFejl("Forsendelsen findes ikke hos fragtfirmaet.");
    try {
      const r = await kald<{ cancelled?: boolean }>("PUT", `/shipments/${forsendelsesId}/cancel`);
      if (!r?.cancelled) throw new FragtAnnulleringIkkeMulig("Shipmondo annullerede ikke forsendelsen.");
    } catch (err) {
      if (err instanceof ShipmondoFejl && (err.status === 422 || err.status === 404)) {
        throw new FragtAnnulleringIkkeMulig(err.message);
      }
      throw err;
    }
  },

  // Shipmondo API v3 har ingen sporing at hente - kun webhooken.
  async hentSporing(): Promise<Sporingshaendelse[]> {
    return [];
  },

  fortolkWebhook: fortolk,
  soegPakkeshops: soeg,

  async hentPakkeshop(id, naer) {
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(id)) return null;
    const liste = await soeg({ ...naer, antal: 20 });
    return liste.find((p) => p.id === id) ?? null;
  },
};
