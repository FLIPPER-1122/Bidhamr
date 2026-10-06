// Antal fundne auktioner på /auktioner - fælles for server og klient.
//
// "praecis": total er det præcise antal. "ca": et skøn over mange rækker
// (vises som "ca. 1.200"). "mange": flere, end der er talt (afstandsfilterets
// loft) - total er så kun det, der er fundet indtil videre, og må ikke vises
// som et samlet antal.
export type TotalType = "praecis" | "ca" | "mange";

const tal = new Intl.NumberFormat("da-DK");

// "24", "ca. 1.200" eller "mange" - fx i "Viser 24 af …".
export function antalTekst(total: number, type: TotalType): string {
  if (type === "mange") return "mange";
  if (type === "ca") return `ca. ${tal.format(total)}`;
  return tal.format(total);
}

// "1 auktion fundet", "ca. 1.200 auktioner fundet", "Mange auktioner fundet".
export function antalFundet(total: number, type: TotalType): string {
  if (type === "mange") return "Mange auktioner fundet";
  return `${antalTekst(total, type)} auktion${total === 1 && type === "praecis" ? "" : "er"} fundet`;
}
