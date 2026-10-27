import "server-only";

// Data til firmasiden i admin (Admin -> Erhverv -> Firmaer -> [firma]).
// Kaldes KUN efter kraevErhvervSide() (chef og sælger-rollen) med dens
// service-role-klient. Hver funktion fejler blødt: en fejl giver null eller
// { fejl }, så resten af siden stadig vises.
import type { createAdminClient } from "@/lib/supabase/admin";
import { manglerUgensButik } from "@/lib/betaling/ugensButik";
import { erSystem } from "@/lib/moderationLog";
import { nrITraek } from "@/lib/erhverv/ugensButikStribe";

type Admin = ReturnType<typeof createAdminClient>;

// --- Kvote (erhverv_kvote: nuværende ugekvote) --------------------------------

// Kvoten er pr. KALENDERMÅNED (20261102010000). maks: null = ubegrænset.
// max/naeste_uge er de gamle felter (max = maks, 0 ved ubegrænset;
// naeste_uge = den 1. i næste måned) - brug maks/naeste_maaned.
export type FirmaKvote = {
  brugt: number;
  max: number;
  maks: number | null;
  ekstra: number;
  ubegraenset: boolean;
  naeste_uge: string;
  naeste_maaned: string;
};

export async function hentFirmaKvote(admin: Admin, brugerId: string): Promise<FirmaKvote | null> {
  const { data, error } = await admin.rpc("erhverv_kvote", { p_bruger: brugerId, p_laas: false });
  if (error || !data) {
    if (error) console.error("erhverv_kvote:", error.message);
    return null;
  }
  const k = data as { brugt?: number; max?: number | null; ekstra?: number; ubegraenset?: boolean; naeste_maaned?: string; naeste_uge?: string };
  const maks = k.max == null ? null : Number(k.max);
  const naeste = String(k.naeste_maaned ?? k.naeste_uge ?? "");
  return {
    brugt: Number(k.brugt ?? 0),
    max: maks ?? 0,
    maks,
    ekstra: Number(k.ekstra ?? 0),
    ubegraenset: !!k.ubegraenset,
    naeste_uge: naeste,
    naeste_maaned: naeste,
  };
}

// --- Ugens butik ---------------------------------------------------------------

export type UgeCelle = {
  uge_start: string;
  uge_nr: number;
  aar: number;
  booking_id: string | null;
  status: string | null;
  firma_id: string | null;
  firmanavn: string | null;
  // Loft-status for en booket uge (20261102020000).
  i_traek?: number | null;
  loft_brudt?: boolean | null;
  loft_omgaaet?: boolean | null;
  // Ugens plads i striben (1 = første uge i træk) - regnet af nrITraek.
  nr_i_traek?: number | null;
};

export type UgensBooking = {
  id: string;
  uge_start: string;
  status: string;
  kilde: "firma" | "staff";
  betaling: "stripe" | "ingen";
  beloeb_oere: number;
  rabat_procent: number;
  reserveret_til: string | null;
  betalt_kl: string | null;
  refunderet_kl: string | null;
  annulleret_kl: string | null;
  note: string | null;
  kraever_opmaerksomhed: boolean;
  opmaerksomhed_tekst: string | null;
  oprettet_kl: string;
};

// Prisen for firmaet for en ledig uge (ugens_butik_pris_for - med pakkens rabat).
export type UgePris = { inkl_oere: number; rabat_procent: number };

export type FirmaUgensButik = {
  denneUge: string;
  pris: { ekskl_moms_oere: number; inkl_moms_oere: number };
  uger: UgeCelle[];
  bookinger: UgensBooking[];
  priser: Record<string, UgePris>;
  // Alle ledige uger fra den igangværende og op til staff_maks_uger_frem (52)
  // uger frem - til "Book Ugens butik". Kalenderen viser kun de første 8.
  ledige: { uge_start: string; uge_nr: number; aar: number; pris: UgePris | null }[];
  rabat: { procent: number; antal: number; brugt: number } | null;
  // Pakkens rabat og firmaets egen (tilsidesætter pakkens; null = følger pakken).
  rabatIndstilling: {
    pakkeProcent: number;
    pakkeAntal: number;
    egen: { procent: number; antal: number; begrundelse: string | null; opdateret_kl: string | null; opdateret_af_navn: string | null } | null;
  } | null;
};

type AdminFirmaRaekke = {
  id: string;
  pakke_rabat_procent?: number;
  pakke_rabat_antal?: number;
  egen_rabat?: { procent: number; antal: number; begrundelse: string | null; opdateret_kl: string | null; opdateret_af_navn: string | null } | null;
};

