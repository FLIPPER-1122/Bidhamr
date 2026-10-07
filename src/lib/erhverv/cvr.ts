import "server-only";

// Opslag af et firma ud fra CVR-nummer (Admin → Erhverv), så staff ikke skal
// taste firmanavn og adresse. Gratis offentligt opslag via cvrapi.dk, som
// kræver en beskrivende User-Agent. Tjenesten har et dagligt loft for gratis
// brug - fejler opslaget, svarer funktionen { ok: false }, og staff taster
// oplysningerne selv (fallback). Opslaget gemmer intet.
//
// Bruges kun af serveren (src/app/actions/adminErhverv.ts → slaaCvrOp), aldrig
// fra browseren, så User-Agent og rate limit styres her.

import { renCvr } from "./regler";

const USER_AGENT = "BidHamr - erhvervsopslag i admin - erhverv@bidhamr.dk";
const TIMEOUT_MS = 6000;

export type CvrOpslag =
  | {
      ok: true;
      cvr: string;
      firmanavn: string;
      adresse: string | null;
      postnummer: string | null;
      by: string | null;
      telefon: string | null;
      email: string | null;
      virksomhedsform: string | null;
      // false = ophørt (slutdato) - må ikke oprettes (kun aktivt dansk CVR).
      aktiv: boolean;
      ophoert: string | null;
    }
  | { ok: false; grund: "ugyldigt_cvr" | "ikke_fundet" | "utilgaengelig" };

type CvrApiSvar = {
  vat?: number | string;
  name?: string;
  address?: string;
  zipcode?: string | number;
  city?: string;
  phone?: string | number | null;
  email?: string | null;
  enddate?: string | null;
  companydesc?: string | null;
  error?: string;
};

function tekst(v: unknown, maks: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, maks) : null;
}

export async function slaaCvrOpOffentligt(input: string): Promise<CvrOpslag> {
  const cvr = renCvr(input);
  if (!cvr) return { ok: false, grund: "ugyldigt_cvr" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `https://cvrapi.dk/api?search=${encodeURIComponent(cvr)}&country=dk`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.status === 404) return { ok: false, grund: "ikke_fundet" };
    if (!res.ok) return { ok: false, grund: "utilgaengelig" };
    const data = (await res.json()) as CvrApiSvar;
    if (data.error) {
      return { ok: false, grund: data.error === "NOT_FOUND" ? "ikke_fundet" : "utilgaengelig" };
    }
    // Svaret skal være for præcis det CVR, vi spurgte om (search kan ellers
    // matche på navn).
    if (String(data.vat ?? "") !== cvr) return { ok: false, grund: "ikke_fundet" };
    const firmanavn = tekst(data.name, 200);
    if (!firmanavn) return { ok: false, grund: "ikke_fundet" };
    const postnummer = tekst(data.zipcode, 4);
    const ophoert = tekst(data.enddate, 30);
    return {
      ok: true,
      cvr,
      firmanavn,
      adresse: tekst(data.address, 200),
      postnummer: postnummer && /^[0-9]{4}$/.test(postnummer) ? postnummer : null,
      by: tekst(data.city, 100),
      telefon: tekst(data.phone, 30),
      email: tekst(data.email, 254),
      virksomhedsform: tekst(data.companydesc, 100),
      aktiv: !ophoert,
      ophoert,
    };
  } catch {
    return { ok: false, grund: "utilgaengelig" };
  } finally {
    clearTimeout(timer);
  }
}
