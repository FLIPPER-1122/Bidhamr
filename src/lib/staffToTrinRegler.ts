// To-trins-login for staff på admin-hosten - de rene regler (ingen database,
// intet netværk), så de kan enhedstestes (tests/enhed/staffToTrin.test.ts).
// Server-delen ligger i src/lib/staffToTrin.ts og src/lib/adminAuth.ts.
//
// Filip, 19. okt. 2026 (ROADMAP-BESLUTNINGER.md, "Admin på admin.bidhamr.dk"):
// Supabase MFA (TOTP) er obligatorisk for alle staff-roller på admin-hosten.
// Brugere har stadig intet to-trins-login (beslutningen fra 7. okt. gælder
// dem), og intet uden for admin-hosten kræver aal2. MEN: Supabase Auth logger
// medarbejderens aal1-sessioner (appen og bidhamr.dk) ud, hver gang han
// bekræfter en kode i admin - Supabases egen regel, som koden ikke kan slå
// fra (docs/ADMIN-VAERT.md, "Kendte konsekvenser"). Og indtil migration B er
// kørt, beskytter to-trins-login kun admin-siderne - ikke staff-adgang via
// API'et (RLS kender kun rollen).
//
// Ingen node:crypto her, så filen også kan bruges i proxyen og browseren;
// tilfældighed og hashing ligger i src/lib/staffToTrin.ts.
import { sikkerSti } from "@/lib/sikkerSti";

export const STAFF_ROLLER = ["medarbejder", "admin", "chef", "saelger"] as const;
export type StaffRolle = (typeof STAFF_ROLLER)[number];

export function somStaffRolle(rolle: unknown): StaffRolle | null {
  return typeof rolle === "string" && (STAFF_ROLLER as readonly string[]).includes(rolle)
    ? (rolle as StaffRolle)
    : null;
}

// Metoder i JWT'ens amr, der tæller som andet trin. En passkey (webauthn)
// kan tilføjes her senere - datamodellen (staff_to_trin.faktor_ider) rummer
// enhver faktor i auth.mfa_factors.
export const ANDET_TRIN_METODER = ["totp"] as const;

// En ny kode kræves efter så mange timer (STAFF_TO_TRIN_MAKS_TIMER).
export const TO_TRIN_STANDARD_TIMER = 12;
// Chefens nulstilling af andres to-trins-login kræver en kode, der højst er
// så gammel.
export const FRISK_KODE_MINUTTER = 15;

export function toTrinMaksTimer(vaerdi: string | undefined = process.env.STAFF_TO_TRIN_MAKS_TIMER): number {
  const n = Number(vaerdi);
  if (!vaerdi || !Number.isInteger(n) || n < 1 || n > 168) return TO_TRIN_STANDARD_TIMER;
  return n;
}

// Seneste tidspunkt (sekunder siden 1970) for andet trin i JWT'ens amr-claim,
// eller null. amr er en liste af { method, timestamp } fra Supabase Auth.
export function nyesteAndetTrinSek(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let nyeste: number | null = null;
  for (const e of amr) {
    if (!e || typeof e !== "object") continue;
    const { method, timestamp } = e as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string" || !(ANDET_TRIN_METODER as readonly string[]).includes(method)) continue;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) continue;
    if (nyeste === null || timestamp > nyeste) nyeste = timestamp;
  }
  return nyeste;
}

// Er andet trin højst maksSek gammelt? Et tidspunkt i fremtiden (ur-skævhed)
// godtages højst 5 minutter frem.
export function andetTrinFrisk(amr: unknown, maksSek: number, nuSek: number): boolean {
  const t = nyesteAndetTrinSek(amr);
  if (t === null) return false;
  if (t > nuSek + 300) return false;
  return nuSek - t <= maksSek;
}

export type StaffAfvisning =
  | "ikke_logget_ind"
  | "forkert_vaert"
  | "kraever_kode"
  | "ikke_opsat"
  | "ukendt_faktor"
  | "ingen_adgang"
  | "fejl";

export type StaffDb = { aktiv: boolean; ukendte_faktorer: boolean };

export type StaffVurdering =
  | { ok: true; rolle: StaffRolle; andetTrinSek: number | null }
  | { ok: false; grund: StaffAfvisning };

export type StaffInput = {
  // ADMIN_VAERT sat?
  flagAktiv: boolean;
  // Er forespørgslen på admin-hosten?
  paaAdminVaert: boolean;
  // Brugeren godkendt af Supabase Auth (getUser).
  brugerId: string | null;
  // sub i den verificerede JWT (getClaims) - skal være samme bruger.
  claimsSub: string | null;
  rolle: string | null;
  aal: unknown;
  amr: unknown;
  // min_staff_adgang() fra databasen (null = kaldet fejlede).
  db: StaffDb | null;
  nuSek: number;
  maksTimer: number;
};

