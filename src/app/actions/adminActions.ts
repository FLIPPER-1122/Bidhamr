"use server";

import { assertRole, harMindstRolle } from "@/lib/adminAuth";
import { revalidatePath } from "next/cache";
import {
  annullerBetaling,
  hentBetalingForHandel,
  indsigelseBlokerer,
  proevOverfoerselIgen,
  refunderBetaling,
} from "@/lib/betaling/stripeBetaling";
import { erSendtTilSaelger, pengeTilSaelger } from "@/lib/betaling/udbetaling";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { notificerAdvarsler } from "@/lib/notifikationer/cron";
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";
import {
  sendAdminRefunderet,
  sendKoeberAfsluttet,
  sendSaelgerAfregning,
} from "@/lib/betaling/handelsbeskeder";
import { REFUSION_I_GANG, REFUSION_KONFLIKT } from "@/lib/betaling/refusionTekster";
import { indgrebFejl, udfoerIndgreb } from "@/lib/dsa/server";
import { notificerAuktionPauser } from "@/lib/notifikationer/auktionPause";
import { send } from "@/lib/notifikationer/send";
import { afgoerelseSti } from "@/lib/dsa/link";
import { erRegel, regelNavn } from "@/lib/dsa/regler";

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

// Fælles felter for et DSA-indgreb (art. 17): regel (DSA_REGLER), fakta
// (begrundelse til brugeren, påkrævet) og aarsag (intern note, valgfri).
function indgrebFelter(formData: FormData) {
  const regel = ((formData.get("regel") as string) ?? "").trim();
  const fakta = ((formData.get("fakta") as string) ?? "").trim();
  const internNote = ((formData.get("aarsag") as string) ?? "").trim();
  if (!erRegel(regel)) throw new BrugerFejl("Vælg hvilken regel eller lov, det bryder.");
  if (!fakta) throw new BrugerFejl("Skriv en begrundelse til brugeren: hvad har brugeren gjort?");
  if (fakta.length > 2000 || internNote.length > 2000) {
    throw new BrugerFejl("En af teksterne er for lang (højst 2000 tegn).");
  }
  return { regel, fakta, internNote };
}

// Suspendering går gennem den fælles DSA-funktion (udfoerIndgreb): brugeren
// får begrundelsen og kan klage. formData: userId, varighed, regel, fakta, aarsag.
async function suspendUserImpl(formData: FormData): Promise<void> {
  const userId = formData.get("userId") as string;
  const varighed = (formData.get("varighed") as string) ?? "permanent";
  const { admin, userId: staffId } = await assertRole("medarbejder");

  afvisSystembruger(userId);
  if (varighed !== "1" && varighed !== "7" && varighed !== "permanent") {
    throw new BrugerFejl("Ugyldig varighed.");
  }
  const f = indgrebFelter(formData);

  const r = await udfoerIndgreb(admin, {
    staffId,
    type: "profil",
    id: userId,
    handling: "konto_suspenderet",
    regel: f.regel,
    fakta: f.fakta,
    internNote: f.internNote,
    varighed,
  });
  if (!r.ok) {
    if (r.kode === "staff") throw new BrugerFejl("Admins og chefer kan ikke suspenderes.");
    throw new BrugerFejl(indgrebFejl(r.kode));
  }

  revalidatePath("/admin/brugere");
  revalidatePath(`/admin/brugere/${userId}`);
  revalidatePath("/admin/dsa");
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

  // 'saelger' = erhvervssælger: kun Erhverv i admin (src/lib/adminAuth.ts).
  if (!["bruger", "medarbejder", "admin", "saelger"].includes(nyRolle)) {
    throw new BrugerFejl("Ugyldig rolle.");
  }
  if (userId === staffId) throw new BrugerFejl("Du kan ikke ændre din egen rolle.");
  afvisSystembruger(userId);

  const { data: target } = await admin
    .from("users")
    .select("rolle, konto_type")
    .eq("id", userId)
    .single();
  if (!target) throw new BrugerFejl("Brugeren findes ikke.");
  if (target.rolle === "chef") {
    throw new BrugerFejl("Chefer kan ikke ændres herfra.");
  }
  // Databasen afviser det også (users_erhverv_ingen_staffrolle).
  if (target.konto_type === "erhverv" && nyRolle !== "bruger") {
    throw new BrugerFejl("En firmakonto kan ikke få en medarbejderrolle.");
  }

  const { error } = await admin
    .from("users")
    .update({ rolle: nyRolle })
    .eq("id", userId);
  if (error) throw new Error(error.message);

  // Rolleskift logges (handling 'rolle_aendret', migration
  // 20261009020000_sikkerhed_rettelser). Rollen er allerede skiftet, så en
  // fejlet logning stopper ikke handlingen, men logges på serveren.
  if (target.rolle !== nyRolle) {
    await logModerationBloedt(admin, {
      medarbejder_id: staffId,
      handling: "rolle_aendret",
      maal_type: "bruger",
      maal_id: userId,
      bruger_id: userId,
      aarsag: `Rolle ændret fra ${target.rolle ?? "bruger"} til ${nyRolle}`,
    });
  }

  revalidatePath("/admin/medarbejdere");
  revalidatePath("/admin/brugere");
}

