import Link from "next/link";
import WaitlistForm from "@/components/landing/WaitlistForm";

export default function ComingSoonPage() {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center bg-white px-4 py-16 text-center">
      <Link
        href="/login"
        className="absolute top-6 right-6 text-sm font-medium text-neutral-400 hover:text-brand"
      >
        Log ind
      </Link>

      <span className="text-3xl font-extrabold tracking-tight text-brand">
        hamr
      </span>

      <h1 className="mt-6 max-w-xl text-3xl font-bold tracking-tight text-neutral-900 sm:text-5xl">
        Danmarks nye <span className="text-brand">lokale</span>{" "}
        auktionsplatform er på vej.
      </h1>

      <p className="mt-4 max-w-md text-[17px] leading-relaxed text-neutral-500">
        Sælg dine ting på auktion til folk i nærheden — eller find gode
        tilbud lige om hjørnet. Tilmeld dig ventelisten og vær med fra dag
        ét.
      </p>

      <div className="mt-2 flex w-full justify-center">
        <WaitlistForm />
      </div>
    </main>
  );
}