// Hele afgørelsen for hentStaffAdgang (src/lib/adminAuth.ts):
//   uden ADMIN_VAERT: kun rollen (som før - intet to-trins-krav),
//   med ADMIN_VAERT: (a) admin-hosten, (b) aal2 og et andet trin, der er
//   nyere end grænsen, (c) databasen siger aktiv og ingen ukendte faktorer,
//   (d) rollen.
export function vurderStaffAdgang(i: StaffInput): StaffVurdering {
  if (!i.brugerId) return { ok: false, grund: "ikke_logget_ind" };
  const rolle = somStaffRolle(i.rolle);
  if (!i.flagAktiv) {
    return rolle ? { ok: true, rolle, andetTrinSek: null } : { ok: false, grund: "ingen_adgang" };
  }
  if (!i.paaAdminVaert) return { ok: false, grund: "forkert_vaert" };
  if (!rolle) return { ok: false, grund: "ingen_adgang" };
  if (!i.claimsSub || i.claimsSub !== i.brugerId) return { ok: false, grund: "ikke_logget_ind" };
  if (!i.db) return { ok: false, grund: "fejl" };
  if (i.db.ukendte_faktorer) return { ok: false, grund: "ukendt_faktor" };
  if (!i.db.aktiv) return { ok: false, grund: "ikke_opsat" };
  if (i.aal !== "aal2" || !andetTrinFrisk(i.amr, i.maksTimer * 3600, i.nuSek)) {
    return { ok: false, grund: "kraever_kode" };
  }
  return { ok: true, rolle, andetTrinSek: nyesteAndetTrinSek(i.amr) };
}

// --- Koden fra app'en ------------------------------------------------------

// 6 cifre; mellemrum og bindestreger ignoreres. null, hvis ugyldig.
export function renTotpKode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const k = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(k) ? k : null;
}

// --- Gendannelseskoder -----------------------------------------------------
// 10 pr. medarbejder, vist én gang. 16 tegn fra et alfabet uden tegn, der
// ligner hinanden (0/O, 1/I/L, U/V), skrevet XXXX-XXXX-XXXX-XXXX: ca. 78
// bit, så en lækket hash ikke kan gættes offline. Kun hashen gemmes
// (staff_gendannelseskoder.kode_hash), med bruger-id'et i hashen, så samme
// kode hos to medarbejdere giver to forskellige hashes.

export const GENDANNELSESKODER_ANTAL = 10;
const GENDAN_ALFABET = "ABCDEFGHJKMNPQRSTWXYZ23456789";
const GENDAN_LAENGDE = 16;

// tilfaeldig(max): et kryptografisk tilfældigt heltal i [0, max) - fx
// node:crypto's randomInt (src/lib/staffToTrin.ts).
export function lavGendannelseskode(tilfaeldig: (max: number) => number): string {
  let s = "";
  for (let i = 0; i < GENDAN_LAENGDE; i++) s += GENDAN_ALFABET[tilfaeldig(GENDAN_ALFABET.length)];
  return s.match(/.{4}/g)!.join("-");
}

export function lavGendannelseskoder(tilfaeldig: (max: number) => number, antal = GENDANNELSESKODER_ANTAL): string[] {
  const koder = new Set<string>();
  while (koder.size < antal) koder.add(lavGendannelseskode(tilfaeldig));
  return [...koder];
}

// Store bogstaver uden mellemrum og bindestreger; null, hvis ugyldig.
export function renGendannelseskode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const k = input.toUpperCase().replace(/[\s-]/g, "");
  if (k.length !== GENDAN_LAENGDE) return null;
  for (const c of k) if (!GENDAN_ALFABET.includes(c)) return null;
  return k;
}

// Teksten, der hashes med sha256 (src/lib/staffToTrin.ts). null, hvis koden
// eller bruger-id'et er ugyldigt.
export function gendannelseHashTekst(brugerId: string, kode: string): string | null {
  const ren = renGendannelseskode(kode);
  if (!ren || !/^[0-9a-f-]{36}$/i.test(brugerId)) return null;
  return `bidhamr-staff-gendan-v1|${brugerId.toLowerCase()}|${ren}`;
}

// --- Sikre stier efter login -------------------------------------------------
// Efter login/kode sendes man tilbage til den admin-side, man kom fra - kun
// en relativ sti under /admin (aldrig en anden host eller //host).
export function sikkerAdminSti(sti: unknown): string {
  if (typeof sti !== "string" || sti.length > 500) return "/admin";
  const s = sikkerSti(sti, "/admin");
  return /^\/admin(?:[/?#]|$)/.test(s) ? s : "/admin";
}
