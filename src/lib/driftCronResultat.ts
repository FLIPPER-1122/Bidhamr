// Resuméet af en cron-kørsel, som det gemmes i drift_cron_koersler.resultat
// (vises på /admin/drift). Ren funktion - testes i
// tests/enhed/driftCronResultat.test.ts.
//
// Kun tal og små objekter med tal (resuméet fra koerBetalingsCron) - aldrig
// fri tekst, der kunne indeholde persondata eller hemmeligheder. Undtagelse:
// felterne springetOver og grund (fx fakturakøens springetOver "adgang" og
// grund "adgang: 401"), og kun når de er korte koder af små bogstaver, tal,
// mellemrum og : _ . - (koden bygger dem selv af faste ord og HTTP-status).

const KODE_FELTER = new Set(["springetOver", "grund"]);
const KODE = /^[a-z0-9_:. -]{1,60}$/;

function kode(k: string, v: unknown): string | null {
  return KODE_FELTER.has(k) && typeof v === "string" && KODE.test(v) ? v : null;
}

export function kortResultat(r: unknown): Record<string, unknown> | null {
  if (!r || typeof r !== "object") return null;
  const ud: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (typeof v === "number") ud[k] = v;
    else if (kode(k, v) !== null) ud[k] = v;
    else if (v && typeof v === "object") {
      const indre: Record<string, number | string> = {};
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === "number") indre[k2] = v2;
        else {
          const t = kode(k2, v2);
          if (t !== null) indre[k2] = t;
        }
      }
      ud[k] = indre;
    }
  }
  return ud;
}
