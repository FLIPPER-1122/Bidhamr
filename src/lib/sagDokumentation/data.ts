import "server-only";

// Henter alt til "Dokumentation til sælger/politiet" med service-role-klienten.
// Kaldes KUN fra route /admin/sager/[id]/dokumentation efter rolletjekket.
// Oplysningerne til politiudgaven (MitID, e-mail, telefon, konto, handler
// mellem parterne, andre sager, log) hentes kun for udgaven 'politi'.
// Billederne hentes som bytes fra lagringen og indlejres i PDF'en.
import type { createAdminClient } from "@/lib/supabase/admin";
import { erSagType, SAG_BUCKET, SAG_KATEGORI_NAVN, type SagBilledeKategori, type SagStatus } from "@/lib/sager";
import { PAKKE_BUCKET, PAKKE_KATEGORI_NAVN, erPakkeBilledeKategori } from "@/lib/pakkebilleder";
import { standNavn } from "@/lib/stand";
import { statusLabel } from "@/components/HandelStatusBadge";
import type { SagDokumentationUdgave } from "@/lib/sagDokumentation/regler";
import type {
  DokBillede,
  DokChatBesked,
  DokForsendelse,
  DokPartPoliti,
  DokumentationData,
} from "@/lib/sagDokumentation/indhold";

type Admin = ReturnType<typeof createAdminClient>;

// Loft, så én PDF ikke bliver uhåndterlig (billeder op til 10 MB hver).
const MAKS_BILLEDER_I_ALT = 60;
const MAKS_BILLED_BYTES = 12 * 1024 * 1024;
const MAKS_BESKEDER = 1000;

class Optaelling {
  brugt = 0;
}

function format(bytes: Uint8Array): "jpg" | "png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

// Andre formater (fx WebP fra appen) laves om til JPEG med sharp, som Next
// selv bruger til billedoptimering. Mangler sharp, vises en tekst i stedet.
async function tilJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const sharp = (await import("sharp")).default;
    const ud = await sharp(bytes, { failOn: "none" }).rotate().jpeg({ quality: 85 }).toBuffer();
    return new Uint8Array(ud);
  } catch {
    return null;
  }
}

async function hentBillede(
  admin: Admin,
  bucket: string,
  sti: string,
  tekst: string,
  tidKl: string | null,
  taeller: Optaelling,
): Promise<DokBillede> {
  if (taeller.brugt >= MAKS_BILLEDER_I_ALT) {
    return { tekst: `${tekst} (ikke medtaget: for mange billeder i én PDF)`, tid: tidKl, bytes: null, format: null };
  }
  taeller.brugt++;
  try {
    const { data, error } = await admin.storage.from(bucket).download(sti);
    if (error || !data) throw new Error(error?.message ?? "intet billede");
    if (data.size > MAKS_BILLED_BYTES) throw new Error("for stort");
    let bytes: Uint8Array = new Uint8Array(await data.arrayBuffer());
    let f = format(bytes);
    if (!f) {
      const jpeg = await tilJpeg(bytes);
      if (jpeg) {
        bytes = jpeg;
        f = "jpg";
      }
    }
    if (!f) return { tekst: `${tekst} (billedformatet kan ikke vises i PDF)`, tid: tidKl, bytes: null, format: null };
    return { tekst, tid: tidKl, bytes, format: f };
  } catch (e) {
    console.error("[sag-dokumentation] billede kunne ikke hentes:", bucket, e instanceof Error ? e.message : e);
    return { tekst: `${tekst} (billedet kunne ikke hentes)`, tid: tidKl, bytes: null, format: null };
  }
}

