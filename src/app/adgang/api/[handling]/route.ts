import { NextResponse, type NextRequest } from "next/server";
import { erAdminVaert } from "@/lib/adminVaert";
import {
  bekraeftAdminKode,
  bekraeftMailKode,
  bekraeftToTrinOpsaet,
  gendanAdmin,
  logIndAdmin,
  logUdAdmin,
  sendMailKode,
  startToTrinOpsaet,
} from "@/lib/adgang";

// POST /adgang/api/<handling> - login og to-trins-login på admin-hosten
// (docs/ADMIN-VAERT.md). Route handler (ikke server actions): proxyen lader
// kun POST til /adgang/api/* igennem på /adgang, så der aldrig kan køres et
// vilkårligt action-id på login-siderne uden om gaten før lancering.
// Kun samme origin (Origin-headeren skal være admin-hosten), JSON, højst 4 KB.
// Svarene er de samme { ok } / { fejl } som før.

export const dynamic = "force-dynamic";

type Krop = Record<string, unknown>;
const tekst = (v: unknown) => (typeof v === "string" ? v : "");

const HANDLINGER: Record<string, (k: Krop) => Promise<unknown>> = {
  login: (k) => logIndAdmin(tekst(k.email), tekst(k.password)),
  kode: (k) => bekraeftAdminKode(tekst(k.kode)),
  "mail-kode": () => sendMailKode(),
  "mail-kode-bekraeft": (k) => bekraeftMailKode(tekst(k.kode)),
  "opsaet-start": () => startToTrinOpsaet(),
  "opsaet-bekraeft": (k) => bekraeftToTrinOpsaet(tekst(k.faktorId), tekst(k.kode)),
  gendan: (k) => gendanAdmin(tekst(k.email), tekst(k.password), tekst(k.gendannelseskode)),
  logud: () => logUdAdmin(),
};

function svar(status: number, krop: unknown) {
  return NextResponse.json(krop, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ handling: string }> }) {
  const host = req.headers.get("host");
  if (!erAdminVaert(host)) return svar(404, { fejl: "Siden findes ikke." });

  // CSRF: kun fra admin-hostens egne sider.
  const origin = req.headers.get("origin");
  let sammeOrigin = false;
  try {
    sammeOrigin = !!origin && new URL(origin).host === host;
  } catch {
    sammeOrigin = false;
  }
  if (!sammeOrigin) return svar(403, { fejl: "Ugyldig forespørgsel." });

  const { handling } = await params;
  const fn = Object.hasOwn(HANDLINGER, handling) ? HANDLINGER[handling] : null;
  if (!fn) return svar(404, { fejl: "Siden findes ikke." });

  const raa = await req.text();
  if (raa.length > 4096) return svar(413, { fejl: "Ugyldig forespørgsel." });
  let krop: Krop = {};
  if (raa) {
    try {
      const j = JSON.parse(raa) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) krop = j as Krop;
    } catch {
      return svar(400, { fejl: "Ugyldig forespørgsel." });
    }
  }
  return svar(200, await fn(krop));
}
