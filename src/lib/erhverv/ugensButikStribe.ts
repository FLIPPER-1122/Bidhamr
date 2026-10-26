// Hvilken uge i træk er hver booket uge i Ugens butik-kalenderen?
//
// ugens_butik_admin giver i_traek = længden af HELE firmaets stribe, som ugen
// ligger i (ugens_butik_stribe tæller både bagud og frem). Ugens plads i
// striben = i_traek minus antallet af firmaets uger lige efter den. Listen er
// fortløbende uger fra den igangværende og så langt frem, som der kan
// bookes, så ugerne efter ligger altid i listen (uger før den igangværende
// er med i i_traek). Kald den på HELE listen fra databasen - før den kortes.
type Uge = { booking_id: string | null; firma_id: string | null; i_traek?: number | null };

export function nrITraek(uger: readonly Uge[]): (number | null)[] {
  const nr: (number | null)[] = new Array(uger.length).fill(null);
  let efter = 0; // firmaets uger lige efter uge i
  for (let i = uger.length - 1; i >= 0; i--) {
    const u = uger[i];
    const naeste = uger[i + 1];
    efter = naeste && naeste.booking_id && u.firma_id && naeste.firma_id === u.firma_id ? efter + 1 : 0;
    if (!u.booking_id || !u.firma_id || u.i_traek == null) continue;
    nr[i] = Math.max(1, Number(u.i_traek) - efter);
  }
  return nr;
}
