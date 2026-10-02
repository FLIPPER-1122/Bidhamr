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
//   supabase.rpc("sag_opret", { p_trade, p_type, p_beskrivelse, p_billeder: [{ sti, kategori }] })
//       -> { kode: "ok", sag_id } | { kode: <fejlkode> } (se SAG_OPRET_FEJL)
//   supabase.rpc("sag_tilfoej_billeder", { p_sag, p_billeder })
//   supabase.from("sager").select("id, trade_id, type, beskrivelse, status,
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
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notificerSagOprettet } from "@/lib/sagerServer";
import {
  SAG_AUTO_FRIGIV_EFTER_DAGE,
  SAG_BESKRIVELSE_MAKS,
  SAG_BESKRIVELSE_MIN,
  SAG_BORTKOMMET_EFTER_DAGE,
  SAG_BUCKET,
  SAG_FRIST_TIMER_EFTER_MODTAGET,
  SAG_MAKS_BILLEDER,
  SAG_OPRET_FEJL,
  type SagBilledeKategori,
  type SagPengeHandling,
  type SagStatus,
  type SagType,
  erSagBilledeKategori,
  erSagType,
  sagKraeverBeskyttelse,
  sagSti,
} from "@/lib/sager";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = 60 * 60 * 1000;
const DAG = 24 * TIME;

export type SagBilledeInput = { sti: string; kategori: SagBilledeKategori };

export type MinSag = {
  id: string;
  tradeId: string;
  type: SagType;
  beskrivelse: string;
  status: SagStatus;
  // Kun for køberen (sælgeren får altid false - han må ikke se det).
  beskyttelse: boolean;
  oprettetKl: string;
  afgjortKl: string | null;
  // Begrundelsen fra BidHamr til køber og sælger.
  begrundelse: string | null;
  returKraeves: boolean;
  returfragtBetaler: "bidhamr" | null;
  returAfleveretKl: string | null;
  genaabnetKl: string | null;
  // Ankefrist: hvad der sker med pengene, tidligst hvornår, og om det er sket.
  pengeHandling: SagPengeHandling | null;
  pengeFlyttesEfterKl: string | null;
  afvikletKl: string | null;
  erKoeber: boolean;
  billeder: { id: string; kategori: SagBilledeKategori; url: string | null; oprettetKl: string }[];
};

export type SagMuligheder = {
  // Typer, køberen kan vælge lige nu (tom = ingen sag mulig).
  typer: SagType[];
  // Typer, der kræver BidHamr Beskyttelse, som køberen ikke har.
  kraeverBeskyttelse: SagType[];
  beskyttelse: boolean;
  // Billeder af pakke, label og indhold kræves (pakken er modtaget).
  billederKraeves: boolean;
  // Sidste frist for at oprette en sag: 48 timer efter "modtaget", eller -
  // når pakken er sendt - 14 dage efter afsendelse (så frigives pengene
  // automatisk).
  fristKl: string | null;
  // Hvornår "Pakken er ikke kommet frem" kan vælges (pakke sendt).
  bortkommetFraKl: string | null;
  // Der findes allerede en sag (så vises den i stedet).
  harSag: boolean;
};

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
export async function opretSag(
  tradeId: string,
  type: string,
  beskrivelse: string,
  billeder: SagBilledeInput[],
): Promise<{ ok: true; sagId: string } | { fejl: string }> {
  try {
    if (!erUuid(tradeId)) return { fejl: SAG_OPRET_FEJL.ikke_fundet };
    if (!erSagType(type)) return { fejl: SAG_OPRET_FEJL.ugyldig_type };
    const tekst = typeof beskrivelse === "string" ? beskrivelse.trim() : "";
    if (tekst.length < SAG_BESKRIVELSE_MIN || tekst.length > SAG_BESKRIVELSE_MAKS) {
      return { fejl: SAG_OPRET_FEJL.ugyldig_beskrivelse };
    }
    const rene = rensBilleder(billeder ?? []);
    if (!rene) return { fejl: SAG_OPRET_FEJL.ugyldige_billeder };

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: SAG_OPRET_FEJL.ikke_logget_ind };

    const { data, error } = await supabase.rpc("sag_opret", {
      p_trade: tradeId,
      p_type: type,
      p_beskrivelse: tekst,
      p_billeder: rene,
    });
    if (error) {
      console.error("sag_opret fejlede:", error);
      return { fejl: GENERISK };
    }
    const svar = data as { kode: string; sag_id?: string } | null;
    if (!svar || svar.kode !== "ok" || !svar.sag_id) {
      return { fejl: SAG_OPRET_FEJL[svar?.kode ?? ""] ?? GENERISK };
    }
    const sagId = svar.sag_id;

    // Notifikationer til køber og sælger (påkrævet type 'sag'). Kaster aldrig.
    after(() => notificerSagOprettet(sagId));

    revalidatePath(sagSti(tradeId));
    revalidatePath("/mine-handler");
    revalidatePath("/admin", "layout");
    return { ok: true, sagId };
  } catch (err) {
    unstable_rethrow(err);
    console.error("opretSag fejlede:", err);
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
    } = await supabase.auth.getUser();
    if (!user) return { fejl: SAG_OPRET_FEJL.ikke_logget_ind };

    const { data, error } = await supabase.rpc("sag_tilfoej_billeder", {
      p_sag: sagId,
      p_billeder: rene,
    });
    if (error) {
      console.error("sag_tilfoej_billeder fejlede:", error);
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
    return { fejl: GENERISK };
  }
}

