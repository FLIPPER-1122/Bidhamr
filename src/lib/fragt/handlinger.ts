import "server-only";

// Fragt-handlinger for en verificeret bruger. Fælles for hjemmesidens server
// actions (src/app/actions/fragt.ts) og appens API (/api/fragt/app/[handling]).
// brugerId SKAL være verificeret med auth af kalderen (cookie-session eller
// Bearer-token) - aldrig fra klientens krop. Databasen tjekker igen under lås.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { fragtLabelsAktiv } from "@/lib/fragt";
import {
  type AdresseInput,
  type Fragtpris,
  type LeveringsvalgInput,
  FRAGT_LABEL_BUCKET,
  annullerUdgaaendeForsendelse,
  gemLeveringsvalg,
  hentFragtpriser,
  opretReturForsendelse,
  opretUdgaaendeForsendelse,
  soegPakkeshops,
} from "@/lib/fragt/server";
import { SPORINGS_NAVN, type SporingsType } from "@/lib/fragt/types";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IKKE_AKTIV = "Fragtlabels er ikke slået til endnu.";
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

type Fejl = { fejl: string };

type Handel = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  status: string;
  afhentning: boolean | null;
};

async function hentHandel(tradeId: unknown, brugerId: string): Promise<Handel | null> {
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) return null;
  const { data } = await createAdminClient()
    .from("trades")
    .select("id, auction_id, seller_id, buyer_id, status, afhentning")
    .eq("id", tradeId)
    .maybeSingle<Handel>();
  if (!data || (data.buyer_id !== brugerId && data.seller_id !== brugerId)) return null;
  return data;
}

// ------------------------------------------------------------ priser og pakkeshops

export async function fragtpriser(): Promise<{ ok: true; priser: Fragtpris[] } | Fejl> {
  try {
    return { ok: true, priser: await hentFragtpriser() };
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: priser", fejl: err });
    return { fejl: GENERISK };
  }
}

export { soegPakkeshops };

// ------------------------------------------------------------ checkout (køber)

export type Checkout = {
  tradeId: string;
  // true = afhentning hos sælger: intet leveringsvalg, betal direkte.
  afhentning: boolean;
  pakkestoerrelse: string | null;
  // Købers fragt (inkl. moms, øre) pr. leveringsmåde. doerOere null = ikke muligt.
  pakkeshopOere: number | null;
  doerOere: number | null;
  valgt: {
    maade: "pakkeshop" | "doer";
    pakkeshopId: string | null;
    pakkeshopNavn: string | null;
    pakkeshopAdresse: string | null;
    pakkeshopPostnummer: string | null;
    pakkeshopBy: string | null;
    modtager: { navn: string; adresse: string | null; postnummer: string | null; by: string | null; telefon: string };
    fragtOere: number;
  } | null;
  // Forudfyldning fra sidste køb (kun køberens egne data).
  forslag: {
    maade: string | null;
    pakkeshopId: string | null;
    pakkeshopNavn: string | null;
    pakkeshopAdresse: string | null;
    pakkeshopPostnummer: string | null;
    pakkeshopBy: string | null;
    modtager: { navn: string | null; adresse: string | null; postnummer: string | null; by: string | null; telefon: string | null };
  } | null;
  betaling: {
    status: string;
    bud_oere: number;
    koebergebyr_oere: number;
    beskyttelse_oere: number;
    fragt_oere: number;
    total_oere: number;
    // Leveringsmåden kan ændre prisen (afventer betaling uden charge).
    kanAendrePris: boolean;
  } | null;
  // Sælgeren har lavet fragtlabelen - valget kan ikke ændres.
  labelLavet: boolean;
};

