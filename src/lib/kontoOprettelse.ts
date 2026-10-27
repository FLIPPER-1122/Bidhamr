import "server-only";

// Oprettelse af konti - ÉN kodevej for hjemmesiden (opretKonto,
// gensendBekraeftelse og verificerSignupKode i src/app/actions/auth.ts) og
// appen (POST /api/konto/opret og /api/konto/bekraeft). Åben og lukket
// tilmelding (src/lib/tilmelding.ts) adskiller sig KUN ved invitationstjekket.
//
// Hvorfor (kontoovertagelse): med Supabases egen signUp kan en angriber
// oprette kontoen først med offerets e-mail og sin egen adgangskode. Når
// offeret bekræfter med koden, beholder kontoen angriberens adgangskode.
// Derfor:
// - "Allow new users to sign up" er ALTID slået fra i Supabase (Filip, i
//   dashboardet). Kontoen oprettes kun her, på serveren, med
//   generateLink('signup') og en TILFÆLDIG adgangskode. generateLink sender
//   ingen mail; koden sendes i vores egen mail (betaKodeMail).
// - Lige før generateLink lægger serveren en billet med hashen af et
//   tilfældigt engangs-nonce (konto_oprettelse_billet_signup,
//   20261018010000_signup_billet_altid.sql) og sender nonce'et med som
//   metadata bh_billet. handle_new_user kræver, at de passer sammen. Så
//   afviser databasen en direkte signUp med anon-nøglen - også i det sekund,
//   billetten ligger - uanset hvad der står i dashboardet. bh_billet fjernes
//   bagefter fra metadata (i databasen og her).
// - Den valgte adgangskode, navnet og vilkårsaccepten sættes først efter en
//   vellykket verifyOtp (bekraeftKode herunder), med oplysninger fra den, der
//   har koden fra mailen. Hjemmesiden gemmer dem imens krypteret i en cookie
//   (src/lib/ventendeAdgangskode.ts); appen sender dem igen sammen med koden.
//   Signup-metadata indeholder derfor hverken navn eller vilkår.
// - En EKSISTERENDE konto får aldrig ny metadata eller adgangskode herfra. Er
//   den ubekræftet, sendes kun en ny kode.
// - Neutrale svar: kalderen svarer det samme, uanset om e-mailen findes, er
//   inviteret, eller noget fejlede (fejl logges i /admin/drift uden e-mail).
// - Højst én kodemail pr. e-mail hvert 2. minut (kodemail_email, tjekket før
//   alt andet). Inden for vinduet sendes intet, så den forrige kode gælder.
import { createHash, randomBytes } from "node:crypto";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAnonClient } from "@/lib/supabase/anon";
import { indenForGraense, nulstilGraense, tjekGraenserLukket } from "@/lib/rateLimit";
import { sideUrl } from "@/lib/mails/handel";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { betaKodeMail } from "@/lib/mails/beta";
import { logDriftFejl } from "@/lib/drift";
import { tilmeldingAaben } from "@/lib/tilmelding";
import { erVilkaarVersion } from "@/lib/vilkaar";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { betaAuthBruger, betaTilmeldingTilladt } from "@/lib/beta";
import { hentKontoStatus, type KontoStatus } from "@/lib/kontoStatus";
import { knytHenvisning } from "@/lib/henvisning/server";

export function renEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
}

export function renNavn(v: unknown, maks = 100): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, maks) : "";
}

// Koden fra mailen: kun cifre. Produktion bruger 6 cifre ("Email OTP
// length"); Supabase tillader 6-10 (testdatabasen bruger 8).
export function renKode(v: unknown): string | null {
  const kode = typeof v === "string" ? v.replace(/\D/g, "") : "";
  return /^\d{6,10}$/.test(kode) ? kode : null;
}

function tilfaeldigAdgangskode(): string {
  return `Bh-${randomBytes(32).toString("base64url")}-9x`;
}

