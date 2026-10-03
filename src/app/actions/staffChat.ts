"use server";

// Chat mellem staff og brugere (ROADMAP-BESLUTNINGER "Chat mellem staff og
// brugere"). Kun staff kan åbne en samtale; brugeren kan svare, så længe den
// er åben; staff kan altid afslutte den. Intet slettes.
//
// Staff-handlinger: assertRole() + service-role-funktioner i databasen
// (staff_chat_aabn/send/luk, faellesbesked), der selv tjekker rollen igen.
// Bruger-handlinger: brugerens egen session; RLS giver kun egne samtaler, og
// svar går gennem staff_chat_svar() (udleder brugeren af auth.uid()).
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
//
// Appen (Expo) kan bruge det samme direkte med supabase-js:
//   supabase.from("staff_samtaler").select("id, emne, aabnet_kl, lukket_kl, trade_id, bruger_laest_kl")
//   supabase.from("staff_beskeder").select("id, samtale_id, fra_staff, tekst, oprettet_kl")
//       (OBS: ikke "*" - aabnet_af/lukket_af/afsender_id er skjult for brugere)
//   supabase.rpc("staff_chat_svar", { p_samtale, p_tekst }) -> { kode: "ok" | "lukket" | "for_mange" | ... }
//   supabase.rpc("staff_chat_marker_laest", { p_samtale })
//   supabase.rpc("antal_ulaeste_staff_beskeder")             rødt tal
//   Realtime: staff_beskeder (filter samtale_id=eq.<id>).
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertRole, type StaffRole } from "@/lib/adminAuth";
import { createClient } from "@/lib/supabase/server";
import { send } from "@/lib/notifikationer/send";
import {
  FAELLESBESKED_MAKS_TEKST,
  STAFF_CHAT_MAKS_EMNE,
  STAFF_CHAT_MAKS_TEKST,
  staffSamtaleSti,
} from "@/lib/staffChat";

// ------------------------------------------------------------------ Typer

export type StaffBesked = {
  id: string;
  fra_staff: boolean;
  tekst: string;
  oprettet_kl: string;
};

// Til staff: hvem i BidHamr der skrev.
export type StaffBeskedAdmin = StaffBesked & {
  afsender_navn: string | null;
};

export type StaffSamtaleAdmin = {
  id: string;
  bruger: { id: string; navn: string | null };
  emne: string;
  aabnet_kl: string;
  aabnet_af_navn: string | null;
  lukket_kl: string | null;
  lukket_af_navn: string | null;
  sag_type: string | null;
  sag_id: string | null;
  trade_id: string | null;
  auktion_titel: string | null;
  sidste_besked: StaffBesked | null;
  // Åben, og den seneste besked er fra brugeren.
  venter_paa_svar: boolean;
};

export type MinStaffSamtale = {
  id: string;
  emne: string;
  aabnet_kl: string;
  lukket_kl: string | null;
  trade_id: string | null;
  auktion_titel: string | null;
  sidste_besked: StaffBesked | null;
  antal_ulaeste: number;
};

// ------------------------------------------------------------------ Hjælpere

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const IKKE_LOGGET_IND = "Du skal være logget ind.";
const INGEN_ADGANG = "Du har ikke adgang til at gøre dette.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ny besked-notifikation sendes ikke igen, hvis brugeren allerede har en
// ulæst staff-besked i samtalen fra de seneste 5 minutter (staff skriver
// flere beskeder i træk).
const NOTIFIKATION_PAUSE_MS = 5 * 60 * 1000;

function erUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

