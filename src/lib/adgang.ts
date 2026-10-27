import "server-only";

// Login og to-trins-login på admin-hosten (/adgang/*) - Filip, 19. okt. 2026
// (docs/ADMIN-VAERT.md). Supabase MFA (TOTP), obligatorisk for alle
// staff-roller. Virker KUN på admin-hosten (ADMIN_VAERT): uden flaget eller på
// hovedsitet afvises alt. Fejl RETURNERES.
//
// Kaldes KUN fra route handleren POST /adgang/api/<handling>
// (src/app/adgang/api/[handling]/route.ts) - ikke som server actions. En
// route handler kan ikke køre server actions, så proxyen kan nøjes med at
// lade POST til /adgang/api/* igennem: et vilkårligt action-id (fx afgivBud)
// kan ikke postes til admin-hostens login-sider uden om gaten før lancering.
//
// Sessionen er admin-hostens egen cookie (src/lib/supabase/server.ts vælger
// navnet ud fra Host). En almindelig bruger kan aldrig komme længere end
// login: ikke-staff logges ud igen med samme besked som en forkert
// adgangskode (afslører ikke, hvem der er medarbejder).
import { createClient, paaAdminVaert } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logIndUdenCaptcha } from "@/lib/supabase/adgangskodeLogin";
import {
  FOR_MANGE_FORSOEG,
  PROEV_IGEN_OM_LIDT,
  graenseFejl,
  klientIp,
  nulstilGraense,
  tjekGraenserLukket,
} from "@/lib/rateLimit";
import { renEmail } from "@/lib/kontoOprettelse";
import { hentKontoStatus } from "@/lib/kontoStatus";
import { registrerLogin } from "@/lib/enheder";
import { logDriftFejl } from "@/lib/drift";
import {
  aktivTotpFaktor,
  bekraeftTotp,
  godkendteFaktorer,
  hashGendannelseskode,
  hashMailKode,
  minStaffStatus,
  nyMailKode,
  nyeGendannelseskoder,
  rydUkendteFaktorer,
  sendSikkerhedsmail,
  sletAlleFaktorer,
} from "@/lib/staffToTrin";
import { renGendannelseskode, renTotpKode } from "@/lib/staffToTrinRegler";
import { toTrinGendannetMail, toTrinMailKodeMail, toTrinOpsatMail } from "@/lib/mails/staffToTrin";
import { sendHandelMailDetaljer } from "@/lib/mails/send";

const MAIL_MANGLER = "Bekræft først koden fra den mail, vi har sendt dig.";

type Fejl = { fejl: string };

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const FORKERT_LOGIN = "Forkert e-mail eller adgangskode.";
const IKKE_HER = "Siden findes ikke.";
const KODE_FORKERT = "Koden passer ikke. Tjek, at uret på telefonen går rigtigt, og prøv med den nye kode.";
const KODE_UGYLDIG = "Skriv de 6 cifre fra din app.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function kunAdminVaert(): Promise<boolean> {
  return paaAdminVaert();
}

type Naeste = "kode" | "opsaet" | "lukket";