// Engangs-nonce til billetten. Kun hashen gemmes i databasen; nonce'et
// sendes med i generateLink (metadata bh_billet) og findes ellers kun i
// serverens hukommelse.
export function nyBillet(): { nonce: string; hash: string } {
  const nonce = randomBytes(32).toString("base64url");
  return { nonce, hash: createHash("sha256").update(nonce, "utf8").digest("hex") };
}

// Fjerner bh_billet fra auth-brugerens metadata (Supabase sletter en nøgle,
// der sættes til null). Databasen gør det også i handle_new_user. Kaster aldrig.
export async function fjernBilletFraMetadata(brugerId: string): Promise<void> {
  try {
    const { error } = await createAdminClient().auth.admin.updateUserById(brugerId, {
      user_metadata: { bh_billet: null },
    });
    if (error) await logSignupFejl("fjernBilletFraMetadata", `${error.status ?? ""} ${error.code ?? ""}: ${error.message}`, brugerId);
  } catch (err) {
    await logSignupFejl("fjernBilletFraMetadata", err, brugerId);
  }
}

// Fjerner en ubrugt billet igen (generateLink fejlede), så den ikke ligger
// og venter i de resterende minutter. Kaster aldrig.
export async function fjernBillet(hash: string): Promise<void> {
  try {
    const { error } = await createAdminClient().from("konto_oprettelse_billetter").delete().eq("noegle_hash", hash);
    if (error) await logSignupFejl("fjernBillet", `${error.code ?? ""}: ${error.message}`);
  } catch (err) {
    await logSignupFejl("fjernBillet", err);
  }
}

export async function logSignupFejl(hvor: string, fejl: unknown, brugerId?: string) {
  const tekst = fejl instanceof Error ? fejl.message : typeof fejl === "string" ? fejl : JSON.stringify(fejl);
  await logDriftFejl({
    kilde: "action",
    hvor,
    fejl: String(tekst).replace(/[^\s@]+@[^\s@]+/g, "[e-mail]"),
    ...(brugerId ? { brugerId } : {}),
  });
}

const VAERN_TIP =
  'Er TILMELDING_AABEN=true, mens beta_indstillinger.kun_inviterede stadig er slået til? Se HUSKELISTE.md under "Lancering".';

// Må e-mailen oprette en konto nu? Åben tilmelding: ja. Lukket: kun med en
// aktiv invitation, mens beta er åben. null = kunne ikke tjekkes (fail closed).
async function maaOpretteSig(email: string): Promise<boolean | null> {
  if (tilmeldingAaben()) return true;
  return betaTilmeldingTilladt(email);
}

// Billet til netop denne oprettelse (handle_new_user kræver den). "ingen" =
// funktionen findes ikke endnu (migrationen 20261018010000 er ikke kørt) - så
// gælder databasens gamle værn, og kontoen kan oprettes som før.
async function laegBillet(email: string, hash: string): Promise<"ok" | "ikke_tilladt" | "ingen" | "fejl"> {
  try {
    const { data, error } = await createAdminClient().rpc("konto_oprettelse_billet_signup", {
      p_email: email,
      p_hash: hash,
    });
    if (error) {
      if (error.code === "PGRST202") return "ingen";
      await logSignupFejl("kontoOprettelse.billet", `${error.code ?? ""}: ${error.message}`);
      return "fejl";
    }
    const kode = (data as { kode?: unknown } | null)?.kode;
    if (kode === "ok") return "ok";
    if (kode === "ikke_tilladt") return "ikke_tilladt";
    await logSignupFejl("kontoOprettelse.billet", `uventet svar: ${String(kode)}`);
    return "fejl";
  } catch (err) {
    await logSignupFejl("kontoOprettelse.billet", err);
    return "fejl";
  }
}

