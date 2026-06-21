import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-16 text-center sm:py-24">
      <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
        Køb og sælg lokalt på <span className="text-brand">Hamr</span>
      </h1>
      <p className="mt-4 max-w-md text-lg text-neutral-600">
        Find gode tilbud i dit lokalområde, eller sæt dine egne ting på
        auktion på få minutter.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/opret-auktion"
          className="rounded-md bg-brand px-6 py-3 text-sm font-medium text-white transition hover:opacity-90"
        >
          Opret en auktion
        </Link>
        <Link
          href="/signup"
          className="rounded-md border border-brand px-6 py-3 text-sm font-medium text-brand transition hover:bg-brand hover:text-white"
        >
          Opret konto
        </Link>
      </div>

      <section className="mt-20 w-full max-w-2xl rounded-lg border border-dashed border-neutral-300 px-6 py-12 text-neutral-500">
        <p>Aktive auktioner kommer her snart.</p>
      </section>
    </main>
  );
}
