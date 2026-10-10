// Tekster til vinduet med brugerbetingelserne (src/components/vilkaar).
// Korte pladsholdere - indhold-agenten må gerne finpudse dem.
// Beskyttelsen hedder altid "BidHamr Beskyttelse" (se CLAUDE.md).

export const VILKAAR_TEKST = {
  overskriftFoerste: "Før du fortsætter: accepter BidHamrs brugerbetingelser",
  overskriftNy: "Vi har opdateret brugerbetingelserne",
  tekstFoerste:
    "For at bruge BidHamr skal du acceptere vores brugerbetingelser. Læs dem gerne først – og se, hvordan vi passer på dine oplysninger.",
  tekstNy: "Læs de nye betingelser, og accepter dem for at fortsætte med at bruge BidHamr.",
  version: (version: string, dato: string) => `Version ${version} af ${dato}`,
  udkast: "Udkast",
  udkastForklaring: "Betingelserne er et udkast og skal godkendes af en advokat.",
  laesBetingelser: "Læs brugerbetingelserne",
  laesPrivatliv: "Læs privatlivspolitikken",
  nytVindue: " (åbner i en ny fane)",
  accepter: "Jeg accepterer",
  gemmer: "Gemmer …",
  logUd: "Log ud",
  loggerUd: "Logger ud …",
  netvaerksfejl: "Din accept kunne ikke gemmes. Tjek din forbindelse, og prøv igen.",
  gemt: "Tak – din accept er gemt.",
} as const;
