// Read a whole notes repository in one go: GitHub serves it as a gzipped tar archive (one API call plus
// one redirect). Searching and scanning then work in memory, which keeps every request far below
// Cloudflare's per-request limit on outside calls (50 on the free plan) however many notes there are.

const decoder = new TextDecoder();

function field(block: Uint8Array, start: number, length: number): string {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

const octal = (block: Uint8Array, start: number, length: number) => parseInt(field(block, start, length).trim() || "0", 8);

/** Path from a PAX extended header ("<len> path=<value>\n" records), if it sets one. */
function paxPath(data: Uint8Array): string | undefined {
  const text = decoder.decode(data);
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const len = parseInt(text.slice(i, space), 10);
    if (!len) break;
    const record = text.slice(space + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (record.slice(0, eq) === "path") return record.slice(eq + 1);
    i += len;
  }
  return undefined;
}

/** Regular files in a tar archive, as path → bytes. Handles ustar prefixes, PAX and GNU long names. */
export function untar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? prefix + "/" : "") + field(header, 0, 100);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { longName = paxPath(body); continue; }
    if (type === "L") { longName = field(body, 0, body.length); continue; }
    longName = undefined;
    if (type === "0" || type === "7") files.set(name, body);
  }
  return files;
}

/** Text files from a .tar.gz, with the archive's top folder (GitHub's "owner-repo-sha/") removed. */
export async function readTarGz(stream: ReadableStream<Uint8Array>): Promise<Map<string, string>> {
  const tar = new Uint8Array(await new Response(stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer());
  const out = new Map<string, string>();
  for (const [path, bytes] of untar(tar)) {
    const slash = path.indexOf("/");
    out.set(slash < 0 ? path : path.slice(slash + 1), decoder.decode(bytes));
  }
  return out;
}
