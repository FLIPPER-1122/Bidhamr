// Private vises med fornavn + initial ("Kasper K."). En firmakonto
// (erFirma, users.konto_type = 'erhverv') hedder sit firmanavn, som er
// offentligt - det vises fuldt ("Testfirma ApS", ikke "Testfirma A.").
export function kortNavn(navn: string | null | undefined, erFirma = false): string {
  if (!navn?.trim()) return "Anonym";
  if (erFirma) return navn.trim().replace(/\s+/g, " ");
  const dele = navn.trim().split(/\s+/);
  if (dele.length === 1) return dele[0];
  return `${dele[0]} ${dele[1][0].toUpperCase()}.`;
}

// Afslutter en sætning med punktum uden at give dobbelt punktum, når teksten
// allerede ender på et (fx kortNavn("Kasper Kjær") = "Kasper K.").
export function medPunktum(tekst: string): string {
  return /[.!?…]$/.test(tekst.trimEnd()) ? tekst.trimEnd() : `${tekst}.`;
}
