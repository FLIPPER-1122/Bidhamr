"use server";

// Sager fra køberen (ROADMAP-BESLUTNINGER afsnit 1 og 4 + "Sager (Filip,
// 3. oktober 2026)"). Køberen opretter sagen selv; staff afgør den
// (src/app/actions/adminSager.ts).
//
// Alle regler håndhæves i databasen (sag_opret - security definer, udleder
// køberen af auth.uid()). Her laves kun forhåndstjek og notifikationer.
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
//
// Billeder uploades af klienten direkte til Supabase Storage (bucket
// 'sag-billeder', privat) FØR sagen oprettes, med stien fra
// sagBilledeSti() i src/lib/sager.ts og { upsert: false }. Stierne sendes
// derefter med til opretSag(). Storage-policyen tillader kun upload i
// køberens egen mappe på en handel, han er køber på.
//
// Appen (Expo) kan bruge det samme direkte med supabase-js:
//   supabase.storage.from("sag-billeder").upload(sti, fil, { upsert: false, contentType })
//   supabase.rpc("sag_opret", { p_trade, p_type, p_beskrivelse, p_billeder: [{ sti, kategori }],
//       p_pakke_smidt_ud?, p_smidt_ud_begrundelse? })   (20261102210000)
//       p_valg? (køberens valg, fx 'tom')                 (20261102350000)
//   ELLER (anbefalet - beskeden til sælgeren sendes straks):
//   POST /api/sag/app/opret og /api/sag/app/svar (docs/APP-ENDPOINTS.md)
//       -> { kode: "ok", sag_id } | { kode: <fejlkode> } (se SAG_OPRET_FEJL)
//   supabase.rpc("sag_tilfoej_billeder", { p_sag, p_billeder })
//   supabase.from("sager").select("id, trade_id, type, koeber_valg, beskrivelse, status,
//       oprettet_kl, afgjort_kl, begrundelse, retur_kraeves, returfragt_betaler,
//       retur_afleveret_kl, genaabnet_kl, penge_handling, penge_flyttes_efter_kl,
//       afviklet_kl")   (OBS: ikke "*". beskyttelse kan IKKE vælges - sælgeren
//       må ikke se den; køberen har den på sin egen betaling)
//   Ankefrist: efter en afgørelse flyttes pengene tidligst penge_flyttes_efter_kl
//   (afgjort + 4 dage); afviklet_kl er sat, når det er sket.
//   supabase.from("sag_billeder").select("id, sag_id, sti, kategori, oprettet_kl")
//   supabase.storage.from("sag-billeder").createSignedUrls(stier, 3600)
//   Notifikationen "sag oprettet" sendes af cron for sager oprettet fra appen
//   (sager.notificeret_kl claimes, så den kun sendes én gang).
//
// Anke (den part, der taber sagen; fra 24 timer til 4 dage efter afgørelsen,
// én pr. sag, endelig):
//   supabase.rpc("sag_anke_mulighed", { p_sag })
//       -> { kode: "kan_anke" | "for_tidligt" | "for_sent" | "findes" | "vandt"
//            | "ingen_anke" | "retur_afleveret" | "ikke_fundet", part?, fra_kl?, til_kl? }
//   Billeder (valgfri): upload til "sag-billeder" under <eget id>/<handel-id>/...
//       (tilladt, mens kode er "kan_anke"), { upsert: false }
//   supabase.rpc("sag_anke_indgiv", { p_sag, p_begrundelse (20-2000 tegn),
//       p_billeder: [{ sti, kategori: "andet" }] })
//       -> { kode: "ok", anke_id } | { kode: <fejlkode> } (se SAG_ANKE_FEJL)
//   supabase.from("sag_anker").select("id, sag_id, trade_id, part, begrundelse,
//       indgivet_kl, ankede_status, ankede_afgjort_kl, status, behandlet_kl,
//       afgoerelse_begrundelse")   (status: afventer | stadfaestet | omgjort)
//   supabase.from("sag_anke_billeder").select("id, anke_id, sti, kategori, oprettet_kl")
//   Beskeden "anke indgivet" sendes af cron for anker indgivet fra appen.
import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { erNyPrivatPrismodel } from "@/lib/betaling/beregn";
import { logDriftFejl } from "@/lib/drift";
import { notificerAnkeIndgivet } from "@/lib/sagerServer";
import { opretSagFor, svarPaaSagFor } from "@/lib/sagHandlinger";
import { hentPakkeBilleder, type VistPakkeBillede } from "@/lib/pakkebillederServer";
import { hentSagMulighederFor, type SagMuligheder } from "@/lib/sagMuligheder";
import {
  SAG_BUCKET,
  SAG_SVAR_FEJL,
  SAG_MAKS_BILLEDER,
  SAG_OPRET_FEJL,
  SAG_ANKE_BEGRUNDELSE_MAKS,
  SAG_ANKE_BEGRUNDELSE_MIN,
  SAG_ANKE_FEJL,
  SAG_ANKE_MAKS_BILLEDER,
  type SagAnkeMulighedKode,
  type SagAnkeStatus,
  type SagBilledeKategori,
  type SagPengeHandling,
  type SagStatus,
  type SagType,
  erSagBilledeKategori,
  sagSvarFristKl,
  sagReturFristKl,
  sagSti,
} from "@/lib/sager";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { SagBilledeInput } from "@/lib/sagHandlinger";
import type { SagBilledeInput } from "@/lib/sagHandlinger";
import { erSagValgId, type SagValgId } from "@/lib/tekster/sagValg";

