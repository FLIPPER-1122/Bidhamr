import Link from "next/link";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import {
  dsaAnmeldelseAfgoer,
  dsaIndgrebFraAnmeldelse,
  dsaKlageAfgoer,
  dsaVideresend,
} from "@/app/actions/adminDsa";
import {
  REGEL_VALG,
  UDFALD_NAVNE,
  anmeldKategoriNavn,
  handlingKraeverAdmin,
  handlingNavn,
  handlingerFor,
  indholdNavn,
} from "@/lib/dsa/regler";
import {
  Boks,
  Frist,
  Inhabil,
  KNAP_BEHOLD,
  KNAP_FJERN,
  KNAP_NEUTRAL,
  Pille,
  PlaceringLink,
  Rolle,
  tid,
} from "@/components/admin/dsa/DsaDele";

// Kortene på /admin/dsa: én anmeldelses-gruppe (alle åbne anmeldelser af
// samme indhold) og én klage. Data og inhabilitet beregnes i page.tsx.

export type Anmeldelse = {
  id: string;
  sagsnummer: string;
  indhold_type: string;
  indhold_id: string | null;
  auktion_id: string | null;
  anmeldt_bruger_id: string | null;
  placering: string;
  kategori: string;
  begrundelse: string;
  anmelder_id: string | null;
  anmelder_navn: string | null;
  anmelder_email: string | null;
  status: string;
  frist_kl: string;
  eskaleret_kl: string | null;
  eskaleret_af: string | null;
  eskaleret_note: string | null;
  udfald: string | null;
  svar_til_anmelder: string | null;
  intern_note: string | null;
  politi_underrettet: boolean;
  behandlet_af: string | null;
  behandlet_kl: string | null;
  genaabnet_kl: string | null;
  anonymiseret_kl: string | null;
  oprettet_kl: string;
};

export type Afgoerelse = {
  id: string;
  sagsnummer: string;
  bruger_id: string;
  indhold_type: string;
  indhold_id: string;
  indhold_tekst: string | null;
  handling: string;
  regel_kode: string;
  regel_tekst: string;
  grundlag: string;
  fakta: string;
  intern_note: string | null;
  automatisk_opdaget: boolean;
  anmeldelse_id: string | null;
  medarbejder_id: string | null;
  oprettet_kl: string;
  ophaevet_kl: string | null;
  ophaevet_grund: string | null;
};

export type Klage = {
  id: string;
  sagsnummer: string;
  afgoerelse_id: string | null;
  anmeldelse_id: string | null;
  klager_id: string | null;
  klager_email: string | null;
  begrundelse: string;
  status: string;
  udfald: string | null;
  svar: string | null;
  afgjort_af: string | null;
  afgjort_kl: string | null;
  frist_kl: string;
  oprettet_kl: string;
};

// Alle åbne anmeldelser af samme indhold.
export type Gruppe = {
  noegle: string;
  anm: Anmeldelse[]; // sorteret efter frist
  forste: Anmeldelse;
  frist: string;
  kategorier: string[];
  ejer: string | null;
  uddrag: string | null;
  tidligereAfg: number;
  videresendt: Anmeldelse | null;
  kunAdmin: boolean;
  inhabil: string | null;
};

type Navn = (id: string | null) => string;

const STANDARD_SVAR =
  "Tak for din anmeldelse. Vi har vurderet indholdet og fundet, at det ikke er ulovligt og ikke bryder BidHamrs regler. Det bliver derfor på BidHamr.";

function Anmelder({ a, navn }: { a: Anmeldelse; navn: Navn }) {
  if (a.anmelder_id) {
    return (
      <Link href={`/admin/brugere/${a.anmelder_id}`} className="font-medium text-groen hover:underline">
        {navn(a.anmelder_id)}
      </Link>
    );
  }
  if (a.anmelder_navn || a.anmelder_email) {
    return (
      <span className="text-neutral-800">
        {a.anmelder_navn ?? "Uden navn"}
        {a.anmelder_email && <span className="break-all text-neutral-600"> · {a.anmelder_email}</span>}
        <span className="text-neutral-600"> (uden login)</span>
      </span>
    );
  }
  return <span className="text-neutral-700">Anonym (misbrug af børn)</span>;
}

