import { NextResponse, type NextRequest } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { erInhabil } from "@/lib/admin/sagTaget";
import { hentDokumentationData, hentSagParter } from "@/lib/sagDokumentation/data";
import { bygDokument } from "@/lib/sagDokumentation/indhold";
import { lavDokumentationPdf } from "@/lib/sagDokumentation/pdf";
import {
  LOG_FEJL,
  MAKS_PR_TIME,
  dokumentationAfvisning,
  dokumentationFilnavn,
  erUdgave,
  logFejlStatus,
  rensFelt,
  tjekFelter,
} from "@/lib/sagDokumentation/regler";

// "Dokumentation til sælger" / "Dokumentation til politiet" som PDF
// (ROADMAP-BESLUTNINGER, "Dokumentation til politiet (Filip, 27. okt. 2026)").
//
// POST /admin/sager/<id>/dokumentation  (formular: udgave, givet_til, journalnummer)
//   saelger: staff (medarbejder+) med to-trins-login, som ikke er inhabil.
//   politi:  kun chefen, som ikke er inhabil.
// Rollen og inhabiliteten tjekkes her og igen i databasen
// (sag_dokumentation_log), som også tjekker aktiv to-trins-login og loftet
// på MAKS_PR_TIME pr. time under en lås pr. medarbejder (20261102380000).
// PDF'en laves, udleveringen logges, og først derefter sendes PDF'en.
// Fejler et opslag eller loggen, sendes intet (500), og intet logges.
// PDF'en gemmes ikke.
// POST (ikke GET), så et link eller prefetch aldrig laver en udlevering.
// Fejl returneres som JSON { fejl } (dialogen viser teksten).

export const dynamic = "force-dynamic";
// Billederne hentes og indlejres - kan tage lidt tid.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fejl(status: number, tekst: string) {
  return NextResponse.json({ fejl: tekst }, { status, headers: { "Cache-Control": "no-store" } });
}

function egenOrigin(req: NextRequest): boolean {
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  try {
    return !!origin && !!vaert && new URL(origin).host === vaert;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let adgang: Awaited<ReturnType<typeof assertRole>>;
  try {
    adgang = await assertRole("medarbejder");
  } catch {
    return fejl(404, "Siden findes ikke.");
  }
  if (!egenOrigin(req)) return fejl(403, "Ugyldig forespørgsel.");

  const { id } = await ctx.params;
  if (!UUID.test(id)) return fejl(404, "Sagen findes ikke.");
  const sagId = id.toLowerCase();

  let udgaveRaa: unknown = null;
  let givetTil = "";
  let journalnummer = "";
  try {
    const f = await req.formData();
    udgaveRaa = f.get("udgave");
    givetTil = rensFelt(f.get("givet_til"));
    journalnummer = rensFelt(f.get("journalnummer"));
  } catch {
    return fejl(400, "Ugyldig forespørgsel.");
  }
  if (!erUdgave(udgaveRaa)) return fejl(400, "Ukendt udgave.");
  const udgave = udgaveRaa;
  const feltFejl = tjekFelter(udgave, givetTil, journalnummer);
  if (feltFejl) return fejl(400, feltFejl);

  const { admin, userId, rolle } = adgang;
  try {
    const parter = await hentSagParter(admin, sagId);
    if (!parter) return fejl(404, "Sagen findes ikke.");
    const inhabil = await erInhabil(admin, userId, parter.koeberId, parter.saelgerId);
    const afvist = dokumentationAfvisning(rolle, udgave, inhabil);
    if (afvist) return fejl(403, afvist);

    // Hurtig forhåndstælling, så PDF'en ikke laves forgæves. Loftet
    // håndhæves i databasen (sag_dokumentation_log, under lås).
    const { count, error: cErr } = await admin
      .from("sag_dokumentation_udlevering")
      .select("id", { count: "exact", head: true })
      .eq("lavet_af", userId)
      .gte("lavet_kl", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if (cErr) throw new Error(`sag_dokumentation_udlevering (antal): ${cErr.message}`);
    if ((count ?? 0) >= MAKS_PR_TIME) {
      return fejl(429, `Du har lavet ${MAKS_PR_TIME} PDF'er den seneste time. Vent lidt, og prøv igen.`);
    }

    const dannet = new Date();
    const data = await hentDokumentationData(admin, parter, udgave);
    const pdf = await lavDokumentationPdf(bygDokument(data, udgave, dannet));

    // Log udleveringen (databasen tjekker rolle og inhabilitet igen).
    const { data: log, error: logErr } = await admin.rpc("sag_dokumentation_log", {
      p_medarbejder: userId,
      p_sag: sagId,
      p_udgave: udgave,
      p_givet_til: givetTil,
      p_journalnummer: journalnummer || null,
    });
    if (logErr) throw new Error(`sag_dokumentation_log: ${logErr.message}`);
    const kode = (log as { kode?: string } | null)?.kode;
    if (kode !== "ok") return fejl(logFejlStatus(kode), LOG_FEJL[kode ?? ""] ?? "Udleveringen kunne ikke logges.");

    return new NextResponse(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${dokumentationFilnavn(udgave, sagId, dannet)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "admin/sager/dokumentation", fejl: err, brugerId: userId });
    return fejl(500, "PDF'en kunne ikke laves. Prøv igen om lidt.");
  }
}
