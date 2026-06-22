export default function StarRating({
  gennemsnit,
  antal,
}: {
  gennemsnit: number;
  antal: number;
}) {
  if (antal === 0) {
    return <p className="text-sm text-neutral-500">Ingen bedømmelser endnu</p>;
  }

  return (
    <p className="text-sm text-neutral-700">
      ⭐ {gennemsnit.toFixed(1)} · {antal} bedømmelse{antal === 1 ? "" : "r"}
    </p>
  );
}
