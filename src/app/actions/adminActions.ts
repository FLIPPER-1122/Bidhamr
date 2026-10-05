"use server";

import { assertRole, harMindstRolle } from "@/lib/adminAuth";
import { revalidatePath } from "next/cache";
import {
  annullerBetaling,
  hentBetalingForHandel,
  indsigelseBlokerer,
  overfoerTilSaelger,
  proevOverfoerselIgen,
  refunderBetaling,
} from "@/lib/betaling/stripeBetaling";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { notificerAdvarsler } from "@/lib/notifikationer/cron";
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";
import {
  sendAdminRefunderet,
  sendKoeberAfsluttet,
  sendSaelgerAfregning,
} from "@/lib/betaling/handelsbeskeder";

// --- Fejlhaandtering ---------------------------------------------------------
// Next skjuler beskeden fra fejl, der kastes i server actions, i produktion.
// Derfor kastes forventelige brugerfejl som BrugerFejl internt og omsaettes af
// koer() til { fejl } med den danske tekst. Alle andre fejl (databasefejl,
// adgangsfejl fra assertRole osv.) logges paa serveren og giver en generisk
// besked, saa intet internt afsloeres.

class BrugerFejl extends Error {}

const GENERISK_FEJL = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

async function koer<T>(
  navn: string,
  fn: () => Promise<T>,
): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    // redirect()/notFound() o.l. skal slippe igennem til Next.
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error(`Admin-handling ${navn} fejlede:`, err);
    return { fejl: GENERISK_FEJL };
  }
}

// --- Brugere ---------------------------------------------------------------

// Systembrugeren "BidHamr" (afsender af faellesbeskeder) er ikke en rigtig
// bruger og kan ikke advares, suspenderes eller faa en anden rolle. Databasen
// afviser det ogsaa (20261003002000_systembruger_vaern.sql).
function afvisSystembruger(userId: string) {
  if (userId === BIDHAMR_SYSTEM_ID) {
    throw new BrugerFejl("BidHamr-systembrugeren kan ikke ændres herfra.");
  }
}

type AdminClient = Awaited<ReturnType<typeof assertRole>>["admin"];

async function logModeration(
  admin: AdminClient,
  entry: {
    medarbejder_id: string;
    handling: string;
    maal_type: "auktion" | "anmeldelse" | "bruger" | "handel";
    maal_id: string;
    bruger_id: string | null;
    aarsag: string;
  },
) {
  const { error } = await admin.from("moderation_log").insert(entry);
  if (error) throw new Error(error.message);
}

// Som logModeration, men returnerer fejlen i stedet for at kaste den. Bruges
// hvor den egentlige handling allerede er gennemfoert, og en fejlet logning
// derfor ikke maa se ud som om intet skete.
async function logModerationBloedt(
  admin: AdminClient,
  entry: {
    medarbejder_id: string;
    handling: string;
    maal_type: "auktion" | "anmeldelse" | "bruger" | "handel";
    maal_id: string;
    bruger_id: string | null;
    aarsag: string;
  },
): Promise<string | null> {
  const { error } = await admin.from("moderation_log").insert(entry);
  if (!error) return null;
  console.error("Kunne ikke skrive til moderation_log:", error);
  return error.message;
}

async function suspendUserImpl(formData: FormData): Promise<void> {
  const userId = formData.get("userId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const varighed = (formData.get("varighed") as string) ?? "permanent";
  const { admin, userId: staffId } = await assertRole("medarbejder");

  afvisSystembruger(userId);
  if (!aarsag) throw new BrugerFejl("Angiv en årsag for suspensionen.");
  if (!["1", "7", "permanent"].includes(varighed)) {
    throw new BrugerFejl("Ugyldig varighed.");
  }

  const { data: target } = await admin
    .from("users")
    .select("rolle, konto_lukket_kl")
    .eq("id", userId)
    .single();
  if (!target) throw new BrugerFejl("Brugeren findes ikke.");
  if (target.rolle === "admin" || target.rolle === "chef") {
    throw new BrugerFejl("Admins og chefer kan ikke suspenderes.");
  }
  // En permanent lukket konto er allerede suspenderet uden slutdato.
  if (target.konto_lukket_kl) {
    throw new BrugerFejl("Kontoen er allerede lukket permanent.");
  }

  const suspenderetTil =
    varighed === "permanent"
      ? null
      : new Date(Date.now() + Number(varighed) * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await admin
    .from("users")
    .update({
      suspenderet: true,
      suspenderet_aarsag: aarsag,
      suspenderet_kl: new Date().toISOString(),
      suspenderet_til: suspenderetTil,
    })
    .eq("id", userId);
  if (error) throw new Error(error.message);

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "suspender",
    maal_type: "bruger",
    maal_id: userId,
    bruger_id: userId,
    aarsag: `${aarsag} (varighed: ${varighed === "permanent" ? "permanent" : `${varighed} dag(e)`})`,
  });

  revalidatePath("/admin/brugere");
  revalidatePath(`/admin/brugere/${userId}`);
}

async function unsuspendUserImpl(formData: FormData): Promise<void> {
  const userId = formData.get("userId") as string;
  const { admin, userId: staffId } = await assertRole("medarbejder");
  afvisSystembruger(userId);

  // En permanent lukket konto (fx svindel) kan ikke åbnes igen herfra.
  // Databasen afviser det også (users_beskyt_lukket_konto).
  const { data: konto } = await admin
    .from("users")
    .select("konto_lukket_kl")
    .eq("id", userId)
    .maybeSingle<{ konto_lukket_kl: string | null }>();
  if (konto?.konto_lukket_kl) {
    throw new BrugerFejl("Kontoen er lukket permanent og kan ikke åbnes igen.");
  }

  const { error } = await admin
    .from("users")
    .update({
      suspenderet: false,
      suspenderet_aarsag: null,
      suspenderet_kl: null,
      suspenderet_til: null,
    })
    .eq("id", userId);
  if (error) throw new Error(error.message);

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "ophaev_suspension",
    maal_type: "bruger",
    maal_id: userId,
    bruger_id: userId,
    aarsag: "Suspension ophævet",
  });

  revalidatePath("/admin/brugere");
  revalidatePath(`/admin/brugere/${userId}`);
}

