// The smart-HTTP git surface: v2 advertisements and ls-refs, v2 and v0 fetches, and v0
// receive-pack. There is no git binary in the trial pod — every byte here is written and read by
// the code below, and every object the suite receives is judged by recomputing its SHA-1.
//
// The shapes follow the client that drives them (sdk/conformance/git-client.ts):
//
//   - info/refs answers with the service preamble, a flush, then either `version 2` plus one
//     capability line per packet, or the v0 ref list with its capabilities on the first line;
//   - a v2 fetch answers `acknowledgments` (only when the client sent haves), `shallow-info` when a
//     depth or a shallow boundary is in play, then `packfile` whose packets are sideband-framed;
//   - receive-pack is v0-only, and its report-status travels inside sideband band 1 as a nested
//     pkt-line stream.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Repo,
  allRefs,
  commitInfo,
  getObject,
  peelToCommit,
  putObject,
  shortRef,
} from './store.ts';
import { isAncestor } from './mergegraph.ts';

/** The largest pkt-line a client will accept, minus its length prefix. */
const MAX_PKT_PAYLOAD = 65516;

/** The sideband data chunk size: one band byte plus this many bytes stays well inside a pkt-line. */
const SIDE_BAND_CHUNK = 65_000;

/** The all-zero object id: "no such object", which creates and deletes speak. */
export const ZERO_OID = '0'.repeat(40);

/** A pkt-line: a 4-hex length prefix and a payload. `-1` marks a flush, `-2` a delim. */
export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Encode one data packet. */
export function pkt(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length + 4 > MAX_PKT_PAYLOAD + 4) throw new Error(`pkt-line payload of ${body.length} bytes is too large`);
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** The flush packet: end of a section. */
export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet: end of a v2 command's argument list. */
export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode every packet in a buffer, stopping at the first truncation. */
export function decodePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let at = 0;
  while (at + 4 <= buffer.length) {
    const headerText = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) return packets;
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      // A response-end packet; treat it as a section end, as the client does.
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) return packets;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return packets;
}

/** Split a request body into its packet section and the bytes after the first flush. */
export function splitBody(body: Buffer): { packets: Packet[]; rest: Buffer } {
  let at = 0;
  const packets: Packet[] = [];
  while (at + 4 <= body.length) {
    const headerText = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) break;
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, rest: body.subarray(at) };
}