export function AnmeldelseGruppeKort({
  g,
  navn,
  erAdmin,
}: {
  g: Gruppe;
  navn: Navn;
  erAdmin: boolean;
}) {
  const a = g.forste;
  const alle = handlingerFor(a.indhold_type);
  const mine = alle.filter((h) => erAdmin || !handlingKraeverAdmin(h));
  const antal = g.anm.length;
  const ider = g.anm.map((x) => x.id).join(",");
  const ikkeVideresendt = g.anm.filter((x) => !x.eskaleret_kl).map((x) => x.id);
  const titelId = `anm-${a.id}`;

  return (
    <li
      aria-labelledby={titelId}
      className={`rounded-[14px] border bg-white p-4 sm:p-5 ${g.videresendt ? "border-purple-300" : "border-kant"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titelId} className="text-[15px] font-semibold text-neutral-900">
            {indholdNavn(a.indhold_type)}
            {g.uddrag && <span className="font-normal text-neutral-600"> · {g.uddrag.slice(0, 80)}{g.uddrag.length > 80 ? "…" : ""}</span>}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {antal > 1 && <Pille farve="orange">{antal} anmeldelser</Pille>}
            {g.kategorier.map((k) => (
              <Pille key={k}>{anmeldKategoriNavn(k)}</Pille>
            ))}
            {g.kunAdmin && <Pille farve="blaa">Kræver admin</Pille>}
            {g.videresendt && <Pille farve="lilla">Videresendt til admin</Pille>}
            {g.anm.some((x) => x.genaabnet_kl) && <Pille farve="blaa">Genåbnet efter klage</Pille>}
          </div>
        </div>
        <Frist iso={g.frist} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Boks titel="Anmeldt indhold">
          <p>
            <PlaceringLink indholdType={a.indhold_type} placering={a.placering} />
          </p>
          {g.uddrag && <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{g.uddrag}</p>}
          {g.ejer && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                <Rolle>Ejer</Rolle>
                <Link href={`/admin/brugere/${g.ejer}`} className="font-medium text-groen hover:underline">
                  {navn(g.ejer)}
                </Link>
              </span>
              <span className={g.tidligereAfg > 0 ? "font-medium text-advarsel-tekst" : "text-neutral-600"}>
                {g.tidligereAfg === 0
                  ? "Ingen tidligere afgørelser"
                  : `${g.tidligereAfg} ${g.tidligereAfg === 1 ? "tidligere afgørelse" : "tidligere afgørelser"}`}
              </span>
            </p>
          )}
        </Boks>
        <Boks titel={antal > 1 ? `Anmeldelserne (${antal})` : "Anmeldelsen"}>
          <ul className="divide-y divide-neutral-200">
            {g.anm.map((x) => (
              <li key={x.id} className="py-2 first:pt-0 last:pb-0">
                <p className="text-xs text-neutral-600">
                  {x.sagsnummer} · {anmeldKategoriNavn(x.kategori)} · {tid(x.oprettet_kl)}
                </p>
                <p className="mt-0.5">
                  <Rolle>Anmelder</Rolle>
                  <Anmelder a={x} navn={navn} />
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{x.begrundelse}</p>
              </li>
            ))}
          </ul>
        </Boks>
      </div>

      {g.videresendt && (
        <p className="mt-3 rounded-lg bg-purple-50 px-3 py-2 text-sm text-purple-900">
          Videresendt af {navn(g.videresendt.eskaleret_af)} {g.videresendt.eskaleret_kl && tid(g.videresendt.eskaleret_kl)}:{" "}
          {g.videresendt.eskaleret_note}
        </p>
      )}

      {g.inhabil ? (
        <Inhabil grund={g.inhabil} />
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {mine.length > 0 && a.indhold_id && (
            <ConfirmDialog
              triggerLabel={a.indhold_type === "profil" ? "Suspendér / luk konto" : "Fjern / skjul"}
              triggerClassName={KNAP_FJERN}
              title="Grib ind over for indholdet"
              description={`Brugeren får begrundelsen på e-mail og kan klage. ${
                antal > 1 ? `Alle ${antal} anmeldelser` : "Anmeldelsen"
              } af indholdet lukkes, og anmelderne får svar.`}
              confirmLabel="Udfør og send begrundelse"
              action={dsaIndgrebFraAnmeldelse}
              hiddenFields={{ anmeldelseId: a.id }}
              varighedField={a.indhold_type === "profil"}
              kvittering="Indgrebet er udført. Brugeren og anmelderne får besked."
              vaelgFelter={[
                {
                  name: "handling",
                  label: "Hvad skal der ske?",
                  valg: mine.map((h) => ({ value: h, label: handlingNavn(h) })),
                  standard: mine[0],
                  hjaelp: a.indhold_type === "profil" ? "Varigheden gælder kun suspendering." : undefined,
                },
                {
                  // Ingen forvalg: reglen står i begrundelsen til brugeren, så
                  // den skal vælges bevidst (ikke ud fra anmelderens kategori).
                  name: "regel",
                  label: "Hvilken regel eller lov bryder det?",
                  valg: REGEL_VALG,
                  pladsholder: "Vælg regel",
                  hjaelp: `Anmelderen valgte: ${g.kategorier.map(anmeldKategoriNavn).join(", ")}. Vælg selv den regel, der passer.`,
                },
              ]}
              tekstFelter={[
                {
                  name: "fakta",
                  label: "Begrundelse til brugeren (vises for brugeren)",
                  placeholder: "Skriv konkret, hvad brugeren har gjort, fx: Auktionen sælger en kopi af en mærketaske som ægte.",
                  required: true,
                  maxLength: 2000,
                  hjaelp: "Skriv aldrig, hvem der har anmeldt.",
                },
                {
                  name: "svar",
                  label: antal > 1 ? "Svar til anmelderne" : "Svar til anmelderen",
                  placeholder: "Tom = standardtekst om, at vi har grebet ind.",
                  required: false,
                  maxLength: 2000,
                },
                { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
              ]}
              afkrydsning={{ name: "politi", label: "Vi har givet politiet besked (mistanke om strafbart forhold, der truer liv eller sikkerhed)" }}
            />
          )}
          <ConfirmDialog
            triggerLabel="Behold"
            triggerClassName={KNAP_BEHOLD}
            title="Afslut uden at gribe ind?"
            description={`Indholdet bliver. ${
              antal > 1 ? `Alle ${antal} anmeldere får` : "Anmelderen får"
            } dit svar og kan klage over afgørelsen.`}
            confirmLabel="Afslut og send svar"
            action={dsaAnmeldelseAfgoer}
            hiddenFields={{ anmeldelseIder: ider }}
            kvittering={antal > 1 ? `Sagen er afsluttet. ${antal} anmeldere får dit svar.` : "Sagen er afsluttet. Anmelderen får dit svar."}
            valgField={{
              name: "udfald",
              label: "Udfald",
              valg: [
                { value: "ingen_overtraedelse", label: "Ingen overtrædelse" },
                { value: "ikke_fundet", label: "Indholdet findes ikke" },
              ],
            }}
            tekstFelter={[
              {
                name: "svar",
                label: antal > 1 ? "Svar til anmelderne (vises for dem)" : "Svar til anmelderen (vises for anmelderen)",
                required: true,
                maxLength: 2000,
                standard: STANDARD_SVAR,
              },
              { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
            ]}
            afkrydsning={{ name: "politi", label: "Vi har givet politiet besked" }}
          />
          {ikkeVideresendt.length > 0 && (
            <ConfirmDialog
              triggerLabel="Videresend til admin"
              triggerClassName={KNAP_NEUTRAL}
              title="Videresend til admin?"
              description="Sagen bliver i listen, markeret til admin. Brug det, når kun admin kan gribe ind (fx en auktion), eller når du er i tvivl."
              confirmLabel="Videresend"
              action={dsaVideresend}
              hiddenFields={{ anmeldelseIder: ikkeVideresendt.join(",") }}
              kvittering="Sagen er sendt videre til admin."
              aarsagField={{ label: "Note til admin", placeholder: "Hvad har du set, og hvad foreslår du?", required: true }}
            />
          )}
          {alle.length > 0 && mine.length === 0 && (
            <span className="text-sm text-neutral-600">Kun admin kan fjerne auktioner og lukke konti.</span>
          )}
        </div>
      )}
    </li>
  );
}

export function KlageKort({
  k,
  afg,
  anm,
  navn,
  inhabil,
  erAdmin,
}: {
  k: Klage;
  afg: Afgoerelse | null;
  anm: Anmeldelse | null;
  navn: Navn;
  inhabil: string | null;
  erAdmin: boolean;
}) {
  const kraeverAdmin = afg ? handlingKraeverAdmin(afg.handling) : false;
  const titelId = `klage-${k.id}`;
  const ramt = afg ? afg.bruger_id : (anm?.anmeldt_bruger_id ?? null);

  return (
    <li aria-labelledby={titelId} className="rounded-[14px] border border-kant bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titelId} className="text-[15px] font-semibold text-neutral-900">
            {afg ? `Klage over: ${handlingNavn(afg.handling)}` : "Anmelder klager over, at vi ikke greb ind"}
          </h3>
          <p className="mt-0.5 text-xs text-neutral-600">
            {k.sagsnummer} · modtaget {tid(k.oprettet_kl)}
          </p>
          {kraeverAdmin && (
            <p className="mt-1.5">
              <Pille farve="blaa">Kræver admin</Pille>
            </p>
          )}
        </div>
        <Frist iso={k.frist_kl} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Boks titel="Den oprindelige afgørelse">
          {afg ? (
            <>
              <p className="text-neutral-800">
                {afg.sagsnummer} · {tid(afg.oprettet_kl)} · af {navn(afg.medarbejder_id)}
              </p>
              {afg.indhold_tekst && <p className="mt-1 text-neutral-700">{afg.indhold_tekst}</p>}
              <p className="mt-1 text-neutral-700"><strong>Regel:</strong> {afg.regel_tekst}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-neutral-700"><strong>Begrundelse:</strong> {afg.fakta}</p>
              {afg.intern_note && <p className="mt-1 text-xs text-neutral-600">Intern note: {afg.intern_note}</p>}
            </>
          ) : anm ? (
            <>
              <p className="text-neutral-800">
                {anm.sagsnummer} · {anmeldKategoriNavn(anm.kategori)} · af {navn(anm.behandlet_af)}
              </p>
              <p className="mt-1"><PlaceringLink indholdType={anm.indhold_type} placering={anm.placering} /></p>
              <p className="mt-1 text-neutral-700">{UDFALD_NAVNE[anm.udfald ?? ""] ?? anm.udfald}</p>
              {anm.svar_til_anmelder && <p className="mt-1 whitespace-pre-wrap break-words text-neutral-700">Svar: {anm.svar_til_anmelder}</p>}
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-neutral-600">Anmeldelsen: {anm.begrundelse}</p>
            </>
          ) : (
            <p className="text-neutral-600">Ikke fundet.</p>
          )}
          {ramt && (
            <p className="mt-2">
              <Rolle>Ejer</Rolle>
              <Link href={`/admin/brugere/${ramt}`} className="font-medium text-groen hover:underline">
                {navn(ramt)}
              </Link>
            </p>
          )}
        </Boks>
        <Boks titel="Klagen">
          <p>
            <Rolle>{afg ? "Klager" : "Anmelder"}</Rolle>
            {k.klager_id ? (
              <Link href={`/admin/brugere/${k.klager_id}`} className="font-medium text-groen hover:underline">
                {navn(k.klager_id)}
              </Link>
            ) : (
              <span className="break-all text-neutral-800">{k.klager_email ?? "anmelder uden login"}</span>
            )}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{k.begrundelse}</p>
        </Boks>
      </div>

      {inhabil ? (
        <Inhabil grund={inhabil} />
      ) : kraeverAdmin && !erAdmin ? (
        <p className="mt-4 rounded-lg bg-info-bg px-3 py-2.5 text-sm text-info-tekst">
          Klager over auktioner og lukkede konti behandles af en admin eller chef.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <ConfirmDialog
            triggerLabel="Giv medhold"
            triggerClassName={KNAP_BEHOLD}
            title="Giv klageren medhold?"
            description={
              afg
                ? afg.handling === "auktion_fjernet" || afg.handling === "auktion_annulleret"
                  ? "Afgørelsen bliver ophævet, men auktionen åbnes ikke igen – buddene gælder ikke. Sælgeren får dit svar (husk en undskyldning) og kan sætte varen op igen med ét klik."
                  : "Indgrebet bliver ophævet med det samme (indholdet vises igen / kontoen åbnes igen). Klageren får dit svar."
                : "Anmeldelsen bliver genåbnet og skal behandles igen. Anmelderen får dit svar."
            }
            confirmLabel="Giv medhold"
            action={dsaKlageAfgoer}
            hiddenFields={{ klageId: k.id, udfald: "medhold" }}
            kvittering="Klageren har fået medhold og får dit svar."
            tekstFelter={[
              { name: "svar", label: "Svar til klageren (vises for klageren)", required: true, maxLength: 2000 },
              { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
            ]}
          />
          <ConfirmDialog
            triggerLabel="Fasthold afgørelsen"
            triggerClassName={KNAP_FJERN}
            title="Fasthold afgørelsen?"
            description="Afgørelsen står ved magt. Klageren får dit svar og besked om andre klagemuligheder. Der er kun ét klagetrin."
            confirmLabel="Fasthold"
            action={dsaKlageAfgoer}
            hiddenFields={{ klageId: k.id, udfald: "fastholdt" }}
            kvittering="Afgørelsen er fastholdt. Klageren får dit svar."
            tekstFelter={[
              { name: "svar", label: "Svar til klageren (vises for klageren)", required: true, maxLength: 2000 },
              { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
            ]}
          />
        </div>
      )}
    </li>
  );
}
