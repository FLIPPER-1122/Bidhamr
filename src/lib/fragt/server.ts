import "server-only";

// Fragt på serveren: oprettelse/annullering af labels, registrering af
// sporingshændelser og sporings-cron. Bruger service-role (createAdminClient)
// - kaldere SKAL selv have verificeret brugeren med auth først.
//
// Hændelser -> handelsflow (ROADMAP-BESLUTNINGER, "Pakken er kommet frem" og
// "48-timers uret"):
//   afleveret  Handlen flyttes IKKE til 'pakke_sendt' automatisk:
//              pakkebillederne er stadig krævet fra sælgeren, og
//              trade_marker_sendt kræver auth.uid() = sælgeren. Står handlen
//              stadig i 'betaling_modtaget', får sælgeren en påmindelse om at
//              markere pakken sendt med billeder.
//   leveret    Køberen får "Pakken er kommet frem" (pakke_leveret, idempotent
//              nøgle). Ingen penge frigives, og 48-timers uret startes IKKE -
//              det gør stadig køberens "modtaget" / den eksisterende
//              automatiske frigivelse, indtil Filip beslutter andet.
//   returneret Markeres til staff (kraever_opmaerksomhed, sat i SQL).
//   fejl       Markeres til staff.
// Ingen pengeflytning her.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { adapterFor, fragtErSatOp, hentFragtfirma } from "@/lib/fragt";
import {
  type Adresse,
  type Label,
  type Pakkestoerrelse,
  type Sporingshaendelse,
  FragtFejl,
  FRAGT_IKKE_SAT_OP,
  erSporingsType,
} from "@/lib/fragt/types";

export const FRAGT_LABEL_BUCKET = "fragt-labels";
const LABEL_MAKS_BYTES = 5 * 1024 * 1024;

type Admin = ReturnType<typeof createAdminClient>;

export type HaendelseKilde = "webhook" | "sporing" | "test";

const GENERISK_FEJL = "Noget gik galt. Prøv igen om lidt.";

const CLAIM_FEJL: Record<string, string> = {
  ikke_fundet: "Handlen findes ikke.",
  afhentning: "Handlen er en afhentning - der skal ikke laves fragtlabel.",
  forkert_status: "Der kan kun laves fragtlabel, når køberen har betalt, og pakken ikke er sendt.",
  ingen_retur: "Der er ingen sag, hvor varen skal sendes retur.",
  i_gang: "Fragtlabelen er ved at blive lavet. Vent et øjeblik, og opdatér siden.",
  ugyldig: "Ugyldigt valg.",
};

function brugerFejl(err: unknown): string {
  return err instanceof FragtFejl ? err.brugerbesked : GENERISK_FEJL;
}