// Ny kode til en EKSISTERENDE, ubekræftet konto. Først Supabases egen mail
// (auth.resend). Virker den ikke (fx fordi "Allow new users to sign up" er
// slået fra), laves en ny kode med generateLink('signup') på den eksisterende
// konto - UDEN metadata og med en tilfældig adgangskode (den rigtige sættes
// først efter bekræftelsen) - og den sendes i vores egen mail. generateLink
// på en eksisterende konto opretter ingen ny auth-bruger, så der skal ingen
// billet til. true = en kode er sendt.
async function sendKodeIgen(email: string): Promise<boolean> {
  const { error: resendFejl } = await createAnonClient().auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: sideUrl("/auth/callback?next=/velkommen") },
  });
  if (!resendFejl) return true;
  await logSignupFejl("sendKodeIgen.resend", `${resendFejl.status ?? ""} ${resendFejl.code ?? ""}: ${resendFejl.message}`);

  const { data: link, error } = await createAdminClient().auth.admin.generateLink({
    type: "signup",
    email,
    password: tilfaeldigAdgangskode(),
  });
  if (error || !link?.properties?.email_otp) {
    await logSignupFejl("sendKodeIgen.generateLink", `${error?.status ?? ""} ${error?.code ?? ""}: ${error?.message ?? "intet svar"}`);
    return false;
  }
  const sendt = await sendHandelMailDetaljer(email, betaKodeMail({ email, kode: link.properties.email_otp }));
  if (!sendt.ok) {
    await logSignupFejl("sendKodeIgen.kodeMail", sendt.fejl, link.user?.id);
    return false;
  }
  return true;
}

// Kun en almindelig, ubekræftet signup-konto får en ny signup-kode - aldrig
// en bekræftet, en inviteret (invited_at) eller en firmakonto.
function kanFaaNyKode(b: { bekraeftet: boolean; inviteret: boolean; firma: boolean }): boolean {
  return !b.bekraeftet && !b.inviteret && !b.firma;
}

// Hvad kalderen skal gøre med det ventende (kun hjemmesiden gemmer det - i
// cookien):
//   "ja"                 en kode er sendt til e-mailen: gem det.
//   "kun_hvis_ventende"  inden for 2-minutters vinduet (ingen ny kode): opdatér
//                        kun det ventende til samme e-mail, som denne browser
//                        allerede har (fx en rettet tastefejl).
//   "nej"                ingen kode sendt (ikke inviteret, bekræftet konto, fejl).
export type GemAdgangskode = "ja" | "kun_hvis_ventende" | "nej";

