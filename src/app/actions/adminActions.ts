"use server";

import { assertRole, harMindstRolle } from "@/lib/adminAuth";
import { revalidatePath } from "next/cache";

// --- Brugere ---------------------------------------------------------------

type AdminClient = Awaited<ReturnType<typeof assertRole>>["admin"];

async function logModeration(
  admin: AdminClient,
  entry: {
    medarbejder_id: string;
    handling: string;
    maal_type: "auktion" | "anmeldelse" | "bruger";
    maal_id: string;
    bruger_id: string | null;
    aarsag: string;
  },
) {
  const { error } = await admin.from("moderation_log").insert(entry);
  if (error) throw new Error(error.message);
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

// --- Auktioner -------------------------------------------------------------

export async function deleteAuction(formData: FormData) {
  const auktionId = formData.get("auktionId") as string;
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();
  const { admin, userId: staffId } = await assertRole("admin");

  if (!aarsag) throw new Error("Angiv en årsag for sletningen.");

  const { data: auktion } = await admin
    .from("auctions")
    .select("bruger_id")
    .eq("id", auktionId)
    .single();
  if (!auktion) throw new Error("Auktionen findes ikke.");

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: "slet_auktion",
    maal_type: "auktion",
    maal_id: auktionId,
    bruger_id: auktion.bruger_id,
    aarsag,
  });

  const { error } = await admin.from("auctions").delete().eq("id", auktionId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/auktioner");
  revalidatePath(`/admin/brugere/${auktion.bruger_id}`);
}

export async function cancelAuction(formData: FormData) {
  const auktionId = formData.get("auktionId") as string;
  const { admin } = await assertRole("admin");

  const { error } = await admin
    .from("auctions")
    .update({ status: "annulleret" })
    .eq("id", auktionId);
  if (error) throw new Error(error.message);

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

  const { error } = await admin.from("ratings").delete().eq("id", ratingId);
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

// Justerer en brugers saldo manuelt. Bruges til fejlrettelser og til at lægge
// testpenge ind, mens platformen køres i testtilstand.
//
// Kun 'chef': det er den eneste handling i systemet, der skaber eller
// fjerner penge, og den bogføres derfor altid med en begrundelse.
export async function justerSaldo(formData: FormData) {
  const userId = formData.get("userId") as string;
  const beløb = Number(formData.get("beloeb"));
  const aarsag = ((formData.get("aarsag") as string) ?? "").trim();

  const { admin, userId: staffId } = await assertRole("chef");

  if (!userId || !Number.isFinite(beløb) || beløb === 0) {
    throw new Error("Angiv et beløb forskelligt fra nul.");
  }
  if (!aarsag) {
    throw new Error("Angiv en begrundelse for justeringen.");
  }

  const { error } = await admin.rpc("wallet_bogfoer", {
    p_user: userId,
    p_amount: beløb,
    p_kind: "justering",
    p_auction: null,
    p_note: aarsag,
    p_stripe_session: null,
  });

  // Saldoen må ikke kunne gå i minus; check-constrainten afviser det.
  if (error) {
    if (error.message.includes("wallets_balance_check")) {
      throw new Error("Justeringen ville sende saldoen under nul.");
    }
    throw new Error(error.message);
  }

  await logModeration(admin, {
    medarbejder_id: staffId,
    handling: beløb > 0 ? "saldo_tilfoert" : "saldo_traukket",
    maal_type: "bruger",
    maal_id: userId,
    bruger_id: userId,
    aarsag: `${beløb > 0 ? "+" : ""}${beløb} kr — ${aarsag}`,
  });

  revalidatePath(`/admin/brugere/${userId}`);
  revalidatePath("/admin/transaktioner");
}
