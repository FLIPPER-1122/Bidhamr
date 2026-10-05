import "server-only";

// Selve kontosletningen (GDPR) - delt af server action'en sletMinKonto
// (hjemmesiden) og POST /api/konto/slet (appen). Reglerne står i
// ROADMAP-BESLUTNINGER.md, "Konto og GDPR":
// - Ikke muligt med aktive auktioner med bud, bud på igangværende auktioner,
//   åbne handler, sager, anker, tilbud eller penge undervejs
//   (konto_sletning_blokeringer i databasen).
// - Bekræftes med adgangskode og ved at skrive "SLET".
// - Persondata anonymiseres i databasen (konto_slet), profilbilleder slettes
//   i storage, og auth-brugeren soft-slettes via admin-API'et, så e-mailen
//   ikke kan logge ind, men kan bruges til en ny konto senere.
// - Handelsdata slettes ALDRIG.
//
// Kalderen SKAL have valideret brugeren (getUser) og tjekket to-trins-login
// (aal2, hvis brugeren har det slået til), før denne funktion kaldes.
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import { bekraeftAdgangskode } from "@/lib/bekraeftAdgangskode";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { kontoSlettetMail } from "@/lib/mails/konto";
import { logDriftFejl } from "@/lib/drift";

export const SLET_GENERISK = "Noget gik galt. Prøv igen om lidt, eller skriv til support@bidhamr.dk.";

export type Blokering = { type: string; tekst: string; link: string | null };

export type SletResultat =
  | { ok: true }
  | { fejl: string; kode: "bekraeftelse" | "for_mange" | "forkert_adgangskode" | "blokeret" | "fejl"; blokeringer?: Blokering[] };

// Nøgler, der altid ryddes i auth-brugerens metadata (nødbremsen). Supabase
// fletter user_metadata ved opdatering, så hver nøgle skal sættes til null -
// et tomt objekt rydder ingenting.
const METADATA_NOEGLER = [
  "fornavn", "efternavn", "navn", "telefon", "full_name", "name", "given_name",
  "family_name", "avatar_url", "picture", "phone", "email", "preferred_username",
  "nickname", "user_name",
];

export async function udfoerKontoSletning(input: {
  bruger: User;
  adgangskode: unknown;
  bekraeftelse: unknown;
  // Logger brugeren ud alle steder (cookie-session eller access token).
  logUdAlleSteder: () => Promise<void>;
}): Promise<SletResultat> {
  const { bruger } = input;

  if ((typeof input.bekraeftelse === "string" ? input.bekraeftelse : "").trim() !== "SLET") {
    return { fejl: "Skriv SLET med store bogstaver for at bekræfte.", kode: "bekraeftelse" };
  }
  if (!(await tjekGraenser([["konto_slet_bruger", bruger.id], ["adgangskode_bruger", bruger.id]]))) {
    return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
  }

  const adgangskode = typeof input.adgangskode === "string" ? input.adgangskode : "";
  const tjek = await bekraeftAdgangskode(bruger.email, adgangskode);
  if (tjek === "forkert") return { fejl: "Adgangskoden er forkert.", kode: "forkert_adgangskode" };
  if (tjek === "for_mange") return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
  if (tjek !== "ok") return { fejl: SLET_GENERISK, kode: "fejl" };

  // E-mailen gemmes til kvitteringen, før den anonymiseres.
  const email = bruger.email ?? null;
  const admin = createAdminClient();

  // 1. Databasen: tjekker blokeringerne igen under lås og anonymiserer.
  const { data, error } = await admin.rpc("konto_slet", { p_bruger: bruger.id });
  if (error) {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto", fejl: error });
    return { fejl: SLET_GENERISK, kode: "fejl" };
  }
  const svar = data as { kode?: string; blokeringer?: Blokering[] } | null;
  if (svar?.kode === "blokeret") {
    return {
      fejl: "Din konto kan ikke slettes endnu. Se hvad der mangler herunder.",
      kode: "blokeret",
      blokeringer: svar.blokeringer ?? [],
    };
  }
  if (svar?.kode !== "ok") {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto", fejl: `konto_slet: ${svar?.kode ?? "ukendt"}` });
    return { fejl: SLET_GENERISK, kode: "fejl" };
  }

  // 2. Profilbilleder i storage (mappen hedder brugerens id).
  try {
    const { data: filer, error: listeFejl } = await admin.storage
      .from("avatarer")
      .list(bruger.id, { limit: 1000 });
    if (listeFejl) throw listeFejl;
    const stier = (filer ?? []).map((f) => `${bruger.id}/${f.name}`);
    if (stier.length > 0) {
      const { error: sletFejl } = await admin.storage.from("avatarer").remove(stier);
      if (sletFejl) throw sletFejl;
    }
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto: avatarer", fejl: err });
  }

  // 3. Log ud alle steder, og soft-slet auth-brugeren: e-mail og telefon
  //    sløres, metadata, identiteter, sessioner og to-trins-faktorer fjernes,
  //    og e-mailen kan bruges til en ny konto. Rækken i auth.users bliver,
  //    fordi public.users (handelsdata) peger på den.
  try {
    await input.logUdAlleSteder();
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto: log ud", fejl: err });
  }
  const { error: authFejl } = await admin.auth.admin.deleteUser(bruger.id, true);
  if (authFejl) {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto: auth", fejl: authFejl });
    // Nødbremse: spær login permanent, frigiv e-mailen og ryd metadata.
    const metadata: Record<string, null> = {};
    for (const k of new Set([...METADATA_NOEGLER, ...Object.keys(bruger.user_metadata ?? {})])) {
      metadata[k] = null;
    }
    const { error: banFejl } = await admin.auth.admin.updateUserById(bruger.id, {
      email: `slettet+${bruger.id}@slettet.invalid`,
      email_confirm: true,
      ban_duration: "876000h",
      user_metadata: metadata,
    });
    if (banFejl) {
      await logDriftFejl({ kilde: "action", hvor: "sletMinKonto: spaerring", fejl: banFejl });
    }
  }

  // 4. Kvittering til den gamle e-mail.
  if (email) {
    const res = await sendHandelMailDetaljer(email, kontoSlettetMail());
    if (!res.ok) await logDriftFejl({ kilde: "action", hvor: "kontoSlettetMail", fejl: res.fejl });
  }

  return { ok: true };
}
