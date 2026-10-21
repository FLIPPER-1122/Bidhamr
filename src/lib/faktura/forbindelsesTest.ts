import "server-only";

import { erTestdatabase } from "@/lib/miljoe";
import { DineroFejl, lavDineroKlient } from "./dinero";
import { hentFakturaKonfig, kontrollerOrganisation } from "./konfig";

// Admin -> Fakturaer -> "Test Dinero-forbindelse" (kun chef, se
// testDineroForbindelse i src/app/actions/adminFakturaer.ts). Logger ind i
// Dinero med den opsætning, der kører (hentFakturaKonfig), henter de
// regnskaber, nøglen har adgang til (GET /v1.1/organizations), og kører
// regnskabs-værnet (kontrollerOrganisation) - præcis som fakturakøen.
//
// Kun læsning hos Dinero: intet oprettes, intet sendes, og ingen
// drift-tilfælde åbnes eller lukkes (det gør fakturakøen selv ved næste
// kørsel).
//
// Svaret vises i browseren og må ALDRIG indeholde nøgler, secret eller
// token - heller ikke dele af dem. Kun "udfyldt ja/nej", længde og
// formfejl (anførselstegn, mellemrum). DINERO_ORG_ID er et regnskabsnummer,
// ikke en hemmelighed, og vises. Dineros egne fejltekster vises ikke (kun
// HTTP-status og en OAuth-kode som "invalid_client").

export type DineroVariabel = {
  navn: string;
  udfyldt: boolean;
  laengde: number;
  advarsel: string | null;
};

export type DineroTestResultat = {
  // Samlet dom øverst.
  ok: boolean;
  overskrift: string;
  // Opsætningen, som fakturakøen ser den.
  database: "test" | "produktion";
  miljoe: string;
  stripe: "test" | "live" | "mangler" | "ukendt";
  konfigOk: boolean;
  konfigBesked: string | null;
  variabler: DineroVariabel[];
  orgId: string | null;
  // Login hos Dinero (null = ikke forsøgt, fx variabler mangler).
  login: { ok: true } | { ok: false; status: number; tekst: string } | null;
  // Regnskaber, nøglen har adgang til (null = ikke hentet).
  regnskaber: { id: string; navn: string }[] | null;
  regnskaberFejl: string | null;
  orgFundet: boolean | null;
  // Regnskabs-værnet (null = ikke kørt).
  vaern: { ok: boolean; tekst: string | null } | null;
};

const HEMMELIGE = ["DINERO_CLIENT_ID", "DINERO_CLIENT_SECRET", "DINERO_API_KEY"] as const;