// --- Advarsler: to tekster (ROADMAP-BESLUTNINGER, "Advarsler og begrundelse") ---
// begrundelse_bruger vises for brugeren (klokke/mail/push og /konto) og kræves.
// Den interne note (aarsag) ser kun staff og er valgfri.

const BEGRUNDELSE_BRUGER_MAKS = 1000;
const INTERN_NOTE_MAKS = 2000;

const ADVARSEL_TEKST_FEJL = {
  begrundelse_bruger_mangler: "Skriv en begrundelse til brugeren. Den vises for brugeren.",
  begrundelse_bruger_for_lang: `Begrundelsen til brugeren er for lang (højst ${BEGRUNDELSE_BRUGER_MAKS} tegn).`,
  begrundelse_for_lang: `Den interne note er for lang (højst ${INTERN_NOTE_MAKS} tegn).`,
} as const;

// Kaster BrugerFejl med dansk tekst, hvis teksterne er ugyldige.
function validerAdvarselTekster(begrundelseBruger: string, internNote: string) {
  if (!begrundelseBruger) throw new BrugerFejl(ADVARSEL_TEKST_FEJL.begrundelse_bruger_mangler);
  if (begrundelseBruger.length > BEGRUNDELSE_BRUGER_MAKS) {
    throw new BrugerFejl(ADVARSEL_TEKST_FEJL.begrundelse_bruger_for_lang);
  }
  if (internNote.length > INTERN_NOTE_MAKS) {
    throw new BrugerFejl(ADVARSEL_TEKST_FEJL.begrundelse_for_lang);
  }
}

// Fejlkoder fra admin_advar_bruger oversat til dansk.
const ADVAR_BRUGER_FEJL: Record<string, string> = {
  ...ADVARSEL_TEKST_FEJL,
  ingen_adgang: "Du har ikke adgang til at give advarsler.",
  ugyldig_bruger: "Brugeren blev ikke fundet.",
  sig_selv: "Du kan ikke give dig selv en advarsel.",
  staff: "Medarbejdere, admins og chefer kan ikke få en advarsel herfra.",
  inhabil: "Du kan ikke give denne bruger en advarsel, fordi I har handlet med hinanden.",
};

// formData: userId, begrundelse_bruger (påkrævet), aarsag (intern note, valgfri).
async function advarUserImpl(formData: FormData): Promise<void> {
  const userId = ((formData.get("userId") as string) ?? "").trim();
  const begrundelseBruger = ((formData.get("begrundelse_bruger") as string) ?? "").trim();
  const internNote = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");

  if (!userId) throw new BrugerFejl("Brugeren blev ikke fundet.");
  afvisSystembruger(userId);
  validerAdvarselTekster(begrundelseBruger, internNote);

  // Databasen (admin_advar_bruger, 20261003051000_advarsel_inhabil.sql)
  // tjekker rolle, sig selv, systembruger, staff-konti, inhabilitet og
  // teksterne, indsætter advarslen og logger i moderation_log.
  const { data, error } = await admin.rpc("admin_advar_bruger", {
    p_medarbejder: staffId,
    p_bruger: userId,
    p_begrundelse_bruger: begrundelseBruger,
    p_intern_note: internNote || null,
  });
  if (error) throw new Error(error.message);
  const kode = (data as { kode?: string } | null)?.kode;
  // allerede_givet = dobbeltklik; advarslen findes allerede, så det er en succes.
  if (kode !== "ok" && kode !== "allerede_givet") {
    const tekst = kode ? ADVAR_BRUGER_FEJL[kode] : undefined;
    if (tekst) throw new BrugerFejl(tekst);
    throw new Error(`admin_advar_bruger returnerede ${kode ?? "intet"}`);
  }

  // Brugeren får besked (klokke/mail/push). Cron samler op, hvis det fejler.
  after(() => notificerAdvarsler());

  revalidatePath(`/admin/brugere/${userId}`);
}

