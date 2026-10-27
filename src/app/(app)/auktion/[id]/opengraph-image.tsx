// Delebillede pr. auktion (Open Graph, 1200x630): varebillede, titel,
// nuværende bud og BidHamr-logoet (Filip, 27. okt. 2026 - punkt 4 i "Nye
// funktioner før lancering"). Next lægger og:image på /auktion/<id> af sig
// selv (filkonventionen går forud for billederne i generateMetadata).
//
// Hvad billedet må vise:
// - Auktionen hentes med en anonym klient UDEN cookies (RLS som for en
//   besøgende uden login: kun aktive, ikke-skjulte auktioner), så billedet er
//   det samme for alle - også når sælgeren selv eller en byder deler, og i
//   en delt cache. Kan auktionen ikke ses anonymt, vises kun BidHamr-logoet.
// - Cache-Control: public, s-maxage=300 (5 minutter i CDN'en), så prisen
//   aldrig er ret gammel, og alle får det samme billede.
// - Før lancering viser billedet aldrig auktionsdata, kun logoet - som
//   coming soon (proxyen sender i forvejen besøgende uden login til
//   /coming-soon, så delingstjenester ser coming soon-sidens delebillede).
// - Ingen sælgeroplysninger eller bud-historik - kun titel og pris.
// - Varebilledet hentes kun fra vores egen Supabase-lagring (kanOptimeres),
//   som JPEG/PNG, højst 5 MB, med timeout - aldrig fra en vilkårlig adresse.
//   Stier med ".." eller "%2e" (også "%2E", "%252e") afvises, så en
//   adresse ikke kan pege ud af den offentlige lagring.
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAnonClient } from "@/lib/supabase/anon";
import { farligBilledSti, kanOptimeres } from "@/lib/billedUrl";
import { foerLancering } from "@/lib/lancering";

export const alt = "Auktion på BidHamr";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GROEN = "#1E5E4A";
const GROEN_MORK = "#154537";
const TEKST = "#1A1A1A";
const DAEMPET = "#555555";
const MAKS_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Samme billede for alle (anonym hentning), 5 minutter i CDN'en.
const CACHE = { "Cache-Control": "public, max-age=0, s-maxage=300, must-revalidate" };
// Kun de kolonner, billedet viser. Typet som string, fordi supabase-js ikke
// kan parse "nuværende_bud" i en select-streng (src/lib/auktionKolonner.ts).
const KOLONNER: string = "id, titel, status, slutter_kl, skjult, startpris, nuværende_bud, antal_bud, billeder";
type Raekke = {
  titel: string | null;
  status: string | null;
  slutter_kl: string;
  skjult: boolean | null;
  startpris: number | null;
  nuværende_bud: number | null;
  antal_bud: number | null;
  billeder: unknown;
};

const SKRIFTER = path.join(process.cwd(), "src", "lib", "pdf", "skrifter");
const LOGO = path.join(process.cwd(), "public", "brand", "bidhamr-logo-512.png");

async function hentFiler() {
  const [regular, semibold, logo] = await Promise.all([
    readFile(path.join(SKRIFTER, "Inter-Regular.ttf")),
    readFile(path.join(SKRIFTER, "Inter-SemiBold.ttf")),
    readFile(LOGO),
  ]);
  return { regular, semibold, logo: `data:image/png;base64,${logo.toString("base64")}` };
}

// Varebilledet som data-URL, eller null (fremmed adresse, forkert type, for
// stort, timeout). Kaster aldrig.
async function varebillede(url: string | undefined): Promise<string | null> {
  if (!url || farligBilledSti(url) || !kanOptimeres(url)) return null;
  try {
    const svar = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!svar.ok) return null;
    const type = (svar.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "image/jpeg" && type !== "image/png") return null;
    const laengde = Number(svar.headers.get("content-length") ?? 0);
    if (laengde > MAKS_BYTES) return null;
    const data = Buffer.from(await svar.arrayBuffer());
    if (data.byteLength > MAKS_BYTES) return null;
    return `data:${type};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

const kr = (n: number) => `${n.toLocaleString("da-DK", { maximumFractionDigits: 0 })} kr.`;

function kortTitel(t: string): string {
  const ren = t.trim().replace(/\s+/g, " ");
  return ren.length > 80 ? `${ren.slice(0, 77)}...` : ren;
}

type Visning = { titel: string; prisLabel: string; pris: string; billede: string | null };

async function hentVisning(id: string): Promise<Visning | null> {
  if (foerLancering()) return null;
  try {
    if (!UUID.test(id)) return null;
    const { data: a } = await createAnonClient()
      .from("auctions")
      .select(KOLONNER)
      .eq("id", id)
      .maybeSingle<Raekke>();
    if (!a || a.skjult) return null;
    const aktiv = a.status === "aktiv" && new Date(a.slutter_kl) > new Date();
    if (a.status === "annulleret") return null;
    const bud = a.nuværende_bud != null && Number(a.antal_bud ?? 0) > 0 ? Number(a.nuværende_bud) : null;
    const billeder = Array.isArray(a.billeder) ? (a.billeder as unknown[]).filter((b): b is string => typeof b === "string") : [];
    return {
      titel: kortTitel(String(a.titel ?? "")),
      prisLabel: !aktiv ? "Auktionen er slut" : bud != null ? "Nuværende bud" : "Startpris",
      pris: kr(bud ?? Number(a.startpris ?? 0)),
      billede: await varebillede(billeder[0]),
    };
  } catch {
    return null;
  }
}

function Logo({ src, stor = false }: { src: string; stor?: boolean }) {
  const s = stor ? 120 : 64;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: stor ? 28 : 18 }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse (satori) kræver <img> */}
      <img src={src} width={s} height={s} alt="" style={{ borderRadius: stor ? 28 : 16 }} />
      <div style={{ fontSize: stor ? 96 : 44, fontWeight: 600, color: stor ? "white" : GROEN, letterSpacing: -1.5 }}>
        BidHamr
      </div>
    </div>
  );
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [filer, v] = await Promise.all([hentFiler(), hentVisning(id)]);
  const fonts = [
    { name: "Inter", data: filer.regular, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: filer.semibold, weight: 600 as const, style: "normal" as const },
  ];

  if (!v) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: GROEN,
            fontFamily: "Inter",
          }}
        >
          <Logo src={filer.logo} stor />
        </div>
      ),
      { ...size, fonts, headers: CACHE },
    );
  }

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "white", fontFamily: "Inter" }}>
        {v.billede ? (
          // eslint-disable-next-line @next/next/no-img-element -- ImageResponse (satori) kræver <img>
          <img src={v.billede} width={630} height={630} alt="" style={{ width: 630, height: 630, objectFit: "cover" }} />
        ) : (
          <div style={{ width: 630, height: 630, display: "flex", alignItems: "center", justifyContent: "center", background: GROEN }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse (satori) kræver <img> */}
            <img src={filer.logo} width={260} height={260} alt="" style={{ borderRadius: 56 }} />
          </div>
        )}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "48px 52px",
            borderLeft: `10px solid #E8772E`,
          }}
        >
          <Logo src={filer.logo} />
          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            <div style={{ fontSize: 46, lineHeight: 1.15, fontWeight: 600, color: TEKST }}>{v.titel}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 28, color: DAEMPET }}>{v.prisLabel}</div>
              <div style={{ fontSize: 64, fontWeight: 600, color: GROEN_MORK }}>{v.pris}</div>
            </div>
          </div>
          <div style={{ fontSize: 26, color: DAEMPET }}>bidhamr.dk</div>
        </div>
      </div>
    ),
    { ...size, fonts, headers: CACHE },
  );
}