// Opretter kontoen (eller sender en ny kode til en eksisterende, ubekræftet
// konto). Kaster aldrig; kalderen svarer altid neutralt. Input skal være
// valideret og renset af kalderen (navn, adgangskode, vilkår gemmes af
// kalderen og bruges først efter koden) og rate-limitet pr. IP.
export async function opretKontoPaaServeren(email: string): Promise<GemAdgangskode> {
  try {
    if (!(await indenForGraense("kodemail_email", email))) return "kun_hvis_ventende";

    const tilladt = await maaOpretteSig(email);
    if (tilladt === null) {
      await logSignupFejl("opretKontoPaaServeren", "Invitationen kunne ikke tjekkes (beta_tilmelding_tilladt).");
      return "nej";
    }
    if (!tilladt) return "nej";

    const findes = await betaAuthBruger(email);
    if (findes === null) {
      await logSignupFejl("opretKontoPaaServeren", "Kontoen kunne ikke slås op (beta_auth_bruger).");
      return "nej";
    }
    if (findes.findes) {
      // Bekræftet, inviteret eller firmakonto: intet (en ny signup-kode ville
      // ugyldiggøre fx firmaets invitationslink). Ellers kun en ny kode.
      return kanFaaNyKode(findes) && (await sendKodeIgen(email)) ? "ja" : "nej";
    }

    const b = nyBillet();
    const billet = await laegBillet(email, b.hash);
    if (billet === "fejl") return "nej";
    if (billet === "ikke_tilladt") {
      // Serveren sagde ja, databasen nej: åben tilmelding med værnet slået til
      // (eller en invitation tilbagekaldt i samme sekund).
      if (tilmeldingAaben()) {
        await logSignupFejl("opretKontoPaaServeren", `Databasen gav ingen billet til en ny konto. ${VAERN_TIP}`);
      }
      return "nej";
    }

    const { data: link, error } = await createAdminClient().auth.admin.generateLink({
      type: "signup",
      email,
      password: tilfaeldigAdgangskode(),
      options: {
        redirectTo: sideUrl("/auth/callback?next=/velkommen"),
        // Kun nonce'et - navn og vilkår sættes efter koden (bekraeftKode).
        ...(billet === "ok" ? { data: { bh_billet: b.nonce } } : {}),
      },
    });
    if (error || !link?.user || !link.properties?.email_otp) {
      if (billet === "ok") await fjernBillet(b.hash);
      // "Findes allerede" (to samtidige oprettelser) er forventet; alt andet
      // logges. Databasens afvisning ("Database error ...") med et tip.
      const findesAllerede = error?.code === "email_exists" || error?.code === "user_already_exists";
      if (!findesAllerede) {
        const dbFejl = error?.status === 500 && /database error/i.test(error.message ?? "");
        await logSignupFejl(
          "opretKontoPaaServeren.generateLink",
          `${error?.status ?? ""} ${error?.code ?? ""}: ${error?.message ?? "intet svar"}${dbFejl ? ` - Supabase afviste en ny konto. ${VAERN_TIP}` : ""}`,
        );
      }
      return "nej";
    }
    if (billet === "ok") await fjernBilletFraMetadata(link.user.id);

    const sendt = await sendHandelMailDetaljer(email, betaKodeMail({ email, kode: link.properties.email_otp }));
    if (!sendt.ok) {
      // Kontoen findes; brugeren kan få en ny kode ("Send ny kode").
      await logSignupFejl("opretKontoPaaServeren.kodeMail", sendt.fejl, link.user.id);
    }
    return "ja";
  } catch (err) {
    await logSignupFejl("opretKontoPaaServeren", err);
    return "nej";
  }
}

// "Send ny kode". "vent" = inden for 2-minutters vinduet (samme svar for alle
// e-mails). Ellers "ok" i alle tilfælde - kun en eksisterende, ubekræftet
// konto (med aktiv invitation, mens tilmeldingen er lukket) får en ny kode.
export async function sendNyKodePaaServeren(email: string): Promise<"ok" | "vent"> {
  try {
    if (!(await indenForGraense("kodemail_email", email))) return "vent";
    const tilladt = await maaOpretteSig(email);
    if (tilladt === null) await logSignupFejl("sendNyKodePaaServeren", "Invitationen kunne ikke tjekkes.");
    if (!tilladt) return "ok";
    const findes = await betaAuthBruger(email);
    if (findes === null) await logSignupFejl("sendNyKodePaaServeren", "Kontoen kunne ikke slås op (beta_auth_bruger).");
    if (findes?.findes && kanFaaNyKode(findes)) await sendKodeIgen(email);
  } catch (err) {
    await logSignupFejl("sendNyKodePaaServeren", err);
  }
  return "ok";
}

// Navn og vilkårsaccept fra den, der har koden (cookien på hjemmesiden, selve
// kaldet fra appen).
export type SignupProfil = { fornavn: string; efternavn: string; vilkaarVersion: string };

type AuthKlient = { auth: Pick<SupabaseClient["auth"], "verifyOtp" | "updateUser" | "signOut"> };

export type BekraeftSvar =
  | {
      ok: true;
      user: User;
      session: Session | null;
      // false = ingen adgangskode givet, eller den kunne ikke sættes: kontoen
      // har en ny tilfældig, og brugeren skal vælge en ("Vælg adgangskode").
      adgangskodeSat: boolean;
      // false = navnet mangler eller kunne ikke gemmes (kontoen hedder
      // "Bruger"): brugeren skal skrive sit navn.
      navnSat: boolean;
      // false = vilkårene er ikke accepteret af den, der har koden:
      // accept-vinduet vises, og databasen afviser bud og salg (BHV02).
      vilkaarSat: boolean;
    }
  | { fejl: "kode_forkert" | "for_mange" | "graense_fejl" | "fejl" }
  | { fejl: "konto"; status: Exclude<KontoStatus, { kode: "ok" }> };

