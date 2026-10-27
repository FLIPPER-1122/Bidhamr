// Teksten i påmindelsen 1 time før en auktion slutter (Filip, 27. okt. 2026 -
// migration 20261102250000_paamindelse_foer_slut.sql). Ren funktion uden
// server-only, så den kan testes (tests/enhed/paamindelseFoerSlut.test.ts) og
// bruges som reference for appen.

export type PaamindelseFoerSlut = {
  titel: string;
  slutterKl: string;
  // Har brugeren budt på auktionen? (Ellers er den kun en favorit.)
  budt: boolean;
  // Har brugeren det højeste bud? Kun meningsfuld, når budt er true.
  foerer: boolean;
};

const MINUT = 60_000;

// "om 1 time" i det normale tilfælde (cron'en kører hvert 5. minut og rammer
// 55-60 minutter før slut). Er der gået længere tid (cron'en var nede, eller
// brugeren gemte auktionen senere), står de reelle minutter i stedet, så
// teksten aldrig lover mere tid, end der er.
export function slutterOm(slutterKl: string, nu: number = Date.now()): string {
  const min = Math.max(1, Math.round((new Date(slutterKl).getTime() - nu) / MINUT));
  return min >= 50 ? "om 1 time" : `om ${min} min.`;
}

function klokkeslaet(iso: string): string {
  return new Date(iso).toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

function kortTitel(titel: string): string {
  const t = titel.trim().replace(/\s+/g, " ");
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

export function paamindelseFoerSlutTekst(
  p: PaamindelseFoerSlut,
  nu: number = Date.now(),
): { titel: string; tekst: string } {
  const om = slutterOm(p.slutterKl, nu);
  const vare = `"${kortTitel(p.titel)}" slutter kl. ${klokkeslaet(p.slutterKl)}.`;
  if (p.budt && p.foerer) {
    return { titel: `Slutter ${om} – du fører`, tekst: `${vare} Du har det højeste bud lige nu.` };
  }
  if (p.budt) {
    return {
      titel: `Slutter ${om} – du fører ikke længere`,
      tekst: `${vare} En anden har budt mere end dig. Byd igen, hvis du stadig vil have den.`,
    };
  }
  return { titel: `Slutter ${om}`, tekst: `${vare} Byd nu, hvis du vil være med.` };
}
