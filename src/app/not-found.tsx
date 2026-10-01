import Link from "next/link";

export const metadata = {
  title: "Siden findes ikke – BidHamr",
};

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center bg-neutral-50 px-4 py-16">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold text-neutral-500">404</p>
        <h1 className="mt-2 text-2xl font-bold text-[#111]">Siden findes ikke</h1>
        <p className="mt-3 text-sm text-neutral-600">
          Siden er flyttet, slettet, eller adressen er skrevet forkert. Auktionen
          kan også være afsluttet og fjernet.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/auktioner"
            className="rounded-lg bg-orange-knap px-6 py-3 text-sm font-semibold text-white hover:bg-orange-knap-mork"
          >
            Se auktioner
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-neutral-300 bg-white px-6 py-3 text-sm font-semibold text-neutral-800 hover:bg-neutral-100"
          >
            Til forsiden
          </Link>
        </div>
      </div>
    </main>
  );
}