// --- Auktioner -------------------------------------------------------------

// Alle tre indgreb på en auktion (fjern, annullér, skjul) går gennem den
// fælles DSA-funktion (udfoerIndgreb): indgrebet og begrundelsen til sælgeren
// gemmes i samme transaktion, og sælgeren kan klage. "Fjern" arkiverer:
// handelsdata må aldrig slettes (bogføringsloven/DAC7), og en auktion med en
// handel afvises - den skal løses som en sag.
async function auktionIndgreb(
  formData: FormData,
  handling: "auktion_fjernet" | "auktion_annulleret" | "auktion_skjult",
): Promise<{ ok: true } | { fejl: string }> {
  const auktionId = ((formData.get("auktionId") as string) ?? "").trim();
  let admin, staffId;
  try {
    ({ admin, userId: staffId } = await assertRole("admin"));
  } catch {
    return { fejl: "Du har ikke adgang til at ændre auktioner." };
  }
  let f;
  try {
    f = indgrebFelter(formData);
  } catch (err) {
    if (err instanceof BrugerFejl) return { fejl: err.message };
    throw err;
  }
  const r = await udfoerIndgreb(admin, {
    staffId,
    type: "auktion",
    id: auktionId,
    handling,
    regel: f.regel,
    fakta: f.fakta,
    internNote: f.internNote,
  });
  if (!r.ok) {
    if (r.kode === "uaendret") return { ok: true };
    return { fejl: indgrebFejl(r.kode) };
  }
  revalidatePath("/admin/auktioner");
  revalidatePath(`/admin/brugere/${r.brugerId}`);
  revalidatePath(`/auktion/${auktionId}`);
  revalidatePath("/admin/dsa");
  return { ok: true };
}

async function deleteAuctionImpl(formData: FormData) {
  return auktionIndgreb(formData, "auktion_fjernet");
}

async function cancelAuctionImpl(formData: FormData) {
  return auktionIndgreb(formData, "auktion_annulleret");
}

async function hideAuctionImpl(formData: FormData) {
  return auktionIndgreb(formData, "auktion_skjult");
}

// --- Ophævelse af afgørelser på en auktion -----------------------------------

// Ophævelsen sker i databasen (dsa_ophaev_auktion_afgoerelser,
// 20261009080000_ophaev_inhabil_klage.sql) i én transaktion: den kræver admin,
// låser auktionen og de gældende afgørelser, afviser en inhabil medarbejder
// (egen auktion eller en sælger, man har handlet med) og afviser, mens en
// klage afventer (klage først, foreslået af Claude - så sælgeren får ét svar).
// Ellers genåbnes evt. rapporten, og en annulleret auktion får sine gældende
// afgørelser ophævet (den åbnes aldrig igen og forbliver skjult, Filip 6. okt.
// 2026); en anden skjult auktion gøres synlig igen. Betinget, så et
// dobbeltklik intet gør anden gang.
const OPHAEV_FEJL: Record<string, string> = {
  ingen_adgang: "Kun admin kan gøre et skjult eller fjernet opslag synligt igen.",
  ikke_fundet: "Auktionen findes ikke.",
  inhabil:
    "Du kan ikke ophæve afgørelsen, fordi det er din egen auktion, eller fordi du har handlet med sælgeren. Bed en anden admin om at gøre det.",
  klage_afventer:
    "Der er en klage over afgørelsen, som afventer. Afgør klagen under DSA → Klager først.",
  rapport_aendret: "Rapporten er allerede ændret af en anden. Genindlæs siden.",
  rapport_arkiveret: "Rapporten er flyttet til arkivet og kan ikke genåbnes.",
};

type OphaevResultat = {
  // De typer afgørelser, der faktisk blev ophævet (kun annullerede auktioner).
  ophaevet: string[];
  // Den nyeste ophævede fjernelse/annullering (null, hvis kun en skjulning).
  fjernelseId: string | null;
  // En ikke-annulleret auktion blev gjort synlig igen.
  vist: boolean;
};

