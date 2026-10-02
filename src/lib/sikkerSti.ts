// Beskytter mod aaben omdirigering: kun relative stier paa vores eget domaene.
export function sikkerSti(sti: string | null | undefined, fallback = "/"): string {
  if (!sti) return fallback;
  if (!sti.startsWith("/")) return fallback;
  if (sti.startsWith("//") || sti.startsWith("/\\")) return fallback;
  if (sti.includes("://")) return fallback;
  // Backslash og kontroltegn (fx tab/linjeskift) kan snyde browserens URL-parser.
  // Mellemrum (alle slags), anførselstegn og < > hører aldrig hjemme i en
  // intern sti (de skal være URL-kodede) og kan bryde ud af en HTML-attribut.
  if (/[\u0000-\u001f\u007f\\"<>\s]/.test(sti)) return fallback;
  return sti;
}
