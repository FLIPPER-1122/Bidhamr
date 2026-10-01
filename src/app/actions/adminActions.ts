"use server";

import { assertRole, harMindstRolle } from "@/lib/adminAuth";
import type { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import {
  annullerBetaling,
  hentBetalingForHandel,
  overfoerTilSaelger,
  refunderBetaling,
} from "@/lib/betaling/stripeBetaling";

// --- Brugere ---------------------------------------------------------------

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

export async function suspendUser(formData: FormData) {
  const userId = formData.get("userId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const varighed = (formData.get("varighed") as string) ?? "permanent";
  const { admin, userId: staffId } = await assertRole("medarbejder");

  if (!aarsag) throw new Error("Angiv en årsag for suspensionen.");
  if (!["1", "7", "permanent"].includes(varighed)) {
    throw new Error("Ugyldig varighed.");
  }

  const { data: target } = await admin
    .from("users")
    .select("rolle")
    .eq("id", userId)
    .single();
  if (!target) throw new Error("Brugeren findes ikke.");
  if (target.rolle === "admin" || target.rolle === "chef") {
    throw new Error("Admins og chefer kan ikke suspenderes.");
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

export async function unsuspendUser(formData: FormData) {
  const userId = formData.get("userId") as string;
  const { admin, userId: staffId } = await assertRole("medarbejder");

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

export async function advarUser(formData: FormData) {
  const userId = formData.get("userId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");

  if (!aarsag) throw new Error("Angiv en årsag for advarslen.");

  const { error } = await admin.from("advarsler").insert({
    bruger_id: userId,
    oprettet_af: staffId,
    aarsag,
  });
  if (error) throw new Error(error.message);

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "advarsel",
    maal_type: "bruger",
    maal_id: userId,
    bruger_id: userId,
    aarsag,
  });

  revalidatePath(`/admin/brugere/${userId}`);
}

// Kun chef: skift rolle mellem 'bruger', 'medarbejder' og 'admin'.
// Chef-rollen kan ikke tildeles eller fjernes herfra.
export async function setRolle(formData: FormData) {
  const userId = formData.get("userId") as string;
  const nyRolle = formData.get("rolle") as string;
  const { admin, userId: staffId } = await assertRole("chef");

  if (!["bruger", "medarbejder", "admin"].includes(nyRolle)) {
    throw new Error("Ugyldig rolle.");
  }
  if (userId === staffId) throw new Error("Du kan ikke ændre din egen rolle.");

  const { data: target } = await admin
    .from("users")
    .select("rolle")
    .eq("id", userId)
    .single();
  if (!target) throw new Error("Brugeren findes ikke.");
  if (target.rolle === "chef") {
    throw new Error("Chefer kan ikke ændres herfra.");
  }

  const { error } = await admin
    .from("users")
    .update({ rolle: nyRolle })
    .eq("id", userId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/medarbejdere");
  revalidatePath("/admin/brugere");
}

// Frigiver den hoejestbydendes wallet-reservation, naar en auktion annulleres.
// wallet_frigiv er en no-op, hvis der ingen reservation er. Fejl logges, men
// vaelter ikke annulleringen (status er allerede skiftet).
async function frigivReservation(
  admin: ReturnType<typeof createAdminClient>,
  auktionId: string,
) {
  const { error } = await admin.rpc("wallet_frigiv", { p_auction: auktionId });
  if (error) console.error("wallet_frigiv fejlede ved annullering:", auktionId, error);
}

// --- Auktioner -------------------------------------------------------------

// "Slet" arkiverer: handelsdata (bud, handler, bedoemmelser, anmeldelser)
// maa aldrig slettes (bogfoeringsloven/DAC7). Auktionen annulleres og skjules.
// Har auktionen en handel, afvises det - den skal loeses som en sag.
export async function deleteAuction(
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

  await frigivReservation(admin, auktionId);

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

export async function cancelAuction(formData: FormData) {
  const auktionId = formData.get("auktionId") as string;
  const { admin } = await assertRole("admin");

  // Idempotent: kun en aktiv auktion annulleres. En afsluttet auktion har en
  // vinder/handel og skal loeses som en sag.
  const { data: opdateret, error } = await admin
    .from("auctions")
    .update({ status: "annulleret" })
    .eq("id", auktionId)
    .eq("status", "aktiv")
    .select("id");
  if (error) throw new Error(error.message);
  if (opdateret && opdateret.length > 0) {
    await frigivReservation(admin, auktionId);
  }

  revalidatePath("/admin/auktioner");
}

export async function hideAuction(formData: FormData) {
  const auktionId = formData.get("auktionId") as string;
  const { admin } = await assertRole("admin");

  const { error } = await admin
    .from("auctions")
    .update({ skjult: true })
    .eq("id", auktionId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/auktioner");
}

export async function unhideAuction(formData: FormData) {
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

export async function deleteRating(formData: FormData) {
  const ratingId = formData.get("ratingId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");

  if (!aarsag) throw new Error("Angiv en årsag for sletningen.");

  const { data: rating } = await admin
    .from("ratings")
    .select("fra_bruger_id, til_bruger_id")
    .eq("id", ratingId)
    .single();
  if (!rating) throw new Error("Anmeldelsen findes ikke.");

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

export async function hideRating(formData: FormData) {
  const ratingId = formData.get("ratingId") as string;
  const { admin } = await assertRole("admin");

  const { error } = await admin
    .from("ratings")
    .update({ skjult: true })
    .eq("id", ratingId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/bedommelser");
}

export async function unhideRating(formData: FormData) {
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
  if (!data) throw new Error("Rapporten findes ikke.");
  return data;
}

// Afslut uden handling - auktionen forbliver aktiv. Noten er obligatorisk og
// dokumenterer hvad der blev tjekket, og hvad konklusionen blev.
// Feltet hedder "aarsag" i formularen, fordi ConfirmDialog bruger det navn.
export async function rapportMarkerBehandlet(formData: FormData) {
  const rapportId = formData.get("rapportId") as string;
  const note = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");

  if (!note) {
    throw new Error("Skriv en note om hvad du har tjekket, og hvad konklusionen er.");
  }

  await afslutRapport(admin, staffId, rapportId, "behandlet", note);
  revalidatePath("/admin/rapporter");
  revalidatePath("/admin/opklarede-rapporter");
}

// Skjul opslaget midlertidigt mens sagen undersøges.
export async function rapportSletMidlertidigt(formData: FormData) {
  const rapportId = formData.get("rapportId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");

  if (!aarsag) throw new Error("Angiv en årsag.");
  const rapport = await hentRapport(admin, rapportId);

  const { data: auktion } = await admin
    .from("auctions")
    .select("bruger_id")
    .eq("id", rapport.auction_id)
    .single();
  if (!auktion) throw new Error("Auktionen findes ikke.");

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
export async function rapportFjernOpslag(formData: FormData) {
  const rapportId = formData.get("rapportId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");

  if (!aarsag) throw new Error("Angiv en årsag.");
  const rapport = await hentRapport(admin, rapportId);

  const { data: auktion } = await admin
    .from("auctions")
    .select("bruger_id")
    .eq("id", rapport.auction_id)
    .single();
  if (!auktion) throw new Error("Auktionen findes ikke.");

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
export async function rapportGenaabn(formData: FormData) {
  const rapportId = formData.get("rapportId") as string;
  const { admin, rolle, userId: staffId } = await assertRole("medarbejder");

  const { data: rapport } = await admin
    .from("reports")
    .select("id, auction_id, status")
    .eq("id", rapportId)
    .single();
  if (!rapport) throw new Error("Rapporten findes ikke.");

  // 'handled' rørte aldrig opslaget, så der er intet at fortryde.
  const opslagetBlevAendret =
    rapport.status === "under_behandling" || rapport.status === "fjernet";

  if (opslagetBlevAendret) {
    if (!harMindstRolle(rolle, "admin")) {
      throw new Error(
        "Kun admin kan gøre et skjult eller fjernet opslag synligt igen.",
      );
    }

    const { data: auktion } = await admin
      .from("auctions")
      .select("bruger_id, slutter_kl")
      .eq("id", rapport.auction_id)
      .single();

    if (auktion) {
      const opdatering: { skjult: boolean; status?: string } = { skjult: false };

      // 'fjernet' satte status til 'annulleret' - den skal tilbage. En auktion
      // hvis sluttid er passeret genoplives som afsluttet, ikke som aktiv.
      if (rapport.status === "fjernet") {
        opdatering.status =
          new Date(auktion.slutter_kl) > new Date() ? "aktiv" : "afsluttet";
      }

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

  const { error } = await admin
    .from("reports")
    .update({
      status: "pending",
      handled_by: null,
      handled_note: null,
      handled_at: null,
    })
    .eq("id", rapportId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/rapporter");
  revalidatePath("/admin/opklarede-rapporter");
  revalidatePath("/admin/auktioner");
  revalidatePath(`/auktion/${rapport.auction_id}`);
}

// --- E-money ---------------------------------------------------------------

// Saldo-handlingerne RETURNERER fejl i stedet for at kaste dem.
//
// En server action, der kaster, faar Next.js til at skjule beskeden i
// produktion ("An error occurred in the Server Components render") - og saa
// staar man uden at vide, hvad der gik galt. Returnerede vaerdier naar frem
// uaendret i baade dev og produktion.
export type SaldoResultat = { ok: true; saldo?: number } | { fejl: string };

// BidHamr har ingen saldo laengere (Stripe holder pengene). Saldo-handlingerne
// afvises altid; UI'en fjernes i naeste roadmap-punkt. Wallet-funktionerne er
// ogsaa lukket for service_role i databasen (20261001010000).
const SALDO_LUKKET = "Saldo findes ikke længere. Penge styres via Stripe.";

export async function justerSaldo(_formData: FormData): Promise<SaldoResultat> {
  void _formData;
  return { fejl: SALDO_LUKKET };
}

export async function saetSaldo(_formData: FormData): Promise<SaldoResultat> {
  void _formData;
  return { fejl: SALDO_LUKKET };
}

// --- Sager (handler) ---------------------------------------------------------

const AKTIVE_HANDEL_STATUSSER = ["betaling_modtaget", "pakke_sendt", "modtaget"];

async function hentHandelTilSag(admin: AdminClient, tradeId: string) {
  const { data: handel } = await admin
    .from("trades")
    .select("id, auction_id, buyer_id, seller_id, status, sag_aaben")
    .eq("id", tradeId)
    .single();
  if (!handel) throw new Error("Handlen findes ikke.");
  return handel;
}

function revaliderSag(tradeId: string) {
  revalidatePath("/admin/sager");
  revalidatePath("/admin/transaktioner");
  revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/mine-handler");
}

// Flag en handel som sag. Medarbejdere maa godt - det flytter ingen penge.
export async function sagAabn(formData: FormData) {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");
  if (!aarsag) throw new Error("Beskriv hvorfor sagen åbnes.");

  const handel = await hentHandelTilSag(admin, tradeId);
  if (!AKTIVE_HANDEL_STATUSSER.includes(handel.status)) {
    throw new Error("Handlen er allerede afsluttet.");
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
export async function sagLuk(formData: FormData) {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("medarbejder");
  if (!aarsag) throw new Error("Skriv en afsluttende note.");

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

// Kroner til visning i moderationsloggen ud fra oere (heltal).
function kr(oere: number): string {
  return (oere / 100).toLocaleString("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Afregn saelgeren uden koeberens godkendelse. Kun admin og opefter.
// Handler med en Stripe-betaling: frigivet_kl saettes i databasen, og
// beloebet (bud minus 5% saelgergebyr) overfoeres til saelgerens Connect-konto.
// Gamle handler fra saldo-modellen afregnes som foer i databasen.
export async function handelFrigiv(formData: FormData) {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");
  if (!aarsag) throw new Error("Angiv en begrundelse.");

  const handel = await hentHandelTilSag(admin, tradeId);
  const betaling = await hentBetalingForHandel(tradeId);
  if (betaling && betaling.status !== "betalt") {
    throw new Error("Handlen er ikke betalt og kan ikke frigives.");
  }

  const { data: frigivet, error } = await admin.rpc("admin_frigiv_handel", {
    p_trade: tradeId,
  });
  if (error) throw new Error(error.message);
  if (!frigivet) throw new Error("Handlen er allerede afsluttet.");

  let overfoersel = "";
  if (betaling) {
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
  }

  const beloeb = betaling
    ? `${kr(Number(betaling.udbetaling_oere))} kr til sælger${overfoersel}`
    : "afregnet (gammel handel)";

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
// Gamle handler fra saldo-modellen refunderes som foer i databasen.
export async function handelRefunder(formData: FormData) {
  const tradeId = formData.get("tradeId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");
  if (!aarsag) throw new Error("Angiv en begrundelse.");

  const handel = await hentHandelTilSag(admin, tradeId);
  const betaling = await hentBetalingForHandel(tradeId);

  let logTekst: string;

  if (betaling) {
    if (betaling.status === "afventer" || betaling.status === "behandles") {
      if (!(await annullerBetaling(tradeId))) {
        throw new Error("Betalingen kan ikke annulleres.");
      }
      logTekst = "Ikke betalt - betalingen annulleret, 0 kr refunderet";
    } else {
      const { data: beloeb, error } = await admin.rpc("betaling_paabegynd_refusion", {
        p_trade: tradeId,
        p_aarsag: "admin",
      });
      if (error) throw new Error(error.message);
      if (beloeb === null) {
        throw new Error(
          "Handlen kan ikke refunderes: den er ikke betalt, allerede refunderet eller pengene er frigivet til sælger.",
        );
      }
      let resultat: string;
      try {
        resultat = await refunderBetaling(betaling.id);
      } catch (err) {
        console.error("Refusion fejlede:", tradeId, err);
        throw new Error(
          "Refusionen fejlede hos Stripe. Handlen er annulleret og markeret - prøv igen.",
        );
      }
      logTekst = `${kr(Number(beloeb))} kr refunderet via Stripe (${resultat})`;
    }
  } else {
    const { data: retur, error } = await admin.rpc("admin_refunder_handel", {
      p_trade: tradeId,
    });
    if (error) throw new Error(error.message);
    if (retur === null) throw new Error("Handlen er allerede afsluttet.");
    logTekst = `${Number(retur)} kr refunderet (gammel handel)`;
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