// Log ind med e-mail og adgangskode. Svaret siger, hvilket trin der er det
// næste: koden fra app'en, opsætning (tilmeldingen er åben) eller "lukket"
// (ingen app sat op, og tilmeldingen er lukket - så logges man ud igen).
export async function logIndAdmin(emailInput: string, password: string): Promise<{ ok: true; naeste: Naeste } | Fejl> {
  try {
    if (!(await kunAdminVaert())) return { fejl: IKKE_HER };
    const email = renEmail(emailInput);
    if (!email || typeof password !== "string" || password.length === 0 || password.length > 200) {
      return { fejl: FORKERT_LOGIN };
    }

    const ip = await klientIp();
    const graense = graenseFejl(
      await tjekGraenserLukket([["admin_login_ip", ip], ["admin_login_email_ip", `${email}|${ip}`]]),
    );
    if (graense) return { fejl: graense };

    const supabase = await createClient();
    const { data, error } = await logIndUdenCaptcha(supabase, email, password);
    if (error || !data.user) {
      if (error?.status === 429) return { fejl: FOR_MANGE_FORSOEG };
      if (error && error.code !== "invalid_credentials" && error.code !== "user_banned" && error.code !== "email_not_confirmed") {
        console.error("logIndAdmin fejlede:", error.code, error.message);
      }
      return { fejl: FORKERT_LOGIN };
    }
    const [konto, status] = await Promise.all([hentKontoStatus(data.user.id), minStaffStatus(supabase)]);
    if (konto.kode !== "ok" || !status?.staff) {
      await supabase.auth.signOut({ scope: "local" });
      if (konto.kode === "suspenderet") return { fejl: konto.besked };
      if (konto.kode === "fejl" || !status) return { fejl: GENERISK };
      return { fejl: FORKERT_LOGIN };
    }
    // Først nulstilling, når det er en medarbejder: login her er uden CAPTCHA
    // (logIndUdenCaptcha), så en almindelig bruger må ikke kunne bruge siden
    // til at gætte adgangskoder hurtigere end loftet.
    await nulstilGraense("admin_login_email_ip", `${email}|${ip}`);

    // Mail ved login fra en ny enhed (som på hovedsitet).
    await registrerLogin({ brugerId: data.user.id, email: data.user.email, accessToken: data.session?.access_token });

    if (status.aktiv || status.ukendte_faktorer) return { ok: true, naeste: "kode" };
    if (status.tilmelding_aaben) return { ok: true, naeste: "opsaet" };
    await supabase.auth.signOut({ scope: "local" });
    return { ok: true, naeste: "lukket" };
  } catch (err) {
    console.error("logIndAdmin kastede:", err);
    return { fejl: GENERISK };
  }
}

// Koden fra app'en (efter login og efter 12 timer). Giver en aal2-session.
export async function bekraeftAdminKode(kodeInput: string): Promise<{ ok: true } | Fejl> {
  try {
    if (!(await kunAdminVaert())) return { fejl: IKKE_HER };
    if (!renTotpKode(kodeInput)) return { fejl: KODE_UGYLDIG };

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: "Log ind igen." };

    const graense = graenseFejl(
      await tjekGraenserLukket([["admin_kode_bruger", user.id], ["admin_kode_ip", await klientIp()]]),
    );
    if (graense) return { fejl: graense };

    const status = await minStaffStatus(supabase);
    if (!status) return { fejl: GENERISK };
    if (!status.staff) return { fejl: IKKE_HER };
    if (!status.aktiv) return { fejl: "Du har ikke sat to-trins-login op endnu." };

    const faktor = await aktivTotpFaktor(user.id);
    if (!faktor) return { fejl: GENERISK };
    const svar = await bekraeftTotp(supabase, faktor, kodeInput);
    if (svar === "ugyldig") return { fejl: KODE_UGYLDIG };
    if (svar === "forkert") return { fejl: KODE_FORKERT };
    if (svar !== "ok") return { fejl: GENERISK };
    await nulstilGraense("admin_kode_bruger", user.id);

    // Kun de godkendte faktorer må findes (ukendte slettes, drift-alarm).
    const godkendte = await godkendteFaktorer(user.id);
    if (godkendte) await rydUkendteFaktorer(user.id, godkendte);
    return { ok: true };
  } catch (err) {
    console.error("bekraeftAdminKode kastede:", err);
    return { fejl: GENERISK };
  }
}

