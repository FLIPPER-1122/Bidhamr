export default function Avatar({
  url,
  navn,
  size = 40,
}: {
  url: string | null;
  navn: string | null;
  size?: number;
}) {
  const initial = navn?.trim()?.[0]?.toUpperCase() ?? "?";

  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={navn ?? "Bruger"}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-brand/10 font-bold text-brand"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initial}
    </div>
  );
}