async function medTimeout<T>(p: Promise<T>, ms: number, hvad: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, afvis) => {
        timer = setTimeout(() => afvis(new Error(`${hvad}: timeout efter ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function labelBytes(label: Label): Promise<Uint8Array> {
  if (label.type === "pdf") return label.data;
  // Fragtfirmaets link kan udløbe - hent og gem i vores egen bucket.
  if (!label.url.startsWith("https://")) throw new Error("Label-URL er ikke https");
  const svar = await fetch(label.url, { signal: AbortSignal.timeout(15_000) });
  if (!svar.ok) throw new Error(`Label kunne ikke hentes (${svar.status})`);
  const buf = new Uint8Array(await svar.arrayBuffer());
  if (buf.byteLength > LABEL_MAKS_BYTES) throw new Error("Labelen er for stor");
  return buf;
}

type BrugerAdresse = { navn: string | null; adresse: string | null; email: string | null; telefon: string | null };

async function hentAdresse(admin: Admin, brugerId: string): Promise<Adresse> {
  const { data } = await admin
    .from("users")
    .select("navn, adresse, email, telefon")
    .eq("id", brugerId)
    .maybeSingle<BrugerAdresse>();
  // TODO(fragt): rigtige adressefelter (postnummer/by) og køberens pakkeshop,
  // før et rigtigt fragtfirma kobles på. Indtil da bruges den frie adresse.
  return {
    navn: data?.navn?.trim() || "BidHamr-bruger",
    adresse: data?.adresse ?? null,
    email: data?.email ?? null,
    telefon: data?.telefon ?? null,
    land: "DK",
  };
}

// ------------------------------------------------------------ oprettelse

// Laver en udgående fragtlabel for sælgeren. saelgerId SKAL være verificeret
// med auth af kalderen; SQL'en tjekker igen under lås, at han er sælger, at
// handlen er en betalt forsendelseshandel, og at der ikke allerede er en
// aktiv label (dobbeltklik giver samme label).
export async function opretUdgaaendeForsendelse(
  tradeId: string,
  saelgerId: string,
  pakkestoerrelse: Pakkestoerrelse,
): Promise<{ ok: true; forsendelseId: string } | { fejl: string }> {
  if (!fragtErSatOp()) return { fejl: FRAGT_IKKE_SAT_OP };
  const firma = hentFragtfirma();
  const admin = createAdminClient();

  const { data: claim, error: claimFejl } = await admin.rpc("forsendelse_claim", {
    p_trade: tradeId,
    p_bruger: saelgerId,
    p_type: "udgaaende",
    p_fragtfirma: firma.navn,
    p_pakkestoerrelse: pakkestoerrelse,
  });
  if (claimFejl) {
    console.error("forsendelse_claim fejlede:", claimFejl.message);
    return { fejl: GENERISK_FEJL };
  }
  const svar = claim as { kode?: string; id?: string } | null;
  if (svar?.kode === "findes" && svar.id) return { ok: true, forsendelseId: svar.id };
  if (svar?.kode !== "ok" || !svar.id) {
    return { fejl: CLAIM_FEJL[svar?.kode ?? ""] ?? GENERISK_FEJL };
  }
  const id = svar.id;

  let oprettetHosFirma: string | null = null;
  try {
    const { data: handel } = await admin
      .from("trades")
      .select("id, auction_id, buyer_id, seller_id")
      .eq("id", tradeId)
      .single<{ id: string; auction_id: string; buyer_id: string; seller_id: string }>();
    if (!handel) throw new Error("Handlen findes ikke");
    const { data: auktion } = await admin
      .from("auctions")
      .select("titel")
      .eq("id", handel.auction_id)
      .maybeSingle<{ titel: string | null }>();

    const [afsender, modtager] = await Promise.all([
      hentAdresse(admin, handel.seller_id),
      hentAdresse(admin, handel.buyer_id),
    ]);

    const oprettet = await medTimeout(
      firma.opretForsendelse({
        reference: id,
        handel: { id: tradeId, titel: auktion?.titel ?? "Vare fra BidHamr" },
        afsender,
        modtager,
        pakkestoerrelse,
      }),
      30_000,
      "opretForsendelse",
    );
    oprettetHosFirma = oprettet.forsendelsesId;

    const bytes = await labelBytes(oprettet.label);
    const sti = `${tradeId}/${id}.pdf`;
    const { error: upFejl } = await admin.storage
      .from(FRAGT_LABEL_BUCKET)
      .upload(sti, bytes, { contentType: "application/pdf", upsert: false });
    if (upFejl && !/exists|duplicate/i.test(upFejl.message)) {
      throw new Error(`Label kunne ikke gemmes: ${upFejl.message}`);
    }

    const { data: gemt, error: gemFejl } = await admin.rpc("forsendelse_gem_oprettet", {
      p_id: id,
      p_forsendelses_id: oprettet.forsendelsesId,
      p_sporingsnummer: oprettet.sporingsnummer,
      p_label_sti: sti,
      p_qr_kode: oprettet.qrKode ?? null,
      p_pris_oere: oprettet.prisOere ?? null,
    });
    if (gemFejl) throw new Error(`forsendelse_gem_oprettet: ${gemFejl.message}`);
    if (!gemt) throw new Error("Forsendelsen var ikke længere claimet");
  } catch (err) {
    console.error("Fragtlabel kunne ikke laves:", err);
    await admin.rpc("forsendelse_marker_fejlet", { p_id: id, p_fejl: renFejltekst(err, 500) });
    // Blev forsendelsen oprettet hos fragtfirmaet, så annullér den igen,
    // så der ikke ligger en betalt label, som ingen kan se.
    if (oprettetHosFirma) {
      try {
        await firma.annullerForsendelse(oprettetHosFirma);
      } catch (annErr) {
        await logDriftFejl({ kilde: "server", hvor: "Fragt: annullér efter fejl", fejl: annErr });
      }
    }
    if (!(err instanceof FragtFejl)) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: opret label", fejl: err });
    }
    return { fejl: brugerFejl(err) };
  }

  // Første hændelse (oprettet) - giver en tidslinje fra start. Labelen er
  // gemt, så en fejl her må ikke annullere den.
  try {
    await registrerForsendelseshaendelse(id, {
      type: "oprettet",
      tidspunkt: new Date().toISOString(),
      noegle: "bidhamr:oprettet",
      beskrivelse: "Fragtlabel oprettet",
    }, "sporing");
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: oprettet-hændelse", fejl: err });
  }
  return { ok: true, forsendelseId: id };
}

// Annullerer en udgående label, før pakken er afleveret. saelgerId SKAL være
// verificeret med auth af kalderen.
export async function annullerUdgaaendeForsendelse(
  forsendelseId: string,
  saelgerId: string,
): Promise<{ ok: true } | { fejl: string }> {
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("id, trade_id, type, fragtfirma, status, forsendelses_id")
    .eq("id", forsendelseId)
    .maybeSingle<{ id: string; trade_id: string; type: string; fragtfirma: string; status: string; forsendelses_id: string | null }>();
  if (!f || f.type !== "udgaaende") return { fejl: "Fragtlabelen findes ikke." };
  const { data: t } = await admin
    .from("trades")
    .select("seller_id")
    .eq("id", f.trade_id)
    .maybeSingle<{ seller_id: string }>();
  if (!t || t.seller_id !== saelgerId) return { fejl: "Fragtlabelen findes ikke." };
  if (f.status !== "oprettet" || !f.forsendelses_id) {
    return { fejl: "Labelen kan ikke annulleres, når pakken er afleveret." };
  }
  const adapter = adapterFor(f.fragtfirma);
  if (!adapter) return { fejl: FRAGT_IKKE_SAT_OP };
  try {
    await medTimeout(adapter.annullerForsendelse(f.forsendelses_id), 20_000, "annullerForsendelse");
  } catch (err) {
    if (!(err instanceof FragtFejl)) {
      await logDriftFejl({ kilde: "server", hvor: "Fragt: annullér label", fejl: err });
    }
    return { fejl: brugerFejl(err) };
  }
  const { data: kode, error } = await admin.rpc("forsendelse_annuller", {
    p_id: forsendelseId,
    p_bruger: saelgerId,
  });
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: forsendelse_annuller", fejl: error });
    return { fejl: GENERISK_FEJL };
  }
  if (kode !== "ok") return { fejl: "Labelen kan ikke annulleres, når pakken er afleveret." };
  return { ok: true };
}

// ------------------------------------------------------------ hændelser

// Gemmer en hændelse idempotent (samme nøgle = ingen ny række) og udfører
// derefter handelseffekterne (beskeder/markeringer). Kaster ved databasefejl.
export async function registrerForsendelseshaendelse(
  forsendelseId: string,
  h: Sporingshaendelse,
  kilde: HaendelseKilde,
): Promise<{ ny: boolean }> {
  if (!erSporingsType(h.type)) throw new Error(`Ukendt hændelsestype: ${String(h.type)}`);
  const tid = Number.isNaN(Date.parse(h.tidspunkt)) ? new Date().toISOString() : h.tidspunkt;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("forsendelse_registrer_haendelse", {
    p_forsendelse: forsendelseId,
    p_type: h.type,
    p_tidspunkt: tid,
    p_noegle: h.noegle.slice(0, 200),
    p_beskrivelse: h.beskrivelse?.slice(0, 300) ?? null,
    p_raa: h.raa ?? null,
    p_kilde: kilde,
  });
  if (error) throw new Error(`forsendelse_registrer_haendelse: ${error.message}`);
  const ny = Boolean((data as { ny?: boolean } | null)?.ny);
  if (ny) await udfoerHandelseffekter(admin, forsendelseId);
  return { ny };
}

type ForsendelseFuld = {
  id: string;
  trade_id: string;
  type: "udgaaende" | "retur";
  status: string;
  sporingsnummer: string | null;
  afleveret_kl: string | null;
  leveret_kl: string | null;
  afleveret_besked_kl: string | null;
  leveret_besked_kl: string | null;
};

// Beskeder ud fra forsendelsens tilstand. Idempotent: hver besked har en
// fast nøgle, og *_besked_kl sættes bagefter, så cron kan prøve igen, hvis
// serveren døde imellem. Kaster aldrig.
async function udfoerHandelseffekter(admin: Admin, forsendelseId: string): Promise<number> {
  let sendt = 0;
  try {
    const { data: f } = await admin
      .from("forsendelser")
      .select("id, trade_id, type, status, sporingsnummer, afleveret_kl, leveret_kl, afleveret_besked_kl, leveret_besked_kl")
      .eq("id", forsendelseId)
      .maybeSingle<ForsendelseFuld>();
    if (!f || f.type !== "udgaaende") return 0;
    if (["opretter", "annulleret", "fejlet"].includes(f.status)) return 0;
    const mangler =
      (f.afleveret_kl && !f.afleveret_besked_kl) || (f.leveret_kl && !f.leveret_besked_kl);
    if (!mangler) return 0;

    const { data: t } = await admin
      .from("trades")
      .select("id, auction_id, buyer_id, seller_id, status")
      .eq("id", f.trade_id)
      .maybeSingle<{ id: string; auction_id: string; buyer_id: string; seller_id: string; status: string }>();
    if (!t) return 0;
    const { data: a } = await admin
      .from("auctions")
      .select("titel")
      .eq("id", t.auction_id)
      .maybeSingle<{ titel: string | null }>();
    const titel = a?.titel ?? "din vare";
    const link = `/mine-handler/${t.id}`;

    // Pakken er indleveret, men sælgeren har ikke markeret den sendt.
    if (f.afleveret_kl && !f.afleveret_besked_kl) {
      if (t.status === "betaling_modtaget") {
        await send(t.seller_id, "betaling_modtaget", {
          titel: "Pakken er indleveret",
          tekst: `Fragtfirmaet har modtaget pakken med "${titel}". Har du ikke allerede gjort det, så markér pakken sendt med de to pakkebilleder på handelssiden - ellers bliver handlen annulleret, når fristen for afsendelse udløber.`,
          link,
          data: { trade_id: t.id },
          noegle: `fragt_afleveret:${f.id}`,
        });
        sendt++;
      }
      await admin.rpc("forsendelse_marker_besked", { p_id: f.id, p_felt: "afleveret", p_note: null });
    }

    // Pakken er kommet frem. Ingen penge flyttes, og 48-timers uret startes
    // ikke - køberen trykker stadig "modtaget".
    if (f.leveret_kl && !f.leveret_besked_kl) {
      let note: string | null = null;
      if (t.status === "betaling_modtaget" || t.status === "pakke_sendt") {
        await send(t.buyer_id, "pakke_leveret", {
          titel: "Pakken er kommet frem",
          tekst:
            t.status === "pakke_sendt"
              ? `Fragtfirmaet melder, at "${titel}" er leveret. Tryk "Jeg har modtaget pakken" på handelssiden, når du har den, og tjek varen.`
              : `Fragtfirmaet melder, at "${titel}" er leveret. Tjek varen, når du har den.`,
          link,
          data: { trade_id: t.id },
          noegle: `fragt_leveret:${t.id}`,
        });
        sendt++;
        if (t.status === "betaling_modtaget") {
          note = "Fragtfirmaet melder pakken leveret, men sælgeren har ikke markeret den sendt med pakkebilleder.";
        }
      } else if (t.status === "annulleret") {
        note = "Fragtfirmaet melder pakken leveret, men handlen er annulleret. Tjek handlen og pengene.";
      }
      await admin.rpc("forsendelse_marker_besked", { p_id: f.id, p_felt: "leveret", p_note: note });
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Fragt: handelseffekter", fejl: err });
  }
  return sendt;
}

// Finder BidHamrs forsendelse ud fra fragtfirmaets id eller sporingsnummer.
export async function findForsendelse(
  fragtfirma: string,
  ref: { forsendelsesId?: string | null; sporingsnummer?: string | null },
): Promise<string | null> {
  const admin = createAdminClient();
  if (ref.forsendelsesId) {
    const { data } = await admin
      .from("forsendelser")
      .select("id")
      .eq("fragtfirma", fragtfirma)
      .eq("forsendelses_id", ref.forsendelsesId)
      .maybeSingle<{ id: string }>();
    if (data) return data.id;
  }
  if (ref.sporingsnummer) {
    // Nyeste først: en annulleret label og en ny kan i teorien dele nummer.
    const { data } = await admin
      .from("forsendelser")
      .select("id")
      .eq("fragtfirma", fragtfirma)
      .eq("sporingsnummer", ref.sporingsnummer)
      .order("oprettet_kl", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0].id as string;
  }
  return null;
}

// ------------------------------------------------------------ cron

const POLL_INTERVAL_MIN = 20;
const POLL_MAKS = 20;
const CRON_BUDGET_MS = 25_000;

// Henter sporing for aktive forsendelser (højst 20 pr. kørsel, hver højst hvert
// 20. minut) og sender beskeder, der mangler. Let og begrænset - kaldes fra
// betalings-cron-ruten. Kaster aldrig.
export async function koerFragtCron(): Promise<{
  sporet: number;
  nyeHaendelser: number;
  beskeder: number;
  fejl: number;
}> {
  const r = { sporet: 0, nyeHaendelser: 0, beskeder: 0, fejl: 0 };
  const start = Date.now();
  const admin = createAdminClient();

  const graense = new Date(Date.now() - POLL_INTERVAL_MIN * 60_000).toISOString();
  const aeldst = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString();
  const { data: aktive, error } = await admin
    .from("forsendelser")
    .select("id, fragtfirma, sporingsnummer")
    .in("status", ["oprettet", "afleveret", "i_transit", "klar_til_afhentning"])
    .gte("oprettet_kl", aeldst)
    .or(`sidst_polled_kl.is.null,sidst_polled_kl.lt.${graense}`)
    .order("sidst_polled_kl", { ascending: true, nullsFirst: true })
    .limit(POLL_MAKS);
  if (error) {
    r.fejl++;
    await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: hent aktive", fejl: error });
    return r;
  }

  for (const f of aktive ?? []) {
    if (Date.now() - start > CRON_BUDGET_MS) break;
    // Markér altid som hentet, så en fejlende forsendelse ikke blokerer køen.
    await admin
      .from("forsendelser")
      .update({ sidst_polled_kl: new Date().toISOString() })
      .eq("id", f.id);
    const adapter = adapterFor(f.fragtfirma as string);
    if (!adapter || !f.sporingsnummer) continue;
    try {
      const haendelser = await medTimeout(
        adapter.hentSporing(f.sporingsnummer as string),
        10_000,
        "hentSporing",
      );
      r.sporet++;
      for (const h of haendelser.slice(0, 100)) {
        const { ny } = await registrerForsendelseshaendelse(f.id as string, h, "sporing");
        if (ny) r.nyeHaendelser++;
      }
    } catch (err) {
      r.fejl++;
      if (!(err instanceof FragtFejl)) {
        await logDriftFejl({ kilde: "cron", sti: "fragt", hvor: "Fragt: hent sporing", fejl: err });
      }
    }
  }

  // Beskeder, der mangler (fx serveren døde mellem hændelse og besked).
  if (Date.now() - start < CRON_BUDGET_MS) {
    const { data: mangler } = await admin
      .from("forsendelser")
      .select("id")
      .eq("type", "udgaaende")
      .not("status", "in", "(opretter,annulleret,fejlet)")
      .or(
        "and(afleveret_kl.not.is.null,afleveret_besked_kl.is.null)," +
          "and(leveret_kl.not.is.null,leveret_besked_kl.is.null)",
      )
      .limit(20);
    for (const m of mangler ?? []) {
      if (Date.now() - start > CRON_BUDGET_MS) break;
      r.beskeder += await udfoerHandelseffekter(admin, m.id as string);
    }
  }

  return r;
}
