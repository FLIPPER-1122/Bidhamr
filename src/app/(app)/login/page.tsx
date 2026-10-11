import { Suspense } from "react";
import { tilmeldingAaben } from "@/lib/tilmelding";
import { betaAaben } from "@/lib/beta";
import LoginForm from "./LoginForm";

// Mens tilmeldingen er lukket, men beta-testen er åben, viser siden et link
// til "Opret konto" for inviterede (src/lib/beta.ts).
export default async function LoginPage() {
  const aaben = tilmeldingAaben();
  const beta = !aaben && (await betaAaben());
  return (
    <Suspense>
      <LoginForm tilmeldingAaben={aaben} betaAaben={beta} />
    </Suspense>
  );
}