// Trin 0 i opsætningen: en engangskode på mail, så adgangskoden alene ikke
// er nok til at sætte en app op (fx en lækket adgangskode i et åbent vindue).
// 6 cifre, gælder 15 min., kun hashen gemmes; højst 3 mails pr. 15 min. pr.
// medarbejder og 5 forsøg pr. kode (databasen).
export async function sendMailKode(): Promise<{ ok: true; email: string } | Fejl> {
  try {
    if (!(await kunAdminVaert())) return { fejl: IKKE_HER };
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) return { fejl: "Log ind igen." };

    const graense = graenseFejl(await tjekGraenserLukket([["admin_mailkode_bruger", user.id], ["admin_kode_ip", await klientIp()]]));
    if (graense) return { fejl: graense };

    const kode = nyMailKode();
    const { data, error } = await createAdminClient().rpc("staff_to_trin_mail_kode_gem", {
      p_bruger: user.id,
      p_hash: hashMailKode(user.id, kode),
    });
    const r = (data as { kode?: string } | null)?.kode;
    if (error || r !== "ok") {
      if (r === "vindue_lukket") return { fejl: "Tilmeldingen er lukket. Bed chefen om at åbne for den under Medarbejdere." };
      if (r === "aktiv") return { fejl: "To-trins-login er allerede sat op." };
      if (r === "ikke_staff") return { fejl: IKKE_HER };
      console.error("staff_to_trin_mail_kode_gem:", error?.message ?? r);
      return { fejl: GENERISK };
    }
    const sendt = await sendHandelMailDetaljer(user.email, toTrinMailKodeMail({ kode }));
    if (!sendt.ok) {
      console.error("Mail-kode kunne ikke sendes:", sendt.fejl);
      return { fejl: "Mailen kunne ikke sendes. Prøv igen om lidt." };
    }
    return { ok: true, email: maskerEmail(user.email) };
  } catch (err) {
    console.error("sendMailKode kastede:", err);
    return { fejl: GENERISK };
  }
}

export async function bekraeftMailKode(kodeInput: string): Promise<{ ok: true } | Fejl> {
  try {
    if (!(await kunAdminVaert())) return { fejl: IKKE_HER };
    const kode = renTotpKode(kodeInput);
    if (!kode) return { fejl: "Skriv de 6 cifre fra mailen." };
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: "Log ind igen." };

    const graense = graenseFejl(await tjekGraenserLukket([["admin_kode_bruger", user.id], ["admin_kode_ip", await klientIp()]]));
    if (graense) return { fejl: graense };

    const { data, error } = await createAdminClient().rpc("staff_to_trin_mail_kode_tjek", {
      p_bruger: user.id,
      p_hash: hashMailKode(user.id, kode),
    });
    const r = (data as { kode?: string } | null)?.kode;
    if (error) {
      console.error("staff_to_trin_mail_kode_tjek:", error.message);
      return { fejl: GENERISK };
    }
    if (r === "ok") return { ok: true };
    if (r === "forkert") return { fejl: "Koden passer ikke. Tjek mailen, og prøv igen." };
    if (r === "for_mange") return { fejl: "Du har prøvet for mange gange. Bed om en ny kode." };
    return { fejl: "Koden er udløbet. Bed om en ny kode." };
  } catch (err) {
    console.error("bekraeftMailKode kastede:", err);
    return { fejl: GENERISK };
  }
}

function maskerEmail(email: string): string {
  const [navn, domaene] = email.split("@");
  if (!domaene) return email;
  return `${navn.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(navn.length - 2, 6)))}@${domaene}`;
}

// Trin 1 i opsætningen: en ny TOTP-faktor (QR-kode og hemmelighed til
// app'en). Kun i et åbent tilmeldingsvindue og kun, hvis to-trins-login ikke
// allerede er aktivt. Alle gamle faktorer slettes først.
export async function startToTrinOpsaet(): Promise<
  { ok: true; faktorId: string; qr: string; hemmelighed: string } | (Fejl & { kode?: "lukket" | "aktiv" | "mail" })
