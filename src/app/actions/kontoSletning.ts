"use server";

// Brugeren sletter selv sin konto (GDPR). Reglerne står i
// ROADMAP-BESLUTNINGER.md, "Konto og GDPR":
// - Ikke muligt med aktive auktioner med bud, bud på igangværende auktioner,
//   åbne handler, sager, anker, tilbud eller penge undervejs
//   (konto_sletning_blokeringer i databasen).
// - Bekræftes med adgangskode og ved at skrive "SLET".
// - Persondata anonymiseres i databasen (konto_slet), profilbilleder slettes
//   i storage, og auth-brugeren soft-slettes via admin-API'et, så e-mailen
//   ikke kan logge ind, men kan bruges til en ny konto senere.
// - Handelsdata slettes ALDRIG.
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import { bekraeftAdgangskode } from "@/lib/bekraeftAdgangskode";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { kontoSlettetMail } from "@/lib/mails/konto";
import { logDriftFejl } from "@/lib/drift";
import { ENHED_COOKIE } from "@/lib/enheder";

const GENERISK = "Noget gik galt. Prøv igen om lidt, eller skriv til support@bidhamr.dk.";

export type Blokering = { type: string; tekst: string; link: string | null };

export async function sletMinKonto(input: {
  adgangskode: string;
  bekraeftelse: string;
}): Promise<{ ok: true } | { fejl: string; blokeringer?: Blokering[] }> {
  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  const bruger = brugerData.user;
  if (!bruger) return { fejl: "Du er ikke logget ind længere. Log ind igen." };

  if ((input?.bekraeftelse ?? "").trim() !== "SLET") {
    return { fejl: 'Skriv SLET med store bogstaver for at bekræfte.' };
  }
  if (!(await tjekGraenser([["konto_slet_bruger", bruger.id], ["adgangskode_bruger", bruger.id]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const tjek = await bekraeftAdgangskode(bruger.email, input?.adgangskode ?? "");
  if (tjek === "forkert") return { fejl: "Adgangskoden er forkert." };
  if (tjek === "for_mange") return { fejl: FOR_MANGE_FORSOEG };
  if (tjek !== "ok") return { fejl: GENERISK };

  // E-mailen gemmes til kvitteringen, før den anonymiseres.
  const email = bruger.email ?? null;
  const admin = createAdminClient();

  // 1. Databasen: tjekker blokeringerne igen under lås og anonymiserer.
  const { data, error } = await admin.rpc("konto_slet", { p_bruger: bruger.id });
  if (error) {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto", fejl: error });
    return { fejl: GENERISK };
  }
  const svar = data as { kode?: string; blokeringer?: Blokering[] } | null;
  if (svar?.kode === "blokeret") {
    return {
      fejl: "Din konto kan ikke slettes endnu. Se hvad der mangler herunder.",
      blokeringer: svar.blokeringer ?? [],
    };
  }
  if (svar?.kode !== "ok") {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto", fejl: `konto_slet: ${svar?.kode ?? "ukendt"}` });
    return { fejl: GENERISK };
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
  //    sløres, identiteter, sessioner og to-trins-faktorer fjernes, og
  //    e-mailen kan bruges til en ny konto. Rækken i auth.users bliver, fordi
  //    public.users (handelsdata) peger på den.
  await supabase.auth.signOut({ scope: "global" });
  const { error: authFejl } = await admin.auth.admin.deleteUser(bruger.id, true);
  if (authFejl) {
    await logDriftFejl({ kilde: "action", hvor: "sletMinKonto: auth", fejl: authFejl });
    // Nødbremse: spær login permanent og frigiv e-mailen.
    const { error: banFejl } = await admin.auth.admin.updateUserById(bruger.id, {
      email: `slettet+${bruger.id}@slettet.invalid`,
      email_confirm: true,
      ban_duration: "876000h",
      user_metadata: {},
    });
    if (banFejl) {
      await logDriftFejl({ kilde: "action", hvor: "sletMinKonto: spaerring", fejl: banFejl });
    }
  }

  const jar = await cookies();
  jar.delete(ENHED_COOKIE);

  // 4. Kvittering til den gamle e-mail.
  if (email) {
    const res = await sendHandelMailDetaljer(email, kontoSlettetMail());
    if (!res.ok) await logDriftFejl({ kilde: "action", hvor: "kontoSlettetMail", fejl: res.fejl });
  }

  return { ok: true };
}