const BOOKING_KOLONNER =
  "id, uge_start, status, kilde, betaling, beloeb_oere, rabat_procent, reserveret_til, betalt_kl, refunderet_kl, " +
  "annulleret_kl, note, kraever_opmaerksomhed, opmaerksomhed_tekst, oprettet_kl";

export const UGER_I_KALENDER = 8;
// Som staff_maks_uger_frem i ugens_butik_indstillinger (standard 52).
const STAFF_UGER_FREM_STANDARD = 52;
const HOLDER_STATUS = ["reserveret", "behandles", "betalt", "manuel"];

// "2026-11-02" + n uger -> "2026-11-16".
function plusUger(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}

// ISO-uge og -år (som to_char(.., 'IW') og 'IYYY' i databasen).
function isoUge(iso: string): { nr: number; aar: number } {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const aar = d.getUTCFullYear();
  return { nr: Math.ceil(((d.getTime() - Date.UTC(aar, 0, 1)) / 86400000 + 1) / 7), aar };
}

export async function hentFirmaUgensButik(
  admin: Admin,
  staffId: string,
  firmaId: string,
): Promise<FirmaUgensButik | { fejl: "mangler" | "fejl" }> {
  const [oversigt, bookinger] = await Promise.all([
    admin.rpc("ugens_butik_admin", { p_staff: staffId }),
    admin
      .from("ugens_butik_bookinger")
      .select(BOOKING_KOLONNER)
      .eq("firma_id", firmaId)
      .order("uge_start", { ascending: false })
      .order("oprettet_kl", { ascending: false })
      .limit(30)
      .returns<UgensBooking[]>(),
  ]);
  if (oversigt.error || bookinger.error) {
    const err = oversigt.error ?? bookinger.error;
    if (manglerUgensButik(err)) return { fejl: "mangler" };
    console.error("Ugens butik (firmaside):", err?.message);
    return { fejl: "fejl" };
  }
  const o = oversigt.data as {
    denne_uge: string;
    pris: { ekskl_moms_oere: number; inkl_moms_oere: number };
    uger: UgeCelle[];
    firmaer?: AdminFirmaRaekke[];
  } | null;
  if (!o) return { fejl: "fejl" };
  // Ugens plads i striben regnes på hele listen, før den kortes.
  const alleUger = o.uger ?? [];
  const nr = nrITraek(alleUger);
  const uger = alleUger.map((u, i) => ({ ...u, nr_i_traek: nr[i] })).slice(0, UGER_I_KALENDER);

  // Staff kan booke op til staff_maks_uger_frem uger frem (ROADMAP-
  // BESLUTNINGER: 52). ugens_butik_admin giver kun maks_uger_frem (12) uger,
  // så de optagne uger længere fremme læses direkte (samme statusser som
  // RPC'en). Databasen (ugens_butik_staff_book) tjekker det endelige.
  const [indstilling, optagetSvar] = await Promise.all([
    admin
      .from("ugens_butik_indstillinger")
      .select("staff_maks_uger_frem")
      .eq("id", true)
      .maybeSingle<{ staff_maks_uger_frem: number }>(),
    admin
      .from("ugens_butik_bookinger")
      .select("uge_start")
      .in("status", HOLDER_STATUS)
      .gte("uge_start", o.denne_uge)
      .lte("uge_start", plusUger(o.denne_uge, 104))
      .returns<{ uge_start: string }[]>(),
  ]);
  const ugerFrem = Number(indstilling.data?.staff_maks_uger_frem ?? STAFF_UGER_FREM_STANDARD);
  const optaget = new Set((optagetSvar.data ?? []).map((b) => b.uge_start.slice(0, 10)));
  for (const u of alleUger) if (u.booking_id) optaget.add(u.uge_start);
  const ledigeStart: string[] = [];
  if (!optagetSvar.error) {
    for (let i = 0; i <= ugerFrem; i++) {
      const uge = plusUger(o.denne_uge, i);
      if (!optaget.has(uge)) ledigeStart.push(uge);
    }
  } else {
    console.error("Ugens butik (optagne uger):", optagetSvar.error.message);
    // Uden de optagne uger: kun RPC'ens ledige uger.
    for (const u of alleUger) if (!u.booking_id) ledigeStart.push(u.uge_start);
  }

  // Prisen afhænger kun af kalenderåret (ugens_butik_pris_for: rabatten
  // tælles pr. kalenderår), så den hentes én gang pr. år.
  const aarFoersteUge = new Map<number, string>();
  for (const uge of ledigeStart) {
    const aar = Number(uge.slice(0, 4));
    if (!aarFoersteUge.has(aar)) aarFoersteUge.set(aar, uge);
  }
  const aarListe = [...aarFoersteUge.entries()];
  const [prisSvar, rabatSvar] = await Promise.all([
    Promise.all(aarListe.map(([, uge]) => admin.rpc("ugens_butik_pris_for", { p_firma: firmaId, p_uge: uge }))),
    admin.rpc("ugens_butik_rabat", { p_firma: firmaId, p_uge: o.denne_uge }),
  ]);
  const prisPrAar = new Map<number, UgePris>();
  aarListe.forEach(([aar], i) => {
    const r = prisSvar[i];
    const raekke = (Array.isArray(r.data) ? r.data[0] : r.data) as { inkl_oere?: number; rabat_procent?: number } | null;
    if (!r.error && raekke?.inkl_oere != null) {
      prisPrAar.set(aar, { inkl_oere: Number(raekke.inkl_oere), rabat_procent: Number(raekke.rabat_procent ?? 0) });
    }
  });
  const prisFor = (uge: string) => prisPrAar.get(Number(uge.slice(0, 4))) ?? null;
  const priser: Record<string, UgePris> = {};
  for (const u of uger) {
    const p = !u.booking_id ? prisFor(u.uge_start) : null;
    if (p) priser[u.uge_start] = p;
  }
  const ledige = ledigeStart.map((uge) => {
    const { nr, aar } = isoUge(uge);
    return { uge_start: uge, uge_nr: nr, aar, pris: prisFor(uge) };
  });
  const rabatRaekke = (Array.isArray(rabatSvar.data) ? rabatSvar.data[0] : rabatSvar.data) as
    | { procent?: number; antal?: number; brugt?: number }
    | null;

  const fr = (o.firmaer ?? []).find((x) => x.id === firmaId) ?? null;

  return {
    rabatIndstilling: fr
      ? {
          pakkeProcent: Number(fr.pakke_rabat_procent ?? 0),
          pakkeAntal: Number(fr.pakke_rabat_antal ?? 0),
          egen: fr.egen_rabat
            ? { ...fr.egen_rabat, procent: Number(fr.egen_rabat.procent), antal: Number(fr.egen_rabat.antal) }
            : null,
        }
      : null,
    denneUge: o.denne_uge,
    pris: { ekskl_moms_oere: Number(o.pris?.ekskl_moms_oere ?? 0), inkl_moms_oere: Number(o.pris?.inkl_moms_oere ?? 0) },
    uger,
    bookinger: bookinger.data ?? [],
    priser,
    ledige,
    rabat:
      !rabatSvar.error && rabatRaekke
        ? { procent: Number(rabatRaekke.procent ?? 0), antal: Number(rabatRaekke.antal ?? 0), brugt: Number(rabatRaekke.brugt ?? 0) }
        : null,
  };
}