export async function hentCheckout(tradeId: unknown, brugerId: string): Promise<{ ok: true; checkout: Checkout } | Fejl> {
  const h = await hentHandel(tradeId, brugerId);
  if (!h || h.buyer_id !== brugerId) return { fejl: "Handlen findes ikke." };
  const admin = createAdminClient();
  const [a, b, l, f, forslag] = await Promise.all([
    admin.from("auctions").select("pakkestoerrelse, fragt_pakkeshop_oere, fragt_doer_oere").eq("id", h.auction_id).maybeSingle(),
    admin
      .from("betalinger")
      .select("status, bud_oere, koebergebyr_oere, beskyttelse_oere, fragt_oere, total_oere, stripe_charge_id")
      .eq("trade_id", h.id)
      .maybeSingle(),
    admin
      .from("handel_levering")
      .select("maade, pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by, modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, fragt_oere")
      .eq("trade_id", h.id)
      .maybeSingle(),
    admin
      .from("forsendelser")
      .select("id")
      .eq("trade_id", h.id)
      .eq("type", "udgaaende")
      .not("status", "in", "(annulleret,fejlet)")
      .limit(1),
    admin.from("leveringsforslag").select("*").eq("user_id", brugerId).maybeSingle(),
  ]);
  if (a.error || b.error || l.error || f.error || forslag.error) {
    await logDriftFejl({
      kilde: "server",
      hvor: "Fragt: checkout",
      fejl: a.error ?? b.error ?? l.error ?? f.error ?? forslag.error,
    });
    return { fejl: GENERISK };
  }
  const bet = b.data;
  const lev = l.data;
  const fs = forslag.data;
  return {
    ok: true,
    checkout: {
      tradeId: h.id,
      afhentning: Boolean(h.afhentning) || Number(bet?.fragt_oere ?? 0) === 0,
      pakkestoerrelse: a.data?.pakkestoerrelse ?? null,
      pakkeshopOere: a.data?.fragt_pakkeshop_oere ?? null,
      doerOere: a.data?.fragt_doer_oere ?? null,
      valgt: lev
        ? {
            maade: lev.maade,
            pakkeshopId: lev.pakkeshop_id,
            pakkeshopNavn: lev.pakkeshop_navn,
            pakkeshopAdresse: lev.pakkeshop_adresse,
            pakkeshopPostnummer: lev.pakkeshop_postnummer,
            pakkeshopBy: lev.pakkeshop_by,
            modtager: {
              navn: lev.modtager_navn,
              adresse: lev.modtager_adresse,
              postnummer: lev.modtager_postnummer,
              by: lev.modtager_by,
              telefon: lev.modtager_telefon,
            },
            fragtOere: Number(lev.fragt_oere),
          }
        : null,
      forslag: fs
        ? {
            maade: fs.maade,
            pakkeshopId: fs.pakkeshop_id,
            pakkeshopNavn: fs.pakkeshop_navn,
            pakkeshopAdresse: fs.pakkeshop_adresse,
            pakkeshopPostnummer: fs.pakkeshop_postnummer,
            pakkeshopBy: fs.pakkeshop_by,
            modtager: {
              navn: fs.modtager_navn,
              adresse: fs.modtager_adresse,
              postnummer: fs.modtager_postnummer,
              by: fs.modtager_by,
              telefon: fs.modtager_telefon,
            },
          }
        : null,
      betaling: bet
        ? {
            status: bet.status,
            bud_oere: Number(bet.bud_oere),
            koebergebyr_oere: Number(bet.koebergebyr_oere),
            beskyttelse_oere: Number(bet.beskyttelse_oere),
            fragt_oere: Number(bet.fragt_oere),
            total_oere: Number(bet.total_oere),
            kanAendrePris: bet.status === "afventer" && !bet.stripe_charge_id && h.status === "afventer_betaling",
          }
        : null,
      labelLavet: (f.data ?? []).length > 0,
    },
  };
}

export async function gemLevering(
  tradeId: unknown,
  brugerId: string,
  input: LeveringsvalgInput,
): Promise<{ ok: true; fragtOere: number; totalOere: number; prisAendret: boolean } | Fejl> {
  const h = await hentHandel(tradeId, brugerId);
  if (!h || h.buyer_id !== brugerId) return { fejl: "Handlen findes ikke." };
  return gemLeveringsvalg(h.id, brugerId, input);
}

