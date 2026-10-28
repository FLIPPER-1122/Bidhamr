// Indholdet af "Dokumentation til sælger" og "Dokumentation til politiet" som
// en ren model (afsnit med felter, tabeller, tekst og billeder). Ingen
// serveradgang, så det kan testes, at udgaven til sælger aldrig indeholder
// e-mail, telefon, MitID eller IP (tests/enhed/sagDokumentation.test.ts).
// src/lib/sagDokumentation/pdf.ts tegner modellen som PDF.
//
// Værn i to lag:
//   1. Dataene til politiudgaven (DokumentationData.politi) hentes kun, når
//      udgaven er 'politi' (src/lib/sagDokumentation/data.ts).
//   2. Byggeren her læser kun DokumentationData.politi for udgaven 'politi'.
import { FIRMA, FIRMA_ADRESSE } from "@/lib/firmaoplysninger";
import { SAG_STATUS_NAVN, SAG_TYPE_NAVN, type SagStatus, type SagType } from "@/lib/sager";
import { UDGAVE_NAVN, loftTekst, type SagDokumentationUdgave } from "@/lib/sagDokumentation/regler";
import { SAG_TYPE_NEUTRAL } from "@/lib/tekster/sagValg";

// ---------------------------------------------------------------------------
// Data (hentet af data.ts)
// ---------------------------------------------------------------------------
export type DokBillede = {
  tekst: string;
  tid: string | null;
  // JPEG eller PNG klar til at indlejre. null: kunne ikke hentes/læses.
  bytes: Uint8Array | null;
  format: "jpg" | "png" | null;
};

export type DokHaendelse = { tidspunkt: string | null; tekst: string; maaltVaegtGram: number | null };

export type DokForsendelse = {
  retning: "udgaaende" | "retur";
  fragtfirma: string;
  sporingsnummer: string | null;
  oprettetKl: string | null;
  afleveretKl: string | null;
  leveretKl: string | null;
  angivetVaegtGram: number | null;
  haendelser: DokHaendelse[];
};

export type DokChatBesked = {
  tid: string;
  fra: "koeber" | "saelger" | "bidhamr" | "ukendt";
  tekst: string;
  // Stoppet af spamfilteret (kom aldrig frem til modparten). Kun i politiudgaven.
  stoppet: string | null;
};

export type DokMitid = {
  status: string;
  navn: string | null;
  foedselsdato: string | null;
  verificeretKl: string | null;
  nulstilletKl: string | null;
};

export type DokPartPoliti = {
  email: string | null;
  telefon: string | null;
  kontoOprettetKl: string | null;
  mitid: DokMitid[];
  andreSagerSomKoeber: number;
  andreSagerSomSaelger: number;
};

export type DokHandelMellem = {
  id: string;
  titel: string | null;
  koeberErSagensKoeber: boolean;
  beloebKr: number | null;
  status: string;
  oprettetKl: string | null;
};

export type DokLog = { tid: string; handling: string; medarbejder: string | null; aarsag: string | null };

export type DokUdlevering = { tid: string; udgave: SagDokumentationUdgave; givetTil: string; journalnummer: string | null; af: string | null };

// Et loft er ramt: vist af i alt (står tydeligt i PDF'en).
export type DokLoft = { vist: number; iAlt: number };