/** The text of each data packet, trailing newline removed. */
function lines(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ----------------------------------------------------------------------------- pack writing

/** The numeric type codes a pack header carries. */
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** One object on its way into a pack. */
export interface PackInput {
  readonly oid: string;
  readonly type: string;
  readonly data: Buffer;
}

/** A pack's object header: the type and size as one varint. */
function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remainder = size;
  let first = (typeCode << 4) | (remainder & 0x0f);
  remainder = Math.floor(remainder / 16);
  while (remainder > 0) {
    bytes.push(first | 0x80);
    first = remainder & 0x7f;
    remainder = Math.floor(remainder / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Deflated bytes per object id. An object's id is the hash of its content, so the same id always means
 * the same bytes and the same deflate output: replaying a cached entry is not an approximation of what
 * deflating again would produce, it is that output. The benchmark clones and pushes the same objects
 * hundreds of times, and zlib is the bulk of both.
 */
const DEFLATED = new Map<string, Buffer>();
/** How many deflated objects are kept: a few hundred KiB of history fits, and the map is bounded. */
const DEFLATE_CACHE_LIMIT = 4096;

/**
 * Whole packs, keyed by the object list they were built from. A pack is a pure function of its objects
 * — their ids carry their bytes — so two requests for the same list must get the same bytes. Fifty
 * concurrent clones of one tip ask for exactly the same list, and this serves them one build.
 */
const PACKS = new Map<string, Buffer>();
/** How many whole packs are kept: enough for a handful of clone shapes at a few hundred KiB each. */
const PACK_CACHE_LIMIT = 64;

/** Write a pack of whole objects (no deltas: correctness first, and the suite accepts zero deltas). */
export function writePack(objects: readonly PackInput[]): Buffer {
  let key = '';
  for (const object of objects) key += `${object.oid},`;
  if (objects.length > 0) {
    const cached = PACKS.get(key);
    if (cached !== undefined) return cached;
  }

  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODE[object.type];
    if (code === undefined) continue;
    let deflated = DEFLATED.get(object.oid);
    if (deflated === undefined) {
      deflated = deflateSync(object.data);
      if (DEFLATED.size >= DEFLATE_CACHE_LIMIT) DEFLATED.clear();
      DEFLATED.set(object.oid, deflated);
    }
    parts.push(packObjectHeader(code, object.data.length));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  if (objects.length > 0) {
    if (PACKS.size >= PACK_CACHE_LIMIT) PACKS.clear();
    PACKS.set(key, pack);
  }
  return pack;
}

// ----------------------------------------------------------------------------- pack reading

/** An object as a push delivered it, resolved from any delta chain. */
export interface UnpackedObject {
  readonly type: string;
  readonly data: Buffer;
  readonly oid: string;
}

/** A pack that does not decode: the push's unpack line reports `unpack <message>`. */
export class PackError extends Error {}

/** The varint at `at`: the size and the type code, plus where the next field starts. */
function readObjectHeader(buffer: Buffer, at: number): { size: number; typeCode: number; next: number } {
  if (at >= buffer.length) throw new PackError('pack entry header is truncated');
  let byte = buffer[at] as number;
  let offset = at + 1;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('pack entry header is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 60) throw new PackError('pack entry header is too long');
  }
  return { size, typeCode, next: offset };
}

/** The ofs-delta base offset, whose encoding is relative and self-delimiting. */
function readOfsBase(buffer: Buffer, at: number): { distance: number; next: number } {
  if (at >= buffer.length) throw new PackError('ofs-delta has no base offset');
  let byte = buffer[at] as number;
  let offset = at + 1;
  let distance = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    distance = (distance + 1) * 128 + (byte & 0x7f);
  }
  return { distance, next: offset };
}

/** Inflate the zlib stream at `at`, answering its bytes and where the stream ended. */
function inflateAt(buffer: Buffer, at: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(at), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (error) {
    throw new PackError(`zlib stream did not inflate: ${(error as Error).message}`);
  }
  const written = result?.engine?.bytesWritten ?? 0;
  if (written <= 0) throw new PackError('zlib stream consumed no bytes');
  return { data: result.buffer, next: at + written };
}

/** Apply a git delta: the copy/insert instruction stream a pack entry may carry. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new PackError('delta varint is truncated');
      const byte = delta[at++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
      if (shift > 60) throw new PackError('delta varint is too long');
    }
  };
  const baseSize = readVarint();
  const targetSize = readVarint();
  if (baseSize !== base.length) throw new PackError(`delta expects a ${baseSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++] as number;
    if (op & 0x80) {
      let copyAt = 0;
      let copySize = 0;
      for (let bit = 0, shift = 0; bit < 4; bit += 1, shift += 8) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new PackError('delta copy offset is truncated');
          copyAt += (delta[at++] as number) * 2 ** shift;
        }
      }
      for (let bit = 4, shift = 0; bit < 7; bit += 1, shift += 8) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new PackError('delta copy size is truncated');
          copySize += (delta[at++] as number) * 2 ** shift;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyAt + copySize > base.length) throw new PackError('delta copy is out of the base');
      if (written + copySize > targetSize) throw new PackError('delta writes past its target size');
      base.copy(out, written, copyAt, copyAt + copySize);
      written += copySize;
      continue;
    }
    if (op === 0) throw new PackError('delta has an invalid opcode 0');
    const literal = op & 0x7f;
    if (at + literal > delta.length) throw new PackError('delta insert is truncated');
    if (written + literal > targetSize) throw new PackError('delta writes past its target size');
    delta.copy(out, written, at, at + literal);
    at += literal;
    written += literal;
  }
  if (written !== targetSize) throw new PackError(`delta wrote ${written} of ${targetSize} bytes`);
  return out;
}

/** Read a pack into its objects, resolving deltas. */
export function readPack(pack: Buffer): UnpackedObject[] {
  if (pack.length < 32) throw new PackError(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const body = pack.subarray(0, trailerAt);
  const trailer = pack.subarray(trailerAt).toString('hex');
  if (trailer !== createHash('sha1').update(body).digest('hex')) throw new PackError('pack trailer does not match its bytes');

  interface Entry {
    offset: number;
    typeCode: number;
    size: number;
    payload: Buffer;
    baseAt?: number;
    baseOid?: string;
  }
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const offset = at;
    const header = readObjectHeader(pack, at);
    at = header.next;
    const entry: Entry = { offset, typeCode: header.typeCode, size: header.size, payload: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, at);
      at = base.next;
      const baseAt = offset - base.distance;
      if (baseAt < 12 || baseAt >= offset) throw new PackError(`ofs-delta at ${offset} names an invalid base offset ${base.distance}`);
      entry.baseAt = baseAt;
    } else if (header.typeCode === 7) {
      if (at + 20 > trailerAt) throw new PackError('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (TYPE_NAME[header.typeCode] === undefined) {
      throw new PackError(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(body, at);
    if (inflated.data.length !== header.size) {
      throw new PackError(`pack entry at ${offset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.payload = inflated.data;
    at = inflated.next;
    entries.push(entry);
    byOffset.set(offset, entry);
  }

  const resolved = new Map<number, UnpackedObject>();
  const byOid = new Map<string, UnpackedObject>();
  const resolving = new Set<number>();

  const resolve = (entry: Entry): UnpackedObject => {
    const done = resolved.get(entry.offset);
    if (done !== undefined) return done;
    if (resolving.has(entry.offset)) throw new PackError('pack has a delta cycle');
    resolving.add(entry.offset);
    let object: UnpackedObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseAt as number);
      if (baseEntry === undefined) throw new PackError('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.payload);
      object = { type: base.type, data, oid: hashObject(base.type, data) };
    } else if (entry.typeCode === 7) {
      const base = byOid.get(entry.baseOid as string) ?? resolveByOid(entry.baseOid as string);
      if (base === undefined) throw new PackError(`ref-delta base ${entry.baseOid} is not in the pack`);
      const data = applyDelta(base.data, entry.payload);
      object = { type: base.type, data, oid: hashObject(base.type, data) };
    } else {
      const type = TYPE_NAME[entry.typeCode] as string;
      object = { type, data: entry.payload, oid: hashObject(type, entry.payload) };
    }
    resolving.delete(entry.offset);
    resolved.set(entry.offset, object);
    byOid.set(object.oid, object);
    return object;
  };

  /** A ref-delta may name an object that appears later in the pack; scan for it then. */
  const resolveByOid = (oid: string): UnpackedObject | undefined => {
    const known = byOid.get(oid);
    if (known !== undefined) return known;
    for (const candidate of entries) {
      const object = resolve(candidate);
      if (object.oid === oid) return object;
    }
    return undefined;
  };

  const objects: UnpackedObject[] = [];
  for (const entry of entries) objects.push(resolve(entry));
  return objects;
}

/** The type names a pack's numeric codes stand for. */
const TYPE_NAME: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 of an object as git frames it: `<type> <size>\0<payload>`. */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

// ----------------------------------------------------------------------------- ref advertisement

/** The refs an advertisement lists, in the order git sorts them. */
export function advertiseRefs(repo: Repo): { name: string; oid: string; peeled: string | null }[] {
  const rows: { name: string; oid: string; peeled: string | null }[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head !== undefined) rows.push({ name: 'HEAD', oid: head, peeled: null });
  for (const ref of allRefs(repo)) {
    rows.push({ name: ref.ref, oid: ref.sha, peeled: ref.peeled });
  }
  return rows;
}

/** The capabilities the v2 upload-pack advertises. */
function uploadPackV2Capabilities(): string[] {
  return ['agent=makefun-git/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
}

/** The capabilities the v0 upload-pack advertises. */
function uploadPackV0Capabilities(repo: Repo): string[] {
  return [
    'multi_ack_detailed',
    'thin-pack',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    `agent=makefun-git/1.0`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ];
}

/** The capabilities the v0 receive-pack advertises. */
function receivePackCapabilities(repo: Repo): string[] {
  return [
    'report-status',
    'report-status-v2',
    'delete-refs',
    'side-band-64k',
    'ofs-delta',
    'agent=makefun-git/1.0',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ];
}

/** The v2 advertisement: `version 2`, then one capability per packet. */
export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pkt(`# service=git-upload-pack\n`), flushPkt(), pkt('version 2\n')];
  for (const capability of uploadPackV2Capabilities()) parts.push(pkt(`${capability}\n`));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** The v0 ref advertisement for a service. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities = service === 'git-upload-pack' ? uploadPackV0Capabilities(repo) : receivePackCapabilities(repo);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), flushPkt()];
  const rows = advertiseRefs(repo);
  if (rows.length === 0) {
    // An unborn repository advertises only its capabilities, on the documented empty line.
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities.join(' ')}\n`));
    parts.push(flushPkt());
    return Buffer.concat(parts);
  }
  rows.forEach((row, index) => {
    const suffix = row.peeled === null ? '' : `\n${pkt(`${row.peeled} ${row.name}^{}\n`).toString('binary')}`;
    void suffix;
    const base = index === 0 ? `${row.oid} ${row.name}\0${capabilities.join(' ')}\n` : `${row.oid} ${row.name}\n`;
    parts.push(pkt(base));
    if (row.peeled !== null) parts.push(pkt(`${row.peeled} ${row.name}^{}\n`));
  });
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------------------- v2 ls-refs

/** Answer a v2 `ls-refs` command. */
export function lsRefs(repo: Repo, packets: readonly Packet[]): Buffer {
  const args = lines(packets);
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length).trim());
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const out: Buffer[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // HEAD is a symref, not a ref: it is only answered when the client asked for no prefix, because
  // a ref-prefix filter is a promise about every line the server sends.
  if (prefixes.length === 0 && symrefs) {
    if (head === undefined) out.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else out.push(pkt(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of allRefs(repo)) {
    if (!keep(ref.ref)) continue;
    const suffix = peel && ref.peeled !== null ? ` peeled:${ref.peeled}` : '';
    out.push(pkt(`${ref.sha} ${ref.ref}${suffix}\n`));
  }
  out.push(flushPkt());
  return Buffer.concat(out);
}

// ----------------------------------------------------------------------------- fetch

/** What a fetch request asks for, read out of its argument lines. */
interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Read a v2 `fetch` command's arguments. */
function readFetchArgs(packets: readonly Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines(packets)) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** Every object reachable from `roots`, walked through commits, trees and tags. A commit in `stop`
 *  counts as held, but its parents are not walked past: that is what a shallow client actually has. */
function reachable(repo: Repo, roots: readonly string[], stop: ReadonlySet<string> = new Set(), limit = 20_000): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0 && seen.size < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = commitInfo(repo, oid);
      if (info === null) continue;
      queue.push(info.tree);
      // A commit the client is shallow at is held, but its parents past the boundary are not: the
      // client does not have them, so a deepen fetch must be free to send them.
      if (!stop.has(oid)) for (const parent of info.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      const raw = object.data;
      let at = 0;
      while (at < raw.length) {
        const space = raw.indexOf(0x20, at);
        if (space < 0) break;
        const nul = raw.indexOf(0x00, space);
        if (nul < 0) break;
        if (nul + 21 > raw.length) break;
        queue.push(raw.subarray(nul + 1, nul + 21).toString('hex'));
        at = nul + 21;
      }
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})/m.exec(text);
      if (match !== null) queue.push(match[1] as string);
    }
  }
  return seen;
}

/** The result of planning a fetch: the objects to send and the shallow boundary that moved. */
interface FetchPlan {
  objects: PackInput[];
  shallow: string[];
  unshallow: string[];
}

/** Plan a fetch: the wanted commits within `depth`, their trees, minus everything the client holds. */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const clientShallow = new Set(args.shallow);
  // Everything the client holds, stopping at its shallow boundary: the commits past it are absent, so
  // a deepen fetch has to deliver them.
  const haveSet = args.haves.length === 0 ? new Set<string>() : reachable(repo, args.haves, clientShallow);

  // The commit walk: generation 1 is each wanted tip, and `depth` caps how far it goes.
  const commitSet = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; generation: number }[] = [];
  for (const want of args.wants) {
    const object = getObject(repo, want);
    if (object === null) continue;
    if (object.type === 'tag') {
      const target = peelToCommit(repo, want);
      if (target !== null) queue.push({ oid: target, generation: 1 });
      continue;
    }
    queue.push({ oid: want, generation: 1 });
  }
  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    if (commitSet.has(oid)) continue;
    commitSet.add(oid);
    const info = commitInfo(repo, oid);
    if (info === null) continue;
    const atLimit = args.depth !== null && generation >= args.depth;
    if (atLimit && info.parents.length > 0) {
      boundary.add(oid);
      continue;
    }
    for (const parent of info.parents) {
      if (commitSet.has(parent)) continue;
      queue.push({ oid: parent, generation: generation + 1 });
    }
  }

  // The roots the pack must carry: every wanted object itself (a tag stays a tag), plus the commits
  // the walk reached. An object the client already holds is never re-sent.
  const roots = new Set<string>();
  for (const want of args.wants) {
    if (getObject(repo, want) === null) continue;
    if (!haveSet.has(want)) roots.add(want);
  }
  for (const oid of commitSet) if (!haveSet.has(oid)) roots.add(oid);

  const wanted = new Set<string>();
  const visit = [...roots];
  while (visit.length > 0) {
    const oid = visit.shift() as string;
    if (wanted.has(oid) || haveSet.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null) continue;
    wanted.add(oid);
    if (object.type === 'commit') {
      const info = commitInfo(repo, oid);
      if (info === null) continue;
      visit.push(info.tree);
      // A boundary commit's parents are outside this fetch by construction.
      if (!boundary.has(oid)) for (const parent of info.parents) visit.push(parent);
    } else if (object.type === 'tree') {
      const raw = object.data;
      let at = 0;
      while (at < raw.length) {
        const space = raw.indexOf(0x20, at);
        if (space < 0) break;
        const nul = raw.indexOf(0x00, space);
        if (nul < 0) break;
        if (nul + 21 > raw.length) break;
        visit.push(raw.subarray(nul + 1, nul + 21).toString('hex'));
        at = nul + 21;
      }
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match !== null) visit.push(match[1] as string);
    }
  }

  const objects: PackInput[] = [];
  for (const oid of wanted) {
    const object = getObject(repo, oid);
    if (object === null) continue;
    objects.push({ oid, type: object.type, data: object.data });
  }
  objects.sort((left, right) => (left.oid < right.oid ? -1 : 1));

  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of boundary) if (!clientShallow.has(oid)) shallow.push(oid);
  for (const oid of clientShallow) if (!boundary.has(oid) && commitSet.has(oid)) unshallow.push(oid);
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

/** Wrap a pack in sideband band-1 packets, never exceeding a pkt-line. */
function sideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let at = 0; at < pack.length; at += SIDE_BAND_CHUNK) {
    const chunk = pack.subarray(at, Math.min(at + SIDE_BAND_CHUNK, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pkt(Buffer.from([1])));
  return parts;
}

/** Answer a v2 `fetch` command. */
export function serveFetchV2(repo: Repo, packets: readonly Packet[]): Buffer {
  const args = readFetchArgs(packets);
  const unknown = args.wants.filter((want) => getObject(repo, want) === null);
  if (unknown.length > 0) {
    const message = `upload-pack: not our ref ${unknown[0] as string}`;
    return Buffer.concat([pkt('packfile\n'), pkt(Buffer.concat([Buffer.from([3]), Buffer.from(`${message}\n`)])), flushPkt()]);
  }

  const plan = planFetch(repo, args);
  const out: Buffer[] = [];

  // The acknowledgment section appears only when the client claimed to have something.
  if (args.haves.length > 0) {
    out.push(pkt('acknowledgments\n'));
    const known = args.haves.filter((have) => getObject(repo, have) !== null);
    if (known.length > 0) out.push(pkt(`ACK ${known[known.length - 1] as string}\n`));
    else out.push(pkt('NAK\n'));
    out.push(pkt('ready\n'));
    out.push(flushPkt());
  }

  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(flushPkt());
  }

  out.push(pkt('packfile\n'));
  for (const frame of sideband(writePack(plan.objects))) out.push(frame);
  out.push(flushPkt());
  return Buffer.concat(out);
}

/** Answer a v0 upload-pack POST: NAK, then the sideband-framed pack. */
export function serveFetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitBody(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines(packets)) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  const plan = planFetch(repo, args);
  const out: Buffer[] = [pkt('NAK\n')];
  for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
  for (const frame of sideband(writePack(plan.objects))) out.push(frame);
  out.push(flushPkt());
  return Buffer.concat(out);
}

// ----------------------------------------------------------------------------- receive-pack

/** One ref update a push asks for. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** The report-status lines a push answers with. */
interface PushReport {
  unpack: string;
  refs: { ref: string; ok: boolean; reason: string }[];
}

/** Read the command list a receive-pack POST opens with. */
function readPushCommands(packets: readonly Packet[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const line of lines(packets)) {
    if (line === '') continue;
    const nul = line.indexOf('\u0000');
    const commandLine = nul < 0 ? line : line.slice(0, nul);
    const parts = commandLine.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  return commands;
}

/** Apply a push: unpack the pack, then move each ref that may move. */
export function serveReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = splitBody(body);
  const commands = readPushCommands(packets);
  const report: PushReport = { unpack: 'ok', refs: [] };

  if (rest.length > 0) {
    try {
      const objects = readPack(rest);
      for (const object of objects) {
        if (object.type !== 'commit' && object.type !== 'tree' && object.type !== 'blob' && object.type !== 'tag') {
          throw new PackError(`unexpected object type ${object.type}`);
        }
        putObject(repo, object.type as 'commit' | 'tree' | 'blob' | 'tag', object.data);
      }
    } catch (error) {
      report.unpack = error instanceof Error ? error.message : String(error);
    }
  }

  if (report.unpack === 'ok') {
    for (const command of commands) {
      if (command.newOid === ZERO_OID) {
        const current = repo.refs.get(command.ref);
        if (current === undefined) {
          report.refs.push({ ref: command.ref, ok: false, reason: 'no such ref' });
          continue;
        }
        if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          report.refs.push({ ref: command.ref, ok: false, reason: 'stale info' });
          continue;
        }
        repo.refs.delete(command.ref);
        report.refs.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (getObject(repo, command.newOid) === null) {
        report.refs.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          report.refs.push({ ref: command.ref, ok: false, reason: 'already exists' });
          continue;
        }
      } else if (current === undefined) {
        report.refs.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        continue;
      } else if (current !== command.oldOid) {
        report.refs.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      // A branch may only move forward; a tag is a label and may be repointed.
      if (command.ref.startsWith('refs/heads/') && command.oldOid !== ZERO_OID) {
        const newCommit = peelToCommit(repo, command.newOid);
        const oldCommit = peelToCommit(repo, command.oldOid);
        if (newCommit === null || oldCommit === null || !isAncestor(repo, oldCommit, newCommit)) {
          report.refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      report.refs.push({ ref: command.ref, ok: true, reason: '' });
    }
  }

  const reportLines: string[] = [report.unpack === 'ok' ? 'unpack ok\n' : `unpack ${report.unpack}\n`];
  for (const ref of report.refs) {
    reportLines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pkt(line)), flushPkt()]);
  // The client asked for side-band-64k, so the report travels inside band 1 as a nested stream.
  const outer: Buffer[] = [];
  for (let at = 0; at < inner.length; at += SIDE_BAND_CHUNK) {
    const chunk = inner.subarray(at, Math.min(at + SIDE_BAND_CHUNK, inner.length));
    outer.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  outer.push(flushPkt());
  return Buffer.concat(outer);
}

// ----------------------------------------------------------------------------- HTTP glue

/** A parsed repository address from a request path. */
export interface RepoAddress {
  owner: string;
  name: string;
  suffix: string;
}

/** Read `/{owner}/{repo}.git/{suffix}` out of a request path, or null. */
export function parseGitPath(pathname: string): RepoAddress | null {
  const cleaned = pathname.replace(/^\/+/, '');
  const segments = cleaned.split('/').filter((part) => part !== '');
  if (segments.length < 2) return null;
  const owner = decodeURIComponent(segments[0] as string);
  let name = decodeURIComponent(segments[1] as string);
  if (name.endsWith('.git')) name = name.slice(0, -4);
  else return null;
  return { owner, name, suffix: segments.slice(2).join('/') };
}

/** Answer a git request, given the repository it addresses (null when it does not exist). */
export function handleGit(repo: Repo | null, address: RepoAddress, method: string, url: URL, headers: IncomingMessage['headers'], body: Buffer): {
  status: number;
  contentType: string;
  body: Buffer;
} {
  void headers;
  const service = url.searchParams.get('service');
  const gitProtocol = String((headers as Record<string, unknown>)['git-protocol'] ?? '');

  if (address.suffix === 'info/refs') {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 403, contentType: 'text/plain', body: Buffer.from('smart HTTP is the only supported transport\n') };
    }
    if (repo === null) {
      return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n') };
    }
    const wantsV2 = service === 'git-upload-pack' && /version=2/.test(gitProtocol);
    const payload = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body: payload };
  }

  if (address.suffix === 'git-upload-pack') {
    if (method !== 'POST') return { status: 405, contentType: 'text/plain', body: Buffer.from('Method Not Allowed\n') };
    if (repo === null) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n') };
    const { packets } = splitBody(body);
    const first = lines(packets)[0] ?? '';
    let payload: Buffer;
    if (first.startsWith('command=')) {
      const command = first.slice('command='.length).trim();
      if (command === 'ls-refs') payload = lsRefs(repo, packets);
      else if (command === 'fetch') payload = serveFetchV2(repo, packets);
      else {
        // An unknown command is a protocol error, reported in the v2 error shape.
        payload = Buffer.concat([pkt(`ERR unknown command ${command}\n`), flushPkt()]);
      }
    } else {
      payload = serveFetchV0(repo, body);
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: payload };
  }

  if (address.suffix === 'git-receive-pack') {
    if (method !== 'POST') return { status: 405, contentType: 'text/plain', body: Buffer.from('Method Not Allowed\n') };
    if (repo === null) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n') };
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: serveReceivePack(repo, body) };
  }

  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n') };
}

/** The branch name a ref names, for logs. */
export function branchName(ref: string): string {
  return shortRef(ref);
}

/** A short label for a repository, for logs. */
export function label(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

/** Write one git answer to the response. */
export function writeGit(res: ServerResponse, answer: { status: number; contentType: string; body: Buffer }): void {
  res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': String(answer.body.length), 'cache-control': 'no-cache' });
  res.end(answer.body);
}