export type MinSag = {
  id: string;
  tradeId: string;
  type: SagType;
  // Køberens hverdagsvalg (sager.koeber_valg). null på gamle sager - vis
  // sagProblemTekst(type, koeberValg), aldrig SAG_TYPE_NAVN.
  koeberValg: SagValgId | null;
  beskrivelse: string;
  status: SagStatus;
  // Kun for køberen (sælgeren får altid false - han må ikke se det).
  beskyttelse: boolean;
  // Kun for køberen: handlen følger den nye prismodel (20261031010000) - ved
  // medhold får køberen kun buddet tilbage (beregn.ts sagRefusionOere).
  nyPrismodel: boolean;
  oprettetKl: string;
  afgjortKl: string | null;
  // Begrundelsen fra BidHamr til køber og sælger.
  begrundelse: string | null;
  returKraeves: boolean;
  // Hvem betaler returfragten (20261102210000: 'saelger' ved transportskade
  // med dårlig indpakning, 'bidhamr' ved god indpakning).
  returfragtBetaler: "koeber" | "saelger" | "bidhamr" | null;
  returAfleveretKl: string | null;
  // Køberen har smidt pakken ud (sagen oprettet uden pakkebillede).
  pakkeSmidtUd: boolean;
  // Sælgerens svar (regel 3) - vises for køber og sælger (og staff).
  svar: MitSagSvar | null;
  // Sælgerens svarfrist (oprettet + 48 timer), og om DENNE bruger (sælgeren)
  // kan svare nu.
  svarFristKl: string | null;
  kanSvare: boolean;
  genaabnetKl: string | null;
  // Ankefrist: hvad der sker med pengene, tidligst hvornår, og om det er sket.
  pengeHandling: SagPengeHandling | null;
  pengeFlyttesEfterKl: string | null;
  afvikletKl: string | null;
  // Medhold til køber med retur: køberen venter med at sende varen, til
  // ankefristen er udløbet (sælgeren kan anke indtil da). Tidspunktet, eller
  // null, når returen kan sendes nu (fristen er udløbet, eller anken er afgjort).
  returVenterTilKl: string | null;
  // Køberen skal sende varen retur nu: fristen (7 dage efter beskeden), hvorefter
  // BidHamr kan afgøre sagen til sælgerens fordel. Ellers null.
  returFristKl: string | null;
  erKoeber: boolean;
  billeder: { id: string; kategori: SagBilledeKategori; url: string | null; oprettetKl: string }[];
  // Sælgerens billeder af indpakningen fra "Send pakke" (tom ved afhentning
  // og ved handler sendt før pakkebilleder blev krævet).
  pakkebilleder: VistPakkeBillede[];
  // Anken (højst én pr. sag), eller null.
  anke: MinAnke | null;
  // Kan den indloggede bruger anke lige nu? (sag_anke_mulighed)
  ankeMulighed: AnkeMulighed;
};

