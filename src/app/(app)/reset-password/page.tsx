import NulstilForm from "./NulstilForm";

// ?velkommen=1 sættes af linket i velkomstmailen til en ny firmakonto
// (src/app/actions/adminErhverv.ts, velkomstLink) - så viser siden
// "Vælg din adgangskode" i stedet for "Ny adgangskode".
export default async function NulstilAdgangskodePage({
  searchParams,
}: {
  searchParams: Promise<{ velkommen?: string }>;
}) {
  const { velkommen } = await searchParams;
  return <NulstilForm velkommen={velkommen === "1"} />;
}
