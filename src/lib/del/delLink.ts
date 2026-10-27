// Del auktion (Filip, 27. okt. 2026 - ROADMAP-BESLUTNINGER.md, "Nye
// funktioner før lancering", punkt 4). Ren logik uden server-only: bruges af
// Del-knappen (src/components/del/DelAuktion.tsx) og som reference for appen.
//
// Linket indeholder KUN auktionens id - aldrig brugerens id, e-mail, navn
// eller sporingsparametre. Den eneste undtagelse er henvisningskoden fra
// "Henvis en ven" (?ref=<kode>), og kun når en indlogget PRIVAT bruger deler
// (se src/lib/del/henvisning.ts). Koden er brugerens egen offentlige
// invitationskode, ikke et bruger-id.

// Navnet på parameteren med henvisningskoden. "Henvis en ven" (migration
// 20261102230000) skal læse den samme parameter, når en ny bruger lander på
// en auktion via et delt link.
export const HENVISNING_PARAM = "ref";

// Kun bogstaver, tal, bindestreg og understreg - alt andet droppes, så der
// aldrig kan sniges noget andet ind i linket.
const GYLDIG_KODE = /^[A-Za-z0-9_-]{4,40}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function auktionDelUrl(origin: string, auktionId: string, henvisningskode?: string | null): string | null {
  if (!UUID.test(auktionId)) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const url = new URL(`/auktion/${auktionId.toLowerCase()}`, base.origin);
  if (henvisningskode && GYLDIG_KODE.test(henvisningskode)) {
    url.searchParams.set(HENVISNING_PARAM, henvisningskode);
  }
  return url.toString();
}

export function delTekst(titel: string): string {
  const t = titel.trim().replace(/\s+/g, " ");
  const kort = t.length > 80 ? `${t.slice(0, 77)}...` : t;
  return `Se "${kort}" på BidHamr`;
}

export type DelMaal = {
  // Messenger-appen på mobil (åbner appens delingsvindue).
  messengerApp: string;
  // Messenger i browseren via Facebooks send-dialog. Kræver et Facebook
  // app-id (NEXT_PUBLIC_FACEBOOK_APP_ID) - uden det null, og knappen kopierer
  // i stedet linket og åbner messenger.com.
  messengerWeb: string | null;
  sms: string;
  facebook: string;
  email: string;
};

export function delMaal(url: string, titel: string, facebookAppId?: string | null): DelMaal {
  const u = encodeURIComponent(url);
  const tekst = delTekst(titel);
  const appId = facebookAppId && /^\d{5,20}$/.test(facebookAppId) ? facebookAppId : null;
  return {
    messengerApp: `fb-messenger://share/?link=${u}`,
    messengerWeb: appId
      ? `https://www.facebook.com/dialog/send?app_id=${appId}&link=${u}&redirect_uri=${u}`
      : null,
    // "sms:?&body=" virker på både iOS og Android.
    sms: `sms:?&body=${encodeURIComponent(`${tekst}: ${url}`)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    email: `mailto:?subject=${encodeURIComponent(tekst)}&body=${encodeURIComponent(`${tekst}:\n${url}`)}`,
  };
}
