import { redirect } from "next/navigation";

// Oprettelse af konti er lukket indtil launch. Ruten er også fjernet fra de
// offentlige ruter i src/lib/supabase/middleware.ts, så den ikke kan nås.
// BEMÆRK: dette er kun app-laget. Selve tilmeldingen skal også slås fra i
// Supabase (Auth -> Sign In / Providers -> "Allow new users to sign up"),
// ellers kan man stadig oprette konti direkte mod auth-API'et med anon-nøglen.
export default function SignupLukket() {
  redirect("/coming-soon");
}
