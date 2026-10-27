import { Suspense } from "react";
import { redirect } from "next/navigation";
import { tilmeldingAaben } from "@/lib/tilmelding";
import { betaAaben } from "@/lib/beta";
import { hentBruger } from "@/lib/supabase/bruger";
import { sikkerSti } from "@/lib/sikkerSti";
import LoginForm from "./LoginForm";

// Mens tilmeldingen er lukket, men beta-testen er åben, viser siden et link
// til "Opret konto" for inviterede (src/lib/beta.ts).
// Er man allerede logget ind, sendes man videre til ?redirect (kun interne
// stier) eller forsiden - gaten sender selv en firmakonto til /firma.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const [bruger, sp] = await Promise.all([hentBruger(), searchParams]);
  if (bruger) {
    const maal = sikkerSti(typeof sp.redirect === "string" ? sp.redirect : null, "/");
    redirect(maal === "/login" || maal.startsWith("/login?") || maal.startsWith("/login/") ? "/" : maal);
  }
  const aaben = tilmeldingAaben();
  const beta = !aaben && (await betaAaben());
  return (
    <Suspense>
      <LoginForm tilmeldingAaben={aaben} betaAaben={beta} />
    </Suspense>
  );
}