// Gemmer navn og vilkårsaccept på public.users med service role, efter koden
// er bekræftet. Kaster aldrig.
async function gemProfil(brugerId: string, profil: SignupProfil | null): Promise<{ navnSat: boolean; vilkaarSat: boolean }> {
  const fornavn = renNavn(profil?.fornavn);
  const efternavn = renNavn(profil?.efternavn);
  // Versionen er tjekket af kalderen (VILKAAR_VERSION eller databasens aktive,
  // godkendtSignupVersion).
  const vilkaar = erVilkaarVersion(profil?.vilkaarVersion);
  const navnOk = !!fornavn && !!efternavn;
  const admin = createAdminClient();
  let navnSat = false;
  let vilkaarSat = false;
  if (!navnOk || !vilkaar) {
    // Det, der mangler, nulstilles, så intet fra den, der oprettede kontoen
    // (fx metadata på en ældre ubekræftet konto), står tilbage: navnet bliver
    // "Bruger", og accept-vinduet vises (BHV02 afviser bud og salg imens).
    const { error } = await admin
      .from("users")
      .update({
        ...(!navnOk ? { navn: "Bruger", fornavn: null, efternavn: null } : {}),
        ...(!vilkaar ? { vilkaar_version: null, vilkaar_accepteret_kl: null } : {}),
      })
      .eq("id", brugerId);
    if (error) await logSignupFejl("bekraeftKode.nulstil", `${error.code ?? ""}: ${error.message}`, brugerId);
  }
  if (navnOk) {
    const { error } = await admin
      .from("users")
      .update({ navn: `${fornavn} ${efternavn}`, fornavn, efternavn })
      .eq("id", brugerId);
    if (error) {
      // Fx BHN01/BHN02 (navnet indeholder "BidHamr" eller kontaktoplysninger).
      await logSignupFejl("bekraeftKode.navn", `${error.code ?? ""}: ${error.message}`, brugerId);
      // Navnet fra signup-metadata (handle_new_user) må ikke blive stående -
      // det kan være et forbudt navn eller fra den, der oprettede kontoen.
      // Kontoen hedder "Bruger", og brugeren bliver bedt om sit navn.
      const { error: nulFejl } = await admin
        .from("users")
        .update({ navn: "Bruger", fornavn: null, efternavn: null })
        .eq("id", brugerId);
      if (nulFejl) await logSignupFejl("bekraeftKode.navnNulstil", `${nulFejl.code ?? ""}: ${nulFejl.message}`, brugerId);
    } else {
      navnSat = true;
    }
  }
  if (vilkaar) {
    const { error } = await admin
      .from("users")
      .update({ vilkaar_version: profil?.vilkaarVersion, vilkaar_accepteret_kl: new Date().toISOString() })
      .eq("id", brugerId)
      .is("konto_slettet_kl", null);
    if (error) {
      await logSignupFejl("bekraeftKode.vilkaar", `${error.code ?? ""}: ${error.message}`, brugerId);
    } else {
      vilkaarSat = true;
    }
  }
  return { navnSat, vilkaarSat };
}

