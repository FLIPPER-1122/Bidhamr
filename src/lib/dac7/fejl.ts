// Databasens fejl, når en sælger er spærret for nye auktioner, fordi
// DAC7-oplysningerne mangler efter fristen (dac7_kraev, 20261014010000_dac7.sql).
// Bruges både på serveren og i klientkomponenter.
export const DAC7_FEJLKODE = "BHD01";

export const DAC7_FEJL_TEKST =
  "Du skal give os de oplysninger, Skattestyrelsen kræver, før du kan sætte flere varer til salg. Gå til Min konto → Skatteoplysninger.";

export function erDac7Fejl(code: string | null | undefined, message?: string | null): boolean {
  return code === DAC7_FEJLKODE || (message ?? "").includes("dac7_mangler");
}
