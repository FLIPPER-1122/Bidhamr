import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { kortNavn } from "@/lib/kortNavn";
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import AuctionCard from "@/components/AuctionCard";
import ProfileHeader from "@/components/profile/ProfileHeader";
import ProfilTryghed from "@/components/tryghed/ProfilTryghed";
import AnmeldKnap from "@/components/dsa/AnmeldKnap";
import FoelgKnap from "@/components/foelg/FoelgKnap";
import { createAdminClient } from "@/lib/supabase/admin";
import { erPaaPause } from "@/lib/auctionTid";
import BedoemmelseListe from "@/components/profile/BedoemmelseListe";
import { hentBedoemmelseOpsummering, hentBedoemmelser } from "@/lib/bedoemmelserHent";
import ProfileTabs, {
  type MitBud,
  type EgenAuktion,
  type Rating,
} from "@/components/profile/ProfileTabs";

// public.profil_offentlige_tal (20261007050000/051000): kun antal, ingen beløb.
// Samme definitioner som min_statistik (/konto/statistik).
// auktioner_oprettet tæller ikke auktioner, BidHamr har skjult;
// auktioner_oprettet_alle (alle, også skjulte) og bud_afgivet får kun
// brugeren selv - ellers null.
type ProfilTal = {
  auktioner_oprettet: number;
  auktioner_oprettet_alle: number | null;
  solgte_handler: number;
  medlem_siden: string;
  bud_afgivet: number | null;
};

async function hentProfilTal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
): Promise<ProfilTal | null> {
  const { data, error } = await supabase.rpc("profil_offentlige_tal", { p_bruger: id });
  if (error) {
    console.error("Profiltal kunne ikke hentes:", error.message);
    return null;
  }
  return (data ?? null) as ProfilTal | null;
}

// Dansk ejefald: "Kasper K.s", men "Testfirma ApS'" (navn på s, x eller z).
function genitiv(navn: string): string {
  return /[sxz]$/i.test(navn) ? `${navn}'` : `${navn}s`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Systembrugeren har ingen offentlig profil (siden giver 404).
  if (id.toLowerCase() === BIDHAMR_SYSTEM_ID) {
    return { title: "Siden findes ikke", robots: { index: false, follow: false } };
  }
  const supabase = await createClient();
  const [{ data: authData }, { data: profil }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("users").select("navn, konto_type").eq("id", id).single(),
  ]);
  if (!profil) return { title: "Profil", robots: { index: false, follow: false } };
  const erEgen = authData.user?.id === id;
  const visNavn = erEgen ? (profil.navn ?? "") : kortNavn(profil.navn, profil.konto_type === "erhverv");
  // Kun det korte navn (som på siden) - aldrig fulde navn i søgemaskiner.
  const offentligtNavn = kortNavn(profil.navn, profil.konto_type === "erhverv");
  return {
    title: `${genitiv(visNavn)} profil`,
    description: `Se ${genitiv(offentligtNavn)} auktioner og bedømmelser på BidHamr.`,
    alternates: { canonical: `/profil/${id}` },
    openGraph: { title: `${genitiv(offentligtNavn)} profil · BidHamr`, url: `/profil/${id}` },
  };
}