// Kun chef: skift rolle mellem 'bruger', 'medarbejder' og 'admin'.
// Chef-rollen kan ikke tildeles eller fjernes herfra.
async function setRolleImpl(formData: FormData): Promise<void> {
  const userId = formData.get("userId") as string;
  const nyRolle = formData.get("rolle") as string;
  const { admin, userId: staffId } = await assertRole("chef");

  if (!["bruger", "medarbejder", "admin"].includes(nyRolle)) {
    throw new BrugerFejl("Ugyldig rolle.");
  }
  if (userId === staffId) throw new BrugerFejl("Du kan ikke ændre din egen rolle.");
  afvisSystembruger(userId);

  const { data: target } = await admin
    .from("users")
    .select("rolle")
    .eq("id", userId)
    .single();
  if (!target) throw new BrugerFejl("Brugeren findes ikke.");
  if (target.rolle === "chef") {
    throw new BrugerFejl("Chefer kan ikke ændres herfra.");
  }

  const { error } = await admin
    .from("users")
    .update({ rolle: nyRolle })
    .eq("id", userId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/medarbejdere");
  revalidatePath("/admin/brugere");
}

// --- Auktioner -------------------------------------------------------------

// "Slet" arkiverer: handelsdata (bud, handler, bedoemmelser, anmeldelser)
// maa aldrig slettes (bogfoeringsloven/DAC7). Auktionen annulleres og skjules.
// Har auktionen en handel, afvises det - den skal loeses som en sag.
async function deleteAuctionImpl(
  formData: FormData,
): Promise<{ ok: true } | { fejl: string }> {
  const auktionId = formData.get("auktionId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();

  let admin, staffId;
  try {
    ({ admin, userId: staffId } = await assertRole("admin"));
  } catch {
    return { fejl: "Du har ikke adgang til at fjerne auktioner." };
  }

  if (!aarsag) return { fejl: "Angiv en årsag for fjernelsen." };

  const { data: auktion } = await admin
    .from("auctions")
    .select("bruger_id, status, skjult")
    .eq("id", auktionId)
    .maybeSingle();
  if (!auktion) return { fejl: "Auktionen findes ikke." };

  const { count: antalHandler } = await admin
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("auction_id", auktionId);
  if ((antalHandler ?? 0) > 0) {
    return {
      fejl: "Auktionen har en handel og kan ikke fjernes. Håndter den som en sag.",
    };
  }
  if (auktion.status === "afsluttet") {
    return { fejl: "Auktionen er afsluttet og kan ikke fjernes. Skjul den i stedet." };
  }

  // Idempotent: kun en aktiv/annulleret auktion, der ikke allerede er fjernet.
  const { data: opdateret, error } = await admin
    .from("auctions")
    .update({ status: "annulleret", skjult: true })
    .eq("id", auktionId)
    .in("status", ["aktiv", "annulleret"])
    .select("id");
  if (error) return { fejl: "Auktionen kunne ikke fjernes. Prøv igen." };
  if (!opdateret || opdateret.length === 0) {
    return { fejl: "Auktionens status er ændret. Genindlæs siden." };
  }

  if (!(auktion.status === "annulleret" && auktion.skjult)) {
    await logModerationBloedt(admin, {
      medarbejder_id: staffId,
      handling: "slet_auktion",
      maal_type: "auktion",
      maal_id: auktionId,
      bruger_id: auktion.bruger_id,
      aarsag,
    });
  }

  revalidatePath("/admin/auktioner");
  revalidatePath(`/admin/brugere/${auktion.bruger_id}`);
  return { ok: true };
}

async function cancelAuctionImpl(formData: FormData): Promise<void> {
  const auktionId = formData.get("auktionId") as string;
  const { admin } = await assertRole("admin");

  // Idempotent: kun en aktiv auktion annulleres. En afsluttet auktion har en
  // vinder/handel og skal loeses som en sag.
  const { error } = await admin
    .from("auctions")
    .update({ status: "annulleret" })
    .eq("id", auktionId)
    .eq("status", "aktiv");
  if (error) throw new Error(error.message);

  revalidatePath("/admin/auktioner");
}

async function hideAuctionImpl(formData: FormData): Promise<void> {
  const auktionId = formData.get("auktionId") as string;
  const { admin } = await assertRole("admin");

  const { error } = await admin
    .from("auctions")
    .update({ skjult: true })
    .eq("id", auktionId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/auktioner");
}

async function unhideAuctionImpl(formData: FormData): Promise<void> {
  const auktionId = formData.get("auktionId") as string;
  const { admin } = await assertRole("admin");

  const { error } = await admin
    .from("auctions")
    .update({ skjult: false })
    .eq("id", auktionId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/auktioner");
}

// --- Bedømmelser -----------------------------------------------------------

async function deleteRatingImpl(formData: FormData): Promise<void> {
  const ratingId = formData.get("ratingId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");

  if (!aarsag) throw new BrugerFejl("Angiv en årsag for sletningen.");

  const { data: rating } = await admin
    .from("ratings")
    .select("fra_bruger_id, til_bruger_id")
    .eq("id", ratingId)
    .single();
  if (!rating) throw new BrugerFejl("Anmeldelsen findes ikke.");

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "slet_anmeldelse",
    maal_type: "anmeldelse",
    maal_id: ratingId,
    bruger_id: rating.fra_bruger_id,
    aarsag,
  });

  // Handelsdata slettes aldrig: "slet" arkiverer ved at skjule bedoemmelsen.
  // Skjulte bedoemmelser er filtreret fra i visning og gennemsnit.
  const { error } = await admin
    .from("ratings")
    .update({ skjult: true })
    .eq("id", ratingId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/bedommelser");
  revalidatePath(`/admin/brugere/${rating.fra_bruger_id}`);
}

async function hideRatingImpl(formData: FormData): Promise<void> {
  const ratingId = formData.get("ratingId") as string;
  const { admin } = await assertRole("admin");

  const { error } = await admin
    .from("ratings")
    .update({ skjult: true })
    .eq("id", ratingId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/bedommelser");
}

async function unhideRatingImpl(formData: FormData): Promise<void> {
  const ratingId = formData.get("ratingId") as string;
  const { admin } = await assertRole("admin");

  const { error } = await admin
    .from("ratings")
    .update({ skjult: false })
    .eq("id", ratingId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/bedommelser");
}


// --- Rapporter -------------------------------------------------------------
// Tre udfald af en rapport. Kun "markér som behandlet" rører ikke auktionen og
// er derfor tilladt for medarbejdere; de to øvrige ændrer et opslag og kræver
// admin, som resten af auktions-moderationen.

async function afslutRapport(
  admin: AdminClient,
  staffId: string,
  rapportId: string,
  status: "behandlet" | "under_behandling" | "fjernet",
  note: string,
) {
  const { error } = await admin
    .from("reports")
    .update({
      status,
      handled_by: staffId,
      handled_note: note,
      handled_at: new Date().toISOString(),
    })
    .eq("id", rapportId);
  if (error) throw new Error(error.message);
}

async function hentRapport(admin: AdminClient, rapportId: string) {
  const { data } = await admin
    .from("reports")
    .select("id, auction_id")
    .eq("id", rapportId)
    .single();
  if (!data) throw new BrugerFejl("Rapporten findes ikke.");
  return data;
}

// Afslut uden handling - auktionen forbliver aktiv. Noten er obligatorisk og
// dokumenterer hvad der blev tjekket, og hvad konklusionen blev.
// Feltet hedder "aarsag" i formularen, fordi ConfirmDialog bruger det navn.
async function rapportMarkerBehandletImpl(formData: FormData): Promise<void> {
  const rapportId = formData.get("rapportId") as string;
  const note = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");

  if (!note) {
    throw new BrugerFejl("Skriv en note om hvad du har tjekket, og hvad konklusionen er.");
  }

  await afslutRapport(admin, staffId, rapportId, "behandlet", note);
  revalidatePath("/admin/rapporter");
  revalidatePath("/admin/opklarede-rapporter");
}

// Skjul opslaget midlertidigt mens sagen undersøges.
async function rapportSletMidlertidigtImpl(formData: FormData): Promise<void> {
  const rapportId = formData.get("rapportId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");

  if (!aarsag) throw new BrugerFejl("Angiv en årsag.");
  const rapport = await hentRapport(admin, rapportId);

  const { data: auktion } = await admin
    .from("auctions")
    .select("bruger_id")
    .eq("id", rapport.auction_id)
    .single();
  if (!auktion) throw new BrugerFejl("Auktionen findes ikke.");

  const { error } = await admin
    .from("auctions")
    .update({ skjult: true })
    .eq("id", rapport.auction_id);
  if (error) throw new Error(error.message);

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "slet_auktion",
    maal_type: "auktion",
    maal_id: rapport.auction_id,
    bruger_id: auktion.bruger_id,
    aarsag: `Midlertidigt skjult efter anmeldelse: ${aarsag}`,
  });

  await afslutRapport(admin, staffId, rapportId, "under_behandling", aarsag);
  revalidatePath("/admin/rapporter");
  revalidatePath("/admin/auktioner");
  revalidatePath(`/auktion/${rapport.auction_id}`);
}

// Fjern opslaget permanent fra platformen. Auktionen annulleres og skjules i
// stedet for at blive slettet: reports.auction_id har ON DELETE CASCADE, så en
// hård sletning ville også fjerne selve rapporten og dermed dokumentationen.
async function rapportFjernOpslagImpl(formData: FormData): Promise<void> {
  const rapportId = formData.get("rapportId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");

  if (!aarsag) throw new BrugerFejl("Angiv en årsag.");
  const rapport = await hentRapport(admin, rapportId);

  const { data: auktion } = await admin
    .from("auctions")
    .select("bruger_id")
    .eq("id", rapport.auction_id)
    .single();
  if (!auktion) throw new BrugerFejl("Auktionen findes ikke.");

  const { error } = await admin
    .from("auctions")
    .update({ status: "annulleret", skjult: true })
    .eq("id", rapport.auction_id);
  if (error) throw new Error(error.message);

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "slet_auktion",
    maal_type: "auktion",
    maal_id: rapport.auction_id,
    bruger_id: auktion.bruger_id,
    aarsag: `Opslag fjernet efter anmeldelse: ${aarsag}`,
  });

  await afslutRapport(admin, staffId, rapportId, "fjernet", aarsag);
  revalidatePath("/admin/rapporter");
  revalidatePath("/admin/auktioner");
  revalidatePath(`/auktion/${rapport.auction_id}`);
}

// Fortryd. Skal også gøre opslaget synligt igen - ellers bliver auktionen ved
// med at give 404 for brugerne, selvom rapporten står som afventende.
async function rapportGenaabnImpl(formData: FormData): Promise<void> {
  const rapportId = formData.get("rapportId") as string;
  const { admin, rolle, userId: staffId } = await assertRole("medarbejder");

  const { data: rapport } = await admin
    .from("reports")
    .select("id, auction_id, status")
    .eq("id", rapportId)
    .single();
  if (!rapport) {
    throw new BrugerFejl(
      "Rapporten findes ikke. Den kan være flyttet til arkivet og kan ikke genåbnes.",
    );
  }

  // 'handled' rørte aldrig opslaget, så der er intet at fortryde.
  const opslagetBlevAendret =
    rapport.status === "under_behandling" || rapport.status === "fjernet";

  if (opslagetBlevAendret && !harMindstRolle(rolle, "admin")) {
    throw new BrugerFejl(
      "Kun admin kan gøre et skjult eller fjernet opslag synligt igen.",
    );
  }

  // Rapporten genåbnes FØR opslaget ændres. Den automatiske oprydning kan have
  // flyttet rapporten til arkivet imens (eller en anden kan have genåbnet den) - så må
  // opslaget ikke røres. Status tjekkes i samme update, så et dobbeltklik ikke
  // giver dobbelt effekt.
  const { data: genaabnet, error } = await admin
    .from("reports")
    .update({
      status: "pending",
      handled_by: null,
      handled_note: null,
      handled_at: null,
    })
    .eq("id", rapportId)
    .eq("status", rapport.status)
    .select("id");
  if (error) throw new Error(error.message);
  if (!genaabnet || genaabnet.length === 0) {
    const { data: findes } = await admin
      .from("reports")
      .select("id")
      .eq("id", rapportId)
      .maybeSingle();
    throw new BrugerFejl(
      findes
        ? "Rapporten er allerede ændret af en anden. Genindlæs siden."
        : "Rapporten er flyttet til arkivet og kan ikke genåbnes.",
    );
  }

  if (opslagetBlevAendret) {
    const { data: auktion } = await admin
      .from("auctions")
      .select("bruger_id, slutter_kl")
      .eq("id", rapport.auction_id)
      .single();

    if (auktion) {
      const opdatering: { skjult: boolean; status?: string; arkiveret_kl?: null } = {
        skjult: false,
      };

      // 'fjernet' satte status til 'annulleret' - den skal tilbage. En auktion
      // hvis sluttid er passeret genoplives som afsluttet, ikke som aktiv.
      if (rapport.status === "fjernet") {
        opdatering.status =
          new Date(auktion.slutter_kl) > new Date() ? "aktiv" : "afsluttet";
      }

      // En aktiv auktion må aldrig være arkiveret. Triggeren
      // auctions_arkiv_felter nulstiller også arkiveret_kl, når status bliver
      // 'aktiv'; her gøres det eksplicit. En afsluttet auktion forbliver
      // arkiveret - afsluttet_kl ændres ikke, så næste oprydning ville
      // arkivere den igen med det samme.
      if (opdatering.status === "aktiv") opdatering.arkiveret_kl = null;

      const { error: opdateringFejl } = await admin
        .from("auctions")
        .update(opdatering)
        .eq("id", rapport.auction_id);
      if (opdateringFejl) throw new Error(opdateringFejl.message);

      await logModeration(admin, {
        medarbejder_id: staffId,
        handling: "annuller_auktion",
        maal_type: "auktion",
        maal_id: rapport.auction_id,
        bruger_id: auktion.bruger_id,
        aarsag: "Opslag gjort synligt igen da anmeldelsen blev genåbnet",
      });
    }
  }

  revalidatePath("/admin/rapporter");
  revalidatePath("/admin/opklarede-rapporter");
  revalidatePath("/admin/auktioner");
  revalidatePath(`/auktion/${rapport.auction_id}`);
}

// --- Sager (handler) ---------------------------------------------------------

const AKTIVE_HANDEL_STATUSSER = ["betaling_modtaget", "pakke_sendt", "modtaget"];

async function hentHandelTilSag(admin: AdminClient, tradeId: string) {
  const { data: handel } = await admin
    .from("trades")
    .select("id, auction_id, buyer_id, seller_id, status, sag_aaben")
    .eq("id", tradeId)
    .single();
  if (!handel) throw new BrugerFejl("Handlen findes ikke.");
  return handel;
}

// En sag fra køberen (tabellen sager) skal afgøres under Sager -> sagen
// (src/app/actions/adminSager.ts), ikke med de generelle handelsknapper.
// Databasen afviser det også (trigger trades_beskyt_sagsfrys).
// Også når sagen er afgjort, men pengene venter på ankefristen (4 dage):
// så sker refusion/frigivelse automatisk efter afgørelsen, og databasen
// afviser admin-refusion (betaling_paabegynd_refusion) og frigivelse.
const AABEN_KOEBERSAG =
  "Handlen har en sag fra køberen, der holder pengene (åben, afventer retur eller afgjort med ankefrist). Afgør eller genåbn sagen under Sager.";

async function afvisVedAabenKoeberSag(admin: AdminClient, tradeId: string) {
  const { data, error } = await admin.rpc("sag_holder_pengene", { p_trade: tradeId });
  if (error) throw new Error(error.message);
  if (data === true) throw new BrugerFejl(AABEN_KOEBERSAG);
}

// Ingen medarbejder må behandle en handel, hvor han selv er køber eller
// sælger. Databasen afviser det også, hvor funktionen kender medarbejderen
// (20261003012000_inhabil_handel.sql); admin_frigiv_handel og
// betaling_paabegynd_refusion gør ikke, så tjekket her er værnet.
const INHABIL_HANDEL = "Du kan ikke behandle en handel, hvor du selv er køber eller sælger.";

function afvisInhabil(
  staffId: string,
  parter: { buyer_id: string | null; seller_id: string | null },
) {
  if (staffId === parter.buyer_id || staffId === parter.seller_id) {
    throw new BrugerFejl(INHABIL_HANDEL);
  }
}

function revaliderSag(tradeId: string) {
  revalidatePath("/admin/sager");
  revalidatePath("/admin/handler");
  revalidatePath("/admin/betalinger");
  revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/mine-handler");
}

// Flag en handel som sag. Medarbejdere maa godt - det flytter ingen penge.
async function sagAabnImpl(formData: FormData): Promise<void> {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");
  if (!aarsag) throw new BrugerFejl("Beskriv hvorfor sagen åbnes.");

  const handel = await hentHandelTilSag(admin, tradeId);
  afvisInhabil(staffId, handel);
  if (!AKTIVE_HANDEL_STATUSSER.includes(handel.status)) {
    throw new BrugerFejl("Handlen er allerede afsluttet.");
  }

  const { error } = await admin
    .from("trades")
    .update({
      sag_aaben: true,
      sag_note: aarsag,
      sag_aabnet_af: staffId,
      sag_aabnet_at: new Date().toISOString(),
    })
    .eq("id", tradeId);
  if (error) throw new Error(error.message);

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "sag_aabnet",
    maal_type: "handel",
    maal_id: tradeId,
    bruger_id: null,
    aarsag,
  });
  revaliderSag(tradeId);
}

