// Statuslinjen (docs/ADMIN-REDESIGN.md 3.1): én farve + én kort tekst, der
// siger, om noget er galt. Beregnes ét sted, så menuens lille lampe og
// forsidens linje altid siger det samme.
//
// Trin 1-2: kun ud fra det, der findes i dag (menuens tællere og
// admin_forside_tal + drift-data på forsiden). Nødstop, afstemning og
// godkendelser kommer i trin 3 (admin_status()), når penge-agenterne er
// flettet ind. Der vises aldrig et tal, vi ikke har.
//
// TODO indhold-agenten: de endelige tekster for alle kombinationer.

export type StatusTone = "groen" | "gul" | "roed";

export type StatusPunkt = {
  tone: StatusTone;
  // Kort tekst, fx "1 DSA-sag er over fristen".
  tekst: string;
  href: string;
};

export type Status = {
  tone: StatusTone;
  titel: string;
  tekst: string;
  href: string | null;
  knap: string | null;
  punkter: StatusPunkt[];
};

const flertal = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;

// Tallene, menuen kender (admin/layout.tsx). Alle er antal - ingen beløb.
export type KoeTal = {
  dsaOverskredet: number;
  dsa: number;
  sager: number;
  betalinger: number;
  // Reklamationer hos fragtfirmaet, der kræver staff (begge røde).
  reklamationStille?: number;
  reklamationSagAendret?: number;
  // Indsigelser mod ekstra fragt (rødt - staff skal afgøre dem).
  ekstraFragtIndsigelser?: number;
  // Tabte bankindsigelser på betalte ekstraregninger (rødt - staff afgør, om
  // regningen skal genåbnes).
  ekstraFragtTabteBankindsigelser?: number;
};

export function koePunkter(t: KoeTal): StatusPunkt[] {
  const p: StatusPunkt[] = [];
  if (t.dsaOverskredet > 0) {
    p.push({
      tone: "roed",
      tekst: `${flertal(t.dsaOverskredet, "DSA-sag", "DSA-sager")} over fristen`,
      href: "/admin/dsa",
    });
  }
  if ((t.reklamationSagAendret ?? 0) > 0) {
    p.push({
      tone: "roed",
      tekst: `${flertal(t.reklamationSagAendret ?? 0, "reklamation", "reklamationer")}: sagen er ændret efter anmeldelsen`,
      href: "/admin/reklamationer?vis=sag_aendret",
    });
  }
  if ((t.reklamationStille ?? 0) > 0) {
    p.push({
      tone: "roed",
      tekst: `${flertal(t.reklamationStille ?? 0, "reklamation", "reklamationer")} har stået stille i 14 dage`,
      href: "/admin/reklamationer?vis=stille",
    });
  }
  if ((t.ekstraFragtIndsigelser ?? 0) > 0) {
    p.push({
      tone: "roed",
      tekst: `${flertal(t.ekstraFragtIndsigelser ?? 0, "indsigelse", "indsigelser")} mod ekstra fragt venter`,
      href: "/admin/ekstra-fragt?vis=indsigelse",
    });
  }
  if ((t.ekstraFragtTabteBankindsigelser ?? 0) > 0) {
    p.push({
      tone: "roed",
      tekst: `${flertal(t.ekstraFragtTabteBankindsigelser ?? 0, "tabt bankindsigelse", "tabte bankindsigelser")} på ekstra fragt – betalingen er tilbageført`,
      href: "/admin/ekstra-fragt?vis=tabt",
    });
  }
  if (t.betalinger > 0) {
    p.push({ tone: "gul", tekst: flertal(t.betalinger, "betalingsfejl venter", "betalingsfejl venter"), href: "/admin/betalinger" });
  }
  if (t.sager > 0) {
    p.push({ tone: "gul", tekst: flertal(t.sager, "åben sag venter", "åbne sager venter"), href: "/admin/sager" });
  }
  const dsaInden = t.dsa - t.dsaOverskredet;
  if (dsaInden > 0) {
    p.push({
      tone: "gul",
      tekst: `${flertal(dsaInden, "DSA-sag", "DSA-sager")} med lovpligtig frist`,
      href: "/admin/dsa",
    });
  }
  return p;
}

// Samler punkterne til én linje. Den vigtigste (røde først) står forrest,
// resten tælles som "+2 mere".
// systemerTjekket: systemlamperne er med (admin/chef på forsiden) - kun da
// må den grønne linje sige "Alt kører".
export function beregnStatus(punkter: StatusPunkt[], opts: { systemerTjekket?: boolean } = {}): Status {
  const roede = punkter.filter((p) => p.tone === "roed");
  const gule = punkter.filter((p) => p.tone === "gul");
  const sorteret = [...roede, ...gule];
  if (roede.length > 0) {
    const foerste = roede[0];
    const resten = sorteret.slice(1);
    return {
      tone: "roed",
      titel: foerste.tekst,
      tekst: resten.length
        ? `+${resten.length} mere: ${resten.map((p) => p.tekst.toLowerCase()).join(" · ")}`
        : "Skal behandles nu.",
      href: foerste.href,
      knap: "Gå til",
      punkter: sorteret,
    };
  }
  if (gule.length > 0) {
    return {
      tone: "gul",
      titel: `${flertal(gule.length, "ting kræver", "ting kræver")} din stillingtagen`,
      tekst: gule.map((p) => p.tekst).join(" · "),
      href: gule[0].href,
      knap: "Se dem",
      punkter: sorteret,
    };
  }
  return {
    tone: "groen",
    titel: opts.systemerTjekket ? "Alt kører" : "Intet haster lige nu",
    tekst: opts.systemerTjekket
      ? "Ingen systemfejl, og intet med høj alvor venter på dig."
      : "Ingen frister er overskredet, og ingen fejl venter.",
    href: null,
    knap: null,
    punkter: [],
  };
}
