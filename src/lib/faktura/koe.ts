import "server-only";

// Fakturakøen (betalings-cron'en, src/lib/betaling/cron.ts). Se docs/FAKTURA.md.
//
//   1. faktura_planlaeg(): opretter de fakturaer, kreditnotaer og
//      abonnementsbilag, der mangler (idempotent, i databasen).
//   2. Dinero sat op? (konfig.ts - test/live-vagt). Ellers stop; drift-
//      alarm, hvis der står dokumenter og venter.
//   3. faktura_claim(): op til 8 dokumenter med lås; hvert behandles trin for
//      trin (proces.ts). Fejl: spredte forsøg (5, 10, 20, 40 min) og
//      "opgivet" + drift-alarm efter 5 fejl (som refusionskøen). Fejl, der
//      ikke går over af sig selv (fx Dinero afviser et CVR-nummer), stopper
//      dokumentet til staff (Admin -> Fakturaer). Dineros grænse (60 kald i
//      minuttet) bruger ikke et forsøg.
//
// Kaster aldrig for et enkelt dokument; kun hvis planlægningen fejler.

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { DineroFejl, lavDineroKlient, type DineroKlient, type DineroKontaktModel } from "./dinero";
import { hentFakturaKonfig } from "./konfig";
import {
  behandlDokument,
  type FakturaKontekst,
  type FakturaRaekke,
  type Fremskridt,
  type ProcesDeps,
} from "./proces";

const PR_KOERSEL = 8;
// BidHamrs CVR - live-regnskabet i Dinero skal have det (ROADMAP-BESLUTNINGER
// "Virksomhedsoplysninger").
const BIDHAMR_CVR = "46836219";
// Samlet tidsbudget for trin 11: nye dokumenter påbegyndes ikke efter 20 s
// (et påbegyndt dokument tager højst få kald à højst 8 s).
const MAKS_TID_MS = 20_000;
// Dokumenter, der har ventet så længe uden at blive færdige -> drift-alarm.
const HAENGER_EFTER_MS = 2 * 60 * 60 * 1000;
const MAKS_PDF = 6 * 1024 * 1024;

export type FakturaKoeResultat = {
  planlagt: Record<string, number> | null;
  behandlet: number;
  faerdige: number;
  fejl: number;
  stoppet: number;
  springetOver?: "ikke_migreret" | "ikke_konfigureret" | "graense" | "adgang";
};

type Admin = ReturnType<typeof createAdminClient>;

// Databasen er ikke migreret endnu (funktionen findes ikke): ingen alarm.
function mangler(fejl: { code?: string; message?: string } | null): boolean {
  if (!fejl) return false;
  return fejl.code === "PGRST202" || fejl.code === "42883" || fejl.code === "42P01" || /does not exist|Could not find the function/i.test(fejl.message ?? "");
}

const ren = (t: string | null | undefined, maks: number) =>
  (t ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maks);

