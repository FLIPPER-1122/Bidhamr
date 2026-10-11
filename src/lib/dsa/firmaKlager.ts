import "server-only";

// DSA-klager over suspension og lukning af en FIRMAKONTO (users.konto_type =
// 'erhverv'). Chef og sælger-rollen behandler dem under Admin → Erhverv →
// Klager over afgørelser (Filip, 10. okt. 2026: de kan gøre alt ved firmaer).
// Databasen afgør resten (dsa_klage_afgoer, 20261016050000): adgang,
// inhabilitet, ophævelse, log. Klageren får besked som i det almindelige
// DSA-flow (notificerKlageSvar).
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Afgoerelse, Klage } from "@/components/admin/dsa/DsaKort";

type Admin = ReturnType<typeof createAdminClient>;

export const FIRMA_KLAGE_HANDLINGER = ["konto_suspenderet", "konto_lukket"] as const;

export const FIRMA_KLAGER_SIDE = 20;

const KLAGE_FELTER =
  "id, sagsnummer, afgoerelse_id, anmeldelse_id, klager_id, klager_email, begrundelse, status, udfald, svar, afgjort_af, afgjort_kl, frist_kl, oprettet_kl";
const AFG_FELTER =
  "id, sagsnummer, bruger_id, indhold_type, indhold_id, indhold_tekst, handling, regel_kode, regel_tekst, grundlag, fakta, intern_note, automatisk_opdaget, anmeldelse_id, medarbejder_id, oprettet_kl, ophaevet_kl, ophaevet_grund, varighed_til";

// Kun klager over en afgørelse (ikke anmelderes klager), hvor afgørelsen er
// en suspension/lukning af en firmakonto. !inner: filtrene på de indlejrede
// tabeller begrænser selve klagerne (før limit).
const FIRMA_SELECT = `${KLAGE_FELTER}, afg:dsa_afgoerelser!inner(${AFG_FELTER}, bruger:users!dsa_afgoerelser_bruger_id_fkey!inner(konto_type))`;

export type FirmaAfgoerelse = Afgoerelse & { varighed_til: string | null };

export type FirmaKlage = Klage & {
  afg: FirmaAfgoerelse;
};

type Raa = Klage & { afg: (FirmaAfgoerelse & { bruger: unknown }) | null };

function fraRaa(r: Raa): FirmaKlage | null {
  if (!r.afg) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { bruger, ...afg } = r.afg;
  return { ...r, afg };
}

export type FirmaKlageStatus = "afventer" | "afgjort";

// Listen (nyeste frist først for åbne, senest afgjort først for afgjorte).
export async function hentFirmaDsaKlager(
  admin: Admin,
  status: FirmaKlageStatus,
  antal: number,
): Promise<{ klager: FirmaKlage[]; flere: boolean } | { fejl: true }> {
  const q = admin
    .from("dsa_klager")
    .select(FIRMA_SELECT)
    .eq("status", status)
    .in("afg.handling", [...FIRMA_KLAGE_HANDLINGER])
    .eq("afg.bruger.konto_type", "erhverv")
    .order(status === "afventer" ? "frist_kl" : "afgjort_kl", { ascending: status === "afventer" });
  // Én ekstra række fortæller, om der er flere.
  const { data, error } = await q.limit(antal + 1);
  if (error) {
    console.error("hentFirmaDsaKlager:", error.message);
    return { fejl: true };
  }
  const alle = ((data ?? []) as unknown as Raa[]).map(fraRaa).filter((x): x is FirmaKlage => !!x);
  return { klager: alle.slice(0, antal), flere: alle.length > antal };
}

// Antal åbne (til fanen). 0 ved fejl.
export async function antalAabneFirmaDsaKlager(admin: Admin): Promise<number> {
  const { count, error } = await admin
    .from("dsa_klager")
    .select("id, afg:dsa_afgoerelser!inner(handling, bruger:users!dsa_afgoerelser_bruger_id_fkey!inner(konto_type))", {
      count: "exact",
      head: true,
    })
    .eq("status", "afventer")
    .in("afg.handling", [...FIRMA_KLAGE_HANDLINGER])
    .eq("afg.bruger.konto_type", "erhverv");
  return error ? 0 : (count ?? 0);
}

// Én klage - kun hvis den gælder en firmakonto. null ellers.
export async function hentFirmaDsaKlage(admin: Admin, id: string): Promise<FirmaKlage | null> {
  const { data, error } = await admin
    .from("dsa_klager")
    .select(FIRMA_SELECT)
    .eq("id", id)
    .in("afg.handling", [...FIRMA_KLAGE_HANDLINGER])
    .eq("afg.bruger.konto_type", "erhverv")
    .maybeSingle();
  if (error) throw new Error(`hentFirmaDsaKlage: ${error.message}`);
  return data ? fraRaa(data as unknown as Raa) : null;
}

const GRUND = {
  klager: "Du har selv klaget.",
  traf: "Du traf selv den oprindelige afgørelse.",
  selvAnmeldt: "Du har selv anmeldt dette indhold.",
  egen: "Sagen handler om dig selv.",
  handel: "Du har handlet med firmaet.",
};

// Samme regler som dsa_klage_afgoer (konto-afgørelser), så knapperne slet
// ikke vises. Databasen tjekker det igen.
export async function firmaKlageInhabil(admin: Admin, k: FirmaKlage, userId: string): Promise<string | null> {
  if (k.klager_id === userId) return GRUND.klager;
  if (k.afg.medarbejder_id === userId) return GRUND.traf;
  if (k.afg.bruger_id === userId) return GRUND.egen;
  if (k.afg.anmeldelse_id) {
    const { data } = await admin
      .from("dsa_anmeldelser")
      .select("anmelder_id")
      .eq("id", k.afg.anmeldelse_id)
      .maybeSingle<{ anmelder_id: string | null }>();
    if (data?.anmelder_id === userId) return GRUND.selvAnmeldt;
  }
  const { data: handel, error } = await admin.rpc("dsa_er_inhabil", { p_medarbejder: userId, p_bruger: k.afg.bruger_id });
  if (error) throw new Error(`dsa_er_inhabil: ${error.message}`);
  return handel === true ? GRUND.handel : null;
}

// Firmaet bag kontoen (navn, CVR og link til firmasiden).
export async function hentFirmaFor(
  admin: Admin,
  brugerIder: string[],
): Promise<Map<string, { id: string; firmanavn: string; cvr: string }>> {
  if (brugerIder.length === 0) return new Map();
  const { data } = await admin.from("firmaer").select("id, bruger_id, firmanavn, cvr").in("bruger_id", brugerIder);
  return new Map(
    ((data ?? []) as { id: string; bruger_id: string; firmanavn: string; cvr: string }[]).map((f) => [
      f.bruger_id,
      { id: f.id, firmanavn: f.firmanavn, cvr: f.cvr },
    ]),
  );
}
