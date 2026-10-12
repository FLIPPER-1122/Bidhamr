import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { adminSagSti } from "@/lib/sager";

// Søgningen øverst i admin: find en bruger, handel, auktion eller sag ud fra
// e-mail, navn, id (hele eller de første tegn, som vises i admin) eller
// nummer, og gå direkte dertil. Ingen ny RPC: brugere via admin_brugere_soeg,
// resten med almindelige opslag (id-præfiks som et interval på uuid'en).
// Kaldes KUN efter kraevSideRolle()/kraevErhvervSide(). Hent kun de
// kolonner, der vises. Højst 6 pr. type.

type Admin = ReturnType<typeof createAdminClient>;

export type SoegType = "bruger" | "handel" | "auktion" | "sag" | "dsa" | "firma" | "henvendelse" | "firmaklage";

// eksakt: hele e-mailen, hele id'et, CVR'et eller nummeret passer præcist.
export type SoegTraef = { type: SoegType; id: string; titel: string; under?: string; href: string; eksakt?: boolean };

// Hvor skal søgningen hen? Ét resultat, eller præcis ét eksakt match.
export function direkteTil(traef: SoegTraef[]): string | null {
  if (traef.length === 1) return traef[0].href;
  const eksakte = traef.filter((t) => t.eksakt);
  return eksakte.length === 1 ? eksakte[0].href : null;
}

export const SOEG_TYPE_NAVN: Record<SoegType, string> = {
  bruger: "Brugere",
  handel: "Handler",
  auktion: "Auktioner",
  sag: "Sager",
  dsa: "DSA-sager",
  firma: "Firmaer",
  henvendelse: "Erhvervshenvendelser",
  firmaklage: "Klager over firmaer",
};

const MAKS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "abcd1234" -> ["abcd1234-0000-...", "abcd1234-ffff-..."]. Mindst 6 tegn.
export function idInterval(q: string): [string, string] | null {
  const hex = q.trim().toLowerCase().replace(/-/g, "");
  if (hex.length < 6 || hex.length > 32 || !/^[0-9a-f]+$/.test(hex)) return null;
  const fmt = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return [fmt(hex.padEnd(32, "0")), fmt(hex.padEnd(32, "f"))];
}

