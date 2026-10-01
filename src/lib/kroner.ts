// Formaterer et beløb i øre til danske kroner. Kun visning - ingen beregning.
export function kroner(oere: number) {
  return (
    (oere / 100).toLocaleString("da-DK", {
      minimumFractionDigits: oere % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }) + " kr"
  );
}
