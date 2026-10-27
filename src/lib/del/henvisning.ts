import "server-only";

// KROG til "Henvis en ven" (Filip, 27. okt. 2026 - bygges i migration
// 20261102230000 af en anden opgave). Del-knappen på auktionssiden kalder
// denne og lægger koden i linket som ?ref=<kode> (HENVISNING_PARAM i
// src/lib/del/delLink.ts).
//
// Sådan kobles den på, når "Henvis en ven" er færdig:
//   1. Er brugeren ikke logget ind, eller er kontoen ikke privat
//      (hentKontoType(brugerId) !== "privat" - firmaer kan ikke få point),
//      returnér null.
//   2. Ellers hent brugerens EGEN henvisningskode (fx en rpc, der bruger
//      auth.uid() - aldrig et bruger-id som parameter) og returnér den.
//   3. Landingen: siden, der modtager ?ref= (fx proxyen eller
//      /auktion/[id]), gemmer koden til tilmeldingen, ligesom "Henvis en
//      ven"-linket gør.
// Indtil da returneres altid null, så linket kun indeholder auktionens id.
export async function henvisningskodeTilDeling(brugerId: string | null): Promise<string | null> {
  if (!brugerId) return null;
  return null;
}