function datoTekst(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}.${m}.${a}`;
}

// ---------------------------------------------------------------- kontakter

type KontaktInfo = { model: DineroKontaktModel; erFirma: boolean; slettet: boolean };

export async function hentKontaktInfo(admin: Admin, brugerId: string): Promise<KontaktInfo> {
  const { data: u, error } = await admin
    .from("users")
    .select("navn, fornavn, efternavn, email, konto_type, konto_slettet_kl")
    .eq("id", brugerId)
    .maybeSingle<{
      navn: string | null;
      fornavn: string | null;
      efternavn: string | null;
      email: string | null;
      konto_type: string | null;
      konto_slettet_kl: string | null;
    }>();
  if (error) throw new Error(`users: ${error.message}`);
  if (!u) throw new Error("Fakturaens modtager findes ikke");
  const fuldtNavn = ren([u.fornavn, u.efternavn].filter(Boolean).join(" "), 200) || ren(u.navn, 200) || "BidHamr-bruger";
  const email = ren(u.email, 200) || null;
  if (u.konto_type === "erhverv") {
    const { data: f, error: fFejl } = await admin
      .from("firmaer")
      .select("firmanavn, cvr, adresse, postnummer, bynavn, kontakt_email")
      .eq("bruger_id", brugerId)
      .maybeSingle<{
        firmanavn: string | null;
        cvr: string | null;
        adresse: string | null;
        postnummer: string | null;
        bynavn: string | null;
        kontakt_email: string | null;
      }>();
    if (fFejl) throw new Error(`firmaer: ${fFejl.message}`);
    if (f) {
      return {
        erFirma: true,
        slettet: !!u.konto_slettet_kl,
        model: {
          ExternalReference: `bidhamr-bruger-${brugerId}`,
          Name: ren(f.firmanavn, 200) || fuldtNavn,
          Street: ren(f.adresse, 200) || null,
          ZipCode: ren(f.postnummer, 10) || null,
          City: ren(f.bynavn, 100) || null,
          CountryKey: "DK",
          Email: ren(f.kontakt_email, 200) || email,
          VatNumber: (f.cvr ?? "").replace(/\D/g, "") || null,
          IsPerson: false,
          IsMember: false,
          UseCvr: false,
        },
      };
    }
  }
  return {
    erFirma: false,
    slettet: !!u.konto_slettet_kl,
    model: {
      ExternalReference: `bidhamr-bruger-${brugerId}`,
      Name: fuldtNavn,
      CountryKey: "DK",
      Email: email,
      IsPerson: true,
      IsMember: false,
      UseCvr: false,
    },
  };
}

async function sikrKontakt(admin: Admin, dinero: DineroKlient, brugerId: string): Promise<string> {
  const info = await hentKontaktInfo(admin, brugerId);
  const hash = createHash("sha256").update(JSON.stringify(info.model)).digest("hex").slice(0, 32);
  const { data, error } = await admin.rpc("faktura_kontakt_reserver", {
    p_bruger: brugerId,
    p_dinero_org: dinero.orgId,
    p_er_firma: info.erFirma,
  });
  if (error) throw new Error(`faktura_kontakt_reserver: ${error.message}`);
  const k = data as { guid: string; oprettet: boolean; hash: string | null };
  if (!k.oprettet) {
    const r = await dinero.opretKontakt({ ...info.model, ContactGuid: k.guid });
    if (r === "findes" && !(await dinero.hentKontakt(k.guid))) {
      throw new DineroFejl("Kontakten findes, men kan ikke hentes", { status: 404, forbigaaende: true });
    }
  } else if (k.hash !== hash && !info.slettet) {
    // Navn, e-mail, CVR eller adresse er ændret: opdatér kontakten. En slettet
    // konto røres ikke (fakturaerne skal beholde de oplysninger, de havde).
    await dinero.opdaterKontakt(k.guid, info.model);
  } else {
    return k.guid;
  }
  const { error: gemFejl } = await admin.rpc("faktura_kontakt_gemt", {
    p_bruger: brugerId,
    p_dinero_org: dinero.orgId,
    p_hash: hash,
  });
  if (gemFejl) throw new Error(`faktura_kontakt_gemt: ${gemFejl.message}`);
  return k.guid;
}

// ---------------------------------------------------------------- kontekst og filer

async function kontekst(admin: Admin, r: FakturaRaekke): Promise<FakturaKontekst> {
  let titel = "";
  if (r.trade_id) {
    const { data: t } = await admin.from("trades").select("auction_id").eq("id", r.trade_id).maybeSingle<{ auction_id: string }>();
    if (t?.auction_id) {
      const { data: a } = await admin.from("auctions").select("titel").eq("id", t.auction_id).maybeSingle<{ titel: string }>();
      titel = ren(a?.titel, 80);
    }
  }
  const varen = titel ? `"${titel}"` : "en vare";
  const handel = r.trade_id ? ` (handels-id ${r.trade_id})` : "";
  const dato = datoTekst(r.betalt_dato);
  let kommentar: string;
  if (r.dokument === "kreditnota") {
    const { data: m } = await admin
      .from("fakturaer")
      .select("dinero_nummer, linjer")
      .eq("id", String(r.krediterer_id))
      .maybeSingle<{ dinero_nummer: number | null; linjer: { kode: string }[] }>();
    const beholdt =
      (m?.linjer ?? []).some((l) => l.kode === "beskyttelse") && !r.linjer.some((l) => l.kode === "beskyttelse");
    kommentar =
      `Kreditnota for faktura nr. ${m?.dinero_nummer ?? "-"} - ${varen} på BidHamr${handel}. Refunderet via vores betalingspartner Stripe den ${dato}.` +
      (beholdt ? " BidHamr Beskyttelse refunderes ikke." : "");
  } else if (r.part === "saelger") {
    kommentar = `Salg af ${varen} på BidHamr${handel}. Sælgergebyret er trukket i købers betaling via vores betalingspartner Stripe den ${dato}.`;
  } else {
    kommentar = `Køb af ${varen} på BidHamr${handel}. Betalt via vores betalingspartner Stripe den ${dato}.`;
  }

  // Adresse: firmaets (så firmaet kan trække momsen fra). Private kun over
  // 3.000 kr. (en forenklet faktura under 3.000 kr. kræver ikke adresse).
  let adresse: string | null = null;
  const { data: f } = await admin
    .from("firmaer")
    .select("adresse, postnummer, bynavn")
    .eq("bruger_id", r.bruger_id)
    .maybeSingle<{ adresse: string | null; postnummer: string | null; bynavn: string | null }>();
  if (f) {
    const linje2 = [ren(f.postnummer, 10), ren(f.bynavn, 100)].filter(Boolean).join(" ");
    adresse = [ren(f.adresse, 200), linje2].filter(Boolean).join("\n") || null;
  } else if (Number(r.beloeb_oere) > 300000) {
    const { data: u } = await admin.from("users").select("adresse").eq("id", r.bruger_id).maybeSingle<{ adresse: string | null }>();
    adresse = ren(u?.adresse, 300) || null;
  }
  return { kommentar: kommentar.slice(0, 1000), adresse };
}

export function pdfSti(r: { bruger_id: string; id: string }) {
  return `${r.bruger_id}/${r.id}.pdf`;
}

export function erPdf(b: Uint8Array | null): b is Uint8Array {
  return !!b && b.byteLength > 4 && b.byteLength <= MAKS_PDF && String.fromCharCode(b[0], b[1], b[2], b[3]) === "%PDF";
}

async function gemPdf(admin: Admin, r: { bruger_id: string; id: string }, pdf: Uint8Array): Promise<string | null> {
  if (!erPdf(pdf)) return null;
  const sti = pdfSti(r);
  const { error } = await admin.storage
    .from("fakturaer")
    .upload(sti, pdf, { contentType: "application/pdf", upsert: true, cacheControl: "0" });
  if (error) {
    console.error("Faktura-PDF kunne ikke gemmes:", r.id, error.message);
    return null;
  }
  return sti;
}

// Stripe-fakturaens PDF (abonnement) som bilag. Kun https fra stripe.com.
async function hentStripePdf(admin: Admin, r: FakturaRaekke): Promise<Uint8Array | null> {
  if (!r.firma_regning_id) return null;
  const { data } = await admin.from("firma_regninger").select("pdf_url").eq("id", r.firma_regning_id).maybeSingle<{ pdf_url: string | null }>();
  // Stripes link (pay.stripe.com) viderestiller til Stripes egen fil-lager
  // (stripe-upload-api.s3.<region>.amazonaws.com - set 9. okt. 2026). Hvert
  // hop tjekkes, så serveren aldrig hentes andre steder hen.
  const stripeVaert = (u: string, foerste: boolean) => {
    try {
      const x = new URL(u);
      if (x.protocol !== "https:") return false;
      if (x.hostname === "stripe.com" || x.hostname.endsWith(".stripe.com")) return true;
      return !foerste && /^stripe-upload-api\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(x.hostname);
    } catch {
      return false;
    }
  };
  if (!data?.pdf_url || !stripeVaert(data.pdf_url, true)) return null;
  try {
    let url = data.pdf_url;
    let svar: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      svar = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store", redirect: "manual" });
      const videre = svar.status >= 300 && svar.status < 400 ? svar.headers.get("location") : null;
      if (!videre) break;
      url = new URL(videre, url).toString();
      if (!stripeVaert(url, false)) return null;
      svar = null;
    }
    if (!svar || !svar.ok) return null;
    const laengde = Number(svar.headers.get("content-length") ?? 0);
    if (laengde > MAKS_PDF) return null;
    const b = new Uint8Array(await svar.arrayBuffer());
    return erPdf(b) ? b : null;
  } catch (err) {
    console.error("Stripe-fakturaens PDF kunne ikke hentes (bogføres uden bilag):", r.id, err instanceof Error ? err.message : err);
    return null;
  }
}

// Abonnement refunderet: det, Stripe faktisk har refunderet på fakturaens
// betaling(er), i øre. Kun læsning hos Stripe.
async function stripeRefunderetOere(r: FakturaRaekke): Promise<number> {
  if (!r.stripe_reference?.startsWith("in_")) throw new Error("Abonnementsbilaget mangler Stripe-faktura-id");
  const { getStripe } = await import("@/lib/stripe");
  const s = getStripe();
  const betalinger = await s.invoicePayments.list({ invoice: r.stripe_reference, limit: 10 });
  let sum = 0;
  for (const b of betalinger.data) {
    if (b.status !== "paid") continue;
    const piRef = b.payment.payment_intent;
    const piId = typeof piRef === "string" ? piRef : piRef?.id;
    if (!piId) continue;
    const pi = await s.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
    const ch = pi.latest_charge && typeof pi.latest_charge !== "string" ? pi.latest_charge : null;
    sum += Number(ch?.amount_refunded ?? 0);
  }
  return sum;
}

// ---------------------------------------------------------------- køen

async function alarm(admin: Admin, r: FakturaRaekke, hvad: string, besked: string) {
  const { data } = await admin.rpc("faktura_alarm_claim", { p_id: r.id });
  if (data !== true) return;
  const navn = r.dokument === "kreditnota" ? "Kreditnota" : r.dokument === "faktura" ? "Faktura" : "Abonnementsbilag";
  await logDriftFejl({
    kilde: "server",
    hvor: "faktura/dinero",
    fejl: `${navn} ${r.id} (${r.part}) ${hvad}: ${besked} Se Admin -> Fakturaer.`,
    brugerId: r.bruger_id,
  });
}

export async function koerFakturaKoe(): Promise<FakturaKoeResultat> {
  const admin = createAdminClient();
  const res: FakturaKoeResultat = { planlagt: null, behandlet: 0, faerdige: 0, fejl: 0, stoppet: 0 };

  // 1) Planlæg (også uden Dinero - så intet går tabt, til Dinero er sat op).
  const { data: plan, error: planFejl } = await admin.rpc("faktura_planlaeg", { p_graense: 200 });
  if (planFejl) {
    if (mangler(planFejl)) return { ...res, springetOver: "ikke_migreret" };
    throw new Error(`faktura_planlaeg: ${planFejl.message}`);
  }
  res.planlagt = plan as Record<string, number>;

  // 1b) Én drift-alarm pr. dokument, der er oprettet som "kræver handling"
  //     (fx gebyret passer ikke, eller fakturaen blev håndteret manuelt).
  const { data: nyeStoppede } = await admin
    .from("fakturaer")
    .select("id, dokument, part, bruger_id, sidste_fejl")
    .eq("status", "kraever_handling")
    .is("alarm_kl", null)
    .limit(50);
  for (const x of (nyeStoppede ?? []) as (FakturaRaekke & { sidste_fejl: string | null })[]) {
    await alarm(admin, x, "kræver handling", x.sidste_fejl ?? "Se fakturaen.");
  }

  // 1c) Dokumenter, der har ventet over 2 timer (også når Dinero er sat op -
  //     fx en kreditnota, hvis faktura står fast). Én alarm, til det er løst.
  const { count: haenger } = await admin
    .from("fakturaer")
    .select("id", { count: "exact", head: true })
    .in("status", ["venter", "kladde", "bogfoert"])
    .eq("opgivet", false)
    .eq("manuel", false)
    .lt("oprettet_kl", new Date(Date.now() - HAENGER_EFTER_MS).toISOString());

  // 2) Dinero sat op?
  const konfig = hentFakturaKonfig();
  if ((haenger ?? 0) > 0) {
    await alarmPrTilfaelde({
      noegle: "faktura:haenger",
      hvor: "faktura/dinero",
      fejl: `${haenger} faktura-dokument(er) har ventet over 2 timer uden at blive lavet i Dinero${
        konfig.ok ? "" : ` (${konfig.besked})`
      }. Se Admin -> Fakturaer.`,
    });
  } else {
    await lukTilfaelde("faktura:haenger");
  }
  if (!konfig.ok) {
    if (konfig.grund !== "mangler") {
      await alarmPrTilfaelde({
        noegle: "faktura:konfiguration",
        hvor: "faktura/dinero",
        fejl: `Fakturaer laves ikke i Dinero: ${konfig.besked} Se docs/FAKTURA.md.`,
      });
    }
    return { ...res, springetOver: "ikke_konfigureret" };
  }
  await lukTilfaelde("faktura:konfiguration");

  const dinero = lavDineroKlient(konfig.dinero, { maksKald: 45 });
  // Live: Dinero-regnskabet skal være BidHamrs eget (CVR 46836219) - ellers
  // laves intet (fx sandkassens nøgler sat i produktionen).
  if (konfig.miljoe === "live") {
    try {
      const org = await dinero.hentOrganisation();
      if (!org || (org.VatNumber ?? "").replace(/\D/g, "") !== BIDHAMR_CVR) {
        await alarmPrTilfaelde({
          noegle: "faktura:konfiguration",
          hvor: "faktura/dinero",
          fejl: `Fakturaer laves ikke: Dinero-regnskabet ${konfig.dinero.orgId} har ikke BidHamrs CVR (${BIDHAMR_CVR}). Se docs/FAKTURA.md.`,
        });
        return { ...res, springetOver: "ikke_konfigureret" };
      }
    } catch (err) {
      if (err instanceof DineroFejl && err.adgang) {
        await alarmPrTilfaelde({ noegle: "faktura:adgang", hvor: "faktura/dinero", fejl: err.message });
      }
      return { ...res, springetOver: err instanceof DineroFejl && err.adgang ? "adgang" : "graense" };
    }
  }

  // 3) Behandl køen.
  const { data: claimet, error: claimFejl } = await admin.rpc("faktura_claim", { p_antal: PR_KOERSEL });
  if (claimFejl) throw new Error(`faktura_claim: ${claimFejl.message}`);
  const raekker = (claimet ?? []) as FakturaRaekke[];
  if (raekker.length === 0) return res;

  const start = Date.now();
  let stop: FakturaKoeResultat["springetOver"] | undefined;

  for (const r of raekker) {
    const noegle = String(r.laas_noegle);
    const slip = async () => {
      await admin.rpc("faktura_registrer", { p_id: r.id, p_noegle: noegle, p_frigiv: true });
    };
    // Organisationen må aldrig skifte for et dokument (test/live): stop det
    // til staff (ellers ville det blokere køen ved hver kørsel).
    if (r.dinero_org && r.dinero_org !== dinero.orgId) {
      const besked = `Dokumentet er påbegyndt i en anden Dinero-organisation (${r.dinero_org}) end den nuværende (${dinero.orgId}) - behandles ikke automatisk.`;
      await admin.rpc("faktura_fejl", { p_id: r.id, p_noegle: noegle, p_fejl: besked, p_permanent: true });
      res.stoppet++;
      await alarm(admin, r, "er stoppet", besked);
      continue;
    }
    if (stop || dinero.budgetOpbrugt(10) || Date.now() - start > MAKS_TID_MS) {
      await slip();
      continue;
    }
    res.behandlet++;
    const deps: ProcesDeps = {
      dinero,
      konti: konfig.konti,
      registrer: async (f: Fremskridt) => {
        const { data, error } = await admin.rpc("faktura_registrer", {
          p_id: r.id,
          p_noegle: noegle,
          p_status: f.status ?? null,
          p_dinero_org: dinero.orgId,
          p_kontakt: f.kontakt ?? null,
          p_nummer: f.nummer ?? null,
          p_moms: f.moms ?? null,
          p_pdf_sti: f.pdfSti ?? null,
          p_fil: f.fil ?? null,
          p_frigiv: f.frigiv ?? false,
        });
        if (error) throw new Error(`faktura_registrer: ${error.message}`);
        return data === true;
      },
      sikrKontakt: (brugerId) => sikrKontakt(admin, dinero, brugerId),
      kontekst: (x) => kontekst(admin, x),
      gemPdf: (x, pdf) => gemPdf(admin, x, pdf),
      hentStripePdf: (x) => hentStripePdf(admin, x),
      stripeRefunderetOere,
    };
    try {
      const ud = await behandlDokument(r, deps);
      if (ud.kode === "faerdig") res.faerdige++;
      if (ud.kode === "kraever_handling") {
        res.stoppet++;
        await admin.rpc("faktura_registrer", {
          p_id: r.id,
          p_noegle: noegle,
          p_status: "kraever_handling",
          p_fejl: ud.besked,
        });
        await alarm(admin, r, "er stoppet", ud.besked);
      }
    } catch (err) {
      res.fejl++;
      const besked = err instanceof Error ? err.message : String(err);
      const d = err instanceof DineroFejl ? err : null;
      if (d?.graense || d?.adgang) {
        stop = d.graense ? "graense" : "adgang";
        await admin.rpc("faktura_fejl", { p_id: r.id, p_noegle: noegle, p_fejl: besked, p_taeller: false });
        if (d.adgang) {
          await alarmPrTilfaelde({ noegle: "faktura:adgang", hvor: "faktura/dinero", fejl: besked });
        }
        continue;
      }
      // Dinero afviser indholdet (4xx, fx et ugyldigt CVR-nummer): det går
      // ikke over af sig selv - stop til staff. Alt andet: prøv igen senere.
      const permanent = !!d && !d.forbigaaende && d.status >= 400 && d.status < 500;
      const { data: f } = await admin.rpc("faktura_fejl", {
        p_id: r.id,
        p_noegle: noegle,
        p_fejl: besked,
        p_permanent: permanent,
      });
      const svar = (f ?? {}) as { opgivet?: boolean; status?: string };
      if (svar.status === "kraever_handling") {
        res.stoppet++;
        await alarm(admin, r, "er stoppet", besked);
      } else if (svar.opgivet) {
        res.stoppet++;
        await alarm(admin, r, "er opgivet efter 5 forsøg", besked);
      }
    }
  }
  if (stop !== "adgang") await lukTilfaelde("faktura:adgang");
  if (stop) res.springetOver = stop;
  return res;
}
