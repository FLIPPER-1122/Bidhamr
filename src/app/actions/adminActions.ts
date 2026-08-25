"use server";

import { assertRole } from "@/lib/adminAuth";
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