export type MitSagSvar = {
  tekst: string;
  oprettetKl: string;
  billeder: { id: string; kategori: SagBilledeKategori; url: string | null; oprettetKl: string }[];
};

export type MinAnke = {
  id: string;
  // Hvem ankede.
  part: "koeber" | "saelger";
  egen: boolean;
  begrundelse: string;
  indgivetKl: string;
  status: SagAnkeStatus;
  behandletKl: string | null;
  // BidHamrs begrundelse for afgørelsen på anken (til begge parter).
  afgoerelseBegrundelse: string | null;
  billeder: { id: string; kategori: SagBilledeKategori; url: string | null; oprettetKl: string }[];
};

export type AnkeMulighed = {
  kode: SagAnkeMulighedKode;
  // Knappen åbner (afgørelse + 24 timer) og lukker (afgørelse + 4 dage).
  fraKl: string | null;
  tilKl: string | null;
};

// Mulighederne for at oprette en sag (fælles med appen - src/lib/sagMuligheder.ts).
export type { SagMuligheder } from "@/lib/sagMuligheder";

function erUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function rensBilleder(billeder: unknown): SagBilledeInput[] | null {
  if (!Array.isArray(billeder) || billeder.length > SAG_MAKS_BILLEDER) return null;
  const ud: SagBilledeInput[] = [];
  for (const b of billeder) {
    if (!b || typeof b !== "object") return null;
    const { sti, kategori } = b as Record<string, unknown>;
    if (typeof sti !== "string" || sti.length > 200 || !erSagBilledeKategori(kategori)) return null;
    ud.push({ sti, kategori });
  }
  return ud;
}

// Køberen opretter en sag. billeder: stier fra upload til 'sag-billeder'.
// Samme kode som appen (src/lib/sagHandlinger.ts opretSagFor).
export async function opretSag(
  tradeId: string,
  type: string,
  beskrivelse: string,
  billeder: SagBilledeInput[],
  // Regel 2 (20261102210000): køberen har ikke pakken længere - forklaring
  // på mindst 20 tegn; sagen markeres til staffs vurdering.
  smidtUd: { pakkeSmidtUd: boolean; begrundelse: string } | null = null,
  // Køberens valg i trin 1 (sagValg.ts). Ved "tom" kræves kun billedet af
  // pakken med labelen (20261102350000).
  valg: string | null = null,
): Promise<{ ok: true; sagId: string } | { fejl: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: SAG_OPRET_FEJL.ikke_logget_ind };
    const r = await opretSagFor(supabase, user.id, {
      tradeId,
      type,
      beskrivelse,
      billeder,
      pakkeSmidtUd: !!smidtUd?.pakkeSmidtUd,
      smidtUdBegrundelse: smidtUd?.begrundelse ?? null,
      valg,
    });
    if ("fejl" in r) return { fejl: r.fejl };
    revalidatePath(sagSti(tradeId));
    revalidatePath("/mine-handler");
    revalidatePath("/admin", "layout");
    return { ok: true, sagId: r.sagId };
  } catch (err) {
    unstable_rethrow(err);
    console.error("opretSag fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "sager", hvor: "opretSag", fejl: err });
    return { fejl: GENERISK };
  }
}

