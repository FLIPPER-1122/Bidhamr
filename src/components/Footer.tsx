export default function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-[#F3F4F6] px-4 py-6 text-sm text-[#6B7280] sm:px-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-bold text-brand">BidHamr</span>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
          <span>+45 70 12 34 56</span>
          <span>support@bidhamr.dk</span>
        </div>
      </div>
    </footer>
  );
}