// Offentlig URL til auktionsbilledet -> bucket og sti i vores egen lagring.
// Kun billeder i "auktion-billeder" hentes (aldrig vilkårlige URL'er).
function auktionSti(url: string): string | null {
  const m = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/auktion-billeder\/([^?#]+)$/.exec(url);
  if (!m) return null;
  const sti = decodeURIComponent(m[1]);
  return /\.\.|\\/.test(sti) ? null : sti;
}

function fragtfirmaNavn(kode: string | null): string {
  if (!kode) return "Ukendt fragtfirma";
  if (kode === "dao") return "DAO";
  if (kode === "gls") return "GLS";
  return kode.toUpperCase();
}

type SagRaekke = {
  id: string;
  trade_id: string;
  type: string;
  status: SagStatus;
  oprettet_kl: string;
  beskrivelse: string;
  beskyttelse: boolean;
  afgjort_kl: string | null;
  begrundelse: string | null;
  retur_kraeves: boolean;
  retur_afleveret_kl: string | null;
};

type Valgfri = {
  oprindelig_type: string | null;
  pakke_smidt_ud: boolean | null;
  pakke_smidt_ud_begrundelse: string | null;
};

export type HentetSag = { sagId: string; tradeId: string; koeberId: string; saelgerId: string };

// Sagen og parterne (til rolletjek før resten hentes).
export async function hentSagParter(admin: Admin, sagId: string): Promise<HentetSag | null> {
  const { data: s, error } = await admin.from("sager").select("id, trade_id").eq("id", sagId).maybeSingle<{ id: string; trade_id: string }>();
  if (error) throw new Error(error.message);
  if (!s) return null;
  const { data: t, error: tErr } = await admin
    .from("trades")
    .select("buyer_id, seller_id")
    .eq("id", s.trade_id)
    .maybeSingle<{ buyer_id: string; seller_id: string }>();
  if (tErr) throw new Error(tErr.message);
  if (!t) return null;
  return { sagId: s.id, tradeId: s.trade_id, koeberId: t.buyer_id, saelgerId: t.seller_id };
}

export async function hentDokumentationData(
  admin: Admin,
  parter: HentetSag,
  udgave: SagDokumentationUdgave,
): Promise<DokumentationData> {
  const { sagId, tradeId, koeberId, saelgerId } = parter;
  const taeller = new Optaelling();

  const [sagR, valgfriR, handelR, betalingR, leveringR, forsendR, sagBilledR, svarR, pakkeR, ankeR, chatR, brugereR] =
    await Promise.all([
      admin
        .from("sager")
        .select("id, trade_id, type, status, oprettet_kl, beskrivelse, beskyttelse, afgjort_kl, begrundelse, retur_kraeves, retur_afleveret_kl")
        .eq("id", sagId)
        .single<SagRaekke>(),
      admin
        .from("sager")
        .select("oprindelig_type, pakke_smidt_ud, pakke_smidt_ud_begrundelse")
        .eq("id", sagId)
        .maybeSingle<Valgfri>(),
      admin
        .from("trades")
        .select("id, auction_id, created_at, afhentning, sendt_kl, received_at, tracking_number")
        .eq("id", tradeId)
        .single<{
          id: string;
          auction_id: string | null;
          created_at: string | null;
          afhentning: boolean | null;
          sendt_kl: string | null;
          received_at: string | null;
          tracking_number: string | null;
        }>(),
      admin
        .from("betalinger")
        .select("bud_oere, fragt_oere, total_oere, betalt_kl, status")
        .eq("trade_id", tradeId)
        .order("oprettet", { ascending: false })
        .limit(1)
        .maybeSingle<{ bud_oere: number | null; fragt_oere: number | null; total_oere: number | null; betalt_kl: string | null; status: string }>(),
      admin
        .from("handel_levering")
        .select("maade, modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by")
        .eq("trade_id", tradeId)
        .maybeSingle<Record<string, string | null>>(),
      admin
        .from("forsendelser")
        .select("id, type, fragtfirma, transportoer, status, sporingsnummer, oprettet_kl, afleveret_kl, leveret_kl, vaegt_gram")
        .eq("trade_id", tradeId)
        .order("oprettet_kl", { ascending: true })
        .limit(20),
      admin.from("sag_billeder").select("sti, kategori, oprettet_kl").eq("sag_id", sagId).order("oprettet_kl", { ascending: true }),
      admin.from("sag_svar").select("id, tekst, oprettet_kl").eq("sag_id", sagId).maybeSingle<{ id: string; tekst: string; oprettet_kl: string }>(),
      admin.from("pakke_billeder").select("sti, kategori, oprettet_kl").eq("trade_id", tradeId).order("oprettet_kl", { ascending: true }).limit(20),
      admin
        .from("sag_anker")
        .select("id, part, indgivet_kl, begrundelse, status, behandlet_kl, afgoerelse_begrundelse")
        .eq("sag_id", sagId)
        .maybeSingle<{
          id: string;
          part: "koeber" | "saelger";
          indgivet_kl: string;
          begrundelse: string;
          status: string;
          behandlet_kl: string | null;
          afgoerelse_begrundelse: string | null;
        }>(),
      admin
        .from("messages")
        .select("sender_id, content, created_at, fra_bidhamr, blokeret_grund")
        .eq("trade_id", tradeId)
        .order("created_at", { ascending: true })
        .limit(MAKS_BESKEDER),
      admin.from("users").select("id, navn").in("id", [koeberId, saelgerId]),
    ]);

  if (sagR.error || !sagR.data) throw new Error(`sager: ${sagR.error?.message ?? "mangler"}`);
  if (handelR.error || !handelR.data) throw new Error(`trades: ${handelR.error?.message ?? "mangler"}`);
  const s = sagR.data;
  const h = handelR.data;
  if (!erSagType(s.type)) throw new Error("ukendt sagstype");
  const valgfri = valgfriR.error ? null : valgfriR.data;
  const navn = new Map(((brugereR.data ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn]));

  // Auktionen
  const { data: a } = h.auction_id
    ? await admin
        .from("auctions")
        .select("id, titel, beskrivelse, kategori, maerke, stand, vaegt_gram, billeder")
        .eq("id", h.auction_id)
        .maybeSingle<{
          id: string;
          titel: string | null;
          beskrivelse: string | null;
          kategori: string | null;
          maerke: string | null;
          stand: string | null;
          vaegt_gram: number | null;
          billeder: string[] | null;
        }>()
    : { data: null };

  // Sporingshændelser (med målt vægt fra fragtfirmaet, hvis den findes).
  const forsendelser = (forsendR.data ?? []) as {
    id: string;
    type: string;
    fragtfirma: string | null;
    transportoer: string | null;
    status: string;
    sporingsnummer: string | null;
    oprettet_kl: string | null;
    afleveret_kl: string | null;
    leveret_kl: string | null;
    vaegt_gram: number | null;
  }[];
  const synlige = forsendelser.filter((f) => f.sporingsnummer || f.afleveret_kl || f.status !== "annulleret");
  const { data: haendelser } = synlige.length
    ? await admin
        .from("forsendelse_haendelser")
        .select("forsendelse_id, tidspunkt, type, beskrivelse, raa")
        .in("forsendelse_id", synlige.map((f) => f.id))
        .order("tidspunkt", { ascending: true })
        .limit(500)
    : { data: [] };
  const hPrF = new Map<string, DokForsendelse["haendelser"]>();
  for (const x of (haendelser ?? []) as {
    forsendelse_id: string;
    tidspunkt: string | null;
    type: string;
    beskrivelse: string | null;
    raa: Record<string, unknown> | null;
  }[]) {
    const maalt = x.raa && typeof x.raa.maalt_vaegt_gram === "number" ? Math.round(x.raa.maalt_vaegt_gram) : null;
    const liste = hPrF.get(x.forsendelse_id) ?? [];
    liste.push({ tidspunkt: x.tidspunkt, tekst: x.beskrivelse?.trim() || x.type.replace(/_/g, " "), maaltVaegtGram: maalt });
    hPrF.set(x.forsendelse_id, liste);
  }

  // Billeder (hentes efter hinanden for at holde hukommelsen nede).
  const auktionBilleder: DokBillede[] = [];
  for (const [i, url] of (a?.billeder ?? []).entries()) {
    const sti = typeof url === "string" ? auktionSti(url) : null;
    if (!sti) {
      auktionBilleder.push({ tekst: `Auktionsbillede ${i + 1} (kan ikke hentes)`, tid: null, bytes: null, format: null });
      continue;
    }
    auktionBilleder.push(await hentBillede(admin, "auktion-billeder", sti, `Auktionsbillede ${i + 1}`, null, taeller));
  }
  const koeberBilleder: DokumentationData["koeberBilleder"] = [];
  for (const b of (sagBilledR.data ?? []) as { sti: string; kategori: SagBilledeKategori; oprettet_kl: string }[]) {
    const kat = SAG_KATEGORI_NAVN[b.kategori] ?? "Billede";
    koeberBilleder.push({ ...(await hentBillede(admin, SAG_BUCKET, b.sti, kat, b.oprettet_kl, taeller)), kategori: kat });
  }
  const pakkebilleder: DokBillede[] = [];
  for (const b of (pakkeR.data ?? []) as { sti: string; kategori: string; oprettet_kl: string }[]) {
    if (!erPakkeBilledeKategori(b.kategori)) continue;
    pakkebilleder.push(await hentBillede(admin, PAKKE_BUCKET, b.sti, PAKKE_KATEGORI_NAVN[b.kategori], b.oprettet_kl, taeller));
  }
  let saelgerSvar: DokumentationData["saelgerSvar"] = null;
  if (svarR.data) {
    const { data: sb } = await admin
      .from("sag_svar_billeder")
      .select("sti, kategori, oprettet_kl")
      .eq("svar_id", svarR.data.id)
      .order("oprettet_kl", { ascending: true });
    const billeder: DokBillede[] = [];
    for (const b of (sb ?? []) as { sti: string; kategori: SagBilledeKategori; oprettet_kl: string }[]) {
      billeder.push(await hentBillede(admin, SAG_BUCKET, b.sti, SAG_KATEGORI_NAVN[b.kategori] ?? "Billede", b.oprettet_kl, taeller));
    }
    saelgerSvar = { tekst: svarR.data.tekst, oprettetKl: svarR.data.oprettet_kl, billeder };
  }
  let anke: DokumentationData["anke"] = null;
  if (ankeR.data) {
    const { data: ab } = await admin
      .from("sag_anke_billeder")
      .select("sti, kategori, oprettet_kl")
      .eq("anke_id", ankeR.data.id)
      .order("oprettet_kl", { ascending: true });
    const billeder: DokBillede[] = [];
    for (const b of (ab ?? []) as { sti: string; kategori: SagBilledeKategori; oprettet_kl: string }[]) {
      billeder.push(await hentBillede(admin, SAG_BUCKET, b.sti, SAG_KATEGORI_NAVN[b.kategori] ?? "Billede", b.oprettet_kl, taeller));
    }
    anke = {
      part: ankeR.data.part,
      indgivetKl: ankeR.data.indgivet_kl,
      begrundelse: ankeR.data.begrundelse,
      status: ankeR.data.status,
      behandletKl: ankeR.data.behandlet_kl,
      afgoerelseBegrundelse: ankeR.data.afgoerelse_begrundelse,
      billeder,
    };
  }

  const chat: DokChatBesked[] = ((chatR.data ?? []) as {
    sender_id: string | null;
    content: string;
    created_at: string;
    fra_bidhamr: boolean | null;
    blokeret_grund: string | null;
  }[]).map((m) => ({
    tid: m.created_at,
    fra: m.fra_bidhamr ? "bidhamr" : m.sender_id === koeberId ? "koeber" : m.sender_id === saelgerId ? "saelger" : "ukendt",
    tekst: m.content,
    stoppet: m.blokeret_grund,
  }));

  const lev = leveringR.error ? null : leveringR.data;
  const pakkeshop = lev?.pakkeshop_navn
    ? [lev.pakkeshop_navn, lev.pakkeshop_adresse, [lev.pakkeshop_postnummer, lev.pakkeshop_by].filter(Boolean).join(" ")]
        .filter((x) => x && x.trim())
        .join(", ")
    : null;

  const data: DokumentationData = {
    sag: {
      id: s.id,
      type: s.type,
      oprindeligType: valgfri && erSagType(valgfri.oprindelig_type) ? valgfri.oprindelig_type : null,
      status: s.status,
      oprettetKl: s.oprettet_kl,
      beskrivelse: s.beskrivelse,
      beskyttelse: s.beskyttelse,
      pakkeSmidtUd: !!valgfri?.pakke_smidt_ud,
      pakkeSmidtUdBegrundelse: valgfri?.pakke_smidt_ud_begrundelse ?? null,
      afgjortKl: s.afgjort_kl,
      begrundelse: s.begrundelse,
      returKraeves: s.retur_kraeves,
      returAfleveretKl: s.retur_afleveret_kl,
    },
    handel: {
      id: h.id,
      oprettetKl: h.created_at,
      afhentning: !!h.afhentning,
      sendtKl: h.sendt_kl,
      modtagetKl: h.received_at,
      sporingsnummer: h.tracking_number,
    },
    auktion: a
      ? {
          id: a.id,
          titel: a.titel,
          beskrivelse: a.beskrivelse,
          kategori: a.kategori,
          maerke: a.maerke,
          stand: a.stand ? standNavn(a.stand) : null,
          vaegtGram: a.vaegt_gram,
        }
      : null,
    auktionBilleder,
    betaling: betalingR.data
      ? {
          budOere: betalingR.data.bud_oere === null ? null : Number(betalingR.data.bud_oere),
          fragtOere: betalingR.data.fragt_oere === null ? null : Number(betalingR.data.fragt_oere),
          totalOere: betalingR.data.total_oere === null ? null : Number(betalingR.data.total_oere),
          betaltKl: betalingR.data.betalt_kl,
          status: betalingR.data.status,
        }
      : null,
    koeberNavn: navn.get(koeberId) ?? null,
    saelgerNavn: navn.get(saelgerId) ?? null,
    levering: lev
      ? {
          maade: lev.maade,
          navn: lev.modtager_navn,
          adresse: lev.modtager_adresse,
          postnummer: lev.modtager_postnummer,
          by: lev.modtager_by,
          pakkeshop,
        }
      : null,
    forsendelser: synlige.map((f) => ({
      retning: f.type === "retur" ? "retur" : "udgaaende",
      fragtfirma: fragtfirmaNavn(f.transportoer ?? f.fragtfirma),
      sporingsnummer: f.sporingsnummer,
      oprettetKl: f.oprettet_kl,
      afleveretKl: f.afleveret_kl,
      leveretKl: f.leveret_kl,
      angivetVaegtGram: f.vaegt_gram,
      haendelser: hPrF.get(f.id) ?? [],
    })),
    koeberBilleder,
    saelgerSvar,
    pakkebilleder,
    anke,
    chat,
  };

  if (udgave === "politi") data.politi = await hentPolitiData(admin, parter);
  return data;
}

// Kun til udgaven 'politi'.
async function hentPolitiData(admin: Admin, parter: HentetSag): Promise<NonNullable<DokumentationData["politi"]>> {
  const { sagId, koeberId, saelgerId } = parter;
  const [konti, mitid, handler, log] = await Promise.all([
    admin.from("users").select("id, email, telefon, oprettet").in("id", [koeberId, saelgerId]),
    admin
      .from("mitid_verificeringer")
      .select("bruger_id, status, juridisk_navn, foedselsdato, verificeret_kl, nulstillet_kl")
      .in("bruger_id", [koeberId, saelgerId])
      .order("verificeret_kl", { ascending: true }),
    admin
      .from("trades")
      .select("id, auction_id, buyer_id, seller_id, amount, status, created_at")
      .or(`and(buyer_id.eq.${koeberId},seller_id.eq.${saelgerId}),and(buyer_id.eq.${saelgerId},seller_id.eq.${koeberId})`)
      .order("created_at", { ascending: true })
      .limit(200),
    admin
      .from("moderation_log")
      .select("medarbejder_id, handling, aarsag, oprettet_kl")
      .eq("maal_type", "sag")
      .eq("maal_id", sagId)
      .order("oprettet_kl", { ascending: true })
      .limit(200),
  ]);
  if (konti.error) throw new Error(`users: ${konti.error.message}`);
  if (mitid.error) throw new Error(`mitid_verificeringer: ${mitid.error.message}`);
  if (handler.error) throw new Error(`trades: ${handler.error.message}`);
  if (log.error) throw new Error(`moderation_log: ${log.error.message}`);

  const handelRaekker = (handler.data ?? []) as {
    id: string;
    auction_id: string | null;
    buyer_id: string;
    seller_id: string;
    amount: number | null;
    status: string;
    created_at: string | null;
  }[];
  const auktionIds = [...new Set(handelRaekker.map((x) => x.auction_id).filter((x): x is string => !!x))];
  const logRaekker = (log.data ?? []) as { medarbejder_id: string; handling: string; aarsag: string | null; oprettet_kl: string }[];
  const staffIds = [...new Set(logRaekker.map((x) => x.medarbejder_id))];

  const [titler, staff, udleveringer, sagerSomKoeber, sagerSomSaelger] = await Promise.all([
    auktionIds.length ? admin.from("auctions").select("id, titel").in("id", auktionIds) : Promise.resolve({ data: [] }),
    staffIds.length ? admin.from("users").select("id, navn").in("id", staffIds) : Promise.resolve({ data: [] }),
    admin
      .from("sag_dokumentation_udlevering")
      .select("udgave, givet_til, journalnummer, lavet_af, lavet_kl")
      .eq("sag_id", sagId)
      .order("lavet_kl", { ascending: true })
      .limit(200),
    andreSager(admin, sagId, "buyer_id", [koeberId, saelgerId]),
    andreSager(admin, sagId, "seller_id", [koeberId, saelgerId]),
  ]);
  const titel = new Map(((titler.data ?? []) as { id: string; titel: string | null }[]).map((x) => [x.id, x.titel]));
  const udlRaekker = (udleveringer.data ?? []) as {
    udgave: "saelger" | "politi";
    givet_til: string;
    journalnummer: string | null;
    lavet_af: string;
    lavet_kl: string;
  }[];
  const ekstraStaff = [...new Set(udlRaekker.map((x) => x.lavet_af).filter((x) => !staffIds.includes(x)))];
  const { data: ekstra } = ekstraStaff.length
    ? await admin.from("users").select("id, navn").in("id", ekstraStaff)
    : { data: [] };
  const staffNavn = new Map(
    ([...(staff.data ?? []), ...(ekstra ?? [])] as { id: string; navn: string | null }[]).map((x) => [x.id, x.navn]),
  );

  const kontoMap = new Map(
    ((konti.data ?? []) as { id: string; email: string | null; telefon: string | null; oprettet: string | null }[]).map((x) => [x.id, x]),
  );
  const mitidRaekker = (mitid.data ?? []) as {
    bruger_id: string;
    status: string;
    juridisk_navn: string | null;
    foedselsdato: string | null;
    verificeret_kl: string | null;
    nulstillet_kl: string | null;
  }[];
  const part = (id: string): DokPartPoliti => {
    const k = kontoMap.get(id);
    return {
      email: k?.email ?? null,
      telefon: k?.telefon ?? null,
      kontoOprettetKl: k?.oprettet ?? null,
      mitid: mitidRaekker
        .filter((m) => m.bruger_id === id)
        .map((m) => ({
          status: m.status,
          navn: m.juridisk_navn,
          foedselsdato: m.foedselsdato,
          verificeretKl: m.verificeret_kl,
          nulstilletKl: m.nulstillet_kl,
        })),
      andreSagerSomKoeber: sagerSomKoeber.get(id) ?? 0,
      andreSagerSomSaelger: sagerSomSaelger.get(id) ?? 0,
    };
  };

  return {
    koeber: part(koeberId),
    saelger: part(saelgerId),
    handlerMellem: handelRaekker.map((x) => ({
      id: x.id,
      titel: x.auction_id ? (titel.get(x.auction_id) ?? null) : null,
      koeberErSagensKoeber: x.buyer_id === koeberId,
      beloebKr: x.amount === null ? null : Number(x.amount),
      status: statusLabel(x.status),
      oprettetKl: x.created_at,
    })),
    log: logRaekker.map((x) => ({
      tid: x.oprettet_kl,
      handling: x.handling,
      medarbejder: staffNavn.get(x.medarbejder_id) ?? null,
      aarsag: x.aarsag,
    })),
    udleveringer: udlRaekker.map((x) => ({
      tid: x.lavet_kl,
      udgave: x.udgave,
      givetTil: x.givet_til,
      journalnummer: x.journalnummer,
      af: staffNavn.get(x.lavet_af) ?? null,
    })),
  };
}

// Antal andre sager (ikke denne), hvor brugeren er køber/sælger i handlen.
async function andreSager(
  admin: Admin,
  sagId: string,
  kolonne: "buyer_id" | "seller_id",
  brugere: string[],
): Promise<Map<string, number>> {
  const ud = new Map<string, number>();
  for (const id of brugere) {
    const { data: handler, error } = await admin.from("trades").select("id").eq(kolonne, id).limit(5000);
    if (error) throw new Error(`trades (${kolonne}): ${error.message}`);
    const ids = ((handler ?? []) as { id: string }[]).map((x) => x.id);
    if (ids.length === 0) {
      ud.set(id, 0);
      continue;
    }
    let antal = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const { count, error: cErr } = await admin
        .from("sager")
        .select("id", { count: "exact", head: true })
        .in("trade_id", ids.slice(i, i + 200))
        .neq("id", sagId);
      if (cErr) throw new Error(`sager (antal): ${cErr.message}`);
      antal += count ?? 0;
    }
    ud.set(id, antal);
  }
  return ud;
}