// Køberen tilføjer flere billeder til sin åbne sag.
export async function tilfoejSagBilleder(
  sagId: string,
  billeder: SagBilledeInput[],
): Promise<{ ok: true } | { fejl: string }> {
  try {
    if (!erUuid(sagId)) return { fejl: "Sagen findes ikke." };
    const rene = rensBilleder(billeder);
    if (!rene || rene.length === 0) return { fejl: SAG_OPRET_FEJL.ugyldige_billeder };

    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: SAG_OPRET_FEJL.ikke_logget_ind };

    const { data, error } = await supabase.rpc("sag_tilfoej_billeder", {
      p_sag: sagId,
      p_billeder: rene,
    });
    if (error) {
      console.error("sag_tilfoej_billeder fejlede:", error);
      await logDriftFejl({ kilde: "action", sti: "sager", hvor: "sag_tilfoej_billeder", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    const kode = (data as { kode: string } | null)?.kode;
    if (kode !== "ok") {
      return { fejl: kode === "ikke_fundet" ? "Sagen findes ikke." : (SAG_OPRET_FEJL[kode ?? ""] ?? GENERISK) };
    }
    revalidatePath("/mine-handler", "layout");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("tilfoejSagBilleder fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "sager", hvor: "tilfoejSagBilleder", fejl: err });
    return { fejl: GENERISK };
  }
}

// Sælgeren svarer på en sag (regel 3, 20261102210000): tekst og billeder,
// én gang, inden for 48 timer fra oprettelsen. billeder: stier fra upload til
// 'sag-billeder' i sælgerens egen mappe (<sælger-id>/<handel-id>/...).
// Databasen (sag_svar_send) tjekker part, frist, kontaktinfo og billeder.
// Appen: POST /api/sag/app/svar (samme kode - svarPaaSagFor).
export async function svarPaaSag(
  sagId: string,
  tekst: string,
  billeder: SagBilledeInput[],
): Promise<{ ok: true } | { fejl: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: SAG_SVAR_FEJL.ikke_logget_ind };
    const r = await svarPaaSagFor(supabase, user.id, { sagId, tekst, billeder });
    if ("fejl" in r) return { fejl: r.fejl };
    revalidatePath("/mine-handler", "layout");
    revalidatePath("/admin", "layout");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("svarPaaSag fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "sager", hvor: "svarPaaSag", fejl: err });
    return { fejl: GENERISK };
  }
}

// Den part, der tabte sagen, anker afgørelsen. billeder: stier fra upload til
// 'sag-billeder' i brugerens egen mappe (valgfri ny dokumentation).
// Databasen (sag_anke_indgiv) tjekker part, frist, én anke pr. sag og billeder.
export async function indgivAnke(
  sagId: string,
  begrundelse: string,
  billeder: SagBilledeInput[],
): Promise<{ ok: true; ankeId: string } | { fejl: string }> {
  try {
    if (!erUuid(sagId)) return { fejl: SAG_ANKE_FEJL.ikke_fundet };
    const tekst = typeof begrundelse === "string" ? begrundelse.trim() : "";
    if (tekst.length < SAG_ANKE_BEGRUNDELSE_MIN || tekst.length > SAG_ANKE_BEGRUNDELSE_MAKS) {
      return { fejl: SAG_ANKE_FEJL.ugyldig_begrundelse };
    }
    const rene = rensBilleder(billeder ?? []);
    if (!rene || rene.length > SAG_ANKE_MAKS_BILLEDER) return { fejl: SAG_ANKE_FEJL.ugyldige_billeder };

    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: SAG_ANKE_FEJL.ikke_logget_ind };

    const { data, error } = await supabase.rpc("sag_anke_indgiv", {
      p_sag: sagId,
      p_begrundelse: tekst,
      p_billeder: rene,
    });
    if (error) {
      console.error("sag_anke_indgiv fejlede:", error);
      await logDriftFejl({ kilde: "action", sti: "sager", hvor: "sag_anke_indgiv", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    const svar = data as { kode: string; anke_id?: string } | null;
    if (!svar || svar.kode !== "ok" || !svar.anke_id) {
      return { fejl: SAG_ANKE_FEJL[svar?.kode ?? ""] ?? GENERISK };
    }
    const ankeId = svar.anke_id;

    // Besked til begge parter (påkrævet type 'sag'). Kaster aldrig; cron
    // samler op, hvis det fejler.
    after(() => notificerAnkeIndgivet(ankeId));

    revalidatePath("/mine-handler", "layout");
    revalidatePath("/admin", "layout");
    return { ok: true, ankeId };
  } catch (err) {
    unstable_rethrow(err);
    console.error("indgivAnke fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "sager", hvor: "indgivAnke", fejl: err });
    return { fejl: GENERISK };
  }
}

const SAG_KOLONNER =
  "id, trade_id, type, koeber_valg, beskrivelse, status, oprettet_kl, afgjort_kl, begrundelse, retur_kraeves, returfragt_betaler, retur_afleveret_kl, genaabnet_kl, penge_handling, penge_flyttes_efter_kl, afviklet_kl";

type SagRaekke = {
  id: string;
  trade_id: string;
  type: SagType;
  koeber_valg: string | null;
  beskrivelse: string;
  status: SagStatus;
  oprettet_kl: string;
  penge_handling: SagPengeHandling | null;
  penge_flyttes_efter_kl: string | null;
  afviklet_kl: string | null;
  afgjort_kl: string | null;
  begrundelse: string | null;
  retur_kraeves: boolean;
  returfragt_betaler: "koeber" | "saelger" | "bidhamr" | null;
  retur_afleveret_kl: string | null;
  genaabnet_kl: string | null;
};

type SvarRaekke = { id: string; tekst: string; oprettet_kl: string };
type SvarBilledeRaekke = { id: string; sti: string; kategori: SagBilledeKategori; oprettet_kl: string };

// Sælgerens svar og "smidt ud" (20261102210000). Tåler en database uden
// migrationen (så findes der intet svar).
async function hentSvar(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sagId: string,
): Promise<{ svar: SvarRaekke | null; billeder: SvarBilledeRaekke[]; smidtUd: boolean }> {
  const [{ data: svar, error }, { data: smidt }] = await Promise.all([
    supabase.from("sag_svar").select("id, tekst, oprettet_kl").eq("sag_id", sagId).maybeSingle<SvarRaekke>(),
    supabase.from("sager").select("pakke_smidt_ud").eq("id", sagId).maybeSingle<{ pakke_smidt_ud: boolean }>(),
  ]);
  if (error || !svar) return { svar: null, billeder: [], smidtUd: !!smidt?.pakke_smidt_ud };
  const { data: billeder } = await supabase
    .from("sag_svar_billeder")
    .select("id, sti, kategori, oprettet_kl")
    .eq("svar_id", svar.id)
    .order("oprettet_kl", { ascending: true })
    .overrideTypes<SvarBilledeRaekke[], { merge: false }>();
  return { svar, billeder: billeder ?? [], smidtUd: !!smidt?.pakke_smidt_ud };
}

// Sagen på en handel for køber eller sælger (null = ingen sag). Billederne
// får signerede links (1 time). Alt hentes med brugerens egen session, så RLS
// afgør adgangen.
export async function hentSagForHandel(
  tradeId: string,
): Promise<{ sag: MinSag | null } | { fejl: string }> {
  try {
    if (!erUuid(tradeId)) return { fejl: "Handlen findes ikke." };
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: SAG_OPRET_FEJL.ikke_logget_ind };

    const { data: handel } = await supabase
      .from("trades")
      .select("id, buyer_id, seller_id")
      .eq("id", tradeId)
      .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
      .maybeSingle<{ id: string; buyer_id: string; seller_id: string }>();
    if (!handel) return { fejl: "Handlen findes ikke." };

    const { data: sag, error } = await supabase
      .from("sager")
      .select(SAG_KOLONNER)
      .eq("trade_id", tradeId)
      .order("oprettet_kl", { ascending: false })
      .limit(1)
      .maybeSingle<SagRaekke>();
    if (error) throw new Error(error.message);
    if (!sag) return { sag: null };

    const { data: billeder } = await supabase
      .from("sag_billeder")
      .select("id, sti, kategori, oprettet_kl")
      .eq("sag_id", sag.id)
      .order("oprettet_kl", { ascending: true })
      .overrideTypes<{ id: string; sti: string; kategori: SagBilledeKategori; oprettet_kl: string }[], { merge: false }>();

    // BidHamr Beskyttelse må kun ses af køberen selv (kolonnen er ikke
    // læsbar for brugere). Hentes med service-role, kun når kalderen er køber.
    const erKoeber = handel.buyer_id === user.id;
    let beskyttelse = false;
    let nyPrismodel = false;
    if (erKoeber) {
      const admin = createAdminClient();
      const [{ data: b }, model] = await Promise.all([
        admin.from("sager").select("beskyttelse").eq("id", sag.id).maybeSingle<{ beskyttelse: boolean }>(),
        // prismodel findes først efter 20261031010000 - fejl = gammel model.
        admin.from("betalinger").select("prismodel").eq("trade_id", tradeId).maybeSingle<{ prismodel: string | null }>(),
      ]);
      beskyttelse = !!b?.beskyttelse;
      nyPrismodel = !model.error && erNyPrivatPrismodel(model.data?.prismodel);
    }

    // Anken (RLS: kun parterne) og om brugeren kan anke lige nu.
    const [{ data: anke }, { data: mulighed }] = await Promise.all([
      supabase
        .from("sag_anker")
        .select("id, part, begrundelse, indgivet_kl, status, behandlet_kl, afgoerelse_begrundelse")
        .eq("sag_id", sag.id)
        .maybeSingle<{
          id: string;
          part: "koeber" | "saelger";
          begrundelse: string;
          indgivet_kl: string;
          status: SagAnkeStatus;
          behandlet_kl: string | null;
          afgoerelse_begrundelse: string | null;
        }>(),
      supabase.rpc("sag_anke_mulighed", { p_sag: sag.id }),
    ]);
    const { data: ankeBilleder } = anke
      ? await supabase
          .from("sag_anke_billeder")
          .select("id, sti, kategori, oprettet_kl")
          .eq("anke_id", anke.id)
          .order("oprettet_kl", { ascending: true })
          .overrideTypes<{ id: string; sti: string; kategori: SagBilledeKategori; oprettet_kl: string }[], { merge: false }>()
      : { data: [] as { id: string; sti: string; kategori: SagBilledeKategori; oprettet_kl: string }[] };
    const m = (mulighed ?? null) as { kode?: string; fra_kl?: string | null; til_kl?: string | null } | null;
    const svarInfo = await hentSvar(supabase, sag.id);
    const svarFristKl = sagSvarFristKl(sag.oprettet_kl);

    const stier = [...(billeder ?? []), ...(ankeBilleder ?? []), ...svarInfo.billeder].map((b) => b.sti);
    const urls = new Map<string, string>();
    const [signeret, pakkebilleder] = await Promise.all([
      stier.length > 0
        ? supabase.storage.from(SAG_BUCKET).createSignedUrls(stier, 3600)
        : Promise.resolve({ data: [] as { path: string | null; signedUrl: string }[] }),
      // Med brugerens egen session: storage-policyen giver køberen adgang til
      // pakkebilleder, der er knyttet til handlen (dvs. efter afsendelsen).
      hentPakkeBilleder(supabase, tradeId),
    ]);
    for (const s of signeret.data ?? []) {
      if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
    }

    return {
      sag: {
        id: sag.id,
        tradeId: sag.trade_id,
        type: sag.type,
        koeberValg: erSagValgId(sag.koeber_valg) ? sag.koeber_valg : null,
        beskrivelse: sag.beskrivelse,
        status: sag.status,
        beskyttelse,
        nyPrismodel,
        oprettetKl: sag.oprettet_kl,
        afgjortKl: sag.afgjort_kl,
        begrundelse: sag.begrundelse,
        returKraeves: sag.retur_kraeves,
        returfragtBetaler: sag.returfragt_betaler,
        returAfleveretKl: sag.retur_afleveret_kl,
        pakkeSmidtUd: svarInfo.smidtUd,
        svar: svarInfo.svar
          ? {
              tekst: svarInfo.svar.tekst,
              oprettetKl: svarInfo.svar.oprettet_kl,
              billeder: svarInfo.billeder.map((b) => ({
                id: b.id,
                kategori: b.kategori,
                url: urls.get(b.sti) ?? null,
                oprettetKl: b.oprettet_kl,
              })),
            }
          : null,
        svarFristKl,
        kanSvare:
          !erKoeber &&
          !svarInfo.svar &&
          sag.status === "aaben" &&
          !!svarFristKl &&
          Date.parse(svarFristKl) > Date.now(),
        genaabnetKl: sag.genaabnet_kl,
        pengeHandling: sag.penge_handling,
        pengeFlyttesEfterKl: sag.penge_flyttes_efter_kl,
        afvikletKl: sag.afviklet_kl,
        returVenterTilKl:
          sag.status === "afventer_retur" &&
          !anke &&
          !sag.retur_afleveret_kl &&
          !!sag.penge_flyttes_efter_kl &&
          Date.parse(sag.penge_flyttes_efter_kl) > Date.now()
            ? sag.penge_flyttes_efter_kl
            : null,
        returFristKl:
          sag.status === "afventer_retur" &&
          !sag.retur_afleveret_kl &&
          anke?.status !== "afventer" &&
          !(
            !anke &&
            !!sag.penge_flyttes_efter_kl &&
            Date.parse(sag.penge_flyttes_efter_kl) > Date.now()
          )
            ? sagReturFristKl(sag.penge_flyttes_efter_kl, sag.afgjort_kl, anke?.behandlet_kl ?? null)
            : null,
        erKoeber,
        billeder: (billeder ?? []).map((b) => ({
          id: b.id,
          kategori: b.kategori,
          url: urls.get(b.sti) ?? null,
          oprettetKl: b.oprettet_kl,
        })),
        pakkebilleder,
        anke: anke
          ? {
              id: anke.id,
              part: anke.part,
              egen: (anke.part === "koeber") === erKoeber,
              begrundelse: anke.begrundelse,
              indgivetKl: anke.indgivet_kl,
              status: anke.status,
              behandletKl: anke.behandlet_kl,
              afgoerelseBegrundelse: anke.afgoerelse_begrundelse,
              billeder: (ankeBilleder ?? []).map((b) => ({
                id: b.id,
                kategori: b.kategori,
                url: urls.get(b.sti) ?? null,
                oprettetKl: b.oprettet_kl,
              })),
            }
          : null,
        ankeMulighed: {
          kode: (m?.kode ?? "ingen_anke") as SagAnkeMulighedKode,
          fraKl: m?.fra_kl ?? null,
          tilKl: m?.til_kl ?? null,
        },
      },
    };
  } catch (err) {
    unstable_rethrow(err);
    console.error("hentSagForHandel fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Hvilke sager kan køberen oprette lige nu? Til "Meld et problem" på
// handelssiden. Samme kode som appens endpoint (src/lib/sagMuligheder.ts).
// Databasen (sag_opret) er stadig den endelige dommer.
export async function hentSagMuligheder(
  tradeId: string,
): Promise<SagMuligheder | { fejl: string }> {
  try {
    if (!erUuid(tradeId)) return { fejl: "Handlen findes ikke." };
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: SAG_OPRET_FEJL.ikke_logget_ind };
    const r = await hentSagMulighederFor(user.id, tradeId);
    return "fejl" in r ? { fejl: r.fejl } : r;
  } catch (err) {
    unstable_rethrow(err);
    console.error("hentSagMuligheder fejlede:", err);
    return { fejl: GENERISK };
  }
}
