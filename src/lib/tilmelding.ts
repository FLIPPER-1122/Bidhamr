import { erTestdatabase } from "@/lib/miljoe";

// Oprettelse af konti er lukket indtil launch. Den åbnes ved at sætte
// TILMELDING_AABEN=true (Vercel) - på testdatabasen er den altid åben, så
// signup og e-mailbekræftelse kan testes.
// BEMÆRK: Supabase har sin egen indstilling ("Allow new users to sign up"),
// som også skal være slået til.
// Mailadressen fra signup huskes i en kort, httpOnly cookie til "Tjek din
// indbakke"-siden - den skal ikke stå i URL'en.
export const TJEK_EMAIL_COOKIE = "bh_tjek_email";

export function tilmeldingAaben(): boolean {
  return erTestdatabase() || process.env.TILMELDING_AABEN === "true";
}
