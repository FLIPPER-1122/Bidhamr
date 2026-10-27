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

// Andre brugeres navn læses som users.visningsnavn (20261102060000): databasen
// har allerede lavet det korte navn ("Kasper K.", firmaer fuldt, "Slettet
// bruger"). users.navn kan kun læses af brugeren selv (rpc mit_navn) og staff
// via service role. Tomt = "Anonym" som kortNavn.
export function visNavn(visningsnavn: string | null | undefined): string {
  return visningsnavn?.trim() || "Anonym";
}

// Afslutter en sætning med punktum uden at give dobbelt punktum, når teksten
// allerede ender på et (fx kortNavn("Kasper Kjær") = "Kasper K.").
export function medPunktum(tekst: string): string {
  return /[.!?…]$/.test(tekst.trimEnd()) ? tekst.trimEnd() : `${tekst}.`;
}
