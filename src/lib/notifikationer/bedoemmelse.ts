import "server-only";

// Notifikationer for bedømmelser:
// - sælgeren svarer        -> køberen (type 'bedoemmelse', valgfri,
//                              nøgle bedoemmelse_svar:<svar-id>)
// - staff skjuler/viser     -> den, der skrev teksten (type 'advarsel',
//                              påkrævet: begrundelsen skal frem - DSA)
//
// Svar sendes med det samme fra server actions (src/app/actions/bedoemmelser.ts)
// og samles op af notifikations-cron'en for svar fra appen, som kalder
// RPC'en direkte. Samme nøgle, så intet sendes dobbelt. Kaster aldrig.
// Ingen bruger-id'er i data.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";
import { skjulGrundNavn, type BedoemmelseDel } from "@/lib/bedoemmelser";

type Admin = ReturnType<typeof createAdminClient>;

export type SvarRaekke = {
  id: string;
  rating_id: string;
  saelger_id: string;
  tekst: string;
  skjult: boolean;
  slettet_kl: string | null;
};

export const bedoemmelseSvarNoegle = (svarId: string) => `bedoemmelse_svar:${svarId}`;

function kort(tekst: string, maks = 140): string {
  return tekst.length > maks ? `${tekst.slice(0, maks - 1)}…` : tekst;
}

// Profilen, hvor bedømmelsen og svaret vises.
const profilLink = (saelgerId: string, ratingId: string) =>
  `/profil/${saelgerId}#bedoemmelse-${ratingId}`;

export function svarInput(s: SvarRaekke): NotifikationInput & { noegle: string } {
  return {
    titel: "Sælgeren har svaret på din bedømmelse",
    tekst: `Sælgeren har svaret på din bedømmelse: "${kort(s.tekst)}"`,
    link: profilLink(s.saelger_id, s.rating_id),
    data: { rating_id: s.rating_id },
    noegle: bedoemmelseSvarNoegle(s.id),
  };
}

// Køberen, der skrev bedømmelsen (null, hvis svaret ikke skal sendes).
export async function koeberForSvar(admin: Admin, s: SvarRaekke): Promise<string | null> {
  if (s.skjult || s.slettet_kl) return null;
  const { data: r } = await admin
    .from("ratings")
    .select("fra_bruger_id, skjult")
    .eq("id", s.rating_id)
    .maybeSingle<{ fra_bruger_id: string; skjult: boolean }>();
  if (!r || r.skjult || r.fra_bruger_id === s.saelger_id) return null;
  return r.fra_bruger_id;
}

export async function notificerBedoemmelseSvar(svarId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: s } = await admin
      .from("bedoemmelse_svar")
      .select("id, rating_id, saelger_id, tekst, skjult, slettet_kl")
      .eq("id", svarId)
      .maybeSingle<SvarRaekke>();
    if (!s) return;
    const koeber = await koeberForSvar(admin, s);
    if (!koeber) return;
    await send(koeber, "bedoemmelse", svarInput(s));
  } catch (err) {
    console.error("notificerBedoemmelseSvar fejlede:", err);
  }
}

// Staff har skjult eller vist noget, brugeren har skrevet. Begrundelsen
// sendes med (Digital Services Act: brugeren skal kende årsagen).
export async function notificerModeration(input: {
  forfatterId: string;
  ratingId: string;
  del: BedoemmelseDel;
  skjult: boolean;
  grund: string | null;
  aarsag: string | null;
}): Promise<void> {
  try {
    const erBedoemmelse = input.del === "bedoemmelse";
    const hvad = erBedoemmelse ? "Din bedømmelse" : "Dit svar på en bedømmelse";
    const den = erBedoemmelse ? "den" : "det";
    const synlig = erBedoemmelse ? "synlig" : "synligt";
    const link = erBedoemmelse ? null : `/profil/${input.forfatterId}?fane=bedommelser`;
    const begrundelse = [skjulGrundNavn(input.grund), input.aarsag].filter(Boolean).join(": ");
    const tekst = input.skjult
      ? `${hvad} er skjult af BidHamr, fordi ${den} bryder reglerne for bedømmelser. Begrundelse: ${
          begrundelse || "Ikke angivet"
        }. ${den[0].toUpperCase()}${den.slice(1)} er ikke slettet, men kan ikke længere ses af andre. Er du uenig, kan du skrive til os via kontaktformularen.`
      : `${hvad} er ${synlig} igen. En medarbejder har gennemgået ${den} igen.`;
    await send(input.forfatterId, "advarsel", {
      titel: input.skjult ? `${hvad} er skjult` : `${hvad} er ${synlig} igen`,
      tekst,
      link,
      data: { rating_id: input.ratingId, del: input.del },
    });
  } catch (err) {
    console.error("notificerModeration fejlede:", err);
  }
}
