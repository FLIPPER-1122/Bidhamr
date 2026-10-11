import { erTestdatabase } from "@/lib/miljoe";

// Oprettelse af konti er lukket indtil launch. Den åbnes ved at sætte
// TILMELDING_AABEN=true (Vercel) - på testdatabasen er den altid åben, så
// signup og bekræftelseskoden kan testes. SIMULER_TILMELDING_LUKKET=true i
// .env.local lukker den lokalt (kun på testdatabasen), så beta-tilmeldingen
// kan testes.
// BEMÆRK: Supabases egen indstilling "Allow new users to sign up" skal ALTID
// være slået fra - også efter lancering. Alle konti oprettes på serveren
// (src/lib/kontoOprettelse.ts), og databasen kræver en billet fra serveren
// (20261018010000_signup_billet_altid.sql). Databasens invitationsværn
// (beta_indstillinger.kun_inviterede) slås fra samtidig med
// TILMELDING_AABEN=true - se HUSKELISTE.md under "Lancering".
//
// Åben og lukket tilmelding bruger samme kodevej; forskellen er kun
// invitationstjekket: mens tilmeldingen er lukket, kan kun inviterede
// beta-testere oprette sig (når chefen har beta åben). Det tjekkes også i
// databasen (handle_new_user).
// Mailadressen fra signup huskes i en kort, httpOnly cookie til siden
// "Indtast koden" (/tjek-indbakke) - den skal ikke stå i URL'en.
export const TJEK_EMAIL_COOKIE = "bh_tjek_email";

export function tilmeldingAaben(): boolean {
  if (erTestdatabase()) return process.env.SIMULER_TILMELDING_LUKKET !== "true";
  return process.env.TILMELDING_AABEN === "true";
}