// Bekræfter e-mailen med koden og sætter BAGEFTER - kun for en konto, der må
// logge ind - den valgte adgangskode (i sessionen fra verifyOtp) samt navn
// og vilkårsaccept fra den, der har koden. Alle forsøg tælles: højst 5 pr.
// e-mail+IP og 30 pr. IP pr. 15 min. og 15 pr. e-mail pr. time; et
// gennemført forsøg nulstiller e-mail+IP. supabase: hjemmesidens
// cookie-klient (sessionen sættes som cookies) eller appens klient uden
// cookies (createAnonClient).
export async function bekraeftKode(
  supabase: AuthKlient,
  input: {
    email: string;
    kode: string;
    ip: string;
    adgangskode: string | null;
    profil: SignupProfil | null;
    // Henvis en ven: koden fra linket (hjemmesidens felt "Henvisningskode",
    // sendt med fra "Indtast koden" - ingen cookie - eller appens felt
    // henvisningskode). Knyttes kun til en NY konto - databasen
    // afgør det (henvisning_knyt). Fejl stopper aldrig bekræftelsen.
    henvisningskode?: string | null;
  },
): Promise<BekraeftSvar> {
  const { email, kode, ip, adgangskode, profil, henvisningskode } = input;
  const graense = await tjekGraenserLukket([
    ["signup_kode_ip", ip],
    ["signup_kode_email_ip", `${email}|${ip}`],
    ["signup_kode_email", email],
  ]);
  if (graense === "for_mange") return { fejl: "for_mange" };
  if (graense === "fejl") return { fejl: "graense_fejl" };

  const { data, error } = await supabase.auth.verifyOtp({ email, token: kode, type: "signup" });
  if (error || !data.user) {
    if (error?.status === 429) return { fejl: "for_mange" };
    // Supabase svarer otp_expired både ved forkert og udløbet kode.
    if (error && (error.code === "otp_expired" || error.status === 403 || error.status === 400)) {
      return { fejl: "kode_forkert" };
    }
    console.error("bekraeftKode: verifyOtp fejlede:", error?.code, error?.message);
    return { fejl: "fejl" };
  }
  await nulstilGraense("signup_kode_email_ip", `${email}|${ip}`);

  // Suspenderet/slettet konto (eller profilen kan ikke læses): ingen
  // ændringer og ingen session (fail closed).
  const status = await hentKontoStatus(data.user.id);
  if (status.kode !== "ok") {
    await supabase.auth.signOut({ scope: "local" });
    return { fejl: "konto", status };
  }

  const navne = [profil?.fornavn, profil?.efternavn].filter((x): x is string => typeof x === "string");
  let adgangskodeSat = false;
  if (adgangskode) {
    const v = vurderAdgangskode(adgangskode, { email: data.user.email ?? email, navn: navne });
    if (v.ok) {
      const { error: pwFejl } = await supabase.auth.updateUser({ password: adgangskode });
      if (!pwFejl || pwFejl.code === "same_password") {
        adgangskodeSat = true;
      } else {
        await logDriftFejl({
          kilde: "action",
          hvor: "bekraeftKode.adgangskode",
          fejl: `${pwFejl.status ?? ""} ${pwFejl.code ?? ""}: ${pwFejl.message}`,
          brugerId: data.user.id,
        });
      }
    }
  }
  if (!adgangskodeSat) {
    // Ingen valgt adgangskode: sæt en ny tilfældig, så INGEN kendt adgangskode
    // overlever bekræftelsen - heller ikke en, som en anden måtte have sat på
    // den ubekræftede konto uden om vores kode (fx hvis "Allow new users to
    // sign up" ved en fejl er slået til). Brugeren vælger sin egen bagefter.
    const { error: tilfFejl } = await supabase.auth.updateUser({ password: tilfaeldigAdgangskode() });
    if (tilfFejl) {
      await logDriftFejl({
        kilde: "action",
        hvor: "bekraeftKode.tilfaeldigAdgangskode",
        fejl: `${tilfFejl.status ?? ""} ${tilfFejl.code ?? ""}: ${tilfFejl.message}`,
        brugerId: data.user.id,
      });
    }
  }

  const { navnSat, vilkaarSat } = await gemProfil(data.user.id, profil);
  // Kun den, der har koden fra mailen, kan knytte kontoen til en henviser.
  if (henvisningskode) await knytHenvisning(data.user.id, henvisningskode);
  return { ok: true, user: data.user, session: data.session, adgangskodeSat, navnSat, vilkaarSat };
}