// Escape %, _ og \ til ilike.
function moenster(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// [fra, til] for et id: hele uuid'en (fra = til) eller et præfiks.
function idSpaend(tekst: string): [string, string] | null {
  if (UUID.test(tekst)) return [tekst.toLowerCase(), tekst.toLowerCase()];
  return idInterval(tekst);
}

// Et opslag, der fejler, må ikke bare give "intet fundet" - det logges
// (uden søgeteksten, som kan være en e-mail), og resten af søgningen kører videre.
function tjek<T extends { error: { message: string } | null }>(hvad: string, r: T): T {
  if (r.error) console.error(`Admin-søgning: ${hvad} fejlede:`, r.error.message);
  return r;
}

const kr = (v: number | string | null) =>
  v == null ? "" : `${Number(v).toLocaleString("da-DK", { maximumFractionDigits: 2 })} kr`;

export async function soegStaff(admin: Admin, raa: string): Promise<SoegTraef[]> {
  const q = raa.trim().slice(0, 120);
  if (q.length < 2) return [];
  const m = moenster(q);
  const tom = Promise.resolve({ data: [] as never[], error: null });

  const id = idSpaend(q);

  const [brugere, handler, sporing, auktioner, auktionerId, sager, dsaAnm, dsaKlager] = (await Promise.all([
    admin.rpc("admin_brugere_soeg", { p_q: q, p_filter: null, p_graense: MAKS }),
    id
      ? admin.from("trades").select("id, status, amount, auction:auctions(titel)").gte("id", id[0]).lte("id", id[1]).limit(MAKS)
      : tom,
    admin
      .from("trades")
      .select("id, status, amount, auction:auctions(titel)")
      .ilike("tracking_number", m)
      .limit(MAKS),
    admin.from("auctions").select("id, titel, status").ilike("titel", m).order("oprettet", { ascending: false }).limit(MAKS),
    id ? admin.from("auctions").select("id, titel, status").gte("id", id[0]).lte("id", id[1]).limit(MAKS) : tom,
    id ? admin.from("sager").select("id, status").gte("id", id[0]).lte("id", id[1]).limit(MAKS) : tom,
    admin.from("dsa_anmeldelser").select("id, sagsnummer, status").ilike("sagsnummer", m).limit(MAKS),
    admin.from("dsa_klager").select("id, sagsnummer, status").ilike("sagsnummer", m).limit(MAKS),
  ])).map((r, i) => tjek(["brugere", "handler", "sporing", "auktioner", "auktion-id", "sager", "DSA-anmeldelser", "DSA-klager"][i], r));

  const ud: SoegTraef[] = [];
  for (const u of (brugere.data ?? []) as { id: string; navn: string | null; email: string; telefon: string | null }[]) {
    ud.push({
      type: "bruger",
      id: u.id,
      titel: u.navn ?? "Uden navn",
      under: [u.email, u.telefon].filter(Boolean).join(" · "),
      href: `/admin/brugere/${u.id}`,
      eksakt: u.email?.toLowerCase() === q.toLowerCase() || u.id === q.toLowerCase(),
    });
  }
  const sete = new Set<string>();
  type H = { id: string; status: string; amount: number | string | null; auction: { titel: string | null } | { titel: string | null }[] | null };
  for (const h of [...((handler.data ?? []) as H[]), ...((sporing.data ?? []) as H[])]) {
    if (sete.has(h.id)) continue;
    sete.add(h.id);
    const a = Array.isArray(h.auction) ? h.auction[0] : h.auction;
    ud.push({
      type: "handel",
      id: h.id,
      titel: a?.titel ?? "(slettet auktion)",
      under: `Handel ${h.id.slice(0, 13)} · ${kr(h.amount)}`,
      href: `/admin/handler/${h.id}`,
      eksakt: h.id === q.toLowerCase(),
    });
  }
  const seteA = new Set<string>();
  for (const a of [...((auktionerId.data ?? []) as { id: string; titel: string }[]), ...((auktioner.data ?? []) as { id: string; titel: string }[])]) {
    if (seteA.has(a.id) || seteA.size >= MAKS) continue;
    seteA.add(a.id);
    ud.push({ type: "auktion", id: a.id, titel: a.titel, under: `Auktion ${a.id.slice(0, 13)}`, href: `/auktion/${a.id}`, eksakt: a.id === q.toLowerCase() });
  }
  for (const s of (sager.data ?? []) as { id: string; status: string }[]) {
    ud.push({ type: "sag", id: s.id, titel: `Sag ${s.id.slice(0, 13)}`, href: adminSagSti(s.id), eksakt: s.id === q.toLowerCase() });
  }
  for (const d of [
    ...((dsaAnm.data ?? []) as { id: string; sagsnummer: string; status: string }[]),
    ...((dsaKlager.data ?? []) as { id: string; sagsnummer: string; status: string }[]),
  ]) {
    // Direkte til den konkrete sag (DSA-siden viser kun den med ?nr=).
    const aaben = d.status === "ny" || d.status === "afventer";
    const fane = aaben ? (d.sagsnummer.startsWith("KLG") ? "klager" : null) : "afsluttede";
    ud.push({
      type: "dsa",
      id: d.id,
      titel: d.sagsnummer,
      under: `${d.sagsnummer.startsWith("KLG") ? "Klage over afgørelse" : "Anmeldelse"} · ${aaben ? "åben" : "afgjort"}`,
      href: `/admin/dsa?${fane ? `fane=${fane}&` : ""}nr=${encodeURIComponent(d.sagsnummer)}`,
      eksakt: d.sagsnummer.toLowerCase() === q.toLowerCase(),
    });
  }
  return ud;
}

// Erhverv (chef og sælger): firmaer, henvendelser og klager over firmaer.
export async function soegErhverv(admin: Admin, raa: string): Promise<SoegTraef[]> {
  const q = raa.trim().slice(0, 120);
  // Et klagenummer kan være ét ciffer ("4"); ellers mindst 2 tegn.
  if (q.length < 2 && !/^\d$/.test(q)) return [];
  const m = moenster(q);
  const cvr = q.replace(/\D/g, "");
  const nummer = /^#?\d{1,9}$/.test(q) ? Number(q.replace("#", "")) : null;
  const tom = Promise.resolve({ data: [] as never[], error: null });

  // Et rent, kort tal ("4", "#12") er et klagenummer - så søges der ikke i
  // navne (ellers ville "1" ramme alle firmaer med et 1 i navnet).
  const kunNummer = /^#?\d{1,4}$/.test(q);
  const [firmaNavn, firmaCvr, henvNavn, henvEmail, henvCvr, klager] = (await Promise.all([
    kunNummer ? tom : admin.from("firmaer").select("id, firmanavn, cvr").ilike("firmanavn", m).limit(MAKS),
    cvr.length >= 4 ? admin.from("firmaer").select("id, firmanavn, cvr").ilike("cvr", `%${cvr}%`).limit(MAKS) : tom,
    kunNummer ? tom : admin.from("erhverv_henvendelser").select("id, firmanavn, cvr, status").ilike("firmanavn", m).limit(MAKS),
    kunNummer ? tom : admin.from("erhverv_henvendelser").select("id, firmanavn, cvr, status").ilike("email", m).limit(MAKS),
    cvr.length >= 4 ? admin.from("erhverv_henvendelser").select("id, firmanavn, cvr, status").ilike("cvr", `%${cvr}%`).limit(MAKS) : tom,
    nummer !== null ? admin.from("erhverv_klager").select("id, nummer, status").eq("nummer", nummer).limit(1) : tom,
  ])).map((r, i) => tjek(["firmaer (navn)", "firmaer (CVR)", "henvendelser (navn)", "henvendelser (e-mail)", "henvendelser (CVR)", "klager"][i], r));

  const ud: SoegTraef[] = [];
  const f = new Set<string>();
  for (const r of [...((firmaNavn.data ?? []) as { id: string; firmanavn: string; cvr: string }[]), ...((firmaCvr.data ?? []) as { id: string; firmanavn: string; cvr: string }[])]) {
    if (f.has(r.id)) continue;
    f.add(r.id);
    ud.push({ type: "firma", id: r.id, titel: r.firmanavn, under: `CVR ${r.cvr}`, href: `/admin/erhverv/firmaer/${r.id}`, eksakt: r.cvr === cvr && cvr.length === 8 });
  }
  const h = new Set<string>();
  for (const r of [
    ...((henvNavn.data ?? []) as { id: string; firmanavn: string; cvr: string }[]),
    ...((henvEmail.data ?? []) as { id: string; firmanavn: string; cvr: string }[]),
    ...((henvCvr.data ?? []) as { id: string; firmanavn: string; cvr: string }[]),
  ]) {
    if (h.has(r.id)) continue;
    h.add(r.id);
    ud.push({ type: "henvendelse", id: r.id, titel: r.firmanavn, under: `CVR ${r.cvr}`, href: `/admin/erhverv/henvendelser/${r.id}` });
  }
  for (const k of (klager.data ?? []) as { id: string; nummer: number }[]) {
    ud.push({ type: "firmaklage", id: k.id, titel: `Klage #${k.nummer}`, href: `/admin/erhverv/klager/${k.id}`, eksakt: true });
  }
  return ud;
}