export default async function ProfilPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Systembrugeren "BidHamr" (afsender af fællesbeskeder) har ingen profil.
  if (id.toLowerCase() === BIDHAMR_SYSTEM_ID) notFound();
  const supabase = await createClient();

  const [{ data: authData }, { data: profil }] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("users")
      .select("id, navn, avatar_url, oprettet, konto_type")
      .eq("id", id)
      .single(),
  ]);

  if (!profil) {
    notFound();
  }

  const erEgenProfil = authData.user?.id === id;

  const medlemSiden = new Date(profil.oprettet).toLocaleDateString("da-DK", {
    month: "long",
    year: "numeric",
  });

  // ── Egen profil ────────────────────────────────────────────────────────────
  if (erEgenProfil) {
    const [
      { data: egneAuktionerRaw },
      { data: mineBidsRaw },
      { data: egenEmail },
      egneRatings,
      egneTal,
      { data: kontakt },
      { data: egneFoelgere },
      opsummering,
    ] = await Promise.all([
      supabase
        .from("auctions")
        .select("*")
        .eq("bruger_id", id)
        .order("oprettet", { ascending: false }),
      supabase
        .from("bids")
        .select("*")
        .eq("bruger_id", id)
        .order("oprettet", { ascending: false }),
      // Egen profil (erEgenProfil): email/telefon via min_profil(), da
      // kolonnerne ikke er laesbare direkte.
      supabase.rpc("min_profil").maybeSingle<{ email: string; telefon: string | null }>(),
      // Skjulte bedømmelser er sorteret fra (tæller heller ikke i gennemsnittet).
      hentBedoemmelser(supabase, id, { erEjer: true }),
      // Samme tal som /konto/statistik (bud_afgivet kun for en selv).
      hentProfilTal(supabase, id),
      // Adressen (kun til afhentning) kan kun læses af ejeren selv.
      supabase.rpc("mine_kontaktoplysninger").maybeSingle<{ adresse: string | null }>(),
      supabase.rpc("antal_foelgere", { p_bruger: id }),
      // Gennemsnit og antal fra databasen - listen er begrænset til 200.
      hentBedoemmelseOpsummering(supabase, id),
    ]);

    const antalRatings = opsummering.antal;
    const gennemsnitRating = opsummering.gennemsnit;

    // Byg egne auktioner med slutter_kl til status-badge
    const egneAuktioner: EgenAuktion[] = (egneAuktionerRaw ?? []).map(
      (auktion) => ({
        ...mapAuctionTilKort(auktion),
        slutterKl: auktion.slutter_kl,
        status: auktion.status,
        pauset: erPaaPause(auktion),
      }),
    );

    // Find unikke auktions-id'er brugeren har budt på og højeste eget bud
    const egneBudPerAuktion = new Map<string, number>();
    for (const bud of mineBidsRaw ?? []) {
      const nuværende = egneBudPerAuktion.get(bud.auktion_id) ?? 0;
      if (bud.beløb > nuværende) {
        egneBudPerAuktion.set(bud.auktion_id, Number(bud.beløb));
      }
    }
    const budAuktionIds = Array.from(egneBudPerAuktion.keys());

    let mineBud: MitBud[] = [];

    if (budAuktionIds.length > 0) {
      // Andres bud kan ikke laeses (bydernes privatliv). Foerende bud staar
      // paa auktionen; har jeg budt mindst det, er det mit.
      const { data: relevanteAuktioner } = await supabase
        .from("auctions")
        .select("*")
        .in("id", budAuktionIds)
        .overrideTypes<
          {
            id: string;
            titel: string;
            billeder: string[] | null;
            slutter_kl: string;
            nuværende_bud: number | string | null;
            vinder_id: string | null;
            status: string;
            pauset_kl: string | null;
          }[],
          { merge: false }
        >();

      mineBud = (relevanteAuktioner ?? []).map((auktion) => {
        const erSlut = new Date(auktion.slutter_kl) <= new Date();
        const højesteBud = Number(auktion.nuværende_bud ?? 0);
        const egetBud = egneBudPerAuktion.get(auktion.id) ?? 0;
        const jegFører = auktion.vinder_id
          ? auktion.vinder_id === id
          : egetBud > 0 && egetBud >= højesteBud;
        const status: MitBud["status"] = erPaaPause(auktion)
          ? "pause"
          : !erSlut
          ? "aktiv"
          : jegFører
            ? "vinder"
            : "overbud";

        return {
          auktionId: auktion.id,
          titel: auktion.titel,
          billede: auktion.billeder?.[0] ?? null,
          egetBud: egneBudPerAuktion.get(auktion.id) ?? 0,
          højesteBud,
          status,
        };
      });
    }

    const ratings: Rating[] = egneRatings;

    return (
      <main className="flex-1 bg-groen-lys px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <div className="mx-auto max-w-5xl">
          <ProfileHeader
            navn={profil.navn ?? ""}
            email={egenEmail?.email}
            avatarUrl={profil.avatar_url}
            medlemSiden={medlemSiden}
            gennemsnitRating={gennemsnitRating}
            antalRatings={antalRatings}
            stats={{
              auktionerOprettet:
                egneTal?.auktioner_oprettet_alle ?? egneTal?.auktioner_oprettet ?? egneAuktioner.length,
              budAfgivet: egneTal?.bud_afgivet ?? budAuktionIds.length,
              gennemforteHandler: egneTal?.solgte_handler ?? 0,
            }}
            erEgenProfil={true}
            brugerId={id}
            antalFoelgere={typeof egneFoelgere === "number" ? egneFoelgere : undefined}
          />

          <Suspense>
            <ProfileTabs
              egneAuktioner={egneAuktioner}
              mineBud={mineBud}
              ratings={ratings}
              brugerId={id}
              navn={profil.navn}
              telefon={egenEmail?.telefon ?? null}
              adresse={kontakt?.adresse ?? null}
              email={egenEmail?.email ?? ""}
              avatarUrl={profil.avatar_url}
            />
          </Suspense>
        </div>
      </main>
    );
  }

  // ── Offentlig profil ───────────────────────────────────────────────────────
  const erLoggetInd = Boolean(authData.user);
  const mitId = authData.user?.id ?? null;
  const [
    { data: aktiveAuktionerRaw },
    ratings,
    { data: harBlokeret },
    { data: antalFoelgere },
    { data: minFoelgning },
    blokeretAfProfil,
    opsummering,
    profilTal,
  ] = await Promise.all([
    supabase
      .from("auctions")
      .select("*")
      .eq("bruger_id", id)
      .eq("status", "aktiv")
      .gt("slutter_kl", new Date().toISOString())
      .order("oprettet", { ascending: false }),
    // Med "Svar fra sælger". Skjulte bedømmelser er sorteret fra.
    hentBedoemmelser(supabase, id),
    // Kun navngivne blokeringer (anonyme spærringer af bydere tæller ikke).
    erLoggetInd
      ? supabase.rpc("jeg_har_blokeret", { p_bruger: id })
      : Promise.resolve({ data: false }),
    supabase.rpc("antal_foelgere", { p_bruger: id }),
    // Altid filtreret på follower_id: i produktion kan RLS stadig tillade at
    // læse alle følgninger (20261007012000 er ikke kørt endnu), og så ville
    // maybeSingle() fejle, når profilen har flere følgere.
    mitId
      ? supabase
          .from("seller_follows")
          .select("id")
          .eq("follower_id", mitId)
          .eq("seller_id", id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Har profilens ejer blokeret mig ved navn? Intern funktion (kun
    // service-role), kaldt med den indloggedes eget id. Browseren får kun,
    // om Følg-knappen vises.
    mitId
      ? createAdminClient()
          .rpc("er_blokeret_navngivet_mellem", { p_a: id, p_b: mitId })
          .then(({ data, error }) => (error ? false : data === true))
      : Promise.resolve(false),
    hentBedoemmelseOpsummering(supabase, id),
    hentProfilTal(supabase, id),
  ]);

  const aktiveAuktioner = (aktiveAuktionerRaw ?? []).map(mapAuctionTilKort);

  // Fra databasen (users.rating + count), ikke fra de højst 200 hentede.
  const antalRatings = opsummering.antal;
  const gennemsnitRating = opsummering.gennemsnit;

  return (
    <main className="flex-1 bg-groen-lys px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <ProfileHeader
          navn={kortNavn(profil.navn, profil.konto_type === "erhverv")}
          avatarUrl={profil.avatar_url}
          medlemSiden={medlemSiden}
          gennemsnitRating={gennemsnitRating}
          antalRatings={antalRatings}
          stats={{
            auktionerOprettet: profilTal?.auktioner_oprettet ?? aktiveAuktioner.length,
            budAfgivet: 0,
            gennemforteHandler: profilTal?.solgte_handler ?? 0,
          }}
          erEgenProfil={false}
          brugerId={id}
          antalFoelgere={typeof antalFoelgere === "number" ? antalFoelgere : undefined}
          handling={
            !blokeretAfProfil && harBlokeret !== true ? (
              <FoelgKnap
                saelgerId={id}
                navn={kortNavn(profil.navn, profil.konto_type === "erhverv")}
                foelger={Boolean(minFoelgning)}
                loginHref={erLoggetInd ? undefined : `/login?redirect=/profil/${id}`}
              />
            ) : undefined
          }
        />

        {!erLoggetInd && (
          <AnmeldKnap type="profil" id={id} hvad={`Profilen ${kortNavn(profil.navn, profil.konto_type === "erhverv")}`} loggetInd={false} label="Anmeld profil" />
        )}
        {erLoggetInd && (
          <ProfilTryghed
            brugerId={id}
            navn={kortNavn(profil.navn, profil.konto_type === "erhverv")}
            erBlokeret={harBlokeret === true}
          />
        )}

        {/* Aktive auktioner */}
        <section className="rounded-[14px] bg-white p-5 sm:p-6">
          <h2 className="text-[20px] leading-tight lg:text-[22px]">
            Aktive auktioner
          </h2>
          {aktiveAuktioner.length === 0 ? (
            <p className="mt-3 text-sm text-tekst-svag">
              Ingen aktive auktioner lige nu.
            </p>
          ) : (
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
              {aktiveAuktioner.map((auktion) => (
                <li key={auktion.id} className="min-w-0">
                  <AuctionCard auktion={auktion} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Bedømmelser */}
        <section className="rounded-[14px] bg-white p-5 sm:p-6">
          <h2 className="text-[20px] leading-tight lg:text-[22px]">
            Bedømmelser
          </h2>
          <div className="mt-4">
            <BedoemmelseListe
              ratings={ratings}
              erSaelger={false}
              erLoggetInd={erLoggetInd}
              mitId={mitId}
              kortKlasse="rounded-xl bg-groen-lys p-4"
              tomTekst="Ingen bedømmelser endnu."
            />
          </div>
        </section>
      </div>
    </main>
  );
}