// hvad: "emnet" eller "beskeden".
function rensTekst(v: unknown, maks: number, hvad: "emnet" | "beskeden"): string {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw new BrugerFejl(hvad === "emnet" ? "Skriv et emne." : "Skriv en besked.");
  if (t.length > maks) {
    throw new BrugerFejl(`${hvad === "emnet" ? "Emnet" : "Beskeden"} må højst være ${maks} tegn.`);
  }
  return t;
}

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: INGEN_ADGANG };
    }
    console.error(`Staff-chat ${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

async function staff(min: StaffRole) {
  return assertRole(min);
}

type Kode = { kode: string; [k: string]: unknown };

function kodeFejl(kode: string): string {
  switch (kode) {
    case "ingen_adgang":
      return INGEN_ADGANG;
    case "ugyldig_bruger":
      return "Brugeren findes ikke.";
    case "sig_selv":
      return "Du kan ikke åbne en chat med dig selv.";
    case "ugyldigt_emne":
      return `Emnet skal være mellem 1 og ${STAFF_CHAT_MAKS_EMNE} tegn.`;
    case "ugyldig_sag":
      return "Sagen er ugyldig.";
    case "ugyldig_handel":
      return "Brugeren er ikke part i den handel.";
    case "ugyldig_tekst":
      return "Beskeden er tom eller for lang.";
    case "ikke_fundet":
      return "Samtalen findes ikke.";
    case "lukket":
      return "Samtalen er afsluttet. Du kan ikke skrive mere i den.";
    case "for_mange":
      return "Du har sendt mange beskeder på kort tid. Vent lidt, og prøv så igen.";
    case "ikke_logget_ind":
      return IKKE_LOGGET_IND;
    case "proev_igen":
      return "Samtalen blev ændret samtidig. Prøv igen.";
    default:
      return GENERISK;
  }
}

function forkort(t: string, n = 120): string {
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Notifikation om en ny staff-besked i en eksisterende samtale. Samtaler om
// en sag eller handel sendes som 'sag' (påkrævet), resten som 'ny_besked'.
// Skriver staff flere i træk, og er den forrige stadig ulæst og under 5
// minutter gammel, sendes der ikke igen.
function notificerStaffBesked(
  brugerId: string,
  samtaleId: string,
  beskedId: string,
  tekst: string,
  forrigeUlaestKl: string | null,
  omSag: boolean,
) {
  const nyligUlaest =
    forrigeUlaestKl !== null && Date.now() - Date.parse(forrigeUlaestKl) < NOTIFIKATION_PAUSE_MS;
  if (nyligUlaest) return;
  after(() =>
    send(brugerId, omSag ? "sag" : "ny_besked", {
      titel: "Ny besked fra BidHamr",
      tekst: forkort(tekst),
      link: staffSamtaleSti(samtaleId),
      data: { staff_samtale_id: samtaleId },
      noegle: `staffbesked:${beskedId}`,
    }),
  );
}

// ------------------------------------------------------------------ Staff

// "Åbn chat" (medarbejder, admin, chef). Findes der allerede en åben samtale
// med brugeren om samme sag (eller en åben generel samtale), returneres den
// (fandtes: true) - dobbeltklik giver ikke to samtaler. Er der en besked,
// lægges den i den eksisterende samtale.
export async function aabnChat(
  brugerId: string,
  emne: string,
  opts: { tradeId?: string | null; sagType?: string | null; sagId?: string | null; besked?: string | null } = {},
): Promise<{ ok: true; samtaleId: string; fandtes: boolean } | { fejl: string }> {
  return koer("aabnChat", async () => {
    const { userId, admin } = await staff("medarbejder");
    if (!erUuid(brugerId)) throw new BrugerFejl("Brugeren findes ikke.");
    const rentEmne = rensTekst(emne, STAFF_CHAT_MAKS_EMNE, "emnet");
    const tradeId = opts.tradeId ? opts.tradeId : null;
    if (tradeId !== null && !erUuid(tradeId)) throw new BrugerFejl("Handlen findes ikke.");
    const sagType = opts.sagType ? opts.sagType : null;
    const sagId = opts.sagId ? opts.sagId : null;
    if ((sagType === null) !== (sagId === null) || (sagId !== null && !erUuid(sagId))) {
      throw new BrugerFejl("Sagen er ugyldig.");
    }
    const besked =
      typeof opts.besked === "string" && opts.besked.trim()
        ? rensTekst(opts.besked, STAFF_CHAT_MAKS_TEKST, "beskeden")
        : null;

    const { data, error } = await admin.rpc("staff_chat_aabn", {
      p_medarbejder: userId,
      p_bruger: brugerId,
      p_emne: rentEmne,
      p_trade: tradeId,
      p_sag_type: sagType,
      p_sag_id: sagId,
      p_besked: besked,
    });
    if (error) throw new Error(error.message);
    const svar = data as Kode;
    if (svar.kode !== "ok" && svar.kode !== "findes") throw new BrugerFejl(kodeFejl(svar.kode));
    const samtaleId = svar.samtale_id as string;

    if (svar.kode === "findes" && besked && typeof svar.besked_id === "string") {
      notificerStaffBesked(
        brugerId,
        samtaleId,
        svar.besked_id,
        besked,
        (svar.forrige_ulaest_kl as string | null | undefined) ?? null,
        svar.om_sag === true,
      );
    }

    if (svar.kode === "ok") {
      // Påkrævet besked: brugeren skal vide, at BidHamr vil i kontakt.
      after(() =>
        send(brugerId, "sag", {
          titel: "BidHamr har skrevet til dig",
          tekst: besked
            ? `BidHamr har åbnet en samtale med dig om "${rentEmne}": ${forkort(besked)}`
            : `BidHamr har åbnet en samtale med dig om "${rentEmne}". Du kan svare under Beskeder.`,
          link: staffSamtaleSti(samtaleId),
          data: { staff_samtale_id: samtaleId },
          noegle: `staffchat_aabnet:${samtaleId}`,
        }),
      );
    }

    revalidatePath("/admin", "layout");
    return { ok: true as const, samtaleId, fandtes: svar.kode === "findes" };
  });
}

// Staff skriver i en åben samtale.
export async function sendStaffBesked(
  samtaleId: string,
  tekst: string,
): Promise<{ ok: true; beskedId: string } | { fejl: string }> {
  return koer("sendStaffBesked", async () => {
    const { userId, admin } = await staff("medarbejder");
    if (!erUuid(samtaleId)) throw new BrugerFejl("Samtalen findes ikke.");
    const ren = rensTekst(tekst, STAFF_CHAT_MAKS_TEKST, "beskeden");

    const { data, error } = await admin.rpc("staff_chat_send", {
      p_medarbejder: userId,
      p_samtale: samtaleId,
      p_tekst: ren,
    });
    if (error) throw new Error(error.message);
    const svar = data as Kode;
    if (svar.kode !== "ok") throw new BrugerFejl(kodeFejl(svar.kode));
    const beskedId = svar.besked_id as string;
    const brugerId = svar.bruger_id as string;
    notificerStaffBesked(
      brugerId,
      samtaleId,
      beskedId,
      ren,
      (svar.forrige_ulaest_kl as string | null | undefined) ?? null,
      svar.om_sag === true,
    );

    revalidatePath("/admin", "layout");
    return { ok: true as const, beskedId };
  });
}

// "Afslut chat" - altid mulig for staff. Idempotent: en allerede afsluttet
// samtale giver også ok.
export async function lukChat(
  samtaleId: string,
): Promise<{ ok: true; alleredeLukket: boolean } | { fejl: string }> {
  return koer("lukChat", async () => {
    const { userId, admin } = await staff("medarbejder");
    if (!erUuid(samtaleId)) throw new BrugerFejl("Samtalen findes ikke.");
    const { data, error } = await admin.rpc("staff_chat_luk", {
      p_medarbejder: userId,
      p_samtale: samtaleId,
    });
    if (error) throw new Error(error.message);
    const svar = data as Kode;
    if (svar.kode !== "ok" && svar.kode !== "allerede_lukket") {
      throw new BrugerFejl(kodeFejl(svar.kode));
    }
    revalidatePath("/admin", "layout");
    return { ok: true as const, alleredeLukket: svar.kode === "allerede_lukket" };
  });
}

type SamtaleRaekke = {
  id: string;
  bruger_id: string;
  aabnet_af: string;
  aabnet_kl: string;
  lukket_af: string | null;
  lukket_kl: string | null;
  emne: string;
  sag_type: string | null;
  sag_id: string | null;
  trade_id: string | null;
};

const SAMTALE_KOLONNER =
  "id, bruger_id, aabnet_af, aabnet_kl, lukket_af, lukket_kl, emne, sag_type, sag_id, trade_id";

type Admin = Awaited<ReturnType<typeof assertRole>>["admin"];

// Seneste besked pr. samtale (én forespørgsel pr. samtale; listerne er små).
async function sidsteBeskeder(admin: Admin, ids: string[]): Promise<Map<string, StaffBesked>> {
  const res = await Promise.all(
    ids.map((id) =>
      admin
        .from("staff_beskeder")
        .select("id, fra_staff, tekst, oprettet_kl")
        .eq("samtale_id", id)
        .order("oprettet_kl", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle<StaffBesked>(),
    ),
  );
  const m = new Map<string, StaffBesked>();
  res.forEach((r, i) => {
    if (r.error) throw new Error(r.error.message);
    if (r.data) m.set(ids[i], r.data);
  });
  return m;
}

async function berigSamtaler(admin: Admin, raekker: SamtaleRaekke[]): Promise<StaffSamtaleAdmin[]> {
  if (raekker.length === 0) return [];
  const personIds = [
    ...new Set(raekker.flatMap((r) => [r.bruger_id, r.aabnet_af, r.lukket_af].filter(Boolean) as string[])),
  ];
  const tradeIds = [...new Set(raekker.map((r) => r.trade_id).filter(Boolean) as string[])];

  const [personer, handler, sidste] = await Promise.all([
    admin.from("users").select("id, navn").in("id", personIds),
    tradeIds.length
      ? admin.from("trades").select("id, auction_id").in("id", tradeIds)
      : Promise.resolve({ data: [] as { id: string; auction_id: string }[], error: null }),
    sidsteBeskeder(admin, raekker.map((r) => r.id)),
  ]);
  if (personer.error) throw new Error(personer.error.message);
  if (handler.error) throw new Error(handler.error.message);
  const navne = new Map((personer.data ?? []).map((p) => [p.id as string, (p.navn as string | null) ?? null]));
  const auktionPrHandel = new Map((handler.data ?? []).map((h) => [h.id as string, h.auction_id as string]));
  const auktionIds = [...new Set(auktionPrHandel.values())];
  const titler = new Map<string, string | null>();
  if (auktionIds.length) {
    const { data, error } = await admin.from("auctions").select("id, titel").in("id", auktionIds);
    if (error) throw new Error(error.message);
    for (const a of data ?? []) titler.set(a.id as string, (a.titel as string | null) ?? null);
  }

  return raekker.map((r) => {
    const s = sidste.get(r.id) ?? null;
    const auktionId = r.trade_id ? auktionPrHandel.get(r.trade_id) : undefined;
    return {
      id: r.id,
      bruger: { id: r.bruger_id, navn: navne.get(r.bruger_id) ?? null },
      emne: r.emne,
      aabnet_kl: r.aabnet_kl,
      aabnet_af_navn: navne.get(r.aabnet_af) ?? null,
      lukket_kl: r.lukket_kl,
      lukket_af_navn: r.lukket_af ? (navne.get(r.lukket_af) ?? null) : null,
      sag_type: r.sag_type,
      sag_id: r.sag_id,
      trade_id: r.trade_id,
      auktion_titel: auktionId ? (titler.get(auktionId) ?? null) : null,
      sidste_besked: s,
      venter_paa_svar: r.lukket_kl === null && s !== null && !s.fra_staff,
    };
  });
}

// Alle samtaler med én bruger (admin-brugersiden), nyeste først.
export async function hentSamtalerForBruger(
  brugerId: string,
): Promise<{ samtaler: StaffSamtaleAdmin[] } | { fejl: string }> {
  return koer("hentSamtalerForBruger", async () => {
    const { admin } = await staff("medarbejder");
    if (!erUuid(brugerId)) throw new BrugerFejl("Brugeren findes ikke.");
    const { data, error } = await admin
      .from("staff_samtaler")
      .select(SAMTALE_KOLONNER)
      .eq("bruger_id", brugerId)
      .order("aabnet_kl", { ascending: false })
      .limit(100)
      .overrideTypes<SamtaleRaekke[], { merge: false }>();
    if (error) throw new Error(error.message);
    return { samtaler: await berigSamtaler(admin, data ?? []) };
  });
}

// Samtaler knyttet til en sag (fx køber og sælger hver for sig).
export async function hentSamtalerForSag(
  sagType: string,
  sagId: string,
): Promise<{ samtaler: StaffSamtaleAdmin[] } | { fejl: string }> {
  return koer("hentSamtalerForSag", async () => {
    const { admin } = await staff("medarbejder");
    if (!/^[a-z_]{1,40}$/.test(sagType) || !erUuid(sagId)) throw new BrugerFejl("Sagen er ugyldig.");
    const { data, error } = await admin
      .from("staff_samtaler")
      .select(SAMTALE_KOLONNER)
      .eq("sag_type", sagType)
      .eq("sag_id", sagId)
      .order("aabnet_kl", { ascending: false })
      .limit(100)
      .overrideTypes<SamtaleRaekke[], { merge: false }>();
    if (error) throw new Error(error.message);
    return { samtaler: await berigSamtaler(admin, data ?? []) };
  });
}

// Åbne samtaler til admin-oversigten; dem, der venter på svar, først.
export async function hentAabneStaffSamtaler(): Promise<
  { samtaler: StaffSamtaleAdmin[] } | { fejl: string }
> {
  return koer("hentAabneStaffSamtaler", async () => {
    const { admin } = await staff("medarbejder");
    const { data, error } = await admin
      .from("staff_samtaler")
      .select(SAMTALE_KOLONNER)
      .is("lukket_kl", null)
      .order("aabnet_kl", { ascending: false })
      .limit(200)
      .overrideTypes<SamtaleRaekke[], { merge: false }>();
    if (error) throw new Error(error.message);
    const samtaler = await berigSamtaler(admin, data ?? []);
    const tid = (s: StaffSamtaleAdmin) => Date.parse(s.sidste_besked?.oprettet_kl ?? s.aabnet_kl);
    samtaler.sort((a, b) =>
      a.venter_paa_svar !== b.venter_paa_svar ? (a.venter_paa_svar ? -1 : 1) : tid(b) - tid(a),
    );
    return { samtaler };
  });
}

// Afsluttede samtaler til admin-oversigten, senest afsluttet først.
// "Vis flere" øger antal; der hentes antal+1 for at vide, om der er flere.
export async function hentLukkedeStaffSamtaler(
  antal = 20,
): Promise<{ samtaler: StaffSamtaleAdmin[]; flere: boolean } | { fejl: string }> {
  return koer("hentLukkedeStaffSamtaler", async () => {
    const { admin } = await staff("medarbejder");
    const n = Number.isInteger(antal) && antal > 0 ? Math.min(antal, 200) : 20;
    const { data, error } = await admin
      .from("staff_samtaler")
      .select(SAMTALE_KOLONNER)
      .not("lukket_kl", "is", null)
      .order("lukket_kl", { ascending: false })
      .order("id", { ascending: false })
      .limit(n + 1)
      .overrideTypes<SamtaleRaekke[], { merge: false }>();
    if (error) throw new Error(error.message);
    const raekker = data ?? [];
    return {
      samtaler: await berigSamtaler(admin, raekker.slice(0, n)),
      flere: raekker.length > n,
    };
  });
}

// Én samtale med alle beskeder (admin-visningen).
export async function hentStaffSamtale(
  samtaleId: string,
): Promise<{ samtale: StaffSamtaleAdmin; beskeder: StaffBeskedAdmin[] } | { fejl: string }> {
  return koer("hentStaffSamtale", async () => {
    const { admin } = await staff("medarbejder");
    if (!erUuid(samtaleId)) throw new BrugerFejl("Samtalen findes ikke.");
    const { data: s, error } = await admin
      .from("staff_samtaler")
      .select(SAMTALE_KOLONNER)
      .eq("id", samtaleId)
      .maybeSingle<SamtaleRaekke>();
    if (error) throw new Error(error.message);
    if (!s) throw new BrugerFejl("Samtalen findes ikke.");

    const { data: b, error: bFejl } = await admin
      .from("staff_beskeder")
      .select("id, afsender_id, fra_staff, tekst, oprettet_kl")
      .eq("samtale_id", samtaleId)
      .order("oprettet_kl", { ascending: true })
      .order("id", { ascending: true })
      .limit(2000);
    if (bFejl) throw new Error(bFejl.message);
    const afsendere = [...new Set((b ?? []).filter((x) => x.fra_staff).map((x) => x.afsender_id as string))];
    const navne = new Map<string, string | null>();
    if (afsendere.length) {
      const { data: u, error: uFejl } = await admin.from("users").select("id, navn").in("id", afsendere);
      if (uFejl) throw new Error(uFejl.message);
      for (const p of u ?? []) navne.set(p.id as string, (p.navn as string | null) ?? null);
    }
    const [samtale] = await berigSamtaler(admin, [s]);
    return {
      samtale,
      beskeder: (b ?? []).map((x) => ({
        id: x.id as string,
        fra_staff: x.fra_staff as boolean,
        tekst: x.tekst as string,
        oprettet_kl: x.oprettet_kl as string,
        afsender_navn: x.fra_staff ? (navne.get(x.afsender_id as string) ?? null) : null,
      })),
    };
  });
}

// Badge-tal i admin: åbne samtaler, hvor brugeren har skrevet sidst.
export async function antalUbesvaredeStaffSamtaler(): Promise<{ antal: number } | { fejl: string }> {
  return koer("antalUbesvaredeStaffSamtaler", async () => {
    await staff("medarbejder");
    // Brugerens egen session: funktionen tjekker er_staff() via auth.uid().
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("antal_ubesvarede_staff_samtaler");
    if (error) throw new Error(error.message);
    return { antal: typeof data === "number" ? data : 0 };
  });
}

// Fællesbesked til køber og sælger i deres chat (admin og chef). Markeres
// fra_bidhamr og får præfikset "Besked fra BidHamr:". Afsender (sender_id)
// er systembrugeren BidHamr, så parterne ikke kan se, hvilken admin der
// skrev; den rigtige admin står i moderation_log.
export async function sendFaellesbesked(
  tradeId: string,
  tekst: string,
): Promise<{ ok: true; beskedId: string } | { fejl: string }> {
  return koer("sendFaellesbesked", async () => {
    const { userId, admin } = await staff("admin");
    if (!erUuid(tradeId)) throw new BrugerFejl("Handlen findes ikke.");
    const ren = rensTekst(tekst, FAELLESBESKED_MAKS_TEKST, "beskeden");

    const { data, error } = await admin.rpc("faellesbesked", {
      p_medarbejder: userId,
      p_trade: tradeId,
      p_tekst: ren,
    });
    if (error) throw new Error(error.message);
    const svar = data as Kode;
    if (svar.kode !== "ok") {
      throw new BrugerFejl(svar.kode === "ikke_fundet" ? "Handlen findes ikke." : kodeFejl(svar.kode));
    }
    const beskedId = svar.besked_id as string;
    const auktionId = svar.auction_id as string;

    after(async () => {
      const { data: a } = await admin.from("auctions").select("titel").eq("id", auktionId).maybeSingle();
      const titel = (a?.titel as string | undefined) ?? "din handel";
      for (const modtager of [svar.buyer_id as string, svar.seller_id as string]) {
        // Samme nøgle som chat-cron'en (besked:<id>:<modtager>), så den ikke
        // sender en ekstra "Ny besked" for fællesbeskeden.
        await send(modtager, "sag", {
          titel: "Besked fra BidHamr",
          tekst: `BidHamr har skrevet til jer om "${titel}": ${forkort(ren)}`,
          link: `/mine-handler/${tradeId}`,
          data: { trade_id: tradeId },
          noegle: `besked:${beskedId}:${modtager}`,
        });
      }
    });

    revalidatePath("/admin", "layout");
    revalidatePath(`/mine-handler/${tradeId}`);
    return { ok: true as const, beskedId };
  });
}

// ------------------------------------------------------------------ Bruger

async function brugerSession() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// Brugerens samtaler med BidHamr (under "Beskeder"), nyeste aktivitet først.
export async function hentMineStaffSamtaler(): Promise<
  { samtaler: MinStaffSamtale[] } | { fejl: string }
> {
  const { supabase, user } = await brugerSession();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  try {
    const { data: s, error } = await supabase
      .from("staff_samtaler")
      .select("id, emne, aabnet_kl, lukket_kl, trade_id, bruger_laest_kl")
      .eq("bruger_id", user.id)
      .order("aabnet_kl", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    const samtaler = s ?? [];
    if (samtaler.length === 0) return { samtaler: [] };

    const ids = samtaler.map((x) => x.id as string);
    // RLS: kun egne beskeder. Hent nyeste først og tag de første pr. samtale.
    const { data: b, error: bFejl } = await supabase
      .from("staff_beskeder")
      .select("id, samtale_id, fra_staff, tekst, oprettet_kl")
      .in("samtale_id", ids)
      .order("oprettet_kl", { ascending: false })
      .limit(1000);
    if (bFejl) throw new Error(bFejl.message);

    const sidste = new Map<string, StaffBesked>();
    const ulaeste = new Map<string, number>();
    const laest = new Map(samtaler.map((x) => [x.id as string, x.bruger_laest_kl as string | null]));
    for (const x of b ?? []) {
      const id = x.samtale_id as string;
      if (!sidste.has(id)) {
        sidste.set(id, {
          id: x.id as string,
          fra_staff: x.fra_staff as boolean,
          tekst: x.tekst as string,
          oprettet_kl: x.oprettet_kl as string,
        });
      }
      const l = laest.get(id);
      if (x.fra_staff && (!l || Date.parse(x.oprettet_kl as string) > Date.parse(l))) {
        ulaeste.set(id, (ulaeste.get(id) ?? 0) + 1);
      }
    }

    // Titler på handlerne, brugeren selv er part i (RLS på trades/auctions).
    const tradeIds = [...new Set(samtaler.map((x) => x.trade_id).filter(Boolean) as string[])];
    const titelPrHandel = new Map<string, string | null>();
    if (tradeIds.length) {
      const { data: t } = await supabase
        .from("trades")
        .select("id, auction_id")
        .in("id", tradeIds);
      const aIds = [...new Set((t ?? []).map((h) => h.auction_id as string))];
      const { data: a } = aIds.length
        ? await supabase.from("auctions").select("id, titel").in("id", aIds)
        : { data: [] as { id: string; titel: string | null }[] };
      const titler = new Map((a ?? []).map((x) => [x.id as string, (x.titel as string | null) ?? null]));
      for (const h of t ?? []) titelPrHandel.set(h.id as string, titler.get(h.auction_id as string) ?? null);
    }

    const resultat: MinStaffSamtale[] = samtaler.map((x) => ({
      id: x.id as string,
      emne: x.emne as string,
      aabnet_kl: x.aabnet_kl as string,
      lukket_kl: (x.lukket_kl as string | null) ?? null,
      trade_id: (x.trade_id as string | null) ?? null,
      auktion_titel: x.trade_id ? (titelPrHandel.get(x.trade_id as string) ?? null) : null,
      sidste_besked: sidste.get(x.id as string) ?? null,
      antal_ulaeste: ulaeste.get(x.id as string) ?? 0,
    }));
    const tid = (m: MinStaffSamtale) => Date.parse(m.sidste_besked?.oprettet_kl ?? m.aabnet_kl);
    resultat.sort((x, y) => tid(y) - tid(x));
    return { samtaler: resultat };
  } catch (err) {
    console.error("Staff-chat hentMineStaffSamtaler fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Én af brugerens samtaler med alle beskeder. Markerer den som læst.
export async function hentMinStaffSamtale(samtaleId: string): Promise<
  | {
      samtale: { id: string; emne: string; aabnet_kl: string; lukket_kl: string | null; trade_id: string | null };
      beskeder: StaffBesked[];
    }
  | { fejl: string }
> {
  const { supabase, user } = await brugerSession();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  if (!erUuid(samtaleId)) return { fejl: "Samtalen findes ikke." };
  try {
    const { data: s, error } = await supabase
      .from("staff_samtaler")
      .select("id, emne, aabnet_kl, lukket_kl, trade_id")
      .eq("id", samtaleId)
      .eq("bruger_id", user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!s) return { fejl: "Samtalen findes ikke." };

    const { data: b, error: bFejl } = await supabase
      .from("staff_beskeder")
      .select("id, fra_staff, tekst, oprettet_kl")
      .eq("samtale_id", samtaleId)
      .order("oprettet_kl", { ascending: true })
      .order("id", { ascending: true })
      .limit(2000);
    if (bFejl) throw new Error(bFejl.message);

    const { error: lFejl } = await supabase.rpc("staff_chat_marker_laest", { p_samtale: samtaleId });
    if (lFejl) console.error("Staff-chat: markering som læst fejlede:", lFejl.message);

    return {
      samtale: {
        id: s.id as string,
        emne: s.emne as string,
        aabnet_kl: s.aabnet_kl as string,
        lukket_kl: (s.lukket_kl as string | null) ?? null,
        trade_id: (s.trade_id as string | null) ?? null,
      },
      beskeder: (b ?? []) as StaffBesked[],
    };
  } catch (err) {
    console.error("Staff-chat hentMinStaffSamtale fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Brugeren svarer i en åben samtale med BidHamr.
export async function svarStaffChat(
  samtaleId: string,
  tekst: string,
): Promise<{ ok: true; besked: StaffBesked } | { fejl: string }> {
  const { supabase, user } = await brugerSession();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  if (!erUuid(samtaleId)) return { fejl: "Samtalen findes ikke." };
  const ren = typeof tekst === "string" ? tekst.trim() : "";
  if (!ren) return { fejl: "Skriv en besked." };
  if (ren.length > STAFF_CHAT_MAKS_TEKST) {
    return { fejl: `Beskeden må højst være ${STAFF_CHAT_MAKS_TEKST} tegn.` };
  }
  const { data, error } = await supabase.rpc("staff_chat_svar", {
    p_samtale: samtaleId,
    p_tekst: ren,
  });
  if (error) {
    console.error("Staff-chat svarStaffChat fejlede:", error.message);
    return { fejl: GENERISK };
  }
  const svar = data as Kode;
  if (svar.kode !== "ok") return { fejl: kodeFejl(svar.kode) };
  return {
    ok: true as const,
    besked: {
      id: svar.besked_id as string,
      fra_staff: false,
      tekst: ren,
      oprettet_kl: new Date().toISOString(),
    },
  };
}

// Badge-tal for brugeren: ulæste beskeder fra BidHamr.
export async function antalUlaesteStaffBeskeder(): Promise<{ antal: number } | { fejl: string }> {
  const { supabase, user } = await brugerSession();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { data, error } = await supabase.rpc("antal_ulaeste_staff_beskeder");
  if (error) {
    console.error("Staff-chat antalUlaesteStaffBeskeder fejlede:", error.message);
    return { fejl: GENERISK };
  }
  return { antal: typeof data === "number" ? data : 0 };
}

// Brugeren markerer en samtale som læst (fx når den er åben og nye svar kommer via realtime).
export async function markerStaffSamtaleLaest(samtaleId: string): Promise<{ ok: true } | { fejl: string }> {
  const { supabase, user } = await brugerSession();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  if (!erUuid(samtaleId)) return { fejl: "Samtalen findes ikke." };
  const { error } = await supabase.rpc("staff_chat_marker_laest", { p_samtale: samtaleId });
  if (error) {
    console.error("Staff-chat markerStaffSamtaleLaest fejlede:", error.message);
    return { fejl: GENERISK };
  }
  return { ok: true as const };
}

// Brugerens samtale med BidHamr om en bestemt sag (sag_type 'sag') og den
// seneste besked fra BidHamr i den. Til sagsboksen på handelssiden. Kun
// læsning med brugerens egen session (RLS og kolonne-grants: kun egne samtaler).
export async function hentMinSagSamtale(
  sagId: string,
): Promise<
  | { samtale: { id: string; lukket: boolean; seneste: StaffBesked | null; ulaest: boolean } | null }
  | { fejl: string }
> {
  const { supabase, user } = await brugerSession();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  if (!erUuid(sagId)) return { fejl: "Sagen findes ikke." };
  try {
    const { data: s, error } = await supabase
      .from("staff_samtaler")
      .select("id, lukket_kl, bruger_laest_kl")
      .eq("bruger_id", user.id)
      .eq("sag_type", "sag")
      .eq("sag_id", sagId)
      .order("aabnet_kl", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; lukket_kl: string | null; bruger_laest_kl: string | null }>();
    if (error) throw new Error(error.message);
    if (!s) return { samtale: null };

    const { data: b, error: bFejl } = await supabase
      .from("staff_beskeder")
      .select("id, fra_staff, tekst, oprettet_kl")
      .eq("samtale_id", s.id)
      .eq("fra_staff", true)
      .order("oprettet_kl", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle<StaffBesked>();
    if (bFejl) throw new Error(bFejl.message);

    return {
      samtale: {
        id: s.id,
        lukket: s.lukket_kl !== null,
        seneste: b ?? null,
        ulaest: !!b && (!s.bruger_laest_kl || Date.parse(b.oprettet_kl) > Date.parse(s.bruger_laest_kl)),
      },
    };
  } catch (err) {
    console.error("Staff-chat hentMinSagSamtale fejlede:", err);
    return { fejl: GENERISK };
  }
}