const SAG_KOLONNER =
  "id, trade_id, type, beskrivelse, status, oprettet_kl, afgjort_kl, begrundelse, retur_kraeves, returfragt_betaler, retur_afleveret_kl, genaabnet_kl, penge_handling, penge_flyttes_efter_kl, afviklet_kl";

type SagRaekke = {
  id: string;
  trade_id: string;
  type: SagType;
  beskrivelse: string;
  status: SagStatus;
  oprettet_kl: string;
  penge_handling: SagPengeHandling | null;
  penge_flyttes_efter_kl: string | null;
  afviklet_kl: string | null;
  afgjort_kl: string | null;
  begrundelse: string | null;
  retur_kraeves: boolean;
  returfragt_betaler: "bidhamr" | null;
  retur_afleveret_kl: string | null;
  genaabnet_kl: string | null;
};

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
    } = await supabase.auth.getUser();
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
    if (erKoeber) {
      const { data: b } = await createAdminClient()
        .from("sager")
        .select("beskyttelse")
        .eq("id", sag.id)
        .maybeSingle<{ beskyttelse: boolean }>();
      beskyttelse = !!b?.beskyttelse;
    }

    const stier = (billeder ?? []).map((b) => b.sti);
    const urls = new Map<string, string>();
    if (stier.length > 0) {
      const { data: signerede } = await supabase.storage
        .from(SAG_BUCKET)
        .createSignedUrls(stier, 3600);
      for (const s of signerede ?? []) {
        if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
      }
    }

    return {
      sag: {
        id: sag.id,
        tradeId: sag.trade_id,
        type: sag.type,
        beskrivelse: sag.beskrivelse,
        status: sag.status,
        beskyttelse,
        oprettetKl: sag.oprettet_kl,
        afgjortKl: sag.afgjort_kl,
        begrundelse: sag.begrundelse,
        returKraeves: sag.retur_kraeves,
        returfragtBetaler: sag.returfragt_betaler,
        returAfleveretKl: sag.retur_afleveret_kl,
        genaabnetKl: sag.genaabnet_kl,
        pengeHandling: sag.penge_handling,
        pengeFlyttesEfterKl: sag.penge_flyttes_efter_kl,
        afvikletKl: sag.afviklet_kl,
        erKoeber,
        billeder: (billeder ?? []).map((b) => ({
          id: b.id,
          kategori: b.kategori,
          url: urls.get(b.sti) ?? null,
          oprettetKl: b.oprettet_kl,
        })),
      },
    };
  } catch (err) {
    unstable_rethrow(err);
    console.error("hentSagForHandel fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Hvilke sager kan køberen oprette lige nu? Til knappen "Opret sag" på
// handelssiden. Databasen (sag_opret) er stadig den endelige dommer.
export async function hentSagMuligheder(
  tradeId: string,
): Promise<SagMuligheder | { fejl: string }> {
  try {
    if (!erUuid(tradeId)) return { fejl: "Handlen findes ikke." };
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: SAG_OPRET_FEJL.ikke_logget_ind };

    // Kun køberen. Hentes med brugerens session (RLS), derefter detaljer med
    // service-role (sendt_kl/betalingen er ikke læsbare for brugeren).
    const { data: rls } = await supabase
      .from("trades")
      .select("id")
      .eq("id", tradeId)
      .eq("buyer_id", user.id)
      .maybeSingle();
    if (!rls) return { fejl: "Handlen findes ikke." };

    const admin = createAdminClient();
    const [{ data: t }, { data: b }, { count }] = await Promise.all([
      admin
        .from("trades")
        .select("status, received_at, sendt_kl")
        .eq("id", tradeId)
        .single<{ status: string; received_at: string | null; sendt_kl: string | null }>(),
      admin
        .from("betalinger")
        .select(
          "status, beskyttelse, betalt_kl, frigivet_kl, refusion_anmodet_kl, overfoersel_paabegyndt_kl, stripe_transfer_id",
        )
        .eq("trade_id", tradeId)
        .maybeSingle<{
          status: string;
          beskyttelse: boolean;
          betalt_kl: string | null;
          frigivet_kl: string | null;
          refusion_anmodet_kl: string | null;
          overfoersel_paabegyndt_kl: string | null;
          stripe_transfer_id: string | null;
        }>(),
      admin.from("sager").select("id", { count: "exact", head: true }).eq("trade_id", tradeId),
    ]);

    const tom: SagMuligheder = {
      typer: [],
      kraeverBeskyttelse: [],
      beskyttelse: !!b?.beskyttelse,
      billederKraeves: false,
      fristKl: null,
      bortkommetFraKl: null,
      harSag: (count ?? 0) > 0,
    };
    if (!t || !b || tom.harSag) return tom;
    if (
      b.status !== "betalt" ||
      b.frigivet_kl ||
      b.refusion_anmodet_kl ||
      b.overfoersel_paabegyndt_kl ||
      b.stripe_transfer_id
    ) {
      return tom;
    }

    const nu = Date.now();
    let kandidater: SagType[] = [];
    if (t.status === "modtaget" && t.received_at) {
      const frist = new Date(t.received_at).getTime() + SAG_FRIST_TIMER_EFTER_MODTAGET * TIME;
      tom.fristKl = new Date(frist).toISOString();
      tom.billederKraeves = true;
      if (frist > nu) kandidater = ["skadet", "ikke_som_beskrevet", "svindel"];
    } else if (t.status === "pakke_sendt") {
      const sendt = t.sendt_kl ?? b.betalt_kl;
      if (sendt) {
        const fra = new Date(sendt).getTime() + SAG_BORTKOMMET_EFTER_DAGE * DAG;
        // Efter 14 dage frigives pengene automatisk (handel_auto_frigiv).
        const til = new Date(sendt).getTime() + SAG_AUTO_FRIGIV_EFTER_DAGE * DAG;
        tom.bortkommetFraKl = new Date(fra).toISOString();
        tom.fristKl = new Date(til).toISOString();
        if (fra <= nu && nu < til) kandidater = ["bortkommet", "svindel"];
      }
    }

    tom.typer = kandidater.filter((k) => !sagKraeverBeskyttelse(k) || b.beskyttelse);
    tom.kraeverBeskyttelse = kandidater.filter((k) => sagKraeverBeskyttelse(k) && !b.beskyttelse);
    return tom;
  } catch (err) {
    unstable_rethrow(err);
    console.error("hentSagMuligheder fejlede:", err);
    return { fejl: GENERISK };
  }
}