// Luk sagen uden at flytte penge - handlen fortsaetter normalt.
async function sagLukImpl(formData: FormData): Promise<void> {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");
  if (!aarsag) throw new BrugerFejl("Skriv en afsluttende note.");
  afvisInhabil(staffId, await hentHandelTilSag(admin, tradeId));
  await afvisVedAabenKoeberSag(admin, tradeId);

  const { error } = await admin
    .from("trades")
    .update({ sag_aaben: false })
    .eq("id", tradeId);
  if (error) throw new Error(error.message);

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "sag_lukket",
    maal_type: "handel",
    maal_id: tradeId,
    bruger_id: null,
    aarsag,
  });
  revaliderSag(tradeId);
}

// Moderationsloggen ses af medarbejdere og indeholder derfor aldrig beløb -
// beløb ses kun af chef i betalingernes beløbskolonner.

// Afregn saelgeren uden koeberens godkendelse. Kun admin og opefter.
// Handler med en Stripe-betaling: frigivet_kl saettes i databasen, og
// beloebet (bud minus 5% saelgergebyr) overfoeres til saelgerens Connect-konto.
// Handler uden betaling kan ikke frigives.
async function handelFrigivImpl(formData: FormData): Promise<void> {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");
  if (!aarsag) throw new BrugerFejl("Angiv en begrundelse.");

  const handel = await hentHandelTilSag(admin, tradeId);
  afvisInhabil(staffId, handel);
  await afvisVedAabenKoeberSag(admin, tradeId);
  const betaling = await hentBetalingForHandel(tradeId);
  if (!betaling) throw new BrugerFejl("Handlen har ingen betaling og kan ikke frigives.");
  if (betaling.status !== "betalt") {
    throw new BrugerFejl("Handlen er ikke betalt og kan ikke frigives.");
  }
  if (indsigelseBlokerer(betaling)) {
    throw new BrugerFejl(
      "Køberen har en indsigelse mod betalingen hos sin bank. Handlen kan ikke frigives, før den er afgjort.",
    );
  }

  const { data: frigivet, error } = await admin.rpc("admin_frigiv_handel", {
    p_trade: tradeId,
  });
  if (error) throw new Error(error.message);
  if (!frigivet) throw new BrugerFejl("Handlen er allerede afsluttet.");

  // Afregning til sælgeren ("Pengene er frigivet") og besked til køberen.
  // Idempotente nøgler pr. handel; kaster aldrig.
  await sendSaelgerAfregning(tradeId, "bidhamr");
  await sendKoeberAfsluttet(tradeId, "bidhamr");

  let overfoersel: string;
  try {
    const r = await overfoerTilSaelger(betaling.id);
    overfoersel =
      r === "overfoert" || r === "allerede_overfoert"
        ? " (overført via Stripe)"
        : ` (overførsel venter: ${r})`;
  } catch (err) {
    console.error("Overførsel efter admin-frigivelse fejlede (prøves igen af cron):", err);
    overfoersel = " (overførsel fejlede - prøves igen automatisk)";
  }

  const beloeb = `Frigivet til sælger${overfoersel}`;

  // Pengene er frigivet - logfejl maa ikke se ud som om intet skete.
  await logModerationBloedt(admin, {
    medarbejder_id: staffId,
    handling: "handel_frigivet",
    maal_type: "handel",
    maal_id: tradeId,
    bruger_id: handel.seller_id,
    aarsag: `${beloeb} — ${aarsag}`,
  });
  revaliderSag(tradeId);
}