async function ophaevAuktionAfgoerelser(
  admin: AdminClient,
  staffId: string,
  auktionId: string,
  rapport?: { id: string; status: string },
): Promise<OphaevResultat> {
  const { data, error } = await admin.rpc("dsa_ophaev_auktion_afgoerelser", {
    p_staff: staffId,
    p_auktion: auktionId,
    p_rapport: rapport?.id ?? null,
    p_rapport_status: rapport?.status ?? null,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as {
    kode?: string;
    ophaevet?: string[] | null;
    fjernelse_id?: string | null;
    vist?: boolean;
  };
  if (r.kode !== "ok") {
    throw new BrugerFejl(OPHAEV_FEJL[r.kode ?? ""] ?? "Afgørelsen kunne ikke ophæves. Prøv igen.");
  }
  return {
    ophaevet: r.ophaevet ?? [],
    fjernelseId: r.fjernelse_id ?? null,
    vist: !!r.vist,
  };
}

function ophaevetAarsag(fjernelse: boolean, kilde: "knap" | "rapport"): string {
  const hvad = fjernelse ? "Fjernelsen er ophævet" : "Skjulningen er ophævet";
  const hvorfor = kilde === "rapport" ? " da anmeldelsen blev genåbnet" : "";
  return fjernelse
    ? `${hvad}${hvorfor} – auktionen forbliver annulleret og skjult, sælgeren kan sætte varen op igen`
    : `${hvad}${hvorfor} – auktionen forbliver annulleret og skjult`;
}

// Sælgeren får en undskyldning og kan sætte varen op igen med ét klik. Fast
// nøgle pr. auktion: en annulleret auktion åbnes aldrig igen, så beskeden
// sendes kun én gang, uanset om fjernelsen ophæves med "Ophæv fjernelse"
// eller ved en genåbnet rapport.
async function sendFjernelseOphaevet(
  saelgerId: string,
  auktionId: string,
  titel: string | null,
  afgoerelseId: string | null,
) {
  const navn = titel ? `"${titel}"` : "din auktion";
  await send(saelgerId, "afgoerelse", {
    titel: "BidHamr har trukket fjernelsen af din auktion tilbage",
    tekst: `Vi beklager, at vi fjernede ${navn}. Auktionen kan ikke åbnes igen, fordi buddene ikke gælder længere – men du kan sætte varen op igen med ét klik.`,
    link: afgoerelseId ? afgoerelseSti(afgoerelseId, false) : `/auktion/${auktionId}`,
    data: { auction_id: auktionId },
    noegle: `fjernelse_ophaevet:${auktionId}`,
  });
}

// Kun en skjulning blev ophævet (fx når sælgeren selv annullerede, og BidHamr
// derefter skjulte auktionen): en kort besked. Fast nøgle pr. auktion, så den
// sendes kun én gang.
async function sendSkjulningOphaevet(saelgerId: string, auktionId: string) {
  await send(saelgerId, "afgoerelse", {
    titel: "Afgørelsen er trukket tilbage",
    tekst: "BidHamr har trukket afgørelsen om at skjule din auktion tilbage.",
    link: `/auktion/${auktionId}`,
    data: { auction_id: auktionId },
    noegle: `skjulning_ophaevet:${auktionId}`,
  });
}

// Besked til sælgeren efter en ophævelse på en annulleret auktion.
function beskedEfterOphaevelse(
  r: OphaevResultat,
  saelgerId: string,
  auktionId: string,
  titel: string | null,
) {
  const fjernelseId = r.fjernelseId;
  if (fjernelseId) {
    after(() => sendFjernelseOphaevet(saelgerId, auktionId, titel, fjernelseId));
  } else if (r.ophaevet.includes("auktion_skjult")) {
    after(() => sendSkjulningOphaevet(saelgerId, auktionId));
  }
}

// Vis igen. Triggeren auctions_dsa_ophaevet markerer begrundelsen som ophævet.
// Var auktionen på pause, genoptager triggeren auctions_pause_skjult den
// (resterende tid, mindst 24 timer), og sælger og bydere får besked.
// En annulleret (fjernet) auktion forbliver skjult (Filip, 6. okt. 2026):
// "Ophæv fjernelse" ophæver i stedet afgørelserne, så sælgeren kan sætte
// varen op igen med ét klik. Idempotent: gentagne klik logger ikke igen.
// Inhabilitet og "klage først" tjekkes i databasen (ophaevAuktionAfgoerelser).
async function unhideAuctionImpl(formData: FormData): Promise<void> {
  const auktionId = formData.get("auktionId") as string;
  const { admin, userId: staffId } = await assertRole("admin");

  const { data: auktion } = await admin
    .from("auctions")
    .select("bruger_id, skjult, status, titel")
    .eq("id", auktionId)
    .maybeSingle<{ bruger_id: string; skjult: boolean; status: string; titel: string | null }>();
  if (!auktion) throw new BrugerFejl("Auktionen findes ikke.");
  if (!auktion.skjult) return;

  const r = await ophaevAuktionAfgoerelser(admin, staffId, auktionId);

  if (r.ophaevet.length > 0) {
    beskedEfterOphaevelse(r, auktion.bruger_id, auktionId, auktion.titel);
    await logModerationBloedt(admin, {
      medarbejder_id: staffId,
      handling: "auktion_vist",
      maal_type: "auktion",
      maal_id: auktionId,
      bruger_id: auktion.bruger_id,
      aarsag: ophaevetAarsag(!!r.fjernelseId, "knap"),
    });
  } else if (r.vist) {
    after(() => notificerAuktionPauser(auktionId));
    await logModerationBloedt(admin, {
      medarbejder_id: staffId,
      handling: "auktion_vist",
      maal_type: "auktion",
      maal_id: auktionId,
      bruger_id: auktion.bruger_id,
      aarsag: "Auktionen er synlig igen",
    });
  }

  revalidatePath(`/auktion/${auktionId}`);
  revalidatePath("/admin/dsa");
  revalidatePath("/admin/auktioner");
}

// Bedømmelser modereres i src/app/actions/adminBedoemmelser.ts.

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

// Skjul eller fjern opslaget efter en rapport. Går gennem den fælles
// DSA-funktion, så sælgeren får en begrundelse og kan klage. Kom rapporten fra
// den automatiske kontrol af forbudte varer, registreres indgrebet som
// "automatisk opdaget" (til gennemsigtighedsrapporten). Auktionen annulleres
// og skjules i stedet for at blive slettet: reports.auction_id har ON DELETE
// CASCADE, så en hård sletning ville også fjerne rapporten.
async function rapportIndgreb(
  formData: FormData,
  handling: "auktion_skjult" | "auktion_fjernet",
): Promise<void> {
  const rapportId = formData.get("rapportId") as string;
  const { admin, userId: staffId } = await assertRole("admin");
  const f = indgrebFelter(formData);
  const rapport = await hentRapport(admin, rapportId);

  const { data: r0 } = await admin
    .from("reports")
    .select("reporter_id")
    .eq("id", rapportId)
    .maybeSingle<{ reporter_id: string | null }>();
  const automatisk = (r0?.reporter_id ?? "").toLowerCase() === BIDHAMR_SYSTEM_ID;

  const r = await udfoerIndgreb(admin, {
    staffId,
    type: "auktion",
    id: rapport.auction_id,
    handling,
    regel: f.regel,
    fakta: f.fakta,
    internNote: f.internNote || `Efter rapport ${rapportId}`,
    automatiskOpdaget: automatisk,
  });
  if (!r.ok && r.kode !== "uaendret") throw new BrugerFejl(indgrebFejl(r.kode));

  await afslutRapport(
    admin,
    staffId,
    rapportId,
    handling === "auktion_skjult" ? "under_behandling" : "fjernet",
    `${regelNavn(f.regel)}: ${f.fakta}${f.internNote ? ` | ${f.internNote}` : ""}`.slice(0, 2000),
  );
  revalidatePath("/admin/rapporter");
  revalidatePath("/admin/auktioner");
  revalidatePath(`/auktion/${rapport.auction_id}`);
  revalidatePath("/admin/dsa");
}

// Skjul opslaget midlertidigt mens sagen undersøges.
async function rapportSletMidlertidigtImpl(formData: FormData): Promise<void> {
  return rapportIndgreb(formData, "auktion_skjult");
}

// Fjern opslaget permanent fra platformen.
async function rapportFjernOpslagImpl(formData: FormData): Promise<void> {
  return rapportIndgreb(formData, "auktion_fjernet");
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

  // Rørte rapporten aldrig opslaget, genåbnes den blot. Status tjekkes i
  // samme update, så et dobbeltklik ikke giver dobbelt effekt, og den
  // automatiske oprydning kan have flyttet rapporten til arkivet imens.
  if (!opslagetBlevAendret) {
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
      throw new BrugerFejl(findes ? OPHAEV_FEJL.rapport_aendret : OPHAEV_FEJL.rapport_arkiveret);
    }
  } else {
    const { data: auktion } = await admin
      .from("auctions")
      .select("bruger_id, status, titel")
      .eq("id", rapport.auction_id)
      .single<{ bruger_id: string; status: string; titel: string | null }>();
    if (!auktion) throw new BrugerFejl("Auktionen findes ikke.");

    // Rapporten genåbnes og opslaget ændres i samme transaktion i databasen,
    // som også afviser en inhabil admin og venter på en afventende klage
    // (klage først). En fjernet (annulleret) auktion genåbnes ALDRIG og
    // bliver ikke synlig igen (Filip, 6. okt. 2026): afgørelserne ophæves,
    // buddene gælder ikke, og sælgeren får besked og kan sætte varen op igen
    // med ét klik. Var en anden auktion skjult og på pause, genoptager
    // triggeren auctions_pause_skjult den (resterende tid, mindst 24 timer).
    // Der logges og gives kun besked, når noget faktisk blev ændret.
    const r = await ophaevAuktionAfgoerelser(admin, staffId, rapport.auction_id, {
      id: rapportId,
      status: rapport.status,
    });

    if (r.ophaevet.length > 0) {
      beskedEfterOphaevelse(r, auktion.bruger_id, rapport.auction_id, auktion.titel);
      await logModeration(admin, {
        medarbejder_id: staffId,
        handling: "annuller_auktion",
        maal_type: "auktion",
        maal_id: rapport.auction_id,
        bruger_id: auktion.bruger_id,
        aarsag: ophaevetAarsag(!!r.fjernelseId, "rapport"),
      });
    } else if (r.vist) {
      after(() => notificerAuktionPauser(rapport.auction_id));
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
  "Handlen har en sag fra køberen, der blokerer udbetalingen (åben, afventer retur eller afgjort med ankefrist). Afgør eller genåbn sagen under Sager.";

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
    const r = await pengeTilSaelger(betaling.id);
    overfoersel =
      r === "overfoert" || r === "allerede_overfoert"
        ? " (overført via Stripe)"
        : r === "udbetalt" || r === "allerede_udbetalt"
          ? " (udbetalt til sælgers bank via Stripe)"
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
        "Refusionen fejlede hos Stripe. Handlen er annulleret, og tilbagebetalingen prøves igen automatisk. Følg den under Betalinger.",
      );
    }
    // Ingen ny tilbagebetaling er sendt: ingen succesbesked og intet
    // "Fuld refusion" i loggen. Handlen er annulleret, og refusionen er claimet.
    if (resultat === "refusion_konflikt") {
      revaliderSag(tradeId);
      throw new BrugerFejl(REFUSION_KONFLIKT);
    }
    if (resultat === "refusion_i_gang") {
      revaliderSag(tradeId);
      throw new BrugerFejl(REFUSION_I_GANG);
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
  // Destination (trin 3): payout fra sælgerens Stripe-konto til banken.
  udbetalt: "Udbetalingen til sælgerens bank er sendt via Stripe.",
  allerede_udbetalt: "Udbetalingen til sælgerens bank var allerede sendt.",
  venter_midler_ikke_tilgaengelige: "Pengene er endnu ikke tilgængelige på sælgerens Stripe-konto. Udbetalingen sendes automatisk, når de er.",
  venter_ventetid: "Udbetalingen venter de 3 dage ved afhentning og sendes derefter automatisk.",
  venter_kraever_opmaerksomhed: "Betalingen er stadig markeret. Luk markeringen, og prøv igen.",
  venter_svindelvarsel: "Svindelvarslet skal gennemgås, før pengene kan udbetales.",
  venter_radar_review: "Stripe Radar gennemgår betalingen. Udbetalingen venter, til det er lukket.",
  venter_venter_paa_bank: "Sælgerens bankkonto hos Stripe skal rettes, før udbetalingen kan sendes.",
  venter_udbetalinger_inaktive: "Udbetalinger er ikke aktive på sælgerens Stripe-konto. Sælger skal gøre kontoen færdig hos Stripe.",
  venter_plan_ikke_manuel: "Sælgerens Stripe-konto står ikke til manuel udbetaling. Den sættes tilbage automatisk - prøv igen om lidt.",
  venter_saldo: "Saldoen på sælgerens Stripe-konto dækker ikke udbetalingen endnu. Den prøves igen automatisk.",
  saldo_afviger: "Saldoen på sælgerens Stripe-konto passer ikke med handlerne. Udbetalinger er stoppet - se /admin/drift.",
  afvist: "Stripe afviste udbetalingen. Se fejlen på betalingen.",
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
    if (betaling.saelger_udbetaling_id) {
      return { ok: true, overfoert: true, besked: OVERFOERSEL_TEKST.allerede_udbetalt };
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

    const overfoert = erSendtTilSaelger(r);
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