// --- Regninger (abonnement) -------------------------------------------------------

export type FirmaRegning = {
  id: string;
  nummer: string | null;
  type: "abonnement" | "opgradering" | "andet";
  periode_fra: string | null;
  periode_til: string | null;
  beloeb_oere: number;
  status: string;
  pdf_url: string | null;
  hosted_url: string | null;
  betalt_kl: string | null;
  oprettet_kl: string;
};

export async function hentFirmaRegninger(admin: Admin, firmaId: string): Promise<FirmaRegning[] | null> {
  const { data, error } = await admin
    .from("firma_regninger")
    .select("id, nummer, type, periode_fra, periode_til, beloeb_oere, status, pdf_url, hosted_url, betalt_kl, oprettet_kl")
    .eq("firma_id", firmaId)
    .order("oprettet_kl", { ascending: false })
    .limit(25)
    .returns<FirmaRegning[]>();
  if (error) {
    console.error("firma_regninger:", error.message);
    return null;
  }
  return data ?? [];
}

// --- Fremhævninger ("Annonce") ------------------------------------------------------

export type FirmaFremhaevning = {
  id: string;
  auktion_id: string;
  titel: string | null;
  start_kl: string;
  slut_kl: string;
  stoppet_kl: string | null;
  tilbagegivet: boolean;
};

export const FREMHAEVNINGER_MAKS = 20;

export async function hentFirmaFremhaevninger(admin: Admin, firmaId: string): Promise<FirmaFremhaevning[] | null> {
  const { data, error } = await admin
    .from("firma_fremhaevninger")
    .select("id, auktion_id, start_kl, slut_kl, stoppet_kl, tilbagegivet")
    .eq("firma_id", firmaId)
    .order("start_kl", { ascending: false })
    .limit(FREMHAEVNINGER_MAKS);
  if (error) {
    console.error("firma_fremhaevninger:", error.message);
    return null;
  }
  const raekker = (data ?? []) as Omit<FirmaFremhaevning, "titel">[];
  const ids = [...new Set(raekker.map((r) => r.auktion_id))];
  const titler = new Map<string, string>();
  if (ids.length) {
    const { data: a } = await admin.from("auctions").select("id, titel").in("id", ids);
    for (const r of (a ?? []) as { id: string; titel: string }[]) titler.set(r.id, r.titel);
  }
  return raekker.map((r) => ({ ...r, titel: titler.get(r.auktion_id) ?? null }));
}

