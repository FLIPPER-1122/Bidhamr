"use server";

// Admin: moderation af bedømmelser og sælgernes svar (medarbejder og op).
// Rollen tjekkes her (assertRole), og databasefunktionerne
// skjul_bedoemmelse / behold_bedoemmelse (kun service_role) tjekker den igen.
// Bedømmelser slettes ALDRIG - de skjules, kan vises igen, og alt logges i
// moderation_log. Den, der skrev teksten, får en notifikation med
// begrundelsen. Fejl RETURNERES som { fejl }.

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { erSkjulGrund, type BedoemmelseDel } from "@/lib/bedoemmelser";
import { notificerModeration } from "@/lib/notifikationer/bedoemmelse";
import { indgrebFejl, udfoerIndgreb } from "@/lib/dsa/server";

class BrugerFejl extends Error {}

const GENERISK_FEJL = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error(`Admin-handling ${navn} fejlede:`, err);
    return { fejl: GENERISK_FEJL };
  }
}

function tekst(formData: FormData, navn: string): string {
  return String(formData.get(navn) ?? "").trim();
}

function del(formData: FormData): BedoemmelseDel {
  const d = tekst(formData, "del");
  if (d !== "bedoemmelse" && d !== "svar") throw new BrugerFejl("Ukendt del af bedømmelsen.");
  return d;
}

const KODE_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at gøre dette.",
  ikke_fundet: "Bedømmelsen eller svaret findes ikke.",
  begrundelse_mangler: "Vælg en begrundelse. Vælger du \"Andet\", skal du skrive hvorfor.",
  for_lang_tekst: "Begrundelsen må højst være 500 tegn.",
  inhabil: "Du kan ikke behandle en bedømmelse, du selv er part i. Lad en kollega tage den.",
};

function revalider() {
  revalidatePath("/admin/bedommelser");
  // Profilerne viser bedømmelserne (og gennemsnittet).
  revalidatePath("/(app)/profil/[id]", "page");
}

type RpcSvar = { kode?: string; forfatter_id?: string };

// Fast begrundelse -> DSA-regel og en standardtekst til brugeren, hvis
// medarbejderen ikke har skrevet en uddybning.
const GRUND_TIL_REGEL: Record<string, { regel: string; fakta: string }> = {
  groft_sprog: { regel: "chikane", fakta: "Teksten indeholder grove ord, chikane eller trusler." },
  personoplysninger: { regel: "personoplysninger", fakta: "Teksten indeholder personoplysninger om en anden person." },
  kontaktinfo: { regel: "kontaktinfo", fakta: "Teksten indeholder kontaktoplysninger eller opfordrer til handel uden om BidHamr." },
  ikke_relateret: { regel: "ikke_relateret", fakta: "Teksten handler ikke om handlen." },
  andet: { regel: "andet", fakta: "" },
};

async function skjulEllerVis(formData: FormData, skjul: boolean) {
  const { admin, userId } = await assertRole("medarbejder");
  const ratingId = tekst(formData, "ratingId");
  if (!UUID.test(ratingId)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
  const d = del(formData);
  const grund = skjul ? tekst(formData, "grund") : "";
  const aarsag = tekst(formData, "aarsag");
  if (skjul && !erSkjulGrund(grund)) throw new BrugerFejl(KODE_FEJL.begrundelse_mangler);
  if (skjul && grund === "andet" && !aarsag) throw new BrugerFejl(KODE_FEJL.begrundelse_mangler);
  if (aarsag.length > 500) throw new BrugerFejl(KODE_FEJL.for_lang_tekst);

  if (skjul) {
    // Skjul går gennem den fælles DSA-funktion: skjul + begrundelse til
    // brugeren (med klagemulighed) i samme transaktion.
    const m = GRUND_TIL_REGEL[grund];
    const r = await udfoerIndgreb(admin, {
      staffId: userId,
      type: d === "bedoemmelse" ? "bedoemmelse" : "bedoemmelse_svar",
      id: ratingId,
      handling: d === "bedoemmelse" ? "bedoemmelse_skjult" : "bedoemmelse_svar_skjult",
      regel: m.regel,
      fakta: [m.fakta, aarsag].filter(Boolean).join(" "),
      anmeldelseId: tekst(formData, "anmeldelseId") || null,
    });
    if (!r.ok) {
      if (r.kode === "uaendret") {
        revalider();
        return { ok: true as const };
      }
      throw new BrugerFejl(KODE_FEJL[r.kode] ?? indgrebFejl(r.kode));
    }
    revalider();
    revalidatePath("/admin/dsa");
    return { ok: true as const };
  }

  const { data, error } = await admin.rpc("skjul_bedoemmelse", {
    p_medarbejder: userId,
    p_rating: ratingId,
    p_del: d,
    p_skjul: false,
    p_grund: null,
    p_aarsag: aarsag || null,
  });
  if (error) throw new Error(error.message);
  const svar = (data ?? {}) as RpcSvar;
  if (svar.kode === "uaendret") {
    revalider();
    return { ok: true as const };
  }
  if (svar.kode !== "ok") throw new BrugerFejl(KODE_FEJL[svar.kode ?? ""] ?? GENERISK_FEJL);

  const forfatterId = svar.forfatter_id;
  if (forfatterId) {
    after(() => notificerModeration({ forfatterId, ratingId, del: d }));
  }
  revalider();
  return { ok: true as const };
}

// formData: ratingId, del ('bedoemmelse' | 'svar'), grund (SKJUL_GRUNDE), aarsag.
export async function skjulBedoemmelse(formData: FormData) {
  return koer("skjulBedoemmelse", () => skjulEllerVis(formData, true));
}

// formData: ratingId, del, aarsag (valgfri intern note).
export async function visBedoemmelse(formData: FormData) {
  return koer("visBedoemmelse", () => skjulEllerVis(formData, false));
}

// Bryder ikke reglerne: lukker alle åbne rapporter på bedømmelsen og svaret.
// formData: ratingId, aarsag (valgfri note).
export async function beholdBedoemmelse(formData: FormData) {
  return koer("beholdBedoemmelse", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    const ratingId = tekst(formData, "ratingId");
    if (!UUID.test(ratingId)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    const note = tekst(formData, "aarsag");
    if (note.length > 500) throw new BrugerFejl("Noten må højst være 500 tegn.");

    const { data, error } = await admin.rpc("behold_bedoemmelse", {
      p_medarbejder: userId,
      p_rating: ratingId,
      p_note: note || null,
    });
    if (error) throw new Error(error.message);
    const kode = (data as RpcSvar | null)?.kode;
    if (kode === "uaendret") throw new BrugerFejl("Der er ingen åbne rapporter på bedømmelsen.");
    if (kode !== "ok") throw new BrugerFejl(KODE_FEJL[kode ?? ""] ?? GENERISK_FEJL);
    revalider();
    return { ok: true as const };
  });
}