export type DokumentationData = {
  // Lister, hvor ikke alt er medtaget (data.ts). Mangler = alt er med.
  afkortet?: {
    beskeder?: DokLoft;
    haendelser?: DokLoft;
    pakkebilleder?: DokLoft;
    forsendelser?: DokLoft;
  };
  sag: {
    id: string;
    type: SagType;
    oprindeligType: SagType | null;
    status: SagStatus;
    oprettetKl: string;
    beskrivelse: string;
    beskyttelse: boolean;
    pakkeSmidtUd: boolean;
    pakkeSmidtUdBegrundelse: string | null;
    afgjortKl: string | null;
    begrundelse: string | null;
    returKraeves: boolean;
    returAfleveretKl: string | null;
  };
  handel: {
    id: string;
    oprettetKl: string | null;
    afhentning: boolean;
    sendtKl: string | null;
    modtagetKl: string | null;
    sporingsnummer: string | null;
  };
  auktion: {
    id: string;
    titel: string | null;
    beskrivelse: string | null;
    kategori: string | null;
    maerke: string | null;
    stand: string | null;
    vaegtGram: number | null;
  } | null;
  auktionBilleder: DokBillede[];
  betaling: {
    budOere: number | null;
    fragtOere: number | null;
    totalOere: number | null;
    betaltKl: string | null;
    status: string;
  } | null;
  koeberNavn: string | null;
  saelgerNavn: string | null;
  levering: {
    maade: string | null;
    navn: string | null;
    adresse: string | null;
    postnummer: string | null;
    by: string | null;
    pakkeshop: string | null;
  } | null;
  forsendelser: DokForsendelse[];
  koeberBilleder: Array<DokBillede & { kategori: string }>;
  saelgerSvar: { tekst: string; oprettetKl: string; billeder: DokBillede[] } | null;
  pakkebilleder: DokBillede[];
  anke: {
    part: "koeber" | "saelger";
    indgivetKl: string;
    begrundelse: string;
    status: string;
    behandletKl: string | null;
    afgoerelseBegrundelse: string | null;
    billeder: DokBillede[];
  } | null;
  chat: DokChatBesked[];
  // Kun for udgaven 'politi'.
  politi?: {
    koeber: DokPartPoliti;
    saelger: DokPartPoliti;
    handlerMellem: DokHandelMellem[];
    log: DokLog[];
    udleveringer: DokUdlevering[];
  };
};

// ---------------------------------------------------------------------------
// Modellen (tegnes af pdf.ts)
// ---------------------------------------------------------------------------
export type DokBlok =
  | { slags: "felter"; raekker: Array<[string, string]> }
  | { slags: "tekst"; tekst: string; daempet?: boolean }
  | { slags: "underoverskrift"; tekst: string }
  | { slags: "tabel"; hoved: string[]; vaegte: number[]; raekker: string[][] }
  | { slags: "billeder"; billeder: DokBillede[] };

export type DokAfsnit = { titel: string; blokke: DokBlok[] };

export type Dokument = {
  udgave: SagDokumentationUdgave;
  titel: string;
  dannetKl: string;
  forside: Array<[string, string]>;
  indledning: string[];
  afsnit: DokAfsnit[];
  afslutning: string[];
};