// ------------------------------------------------------------ fragtlabel (sælger)

async function afsenderForslag(brugerId: string): Promise<AdresseInput | null> {
  const { data } = await createAdminClient()
    .from("leveringsforslag")
    .select("afsender_navn, afsender_adresse, afsender_postnummer, afsender_by, afsender_telefon")
    .eq("user_id", brugerId)
    .maybeSingle();
  if (!data?.afsender_adresse) return null;
  return {
    navn: data.afsender_navn,
    adresse: data.afsender_adresse,
    postnummer: data.afsender_postnummer,
    by: data.afsender_by,
    telefon: data.afsender_telefon,
  };
}

// "Send pakke": opretter fragtlabelen hos fragtfirmaet. Uden afsender bruges
// sælgerens sidst brugte afsenderadresse.
export async function bookPakke(
  tradeId: unknown,
  brugerId: string,
  afsender: AdresseInput | null | undefined,
): Promise<{ ok: true; forsendelseId: string } | Fejl> {
  if (!fragtLabelsAktiv()) return { fejl: IKKE_AKTIV };
  const h = await hentHandel(tradeId, brugerId);
  if (!h) return { fejl: "Handlen findes ikke." };
  if (h.seller_id !== brugerId) return { fejl: "Kun sælgeren kan lave en fragtlabel." };
  if (h.afhentning) return { fejl: "Handlen er en afhentning - der skal ikke laves fragtlabel." };
  if (h.status !== "betaling_modtaget") {
    return { fejl: "Der kan kun laves fragtlabel, når køberen har betalt, og pakken ikke er sendt." };
  }
  const afs = afsender && typeof afsender === "object" ? afsender : await afsenderForslag(brugerId);
  if (!afs) return { fejl: "Udfyld din adresse, før du laver fragtlabelen." };
  return opretUdgaaendeForsendelse(h.id, brugerId, afs);
}

export async function annullerPakke(
  tradeId: unknown,
  forsendelseId: unknown,
  brugerId: string,
): Promise<{ ok: true } | Fejl> {
  if (!fragtLabelsAktiv()) return { fejl: IKKE_AKTIV };
  if (typeof forsendelseId !== "string" || !UUID.test(forsendelseId)) return { fejl: "Fragtlabelen findes ikke." };
  const h = await hentHandel(tradeId, brugerId);
  if (!h || h.seller_id !== brugerId) return { fejl: "Fragtlabelen findes ikke." };
  const { data: f } = await createAdminClient()
    .from("forsendelser")
    .select("trade_id")
    .eq("id", forsendelseId)
    .maybeSingle<{ trade_id: string }>();
  if (!f || f.trade_id !== h.id) return { fejl: "Fragtlabelen findes ikke." };
  return annullerUdgaaendeForsendelse(forsendelseId, brugerId);
}

export async function lavReturlabel(
  tradeId: unknown,
  brugerId: string,
  afsender: AdresseInput | null | undefined,
): Promise<{ ok: true; forsendelseId: string } | Fejl> {
  const h = await hentHandel(tradeId, brugerId);
  if (!h || h.buyer_id !== brugerId) return { fejl: "Handlen findes ikke." };
  return opretReturForsendelse(h.id, brugerId, afsender ?? {});
}

// ------------------------------------------------------------ forsendelse, label, sporing

export type ForsendelseVisning = {
  id: string;
  type: "udgaaende" | "retur";
  status: string;
  levering: string | null;
  pakkestoerrelse: string;
  sporingsnummer: string | null;
  // Kun til den part, der skal sende pakken (sælgeren for udgående, køberen
  // for retur): labelen kan hentes, og labelfri-koden (DAO) vises.
  harLabel: boolean;
  labelfriKode: string | null;
  oprettetKl: string;
  afleveretKl: string | null;
  klarTilAfhentningKl: string | null;
  leveretKl: string | null;
  returneretKl: string | null;
  annulleretKl: string | null;
  haendelser: { type: SporingsType; navn: string; tidspunkt: string; beskrivelse: string | null }[];
};

