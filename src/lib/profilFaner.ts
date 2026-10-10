// Fanerne på egen profil (/profil/<id>?fane=...). Fælles for siden, fanebjælken
// og /profil/mig, så navnene kun står ét sted.

export const PROFIL_FANER = ["auktioner", "bud", "handler", "bedommelser", "indstillinger"] as const;
export type ProfilFane = (typeof PROFIL_FANER)[number];

export const PROFIL_FANE_NAVN: Record<ProfilFane, string> = {
  auktioner: "Mine auktioner",
  bud: "Mine bud",
  handler: "Mine handler",
  bedommelser: "Bedømmelser",
  indstillinger: "Indstillinger",
};

// Linket til fanen "Mine handler" (afløser /mine-handler, som sender videre).
export const MINE_HANDLER_HREF = "/profil/mig?fane=handler";

export function tilProfilFane(raw: string | string[] | null | undefined): ProfilFane {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (PROFIL_FANER as readonly string[]).includes(v ?? "") ? (v as ProfilFane) : "auktioner";
}

// Kun kendte parametre (fane og vis) tages med videre - aldrig fri tekst.
export function profilFaneQuery(sp: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  const raw = Array.isArray(sp.fane) ? sp.fane[0] : sp.fane;
  if (raw && (PROFIL_FANER as readonly string[]).includes(raw)) p.set("fane", raw);
  const vis = Array.isArray(sp.vis) ? sp.vis[0] : sp.vis;
  if (vis && /^\d{1,4}$/.test(vis)) p.set("vis", vis);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}
