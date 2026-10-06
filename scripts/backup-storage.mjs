// Henter alle filer i alle Storage-buckets ned til en lokal mappe.
// Kaldes af scripts/backup-database.ps1 - kan også køres alene:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup-storage.mjs <mappe>
// Læser kun (list + download). Nøglen printes aldrig.
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ud = process.argv[2];

if (!url || !key || !ud) {
  console.error("Mangler SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY eller mappe-argument.");
  process.exit(2);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function listAlle(bucket, prefix = "") {
  const filer = [];
  const side = 1000;
  for (let offset = 0; ; offset += side) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: side, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`Kunne ikke liste ${bucket}/${prefix}: ${error.message}`);
    for (const item of data) {
      const fuld = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) filer.push(...(await listAlle(bucket, fuld))); // mappe
      else filer.push({ sti: fuld, stoerrelse: item.metadata?.size ?? null });
    }
    if (data.length < side) break;
  }
  return filer;
}

const { data: buckets, error } = await supabase.storage.listBuckets();
if (error) {
  console.error(`Kunne ikke hente buckets: ${error.message}`);
  process.exit(1);
}

const manifest = { hentet: new Date().toISOString(), buckets: {} };
let fejl = 0;

for (const b of buckets) {
  const filer = await listAlle(b.name);
  let bytes = 0;
  let ok = 0;
  let udenFil = 0;
  for (const f of filer) {
    const { data, error: dlFejl } = await supabase.storage.from(b.name).download(f.sti);
    if (dlFejl) {
      // Rækker i storage.objects uden størrelse og uden fil (fx indsat direkte
      // i databasen af testdata) er ikke en backupfejl - der er intet at hente.
      if (f.stoerrelse === null) {
        udenFil++;
        console.warn(`  ADVARSEL ${b.name}/${f.sti}: kun metadata, ingen fil`);
        continue;
      }
      fejl++;
      console.error(`  FEJL ${b.name}/${f.sti}: ${dlFejl.message}`);
      continue;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    const maal = path.join(ud, b.name, ...f.sti.split("/"));
    await mkdir(path.dirname(maal), { recursive: true });
    await writeFile(maal, buf);
    bytes += buf.length;
    ok++;
  }
  manifest.buckets[b.name] = {
    offentlig: b.public,
    filer: ok,
    bytes,
    uden_fil: udenFil,
    fejl: filer.length - ok - udenFil,
  };
  console.log(`  ${b.name}: ${ok}/${filer.length} filer, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

await mkdir(ud, { recursive: true });
await writeFile(path.join(ud, "storage-manifest.json"), JSON.stringify(manifest, null, 2));
process.exit(fejl ? 1 : 0);