// --- Auktioner og salg ------------------------------------------------------------

export type FirmaAuktion = {
  id: string;
  titel: string;
  slutter_kl: string;
  startpris: number;
  hoejeste: number | null;
  antal_bud: number;
};

export type FirmaHandel = {
  id: string;
  titel: string | null;
  amount: number;
  status: string;
  afhentning: boolean;
  created_at: string;
};

export const SALG_MAKS = 20;

export async function hentFirmaAuktionerOgSalg(
  admin: Admin,
  brugerId: string,
): Promise<{ auktioner: FirmaAuktion[]; salg: FirmaHandel[] } | null> {
  // "nuværende_bud" kan ikke stå i select-strengen uden at supabase-js'
  // type kollapser - derfor castes rækken.
  const [a, t] = await Promise.all([
    admin
      .from("auctions")
      .select("id, titel, slutter_kl, startpris, nuværende_bud, antal_bud")
      .eq("bruger_id", brugerId)
      .eq("status", "aktiv")
      .order("slutter_kl", { ascending: true })
      .limit(SALG_MAKS),
    admin
      .from("trades")
      .select("id, auction_id, amount, status, afhentning, created_at")
      .eq("seller_id", brugerId)
      .order("created_at", { ascending: false })
      .limit(SALG_MAKS),
  ]);
  if (a.error || t.error) {
    console.error("Firmaets auktioner/salg:", (a.error ?? t.error)?.message);
    return null;
  }
  const auktioner = ((a.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    titel: String(r.titel ?? ""),
    slutter_kl: String(r.slutter_kl),
    startpris: Number(r.startpris ?? 0),
    hoejeste: r["nuværende_bud"] == null ? null : Number(r["nuværende_bud"]),
    antal_bud: Number(r.antal_bud ?? 0),
  }));
  const handler = (t.data ?? []) as { id: string; auction_id: string | null; amount: number; status: string; afhentning: boolean | null; created_at: string }[];
  const auktionIds = [...new Set(handler.map((h) => h.auction_id).filter((x): x is string => !!x))];
  const titler = new Map<string, string>();
  if (auktionIds.length) {
    const { data } = await admin.from("auctions").select("id, titel").in("id", auktionIds);
    for (const r of (data ?? []) as { id: string; titel: string }[]) titler.set(r.id, r.titel);
  }
  return {
    auktioner,
    salg: handler.map((h) => ({
      id: h.id,
      titel: h.auction_id ? (titler.get(h.auction_id) ?? null) : null,
      amount: Number(h.amount),
      status: h.status,
      afhentning: !!h.afhentning,
      created_at: h.created_at,
    })),
  };
}

// --- Log (moderation_log for firmaet og firmakontoen) -----------------------------

export type FirmaLogRaekke = {
  id: string;
  handling: string;
  aarsag: string | null;
  oprettet_kl: string;
  medarbejder_navn: string | null;
  system: boolean;
};

export async function hentFirmaLog(
  admin: Admin,
  firmaId: string,
  brugerId: string,
): Promise<FirmaLogRaekke[] | null> {
  const { data, error } = await admin
    .from("moderation_log")
    .select("id, handling, aarsag, oprettet_kl, medarbejder_id")
    .or(`bruger_id.eq.${brugerId},maal_id.eq.${firmaId}`)
    .order("oprettet_kl", { ascending: false })
    .limit(40);
  if (error) {
    console.error("moderation_log (firma):", error.message);
    return null;
  }
  const raekker = (data ?? []) as { id: string; handling: string; aarsag: string | null; oprettet_kl: string; medarbejder_id: string | null }[];
  const ids = [...new Set(raekker.map((r) => r.medarbejder_id).filter((x): x is string => !!x))];
  const navne = new Map<string, string | null>();
  if (ids.length) {
    const { data: staff } = await admin.from("users").select("id, navn").in("id", ids);
    for (const s of (staff ?? []) as { id: string; navn: string | null }[]) navne.set(s.id, s.navn);
  }
  return raekker.map((r) => ({
    id: r.id,
    handling: r.handling,
    aarsag: r.aarsag,
    oprettet_kl: r.oprettet_kl,
    medarbejder_navn: r.medarbejder_id ? (navne.get(r.medarbejder_id) ?? null) : null,
    system: erSystem(r.medarbejder_id),
  }));
}
