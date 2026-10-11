import { erTestdatabase } from "@/lib/miljoe";

// Oprettelse af konti er lukket indtil launch. Den åbnes ved at sætte
// TILMELDING_AABEN=true (Vercel) - på testdatabasen er den altid åben, så
// signup og bekræftelseskoden kan testes. SIMULER_TILMELDING_LUKKET=true i
// .env.local lukker den lokalt (kun på testdatabasen), så beta-tilmeldingen
// kan testes.
// BEMÆRK: Supabase har sin egen indstilling ("Allow new users to sign up"),
// som også skal være slået til. Og databasen har sit eget værn
// (beta_indstillinger.kun_inviterede, 20261017010000_beta_invitationer.sql),
// som skal slås fra samtidig - se HUSKELISTE.md under "Lancering".
//
// Mens tilmeldingen er lukket, kan kun inviterede beta-testere oprette sig
// (opretKonto i src/app/actions/auth.ts, når chefen har beta åben). Det
// tjekkes også i databasen (handle_new_user).
// Mailadressen fra signup huskes i en kort, httpOnly cookie til siden
// "Indtast koden" (/tjek-indbakke) - den skal ikke stå i URL'en.
export const TJEK_EMAIL_COOKIE = "bh_tjek_email";

export function tilmeldingAaben(): boolean {
  if (erTestdatabase()) return process.env.SIMULER_TILMELDING_LUKKET !== "true";
  return process.env.TILMELDING_AABEN === "true";
}
