import Image from "next/image";
import Link from "next/link";

// Topbar i den lukkede "før lancering"-udgave (src/lib/lukketUdgave.ts): kun
// logoet, som fører til /coming-soon. Ingen menu, søgning eller login.
export default function LukketHeader() {
  return (
    <header className="border-b border-kant bg-white">
      <div className="mx-auto flex max-w-[1280px] items-center px-4 py-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label="BidHamr – til forsiden"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          <Image
            src="/brand/bidhamr-logo.svg"
            alt="BidHamr"
            width={230}
            height={60}
            priority
            unoptimized
            className="h-9 w-auto"
          />
        </Link>
      </div>
    </header>
  );
}