const SKJULT_LABEL = ["opretter", "annulleres", "annulleret", "fejlet"];

function maaSeLabel(type: string, h: Handel, brugerId: string, status: string): boolean {
  if (SKJULT_LABEL.includes(status)) return false;
  return (type === "udgaaende" && h.seller_id === brugerId) || (type === "retur" && h.buyer_id === brugerId);
}

// Handlens forsendelser (udgående og retur, nyeste først, uden fejlede) med
// sporingstidslinje. Køber og sælger.
export async function hentForsendelser(
  tradeId: unknown,
  brugerId: string,
): Promise<{ ok: true; forsendelser: ForsendelseVisning[] } | Fejl> {
  const h = await hentHandel(tradeId, brugerId);
  if (!h) return { fejl: "Handlen findes ikke." };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("forsendelser")
    .select(
      "id, type, status, levering, pakkestoerrelse, sporingsnummer, label_sti, qr_kode, oprettet_kl, afleveret_kl, klar_til_afhentning_kl, leveret_kl, returneret_kl, annulleret_kl",
    )
    .eq("trade_id", h.id)
    .neq("status", "fejlet")
    .order("oprettet_kl", { ascending: false })
    .limit(10);
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: hent forsendelser", fejl: error });
    return { fejl: GENERISK };
  }
  const ids = (data ?? []).map((f) => f.id as string);
  const { data: hs } = ids.length
    ? await admin
        .from("forsendelse_haendelser")
        .select("forsendelse_id, type, tidspunkt, beskrivelse")
        .in("forsendelse_id", ids)
        .order("tidspunkt", { ascending: true })
        .limit(500)
    : { data: [] as { forsendelse_id: string; type: string; tidspunkt: string; beskrivelse: string | null }[] };
  return {
    ok: true,
    forsendelser: (data ?? []).map((f) => {
      const maa = maaSeLabel(f.type, h, brugerId, f.status);
      return {
        id: f.id,
        type: f.type,
        status: f.status,
        levering: f.levering,
        pakkestoerrelse: f.pakkestoerrelse,
        sporingsnummer: f.sporingsnummer,
        harLabel: maa && Boolean(f.label_sti),
        labelfriKode: maa ? f.qr_kode : null,
        oprettetKl: f.oprettet_kl,
        afleveretKl: f.afleveret_kl,
        klarTilAfhentningKl: f.klar_til_afhentning_kl,
        leveretKl: f.leveret_kl,
        returneretKl: f.returneret_kl,
        annulleretKl: f.annulleret_kl,
        haendelser: (hs ?? [])
          .filter((x) => x.forsendelse_id === f.id)
          .map((x) => ({
            type: x.type as SporingsType,
            navn: SPORINGS_NAVN[x.type as SporingsType] ?? x.type,
            tidspunkt: x.tidspunkt,
            beskrivelse: x.beskrivelse,
          })),
      };
    }),
  };
}

// Kortlivet link (5 min) til label-PDF'en - kun til den rette part.
export async function hentLabelLink(
  forsendelseId: unknown,
  brugerId: string,
): Promise<{ ok: true; url: string } | Fejl> {
  if (typeof forsendelseId !== "string" || !UUID.test(forsendelseId)) return { fejl: "Fragtlabelen findes ikke." };
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("trade_id, type, status, label_sti")
    .eq("id", forsendelseId)
    .maybeSingle<{ trade_id: string; type: string; status: string; label_sti: string | null }>();
  if (!f?.label_sti) return { fejl: "Fragtlabelen findes ikke." };
  const h = await hentHandel(f.trade_id, brugerId);
  if (!h || !maaSeLabel(f.type, h, brugerId, f.status)) return { fejl: "Fragtlabelen findes ikke." };
  const { data, error } = await admin.storage.from(FRAGT_LABEL_BUCKET).createSignedUrl(f.label_sti, 300);
  if (error || !data?.signedUrl) return { fejl: "Fragtlabelen kunne ikke hentes." };
  return { ok: true, url: data.signedUrl };
}
