// Databasens fejl, når MitID mangler (mitid_kraev, 20261013010000_mitid.sql).
// Bruges både på serveren og i klientkomponenter.
export const MITID_FEJLKODE = "BHV01";

export function erMitIdFejl(code: string | null | undefined, message?: string | null): boolean {
  return code === MITID_FEJLKODE || (message ?? "").includes("mitid_mangler");
}
