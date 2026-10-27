import "server-only";

// Påmindelse 1 time før en auktion slutter - til brugere, der har auktionen
// som favorit eller har budt på den (Filip, 27. okt. 2026). Erstatter den
// gamle "favorit slutter snart" (kun favoritter, én send() pr. modtager).
//
// Kører fra notifikations-cron'en (betalings-cron'en, hvert 5. minut).
// Databasen gør det tunge i ÉN forespørgsel (paamindelser_foer_slut_claim i
// 20261102250000_paamindelse_foer_slut.sql): finder modtagerne for alle
// auktioner i vinduet, sorterer sælgeren, pausede/annullerede auktioner og
// brugere med typen slået fra fra, og claimer (auktion, bruger) atomisk.
// Derefter sendes i batch: klokken som én bulk-insert, push via Expo i
// bundter, mail (kun til dem, der har mail slået til for typen) med ét
// opslag af adresserne. Samme (auktion, bruger) sendes aldrig to gange -
// heller ikke efter en forlængelse ved sene bud.
//
// Typen er den valgfri 'fulgt_slutter_snart' ("Auktion slutter snart").
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPushBatch, type PushOpgave } from "@/lib/notifikationer/send";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { notifikationMail } from "@/lib/mails/handel";
import { logDriftFejl } from "@/lib/drift";
import { paamindelseFoerSlutTekst } from "@/lib/notifikationer/paamindelseFoerSlutTekst";
import type { NotifikationType } from "@/lib/notifikationer/typer";

const TYPE: NotifikationType = "fulgt_slutter_snart";
const GRAENSE = 2000;
const MAIL_SAMTIDIGE = 5;

type ClaimRaekke = {
  auktion_id: string;
  bruger_id: string;
  titel: string;
  slutter_kl: string;
  budt: boolean;
  foerer: boolean;
  klokke: boolean;
  mail: boolean;
  push: boolean;
};

export type PaamindelseResultat = { claimet: number; klokke: number; push: number; mail: number };

async function logFejl(hvor: string, fejl: unknown) {
  console.error(`Påmindelse før slut (${hvor}):`, fejl);
  await logDriftFejl({ kilde: "cron", hvor: "paamindelseFoerSlut", sti: `notifikation:${TYPE}:${hvor}`, fejl });
}

// Kaster aldrig. Returnerer antal claimede og sendte pr. kanal - eller null,
// hvis migrationen ikke er kørt endnu (så bruger cron'en den gamle
// favorit-påmindelse, og rækkefølgen af deploy og migration er ligegyldig).
export async function notificerFoerSlut(): Promise<PaamindelseResultat | null> {
  const res: PaamindelseResultat = { claimet: 0, klokke: 0, push: 0, mail: 0 };
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("paamindelser_foer_slut_claim", { p_graense: GRAENSE });
  if (error) {
    // PGRST202/42883: migrationen er ikke kørt endnu.
    if (error.code === "PGRST202" || error.code === "42883") return null;
    await logFejl("claim", error.message);
    return res;
  }
  const raekker = (data ?? []) as ClaimRaekke[];
  res.claimet = raekker.length;
  if (raekker.length === 0) return res;

  const nu = Date.now();
  const opgaver = raekker.map((r) => {
    const { titel, tekst } = paamindelseFoerSlutTekst(
      { titel: r.titel, slutterKl: r.slutter_kl, budt: r.budt, foerer: r.foerer },
      nu,
    );
    return {
      r,
      input: {
        titel,
        tekst,
        link: `/auktion/${r.auktion_id}`,
        // Kun auktionens id - aldrig andre brugeres (fx den førende byder).
        data: { auction_id: r.auktion_id, foerer: r.budt ? r.foerer : null },
      },
    };
  });

  // Klokken: én bulk-insert.
  const klokke = opgaver.filter((o) => o.r.klokke);
  if (klokke.length > 0) {
    const { error: kFejl } = await admin.from("notifikationer").insert(
      klokke.map((o) => ({
        bruger_id: o.r.bruger_id,
        type: TYPE,
        titel: o.input.titel.slice(0, 200),
        tekst: o.input.tekst.slice(0, 2000),
        link: o.input.link,
        data: o.input.data,
      })),
    );
    if (kFejl) await logFejl("klokke", kFejl.message);
    else res.klokke = klokke.length;
  }

  // Push: ét token-opslag og Expo i bundter.
  const push: PushOpgave[] = opgaver
    .filter((o) => o.r.push)
    .map((o) => ({ brugerId: o.r.bruger_id, type: TYPE, input: o.input }));
  if (push.length > 0) {
    const p = await sendPushBatch(admin, push);
    res.push = p.modtog.size;
    if (p.fejl) await logFejl("push", p.fejl);
  }

  // Mail: kun til dem, der har mail slået til for typen (standard er til,
  // som for alle notifikationstyper). Adresserne hentes i ét opslag.
  const mail = opgaver.filter((o) => o.r.mail);
  if (mail.length > 0) {
    const ids = [...new Set(mail.map((o) => o.r.bruger_id))];
    const adresser = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: u, error: uFejl } = await admin
        .from("users")
        .select("id, email")
        .in("id", ids.slice(i, i + 200));
      if (uFejl) {
        await logFejl("mail-adresser", uFejl.message);
        break;
      }
      for (const x of u ?? []) if (x.email) adresser.set(x.id as string, x.email as string);
    }
    let sidsteFejl: string | null = null;
    for (let i = 0; i < mail.length; i += MAIL_SAMTIDIGE) {
      const svar = await Promise.all(
        mail.slice(i, i + MAIL_SAMTIDIGE).map((o) => {
          const til = adresser.get(o.r.bruger_id);
          if (!til) return Promise.resolve(null);
          return sendHandelMailDetaljer(til, notifikationMail(o.input.titel, o.input.tekst, o.input.link));
        }),
      );
      for (const s of svar) {
        if (s?.ok) res.mail++;
        else if (s && s.fejl !== "Slettet bruger" && s.fejl !== "RESEND_API_KEY mangler") sidsteFejl = s.fejl;
      }
    }
    if (sidsteFejl) await logFejl("mail", sidsteFejl);
  }

  return res;
}
