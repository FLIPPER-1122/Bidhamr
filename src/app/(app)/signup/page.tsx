import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { tilmeldingAaben } from "@/lib/tilmelding";
import { betaAaben } from "@/lib/beta";
import { renHenvisningskode } from "@/lib/henvisning/kode";
import SignupForm from "./SignupForm";

// Oprettelse af konti er lukket indtil launch (src/lib/tilmelding.ts). På
// testdatabasen er den åben, så hele flowet med e-mailbekræftelse kan testes.
// Mens den er lukket, vises formularen kun, når chefen har beta-testen åben -
// og så kan kun inviterede e-mails oprette sig (opretKonto tjekker
// invitationen, og databasen tjekker igen i handle_new_user).
// Kontoen oprettes altid på serveren (src/lib/kontoOprettelse.ts). "Allow new
// users to sign up" i Supabase skal ALTID være slået fra, og databasen
// afviser enhver ny konto uden en billet fra serveren
// (20261018010000_signup_billet_altid.sql), så signUp med anon-nøglen aldrig
// virker.
export const metadata: Metadata = { title: "Opret konto", robots: { index: false, follow: false } };

// ?ven=KODE (Henvis en ven): feltet "Henvisningskode" udfyldes på forhånd.
// Kun en gyldig kode - ellers er feltet tomt. Intet gemmes i browseren.
export default async function SignupSide({
  searchParams,
}: {
  searchParams: Promise<{ ven?: string | string[] }>;
}) {
  const { ven } = await searchParams;
  const henvisningskode = renHenvisningskode(Array.isArray(ven) ? ven[0] : ven) ?? "";
  const kunBeta = !tilmeldingAaben();
  if (kunBeta && !(await betaAaben())) redirect("/coming-soon");

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect("/konto");

  return <SignupForm kunInviterede={kunBeta} henvisningskode={henvisningskode} />;
}