// Refunder koeberen og annuller handlen. Kun admin og opefter.
// Handler med en Stripe-betaling:
//   - betalt (og ikke frigivet/overfoert): fuld refusion hos Stripe af det,
//     koeberen betalte (bud + koebergebyr + fragt + evt. BidHamr Beskyttelse).
//   - ikke betalt endnu: betalingen annulleres, og PaymentIntenten annulleres
//     hos Stripe.
// Handler uden betaling kan ikke refunderes.
async function handelRefunderImpl(formData: FormData): Promise<void> {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");
  if (!aarsag) throw new BrugerFejl("Angiv en begrundelse.");

  const handel = await hentHandelTilSag(admin, tradeId);
  afvisInhabil(staffId, handel);
  await afvisVedAabenKoeberSag(admin, tradeId);
  const betaling = await hentBetalingForHandel(tradeId);

  if (!betaling) throw new BrugerFejl("Handlen har ingen betaling og kan ikke refunderes.");

  let logTekst: string;
  if (betaling.status === "afventer" || betaling.status === "behandles") {
    // Annulleres i databasen sammen med en ubetalte_vindere-række
    // (aarsag 'admin_annulleret', status 'afvist' - ingen advarsel), så
    // sælgeren kan tilbyde varen til næste byder eller sætte den op igen.
    const { data, error } = await admin.rpc("admin_annuller_ikke_betalt", {
      p_trade: tradeId,
      p_admin: staffId,
      p_begrundelse: aarsag,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode: string } | null)?.kode;
    if (kode !== "ok") {
      throw new BrugerFejl(
        kode === "ingen_adgang"
          ? "Du har ikke adgang til at annullere handlen."
          : kode === "inhabil"
            ? INHABIL_HANDEL
            : "Betalingen kan ikke annulleres.",
      );
    }
    // PaymentIntenten annulleres hos Stripe. Fejler det, prøver cron igen
    // (stripe_annulleret_kl er tom) og markerer til admin efter 7 dage.
    // stripe_annulleret_kl sættes kun, når annulleringen faktisk lykkedes.
    try {
      const r = await annullerBetaling(tradeId);
      if (r === "stripe_fejlede") {
        console.error("Stripe-annullering efter admin-annullering fejlede (cron prøver igen):", tradeId);
      } else {
        await admin
          .from("ubetalte_vindere")
          .update({ stripe_annulleret_kl: new Date().toISOString() })
          .eq("trade_id", tradeId)
          .is("stripe_annulleret_kl", null);
      }
    } catch (err) {
      console.error("Stripe-annullering efter admin-annullering fejlede (cron prøver igen):", err);
    }
    logTekst = "Ikke betalt - betalingen annulleret, 0 kr refunderet";
  } else {
    if (indsigelseBlokerer(betaling)) {
      throw new BrugerFejl(
        "Der er en åben indsigelse hos køberens bank. Refusion afgøres af indsigelsen.",
      );
    }
    const { data: beloeb, error } = await admin.rpc("betaling_paabegynd_refusion", {
      p_trade: tradeId,
      p_aarsag: "admin",
    });
    if (error) throw new Error(error.message);
    if (beloeb === null) {
      // En sag (eller indsigelse) kan være kommet, efter betalingen blev hentet.
      await afvisVedAabenKoeberSag(admin, tradeId);
      const frisk = await hentBetalingForHandel(tradeId);
      if (frisk && indsigelseBlokerer(frisk)) {
        throw new BrugerFejl(
          "Der er en åben indsigelse hos køberens bank. Refusion afgøres af indsigelsen.",
        );
      }
      throw new BrugerFejl(
        "Handlen kan ikke refunderes: den er ikke betalt, allerede refunderet eller pengene er overført til sælger.",
      );
    }
    // Refusionen er claimet, og handlen er annulleret: køberen og sælgeren
    // får besked nu - også hvis Stripe-kaldet nedenfor fejler og skal prøves
    // igen. Idempotente nøgler pr. handel; kaster aldrig.
    await sendAdminRefunderet(tradeId);
    let resultat: string;
    try {
      resultat = await refunderBetaling(betaling.id);
    } catch (err) {
      console.error("Refusion fejlede:", tradeId, err);
      throw new BrugerFejl(
        "Refusionen fejlede hos Stripe. Handlen er annulleret og markeret - prøv igen.",
      );
    }
    logTekst = `Fuld refusion via Stripe (${resultat})`;
  }

  await logModerationBloedt(admin, {
    medarbejder_id: staffId,
    handling: "handel_refunderet",
    maal_type: "handel",
    maal_id: tradeId,
    bruger_id: handel.buyer_id,
    aarsag: `${logTekst} — ${aarsag}`,
  });
  revaliderSag(tradeId);
}