// ---------------------------------------------------------------------------
// Formatering
// ---------------------------------------------------------------------------
const TZ = "Europe/Copenhagen";
const TID = new Intl.DateTimeFormat("da-DK", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function tid(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p: Record<string, string> = {};
  for (const x of TID.formatToParts(d)) p[x.type] = x.value;
  return `${p.day}.${p.month}.${p.year} kl. ${p.hour}.${p.minute}`;
}

function dato(iso: string | null | undefined): string {
  if (!iso) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function kr(oere: number | null | undefined): string {
  if (oere === null || oere === undefined) return "–";
  const k = oere / 100;
  return `${k.toLocaleString("da-DK", { minimumFractionDigits: Number.isInteger(k) ? 0 : 2, maximumFractionDigits: 2 })} kr.`;
}

function vaegt(gram: number | null | undefined): string {
  if (gram === null || gram === undefined) return "–";
  return gram >= 1000 ? `${(gram / 1000).toLocaleString("da-DK", { maximumFractionDigits: 2 })} kg` : `${gram} g`;
}

const v = (s: string | null | undefined) => (s && s.trim() ? s : "–");

const LEVERING_NAVN: Record<string, string> = {
  pakkeshop: "Pakkeshop",
  doer: "Levering til døren",
  afhentning: "Afhentning hos sælgeren",
};

const BETALING_NAVN: Record<string, string> = {
  afventer: "Afventer betaling",
  behandles: "Behandles",
  betalt: "Betalt",
  annulleret: "Annulleret",
  refunderet: "Refunderet",
};

const MITID_STATUS: Record<string, string> = {
  aktiv: "Aktiv",
  nulstillet: "Nulstillet af BidHamr",
  slettet: "Konto slettet",
};

const ANKE_STATUS: Record<string, string> = {
  afventer: "Afventer behandling",
  stadfaestet: "Afgørelsen står ved magt",
  omgjort: "Afgørelsen er ændret",
};

const FRA_NAVN: Record<DokChatBesked["fra"], string> = {
  koeber: "Køber",
  saelger: "Sælger",
  bidhamr: "BidHamr",
  ukendt: "Ukendt",
};

const HANDLING_NAVN: Record<string, string> = {
  sag_afgjort_koeber: "Medhold til køber",
  sag_afgjort_saelger: "Medhold til sælger",
  sag_lukket: "Sagen er lukket",
  sag_retur_afleveret: "Returpakke afleveret",
  sag_genaabnet: "Sagen er genåbnet",
  sag_afviklet: "Pengene er flyttet efter afgørelsen",
  sag_anke_indgivet: "Afgørelsen er anket",
  sag_anke_stadfaestet: "Anken er afgjort – afgørelsen står",
  sag_anke_omgjort: "Anken er afgjort – afgørelsen er ændret",
  konto_lukket: "Konto lukket permanent",
  indpakning_paamindelse: "Påmindelse til sælger: dårlig indpakning",
  advarsel: "Advarsel",
};

function handlingNavn(h: string): string {
  return HANDLING_NAVN[h] ?? h.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Byggeren
// ---------------------------------------------------------------------------
export function bygDokument(d: DokumentationData, udgave: SagDokumentationUdgave, dannet: Date): Dokument {
  const politi = udgave === "politi" ? d.politi : undefined;
  // Sagstypen: staff-navnet (fx "Svindel ...") kun i politiudgaven. Udgaven
  // til sælger får den neutrale tekst, som parterne også ser på sagssiden.
  const typeNavn = (t: SagType) => (udgave === "politi" ? SAG_TYPE_NAVN[t] : SAG_TYPE_NEUTRAL[t]);
  const afsnit: DokAfsnit[] = [];

  // 1. Handlen og varen
  const vare: DokBlok[] = [
    {
      slags: "felter",
      raekker: [
        ["Handlens id", d.handel.id],
        ["Vare (titel)", v(d.auktion?.titel)],
        ...(d.auktion?.kategori ? ([["Kategori", d.auktion.kategori]] as Array<[string, string]>) : []),
        ...(d.auktion?.maerke ? ([["Mærke", d.auktion.maerke]] as Array<[string, string]>) : []),
        ...(d.auktion?.stand ? ([["Stand", d.auktion.stand]] as Array<[string, string]>) : []),
        ...(d.auktion?.vaegtGram ? ([["Vægt (angivet af sælger)", vaegt(d.auktion.vaegtGram)]] as Array<[string, string]>) : []),
        ["Handlen oprettet", tid(d.handel.oprettetKl)],
        ["Sælger", v(d.saelgerNavn)],
        ["Køber", v(d.koeberNavn)],
      ],
    },
    { slags: "underoverskrift", tekst: "Beskrivelse i auktionen" },
    { slags: "tekst", tekst: v(d.auktion?.beskrivelse) },
  ];
  if (d.auktionBilleder.length) {
    vare.push({ slags: "underoverskrift", tekst: `Billeder i auktionen (${d.auktionBilleder.length})` });
    vare.push({ slags: "billeder", billeder: d.auktionBilleder });
  }
  afsnit.push({ titel: "Handlen og varen", blokke: vare });

  // 2. Betaling
  afsnit.push({
    titel: "Betaling",
    blokke: d.betaling
      ? [
          {
            slags: "felter",
            raekker: [
              ["Vindende bud", kr(d.betaling.budOere)],
              ["Fragt", kr(d.betaling.fragtOere)],
              ["Betalt af køber i alt", kr(d.betaling.totalOere)],
              ["Betalingsdato", tid(d.betaling.betaltKl)],
              ["Status", BETALING_NAVN[d.betaling.status] ?? d.betaling.status],
            ],
          },
          { slags: "tekst", tekst: "Betalingen er håndteret af BidHamrs betalingspartner Stripe.", daempet: true },
        ]
      : [{ slags: "tekst", tekst: "Der er ingen betaling registreret for handlen.", daempet: true }],
  });

  // 3. Levering og sporing
  const lev: DokBlok[] = [];
  const l = d.levering;
  const adresse = l ? [l.adresse, [l.postnummer, l.by].filter(Boolean).join(" ")].filter((x) => x && x.trim()).join(", ") : "";
  lev.push({
    slags: "felter",
    raekker: [
      ["Leveringsmåde", d.handel.afhentning ? LEVERING_NAVN.afhentning : l?.maade ? (LEVERING_NAVN[l.maade] ?? l.maade) : "–"],
      ["Købers navn", v(l?.navn ?? d.koeberNavn)],
      ["Leveringsadresse", v(adresse)],
      ...(l?.pakkeshop ? ([["Pakkeshop", l.pakkeshop]] as Array<[string, string]>) : []),
      ["Afsendt", tid(d.handel.sendtKl)],
      ["Sporingsnummer", v(d.handel.sporingsnummer)],
      ["Modtaget (markeret i BidHamr)", tid(d.handel.modtagetKl)],
    ],
  });
  const afk = d.afkortet ?? {};
  if (afk.forsendelser) {
    lev.push({ slags: "tekst", tekst: loftTekst(afk.forsendelser.vist, afk.forsendelser.iAlt, "første", "forsendelser") });
  }
  if (afk.haendelser) {
    lev.push({
      slags: "tekst",
      tekst: `${loftTekst(afk.haendelser.vist, afk.haendelser.iAlt, "seneste", "sporingshændelser")} Ældre hændelser er ikke medtaget.`,
    });
  }
  for (const f of d.forsendelser) {
    lev.push({
      slags: "underoverskrift",
      tekst: `${f.retning === "retur" ? "Returforsendelse" : "Forsendelse"} med ${f.fragtfirma}${f.sporingsnummer ? ` · ${f.sporingsnummer}` : ""}`,
    });
    lev.push({
      slags: "felter",
      raekker: [
        ["Fragtfirma", f.fragtfirma],
        ["Sporingsnummer", v(f.sporingsnummer)],
        ["Label oprettet", tid(f.oprettetKl)],
        ["Afleveret til fragtfirmaet", tid(f.afleveretKl)],
        ["Leveret", tid(f.leveretKl)],
        ["Vægt på labelen", vaegt(f.angivetVaegtGram)],
      ],
    });
    if (f.haendelser.length) {
      const medVaegt = f.haendelser.some((h) => h.maaltVaegtGram !== null);
      lev.push({
        slags: "tabel",
        hoved: medVaegt ? ["Tidspunkt", "Sporingshændelse", "Vægt (målt af fragtfirmaet)"] : ["Tidspunkt", "Sporingshændelse"],
        vaegte: medVaegt ? [1.6, 5, 1.6] : [1.6, 6],
        raekker: f.haendelser.map((h) =>
          medVaegt ? [tid(h.tidspunkt), h.tekst, vaegt(h.maaltVaegtGram)] : [tid(h.tidspunkt), h.tekst],
        ),
      });
    } else {
      lev.push({ slags: "tekst", tekst: "Ingen sporingshændelser registreret.", daempet: true });
    }
  }
  if (d.pakkebilleder.length) {
    lev.push({ slags: "underoverskrift", tekst: `Sælgerens pakkebilleder ved afsendelsen (${d.pakkebilleder.length})` });
    if (afk.pakkebilleder) {
      lev.push({ slags: "tekst", tekst: loftTekst(afk.pakkebilleder.vist, afk.pakkebilleder.iAlt, "første", "pakkebilleder") });
    }
    lev.push({ slags: "billeder", billeder: d.pakkebilleder });
  }
  afsnit.push({ titel: "Levering og sporing", blokke: lev });

  // 4. Sagen
  const sag: DokBlok[] = [
    {
      slags: "felter",
      raekker: [
        ["Sagens id", d.sag.id],
        ["Type", typeNavn(d.sag.type)],
        ...(d.sag.oprindeligType
          ? ([["Oprindelig type (valgt af køber)", typeNavn(d.sag.oprindeligType)]] as Array<[string, string]>)
          : []),
        ["Oprettet", tid(d.sag.oprettetKl)],
        ["BidHamr Beskyttelse", d.sag.beskyttelse ? "Ja" : "Nej"],
        ...(d.sag.pakkeSmidtUd ? ([["Køber har smidt pakken ud", v(d.sag.pakkeSmidtUdBegrundelse)]] as Array<[string, string]>) : []),
      ],
    },
    { slags: "underoverskrift", tekst: "Købers beskrivelse" },
    { slags: "tekst", tekst: v(d.sag.beskrivelse) },
  ];
  if (d.koeberBilleder.length) {
    sag.push({ slags: "underoverskrift", tekst: `Købers billeder (${d.koeberBilleder.length})` });
    sag.push({ slags: "billeder", billeder: d.koeberBilleder });
  }
  sag.push({ slags: "underoverskrift", tekst: "Sælgers svar" });
  if (d.saelgerSvar) {
    sag.push({ slags: "tekst", tekst: `Sendt ${tid(d.saelgerSvar.oprettetKl)}`, daempet: true });
    sag.push({ slags: "tekst", tekst: v(d.saelgerSvar.tekst) });
    if (d.saelgerSvar.billeder.length) {
      sag.push({ slags: "underoverskrift", tekst: `Sælgers billeder (${d.saelgerSvar.billeder.length})` });
      sag.push({ slags: "billeder", billeder: d.saelgerSvar.billeder });
    }
  } else {
    sag.push({ slags: "tekst", tekst: "Sælgeren har ikke svaret i sagen.", daempet: true });
  }
  afsnit.push({ titel: "Sagen", blokke: sag });

  // 5. Afgørelsen
  const afg: DokBlok[] = [
    {
      slags: "felter",
      raekker: [
        ["Status", SAG_STATUS_NAVN[d.sag.status] ?? d.sag.status],
        ["Afgjort", tid(d.sag.afgjortKl)],
        ["Begrundelse", v(d.sag.begrundelse)],
        ...(d.sag.returKraeves
          ? ([["Retur", d.sag.returAfleveretKl ? `Returpakke afleveret ${tid(d.sag.returAfleveretKl)}` : "Køberen skal sende varen retur"]] as Array<[string, string]>)
          : []),
      ],
    },
  ];
  if (d.anke) {
    afg.push({ slags: "underoverskrift", tekst: `Anke fra ${d.anke.part === "koeber" ? "køberen" : "sælgeren"}` });
    afg.push({
      slags: "felter",
      raekker: [
        ["Indgivet", tid(d.anke.indgivetKl)],
        ["Begrundelse", v(d.anke.begrundelse)],
        ["Status", ANKE_STATUS[d.anke.status] ?? d.anke.status],
        ["Afgjort", tid(d.anke.behandletKl)],
        ["BidHamrs begrundelse", v(d.anke.afgoerelseBegrundelse)],
      ],
    });
    if (d.anke.billeder.length) afg.push({ slags: "billeder", billeder: d.anke.billeder });
  }
  afsnit.push({ titel: "Afgørelsen", blokke: afg });

  // 6. Chatten
  const beskeder = politi ? d.chat : d.chat.filter((b) => !b.stoppet);
  // Udgaven til sælger nævner ikke det samlede antal (det tæller også
  // beskeder stoppet af filteret, som sælgeren ikke må se).
  const chatLoft: DokBlok[] = afk.beskeder
    ? [
        {
          slags: "tekst",
          tekst: politi
            ? `${loftTekst(afk.beskeder.vist, afk.beskeder.iAlt, "seneste", "beskeder")} Ældre beskeder er ikke medtaget.`
            : "Chatten er længere, end der er plads til i dokumentet. Kun de seneste beskeder er medtaget.",
        },
      ]
    : [];
  afsnit.push({
    titel: "Chat mellem køber og sælger om handlen",
    blokke: beskeder.length
      ? [
          ...chatLoft,
          {
            slags: "tabel",
            hoved: ["Sendt", "Fra", "Besked"],
            vaegte: [1.6, 1, 6],
            raekker: beskeder.map((b) => [
              tid(b.tid),
              FRA_NAVN[b.fra],
              b.stoppet ? `${b.tekst}\n(Stoppet af BidHamrs filter: ${b.stoppet} – kom ikke frem til modparten)` : b.tekst,
            ]),
          },
        ]
      : [{ slags: "tekst", tekst: "Ingen beskeder i handlens chat.", daempet: true }],
  });

  // 7.-10. Kun til politiet
  if (politi) {
    for (const [titel, part, navn] of [
      ["Køber", politi.koeber, d.koeberNavn],
      ["Sælger", politi.saelger, d.saelgerNavn],
    ] as const) {
      const blokke: DokBlok[] = [
        {
          slags: "felter",
          raekker: [
            ["Navn i BidHamr", v(navn)],
            ["E-mail", v(part.email)],
            ["Telefon", v(part.telefon)],
            ["Konto oprettet", tid(part.kontoOprettetKl)],
            ["Andre sager som køber", String(part.andreSagerSomKoeber)],
            ["Andre sager som sælger", String(part.andreSagerSomSaelger)],
          ],
        },
        { slags: "underoverskrift", tekst: "MitID-verificering" },
      ];
      if (part.mitid.length) {
        blokke.push({
          slags: "tabel",
          hoved: ["Navn (fra MitID)", "Fødselsdato", "Verificeret", "Status"],
          vaegte: [3, 1.4, 1.8, 2],
          raekker: part.mitid.map((m) => [
            v(m.navn),
            dato(m.foedselsdato),
            tid(m.verificeretKl),
            `${MITID_STATUS[m.status] ?? m.status}${m.nulstilletKl ? ` (${tid(m.nulstilletKl)})` : ""}`,
          ]),
        });
      } else {
        blokke.push({ slags: "tekst", tekst: "Ikke verificeret med MitID.", daempet: true });
      }
      afsnit.push({ titel: `${titel}: identitet og konto`, blokke });
    }

    afsnit.push({
      titel: "Handler mellem de to parter",
      blokke: politi.handlerMellem.length
        ? [
            {
              slags: "tabel",
              hoved: ["Oprettet", "Vare", "Købt af", "Beløb", "Status", "Handlens id"],
              vaegte: [1.6, 2.8, 1.4, 1.2, 1.2, 2.6],
              raekker: politi.handlerMellem.map((h) => [
                tid(h.oprettetKl),
                v(h.titel),
                h.koeberErSagensKoeber ? "Sagens køber" : "Sagens sælger",
                h.beloebKr === null ? "–" : `${h.beloebKr.toLocaleString("da-DK")} kr.`,
                h.status,
                h.id,
              ]),
            },
          ]
        : [{ slags: "tekst", tekst: "Ingen andre handler mellem parterne.", daempet: true }],
    });

    afsnit.push({
      titel: "Sagens log",
      blokke: politi.log.length
        ? [
            {
              slags: "tabel",
              hoved: ["Tidspunkt", "Handling", "Medarbejder", "Begrundelse"],
              vaegte: [1.6, 2.4, 1.6, 4],
              raekker: politi.log.map((x) => [tid(x.tid), handlingNavn(x.handling), v(x.medarbejder), v(x.aarsag)]),
            },
          ]
        : [{ slags: "tekst", tekst: "Ingen handlinger i loggen.", daempet: true }],
    });

    if (politi.udleveringer.length) {
      afsnit.push({
        titel: "Tidligere udleveret dokumentation",
        blokke: [
          {
            slags: "tabel",
            hoved: ["Tidspunkt", "Udgave", "Givet til", "Journalnr.", "Lavet af"],
            vaegte: [1.6, 1.8, 3, 1.5, 1.6],
            raekker: politi.udleveringer.map((u) => [
              tid(u.tid),
              u.udgave === "politi" ? "Til politiet" : "Til sælger",
              u.givetTil,
              v(u.journalnummer),
              v(u.af),
            ]),
          },
        ],
      });
    }
  }

  const dannetIso = dannet.toISOString();
  return {
    udgave,
    titel: UDGAVE_NAVN[udgave],
    dannetKl: dannetIso,
    forside: [
      ["Vare", v(d.auktion?.titel)],
      ["Handlens id", d.handel.id],
      ["Sagens id", d.sag.id],
      ["Sagstype", typeNavn(d.sag.type)],
      ["Lavet", tid(dannetIso)],
    ],
    indledning:
      udgave === "politi"
        ? [
            "Denne udgave indeholder personoplysninger om begge parter (MitID-verificering, e-mail og telefon) og udleveres kun til politiet efter anmodning, eller når BidHamr selv anmelder forholdet.",
            "Oplysningerne er trukket direkte fra BidHamrs systemer på tidspunktet ovenfor. Billederne er indlejret, så dokumentet kan læses uden login.",
          ]
        : [
            "Denne dokumentation indeholder de oplysninger om handlen og sagen, som sælgeren i forvejen har adgang til. Den kan vedlægges en anmeldelse til politiet på politi.dk.",
            "Oplysningerne er trukket direkte fra BidHamrs systemer på tidspunktet ovenfor. Billederne er indlejret, så dokumentet kan læses uden login.",
          ],
    afsnit,
    afslutning:
      udgave === "politi"
        ? [
            "BidHamr kan efter anmodning fra politiet levere yderligere oplysninger, fx log over login og enheder, betalingsoplysninger fra vores betalingspartner Stripe og oplysninger fra fragtfirmaet.",
            `Kontakt: ${FIRMA.navn}, CVR ${FIRMA.cvr}, ${FIRMA_ADRESSE} · ${FIRMA.email}. Oplys sagens id ved henvendelse.`,
          ]
        : [
            `Spørgsmål til dokumentationen: ${FIRMA.navn}, CVR ${FIRMA.cvr} · ${FIRMA.email}. Oplys sagens id ved henvendelse.`,
          ],
  };
}

// Al tekst i modellen (til tests).
export function dokumentTekst(dok: Dokument): string {
  const dele: string[] = [dok.titel, ...dok.forside.flat(), ...dok.indledning, ...dok.afslutning];
  for (const a of dok.afsnit) {
    dele.push(a.titel);
    for (const b of a.blokke) {
      if (b.slags === "felter") dele.push(...b.raekker.flat());
      else if (b.slags === "tabel") dele.push(...b.hoved, ...b.raekker.flat());
      else if (b.slags === "billeder") dele.push(...b.billeder.map((x) => x.tekst));
      else dele.push(b.tekst);
    }
  }
  return dele.join("\n");
}

