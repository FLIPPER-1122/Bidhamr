// Fælles formatering og etiketter for e-money-kontoen.

export const KOEBERGEBYR = 0.05;
export const SAELGERGEBYR = 0.1;

export type WalletKind =
  | "indbetaling"
  | "koeb"
  | "salg"
  | "koebergebyr"
  | "saelgergebyr"
  | "justering";

const KIND_LABEL: Record<WalletKind, string> = {
  indbetaling: "Indbetaling",
  koeb: "Køb",
  salg: "Salg",
  koebergebyr: "Købergebyr",
  saelgergebyr: "Sælgergebyr",
  justering: "Justering",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as WalletKind] ?? kind;
}

export function kr(beløb: number | string): string {
  const tal = typeof beløb === "string" ? Number(beløb) : beløb;
  return `${tal.toLocaleString("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} kr`;
}

// Det en køber reelt skal have dækning for: bud + 5% købergebyr.
export function budMedGebyr(bud: number): number {
  return Math.round(bud * (1 + KOEBERGEBYR) * 100) / 100;
}