// --- Eksporterede server actions ---------------------------------------------
// Tynde indpakninger: returnerer { fejl } i stedet for at kaste.

export async function suspendUser(formData: FormData) {
  return koer("suspendUser", () => suspendUserImpl(formData));
}

export async function unsuspendUser(formData: FormData) {
  return koer("unsuspendUser", () => unsuspendUserImpl(formData));
}

export async function advarUser(formData: FormData) {
  return koer("advarUser", () => advarUserImpl(formData));
}

export async function setRolle(formData: FormData) {
  return koer("setRolle", () => setRolleImpl(formData));
}

export async function deleteAuction(formData: FormData) {
  return koer("deleteAuction", () => deleteAuctionImpl(formData));
}

export async function cancelAuction(formData: FormData) {
  return koer("cancelAuction", () => cancelAuctionImpl(formData));
}

export async function hideAuction(formData: FormData) {
  return koer("hideAuction", () => hideAuctionImpl(formData));
}

export async function unhideAuction(formData: FormData) {
  return koer("unhideAuction", () => unhideAuctionImpl(formData));
}

export async function deleteRating(formData: FormData) {
  return koer("deleteRating", () => deleteRatingImpl(formData));
}

export async function hideRating(formData: FormData) {
  return koer("hideRating", () => hideRatingImpl(formData));
}

