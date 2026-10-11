import NulstilForm from "./NulstilForm";

// ?velkommen=1 sættes af linket i velkomstmailen til en ny firmakonto
// (src/app/actions/adminErhverv.ts, velkomstLink) - så viser siden
// "Vælg din adgangskode" i stedet for "Ny adgangskode".
// ?fra=signup: e-mailen er lige bekræftet, men den valgte adgangskode kunne
// ikke sættes (verificerSignupKode i src/app/actions/auth.ts).
export default async function NulstilAdgangskodePage({
  searchParams,
}: {
  searchParams: Promise<{ velkommen?: string; fra?: string }>;
}) {
  const { velkommen, fra } = await searchParams;
  return <NulstilForm velkommen={velkommen === "1"} signup={fra === "signup"} />;
}
