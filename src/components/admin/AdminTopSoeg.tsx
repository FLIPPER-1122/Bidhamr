// Søgningen øverst i admin (Filip, 12. okt. 2026): find en bruger, handel,
// auktion eller sag ud fra e-mail, navn, id eller nummer og gå direkte
// dertil. En almindelig GET-formular - ingen JavaScript. Sælgeren søger kun
// i Erhverv.
export default function AdminTopSoeg({ erhverv = false, vaerdi = "" }: { erhverv?: boolean; vaerdi?: string }) {
  const pladsholder = erhverv ? "Søg firma, CVR, e-mail eller klagenummer" : "Søg bruger, handel, auktion eller sag (navn, e-mail, id, nr.)";
  return (
    <form role="search" action={erhverv ? "/admin/erhverv/soeg" : "/admin/soeg"} className="relative w-full max-w-xl">
      <label htmlFor="admin-top-soeg" className="sr-only">
        Søg i admin
      </label>
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-tekst-svag"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M21 21l-6 -6" />
      </svg>
      <input
        id="admin-top-soeg"
        name="q"
        type="search"
        defaultValue={vaerdi}
        maxLength={120}
        autoComplete="off"
        enterKeyHint="search"
        placeholder={pladsholder}
        className="h-11 w-full rounded-full border border-kant-staerk bg-white pl-10 pr-24 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
      />
      {/* Touch-målet er 44 px højt; den synlige pille ligger indeni (DESIGN 8.4). */}
      <button
        type="submit"
        className="group absolute right-0 top-0 inline-flex h-11 items-center rounded-full px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <span className="inline-flex h-9 items-center rounded-full bg-orange-knap px-4 text-sm font-semibold text-white group-hover:bg-orange-knap-mork">
          Søg
        </span>
      </button>
    </form>
  );
}