function variabel(navn: string): DineroVariabel {
  const raa = process.env[navn] ?? "";
  const v = raa.trim();
  let advarsel: string | null = null;
  if (/^["']|["']$/.test(v)) advarsel = "Værdien starter eller slutter med et anførselstegn - fjern det.";
  else if (/\s/.test(v)) advarsel = "Værdien indeholder mellemrum eller linjeskift.";
  return { navn, udfyldt: v.length > 0, laengde: v.length, advarsel };
}

function stripeTilstand(): DineroTestResultat["stripe"] {
  const k = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!k) return "mangler";
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return "ukendt";
}

// Dansk forklaring på et afvist login. Kun status og en kort OAuth-kode.
export function loginTekst(status: number, loginKode: string | null): string {
  if (status === 0) return "Dinero svarede ikke (netværk eller timeout) - prøv igen om lidt.";
  if (status === 429) return "Dinero afviser for mange kald lige nu (429) - vent et minut.";
  if (status >= 500) return `Dinero har en fejl (${status}) - prøv igen om lidt.`;
  const kode = loginKode ? ` Dinero oplyser: ${loginKode}.` : "";
  if (loginKode === "invalid_client") {
    return `afvist (${status}) - Client ID eller Client Secret passer ikke.${kode}`;
  }
  if (loginKode === "invalid_grant") {
    return `afvist (${status}) - API-nøglen passer ikke (eller er slettet i Dinero).${kode}`;
  }
  if (status === 400 || status === 401 || status === 403) {
    return `afvist (${status}) - Client ID/Secret eller API-nøgle passer ikke.${kode}`;
  }
  return `afvist (${status}).${kode}`;
}

function apiTekst(err: unknown): string {
  const d = err instanceof DineroFejl ? err : null;
  if (!d) return "Regnskaberne kunne ikke hentes (ukendt fejl).";
  if (d.status === 0) return "Dinero svarede ikke på opslaget af regnskaber (netværk eller timeout).";
  if (d.status === 401 || d.status === 403) {
    return `Dinero afviser opslaget af regnskaber (${d.status}) - API-nøglen giver ikke adgang.`;
  }
  if (d.status === 429) return "Dinero afviser for mange kald lige nu (429) - vent et minut.";
  return `Dinero svarede ${d.status} på opslaget af regnskaber.`;
}

const ren = (t: unknown, maks: number) =>
  String(t ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maks);

export async function koerDineroForbindelsesTest(): Promise<DineroTestResultat> {
  const konfig = hentFakturaKonfig();
  const miljoeRaa = (process.env.DINERO_MILJOE ?? "").trim().toLowerCase();
  const orgRaa = (process.env.DINERO_ORG_ID ?? "").trim();
  const res: DineroTestResultat = {
    ok: false,
    overskrift: "",
    database: erTestdatabase() ? "test" : "produktion",
    miljoe: konfig.ok ? konfig.miljoe : miljoeRaa === "" ? "test (standard)" : /^[a-z]{1,10}$/.test(miljoeRaa) ? miljoeRaa : "ugyldig",
    stripe: stripeTilstand(),
    konfigOk: konfig.ok,
    konfigBesked: konfig.ok ? null : konfig.besked,
    variabler: [...HEMMELIGE.map(variabel), variabel("DINERO_ORG_ID")],
    orgId: /^[0-9]{1,12}$/.test(orgRaa) ? orgRaa : null,
    login: null,
    regnskaber: null,
    regnskaberFejl: null,
    orgFundet: null,
    vaern: null,
  };

  // Uden en gyldig opsætning sender fakturakøen intet - og testen logger
  // kun ind med den opsætning, køen faktisk bruger.
  if (!konfig.ok) {
    res.overskrift =
      konfig.grund === "mangler"
        ? "Dinero er ikke sat op - fakturakøen sender intet."
        : "Opsætningen afvises, før Dinero kaldes - fakturakøen sender intet.";
    return res;
  }

  const dinero = lavDineroKlient(konfig.dinero, { maksKald: 4 });
  try {
    await dinero.testLogin();
    res.login = { ok: true };
  } catch (err) {
    const d = err instanceof DineroFejl ? err : null;
    const status = d?.status ?? 0;
    res.login = { ok: false, status, tekst: loginTekst(status, d?.loginKode ?? null) };
    res.overskrift = `Login afvist af Dinero (${status || "intet svar"}) - fakturakøen sender intet.`;
    return res;
  }

  let liste: { Id: number | string; Name: string | null; VatNumber: string | null }[];
  try {
    liste = await dinero.hentOrganisationer();
  } catch (err) {
    res.regnskaberFejl = apiTekst(err);
    res.overskrift = "Login virker, men regnskaberne kunne ikke hentes - fakturakøen sender intet.";
    return res;
  }
  res.regnskaber = liste.slice(0, 50).map((o) => ({ id: ren(o.Id, 20), navn: ren(o.Name, 120) || "(uden navn)" }));
  const org = liste.find((o) => String(o.Id) === konfig.dinero.orgId) ?? null;
  res.orgFundet = !!org;
  const afvist = kontrollerOrganisation(konfig.miljoe, konfig.dinero.orgId, org);
  res.vaern = { ok: afvist === null, tekst: afvist };
  res.ok = afvist === null;
  res.overskrift = res.ok
    ? `Forbindelsen virker - fakturaer sendes til regnskabet ${konfig.dinero.orgId} (${ren(org?.Name, 120)}).`
    : !org
      ? `Login virker, men DINERO_ORG_ID (${konfig.dinero.orgId}) er ikke blandt nøglens regnskaber - fakturakøen sender intet.`
      : "Login virker, men regnskabs-værnet afviser regnskabet - fakturakøen sender intet.";
  return res;
}