export async function unhideRating(formData: FormData) {
  return koer("unhideRating", () => unhideRatingImpl(formData));
}

export async function rapportMarkerBehandlet(formData: FormData) {
  return koer("rapportMarkerBehandlet", () => rapportMarkerBehandletImpl(formData));
}

export async function rapportSletMidlertidigt(formData: FormData) {
  return koer("rapportSletMidlertidigt", () => rapportSletMidlertidigtImpl(formData));
}

export async function rapportFjernOpslag(formData: FormData) {
  return koer("rapportFjernOpslag", () => rapportFjernOpslagImpl(formData));
}

export async function rapportGenaabn(formData: FormData) {
  return koer("rapportGenaabn", () => rapportGenaabnImpl(formData));
}

export async function sagAabn(formData: FormData) {
  return koer("sagAabn", () => sagAabnImpl(formData));
}

export async function sagLuk(formData: FormData) {
  return koer("sagLuk", () => sagLukImpl(formData));
}

export async function handelFrigiv(formData: FormData) {
  return koer("handelFrigiv", () => handelFrigivImpl(formData));
}

export async function handelRefunder(formData: FormData) {
  return koer("handelRefunder", () => handelRefunderImpl(formData));
}

// --- Ubetalt vinder ------------------------------------------------------------
// Sag oprettes af cron, når vinderen ikke betaler inden fristen. Advarslen
// gives IKKE automatisk: en medarbejder giver den eller afviser sagen.

const UBETALT_FEJL: Record<string, string> = {
  ...ADVARSEL_TEKST_FEJL,
  ikke_fundet: "Sagen findes ikke.",
  ingen_adgang: "Du har ikke adgang til at behandle sagen.",
  behandlet: "Sagen er allerede behandlet.",
  inhabil: "Du kan ikke behandle en sag, hvor du selv er køber eller sælger.",
  begrundelse_mangler: "Skriv en begrundelse for at afvise sagen.",
};

// giv = true: begrundelse er den interne note (valgfri), begrundelseBruger kræves.
// giv = false: begrundelse er begrundelsen for at afvise (påkrævet).
async function behandlUbetalt(
  sagId: string,
  giv: boolean,
  begrundelse: string,
  begrundelseBruger: string,
): Promise<{ ok: true }> {
  const { admin, userId: staffId } = await assertRole("medarbejder");
  if (!sagId) throw new BrugerFejl(UBETALT_FEJL.ikke_fundet);
  if (giv) {
    validerAdvarselTekster(begrundelseBruger, begrundelse);
  } else {
    if (!begrundelse) throw new BrugerFejl(UBETALT_FEJL.begrundelse_mangler);
    if (begrundelse.length > INTERN_NOTE_MAKS) {
      throw new BrugerFejl(`Begrundelsen er for lang (højst ${INTERN_NOTE_MAKS} tegn).`);
    }
  }

  // Inhabilitet tjekkes også i advarsel_ubetalt (20261003012000_inhabil_handel.sql).
  const { data: sag, error: sagErr } = await admin
    .from("ubetalte_vindere")
    .select("buyer_id, seller_id")
    .eq("id", sagId)
    .maybeSingle();
  if (sagErr) throw new Error(sagErr.message);
  if (!sag) throw new BrugerFejl(UBETALT_FEJL.ikke_fundet);
  if (staffId === sag.buyer_id || staffId === sag.seller_id) {
    throw new BrugerFejl(UBETALT_FEJL.inhabil);
  }

  const { data, error } = await admin.rpc("advarsel_ubetalt", {
    p_sag: sagId,
    p_medarbejder: staffId,
    p_giv: giv,
    p_begrundelse: begrundelse || null,
    p_begrundelse_bruger: giv ? begrundelseBruger : null,
  });
  if (error) throw new Error(error.message);
  const kode = (data as { kode: string }).kode;
  if (kode !== "ok") throw new BrugerFejl(UBETALT_FEJL[kode] ?? GENERISK_FEJL);
  if (giv) after(() => notificerAdvarsler());

  revalidatePath("/admin", "layout");
  return { ok: true };
}

