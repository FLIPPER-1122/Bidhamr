// Normalisering af stier til den cookiefri besøgsstatistik (tabellen
// sidevisninger, supabase/migrations/20261006050000_statistik.sql).
//
// Kun sidetyper på listen nedenfor gemmes. Id'er erstattes af "[id]", og
// query-strenge fjernes altid, så der aldrig gemmes noget, der kan pege på en
// bestemt bruger, handel eller auktion. Ukendte stier (fx 404) tælles samlet
// som "/ukendt". Admin, dev, api og auth tælles slet ikke (null).

const KENDTE_SIDER = new Set<string>([
  "/",
  "/coming-soon",
  "/auktioner",
  "/auktion/[id]",
  "/auktion/[id]/rediger",
  "/opret-auktion",
  "/profil/[id]",
  "/profil/mig",
  "/favoritter",
  "/mine-handler",
  "/mine-handler/[id]",
  "/mine-handler/[id]/kvittering",
  "/beskeder",
  "/beskeder/bidhamr/[id]",
  "/notifikationer",
  "/konto",
  "/konto/notifikationer",
  "/andenchance/[id]",
  "/login",
  "/signup",
  "/glemt-adgangskode",
  "/nulstil-adgangskode",
  "/reset-password",
  "/saadan-virker-det",
  "/faq",
  "/bidhamr-beskyttelse",
  "/forbudte-varer",
  "/pakkeguide",
  "/om",
  "/kontakt",
  "/cookies",
  "/tilgaengelighed",
  "/betingelser",
  "/privatliv",
]);

const IKKE_TALT = ["/admin", "/dev", "/api", "/auth", "/_next"];

// Faste ord efter første segment, som ikke er id'er.
const FASTE_SEGMENTER = new Set(["mig", "rediger", "kvittering", "bidhamr", "notifikationer"]);

export function normaliserSti(raa: unknown): string | null {
  if (typeof raa !== "string" || raa.length === 0 || raa.length > 500) return null;
  let sti = raa.split(/[?#]/)[0];
  if (!sti.startsWith("/")) return null;
  try {
    sti = decodeURIComponent(sti);
  } catch {
    return "/ukendt";
  }
  sti = sti.toLowerCase().replace(/\/{2,}/g, "/");
  if (sti.length > 1) sti = sti.replace(/\/+$/, "");

  if (IKKE_TALT.some((p) => sti === p || sti.startsWith(`${p}/`))) return null;

  const segmenter = sti.split("/").filter(Boolean);
  const moenster =
    "/" +
    segmenter
      .map((s, i) => {
        // Første segment er altid sidens navn. Senere segmenter er id'er,
        // medmindre de er faste ord (fx /profil/mig, /auktion/[id]/rediger).
        if (i === 0 || FASTE_SEGMENTER.has(s)) return s;
        return "[id]";
      })
      .join("/");

  return KENDTE_SIDER.has(moenster) ? moenster : "/ukendt";
}