> {
  try {
    if (!(await kunAdminVaert())) return { fejl: IKKE_HER };
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: "Log ind igen." };

    const graense = graenseFejl(await tjekGraenserLukket([["admin_opsaet_bruger", user.id]]));
    if (graense) return { fejl: graense };

    const status = await minStaffStatus(supabase);
    if (!status) return { fejl: GENERISK };
    if (!status.staff) return { fejl: IKKE_HER };
    if (status.aktiv) return { fejl: "To-trins-login er allerede sat op.", kode: "aktiv" };
    if (!status.tilmelding_aaben) {
      return { fejl: "Tilmeldingen er lukket. Bed chefen om at åbne for den under Medarbejdere.", kode: "lukket" };
    }
    // Ikke kun adgangskoden: engangskoden fra mailen skal være bekræftet.
    if (!status.mail_bekraeftet) return { fejl: MAIL_MANGLER, kode: "mail" };

    if (!(await sletAlleFaktorer(user.id))) return { fejl: GENERISK };
    // Et nyt navn hver gang (Supabase kræver unikke navne pr. bruger).
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `BidHamr admin ${new Date().toISOString().slice(0, 16)}`,
      issuer: "BidHamr Admin",
    });
    if (error || !data) {
      console.error("mfa.enroll fejlede:", error?.code, error?.message);
      if (error?.code === "mfa_totp_enroll_not_enabled") {
        await logDriftFejl({ kilde: "action", sti: "/adgang/opsaet", hvor: "To-trins-login: TOTP slået fra", fejl: "TOTP er slået fra i Supabase (Authentication → Multi-Factor)" });
      }
      return { fejl: GENERISK };
    }
    return { ok: true, faktorId: data.id, qr: data.totp.qr_code, hemmelighed: data.totp.secret };
  } catch (err) {
    console.error("startToTrinOpsaet kastede:", err);
    return { fejl: GENERISK };
  }
}

// Trin 2: den første kode fra app'en. Faktoren bliver verificeret (aal2), de
// ukendte slettes, og databasen gør to-trins-login aktivt med 10 nye
// gendannelseskoder, som vises denne ene gang.
export async function bekraeftToTrinOpsaet(
  faktorId: string,
  kodeInput: string,
): Promise<{ ok: true; koder: string[] } | Fejl> {
  try {
    if (!(await kunAdminVaert())) return { fejl: IKKE_HER };
    if (typeof faktorId !== "string" || !UUID.test(faktorId)) return { fejl: GENERISK };
    if (!renTotpKode(kodeInput)) return { fejl: KODE_UGYLDIG };

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: "Log ind igen." };

    const graense = graenseFejl(
      await tjekGraenserLukket([["admin_kode_bruger", user.id], ["admin_kode_ip", await klientIp()]]),
    );
    if (graense) return { fejl: graense };

    const status = await minStaffStatus(supabase);
    if (!status) return { fejl: GENERISK };
    if (!status.staff) return { fejl: IKKE_HER };
    if (status.aktiv) return { fejl: "To-trins-login er allerede sat op." };
    if (!status.tilmelding_aaben) return { fejl: "Tilmeldingen er lukket. Bed chefen om at åbne for den under Medarbejdere." };
    if (!status.mail_bekraeftet) return { fejl: MAIL_MANGLER };

    const svar = await bekraeftTotp(supabase, faktorId, kodeInput);
    if (svar === "ugyldig") return { fejl: KODE_UGYLDIG };
    if (svar === "forkert") return { fejl: KODE_FORKERT };
    if (svar !== "ok") return { fejl: GENERISK };
    await nulstilGraense("admin_kode_bruger", user.id);

    // Kun den nye faktor må findes, før den gemmes.
    const ukendte = await rydUkendteFaktorer(user.id, [faktorId]);
    if (ukendte === null) return { fejl: GENERISK };

    const koder = nyeGendannelseskoder();
    const hashes = koder.map((k) => hashGendannelseskode(user.id, k));
    if (hashes.some((h) => !h)) return { fejl: GENERISK };
    const { data, error } = await createAdminClient().rpc("staff_to_trin_aktiver", {
      p_bruger: user.id,
      p_faktor: faktorId,
      p_hashes: hashes,
    });
    const kode = (data as { kode?: string } | null)?.kode;
    if (error || kode !== "ok") {
      console.error("staff_to_trin_aktiver:", error?.message ?? kode);
      if (kode === "allerede_aktiv") return { fejl: "To-trins-login er allerede sat op. Brug koden fra din app." };
      return { fejl: GENERISK };
    }

    await sendSikkerhedsmail(user.id, toTrinOpsatMail({ tidspunkt: new Date() }));
    return { ok: true, koder };
  } catch (err) {
    console.error("bekraeftToTrinOpsaet kastede:", err);
    return { fejl: GENERISK };
  }
}