// formData: sagId, begrundelse_bruger (påkrævet, vises for køberen),
// begrundelse (intern note, valgfri - standard er "Betalte ikke for vundet auktion").
export async function ubetaltGivAdvarsel(formData: FormData) {
  const sagId = ((formData.get("sagId") as string) ?? "").trim();
  const begrundelse = ((formData.get("begrundelse") as string) ?? "").trim();
  const begrundelseBruger = ((formData.get("begrundelse_bruger") as string) ?? "").trim();
  return koer("ubetaltGivAdvarsel", () =>
    behandlUbetalt(sagId, true, begrundelse, begrundelseBruger),
  );
}

// formData: sagId, begrundelse (påkrævet).
export async function ubetaltAfvis(formData: FormData) {
  const sagId = ((formData.get("sagId") as string) ?? "").trim();
  const begrundelse = ((formData.get("begrundelse") as string) ?? "").trim();
  return koer("ubetaltAfvis", () => behandlUbetalt(sagId, false, begrundelse, ""));
}

// Antal sager, der venter på en medarbejder (badge "! 11" i admin-menuen).
export async function hentAntalUbetalte() {
  return koer("hentAntalUbetalte", async () => {
    const { admin } = await assertRole("medarbejder");
    const { count, error } = await admin
      .from("ubetalte_vindere")
      .select("id", { count: "exact", head: true })
      .eq("status", "afventer");
    if (error) throw new Error(error.message);
    return { ok: true as const, antal: count ?? 0 };
  });
}

// --- Overførsel til sælger ------------------------------------------------------
// Admin: prøv en fejlet overførsel igen. Giver nye forsøg (grænsen hæves -
// tælleren nulstilles ikke, da den indgår i Stripes idempotency key) og prøver
// med det samme. Afvises for refunderede, ikke-frigivne eller indsigelses-
// blokerede betalinger.
const OVERFOERSEL_TEKST: Record<string, string> = {
  overfoert: "Pengene er overført til sælger.",
  allerede_overfoert: "Pengene var allerede overført til sælger.",
  afventer_saelgerkonto:
    "Overførslen afventer sælgerens udbetalingskonto. Sælger har fået en mail, og betalingen forbliver markeret.",
  saelgerkonto_frakoblet:
    "Sælger har lukket eller frakoblet sin udbetalingskonto hos Stripe. Der kan ikke overføres, før sagen er løst med sælgeren.",
  indsigelse: "Der er en åben indsigelse hos køberens bank. Overførslen afventer indsigelsen.",
  sag_aaben: "Handlen har en åben sag. Overførslen afventer, at sagen afgøres.",
  annulleret: "Handlen er annulleret og kan ikke overføres.",
  intet_at_overfoere: "Der er intet at overføre til sælger.",
};

type OverfoerselUdfald = { ok: true; overfoert: boolean; besked: string };

export async function prøvOverfoerselIgen(tradeId: string) {
  return koer("prøvOverfoerselIgen", async (): Promise<OverfoerselUdfald> => {
    const { admin, userId: staffId } = await assertRole("admin");
    if (!tradeId) throw new BrugerFejl("Handlen findes ikke.");

    // Handlen tjekkes før nye forsøg gives (databasen tjekker det igen atomisk).
    const handel = await hentHandelTilSag(admin, tradeId);
    afvisInhabil(staffId, handel);
    if (handel.status === "annulleret") throw new BrugerFejl(OVERFOERSEL_TEKST.annulleret);
    if (handel.sag_aaben) throw new BrugerFejl(OVERFOERSEL_TEKST.sag_aaben);

    const betaling = await hentBetalingForHandel(tradeId);
    if (!betaling) throw new BrugerFejl("Handlen har ingen betaling.");
    if (betaling.stripe_transfer_id) {
      return { ok: true, overfoert: true, besked: OVERFOERSEL_TEKST.allerede_overfoert };
    }
    if (indsigelseBlokerer(betaling)) throw new BrugerFejl(OVERFOERSEL_TEKST.indsigelse);

    let r: string;
    try {
      r = await proevOverfoerselIgen(betaling.id);
    } catch (err) {
      console.error("Admin: overførsel fejlede igen:", tradeId, err);
      throw new BrugerFejl(
        "Overførslen fejlede igen hos Stripe. Betalingen forbliver markeret - se fejlen på betalingen.",
      );
    }
    if (r === "ikke_tilladt" || r === "refunderet" || r === "ikke_klar") {
      throw new BrugerFejl(
        "Overførslen kan ikke prøves igen: betalingen er ikke frigivet, er refunderet, har en indsigelse, eller handlen er annulleret eller har en åben sag.",
      );
    }

    const overfoert = r === "overfoert" || r === "allerede_overfoert";
    await logModerationBloedt(admin, {
      medarbejder_id: staffId,
      handling: "overfoersel_proevet_igen",
      maal_type: "handel",
      maal_id: tradeId,
      bruger_id: betaling.seller_id,
      aarsag: `Overførsel prøvet igen: ${r}`,
    });
    revaliderSag(tradeId);
    revalidatePath("/admin/betalinger");
    return {
      ok: true,
      overfoert,
      besked:
        OVERFOERSEL_TEKST[r] ??
        "Overførslen blev ikke gennemført. Betalingen forbliver markeret.",
    };
  });
}

// Til ConfirmDialog på /admin/betalinger. formData: tradeId.
// Er overførslen ikke gennemført, returneres udfaldet som { fejl }, så
// dialogen bliver stående og viser beskeden.
export async function prøvOverfoerselIgenForm(formData: FormData) {
  const res = await prøvOverfoerselIgen(((formData.get("tradeId") as string) ?? "").trim());
  if ("fejl" in res) return res;
  if (!res.overfoert) return { fejl: res.besked };
  return { ok: true as const };
}
