import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { tilmeldingAaben } from "@/lib/tilmelding";
import SignupForm from "./SignupForm";

// Oprettelse af konti er lukket indtil launch (src/lib/tilmelding.ts). På
// testdatabasen er den åben, så hele flowet med e-mailbekræftelse kan testes.
// BEMÆRK: dette er kun app-laget. Selve tilmeldingen skal også styres i
// Supabase (Auth -> Sign In / Providers -> "Allow new users to sign up"),
// ellers kan man stadig oprette konti direkte mod auth-API'et med anon-nøglen.
export const metadata: Metadata = { title: "Opret konto", robots: { index: false, follow: false } };

export default async function SignupSide() {
  if (!tilmeldingAaben()) redirect("/coming-soon");

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect("/konto");

  return <SignupForm />;
}