// Mistet telefon: e-mail, adgangskode og én gendannelseskode. Koden bruges,
// den gamle app slettes, og en ny kan sættes op med det samme (2 timer).
export async function gendanAdmin(
  emailInput: string,
  password: string,
  gendannelseskode: string,
): Promise<{ ok: true } | Fejl> {
  const FORKERT = "E-mail, adgangskode eller gendannelseskode passer ikke.";
  try {
    if (!(await kunAdminVaert())) return { fejl: IKKE_HER };
    const email = renEmail(emailInput);
    const kode = renGendannelseskode(gendannelseskode);
    if (!email || typeof password !== "string" || !password || password.length > 200 || !kode) {
      return { fejl: FORKERT };
    }

    const ip = await klientIp();
    const graense = graenseFejl(await tjekGraenserLukket([["admin_gendan_ip", ip], ["admin_gendan_email", email]]));
    if (graense) return { fejl: graense };

    const supabase = await createClient();
    const { data, error } = await logIndUdenCaptcha(supabase, email, password);
    if (error || !data.user) {
      if (error?.status === 429) return { fejl: FOR_MANGE_FORSOEG };
      return { fejl: FORKERT };
    }

    const [konto, status] = await Promise.all([hentKontoStatus(data.user.id), minStaffStatus(supabase)]);
    const hash = hashGendannelseskode(data.user.id, kode);
    if (konto.kode !== "ok" || !status?.staff || !hash) {
      await supabase.auth.signOut({ scope: "local" });
      if (konto.kode === "suspenderet") return { fejl: konto.besked };
      return { fejl: konto.kode === "fejl" || !status ? PROEV_IGEN_OM_LIDT : FORKERT };
    }

    const { data: svar, error: rpcFejl } = await createAdminClient().rpc("staff_gendan_brug", {
      p_bruger: data.user.id,
      p_kode_hash: hash,
    });
    const r = svar as { kode?: string; tilbage?: number } | null;
    if (rpcFejl || r?.kode !== "ok") {
      await supabase.auth.signOut({ scope: "local" });
      if (rpcFejl) {
        console.error("staff_gendan_brug fejlede:", rpcFejl.message);
        return { fejl: GENERISK };
      }
      return { fejl: FORKERT };
    }

    await registrerLogin({ brugerId: data.user.id, email: data.user.email, accessToken: data.session?.access_token });
    await sendSikkerhedsmail(data.user.id, toTrinGendannetMail({ tidspunkt: new Date(), tilbage: Number(r.tilbage ?? 0) }));
    return { ok: true };
  } catch (err) {
    console.error("gendanAdmin kastede:", err);
    return { fejl: GENERISK };
  }
}

// Log ud af admin (kun denne session - appen og hovedsitet er uberørt).
export async function logUdAdmin(): Promise<{ ok: true }> {
  try {
    if (await kunAdminVaert()) {
      const supabase = await createClient();
      await supabase.auth.signOut({ scope: "local" });
    }
  } catch (err) {
    console.error("logUdAdmin kastede:", err);
  }
  return { ok: true };
}
