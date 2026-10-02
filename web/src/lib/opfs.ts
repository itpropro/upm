// What this browser keeps on OPFS between visits: upm's store backend, the content every install
// downloaded (`upm-store/`), and the registry documents the resolver read (`upm-docs/`).
//
// A backend key `<dir>/<name>` is the file `upm-store/<dir>/<name>`. A key's value never
// changes, so tabs share them with no lock: a write lands whole on `close()`, and upm sets a
// package's index last, once its blobs are all in.
import { concat, shortHash } from "upm/src/runtime.ts";
import type { BackendIndex, StoreBackend } from "upm/src/store-backend.ts";

const DIR = "upm-store";
/** OPFS calls in flight at once, across every package and tab's install. */
const LANES = 32;

let opened: Promise<FileSystemDirectoryHandle | undefined> | undefined;

/** The backend, or undefined where there is no OPFS. Read-only where files cannot be written. */
export async function opfsBackend(): Promise<StoreBackend | undefined> {
  const home = await (opened ??= open());
  if (!home) return undefined;
  const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();
  /** A key's directory and file name. */
  const at = async (key: string): Promise<[FileSystemDirectoryHandle, string]> => {
    const slash = key.indexOf("/");
    const name = key.slice(slash + 1);
    const dir = key.slice(0, slash);
    let handle = dirs.get(dir);
    if (!handle) dirs.set(dir, (handle = home.getDirectoryHandle(dir, { create: true })));
    return [await handle, name];
  };
  const get = (key: string) => lane(async () => read(...(await at(key))));
  const writable =
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype;
  return {
    // Same origin, same disk: as safe from damage as upm's own store would be.
    trusted: true,
    // Local and fast: the lanes, not the package count, are what bound it.
    concurrency: LANES,
    get,
    getMany: (keys) => Promise.all(keys.map(get)),
    set: writable
      ? (key, value) =>
          lane(async () => {
            const [dir, name] = await at(key);
            // One a closed tab cut short is not its size, and is written again.
            if (await find(dir, name, value.length)) return;
            await write(dir, name, value);
          }, LATER)
      : undefined,
  };
}

let asked = false;

/**
 * Ask the browser, once a page, not to evict OPFS when the disk runs low. Chrome decides on
 * its own, Firefox asks the user; either may say no, and the store stays best-effort.
 */
export function persist(): void {
  if (asked) return;
  asked = true;
  const storage = navigator.storage;
  void storage
    ?.persisted?.()
    .then((kept) => kept || storage.persist())
    .catch(() => {});
}

async function open(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await navigator.storage.getDirectory();
    // The whole-filesystem snapshot this replaced.
    void root.removeEntry("upm", { recursive: true }).catch(() => {});
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch {
    return undefined;
  }
}

/** A file, or undefined when it is missing or not `size` long. */
async function find(
  dir: FileSystemDirectoryHandle,
  name: string,
  size?: number,
): Promise<File | undefined> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return size === undefined || file.size === size ? file : undefined;
  } catch {
    return undefined;
  }
}

async function read(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | undefined> {
  const file = await find(dir, name);
  return file && new Uint8Array(await file.arrayBuffer());
}

async function write(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Uint8Array,
): Promise<void> {
  const stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await stream.write(data as FileSystemWriteChunkType);
  await stream.close();
}

// --- Registry documents ---

/**
 * `fetch` for the resolver, answering a registry document from OPFS while the registry's
 * `max-age` lasts, or for a day for a version's own document, which the registry sends with no
 * `max-age` though a published version never changes. After that the request goes out as before: the registry exposes no `etag`
 * to a page, and a conditional request would need a preflight it refuses, so revalidating is
 * left to the browser's HTTP cache. Nor can it read `age`, so a copy a CDN had already aged
 * counts as fresh from when it landed here. A document is kept once it was read to the end: the
 * resolver stops reading some early, once it has the version it wanted.
 */
export function cachedFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const dir = init?.method && init.method !== "GET" ? undefined : await (docs ??= openDocs());
    if (!dir) return await fetch(input, init);
    const name = await shortHash(`${accept} ${url}`);
    const kept = await lane(() => readDoc(dir, name, url, accept));
    if (kept) {
      return new Response(kept.body as unknown as BodyInit, {
        headers: { "content-type": kept.type },
      });
    }
    const response = await fetch(input, init);
    const control = response.headers.get("cache-control") ?? "";
    const maxAge = Number(/max-age=(\d+)/i.exec(control)?.[1]) || (pinned(url) ? DAY : 0);
    if (response.status !== 200 || !response.body || !maxAge) return response;
    const type = response.headers.get("content-type") ?? "";
    const head = new TextEncoder().encode(
      `${JSON.stringify({ url, accept, type, at: Date.now(), maxAge })}\n`,
    );
    const keep = (chunks: Uint8Array[]) =>
      void lane(() => write(dir, name, concat([head, ...chunks])), LATER).catch(() => {});
    const { status, statusText, headers } = response;
    // A small one is read to the end here whatever the resolver reads; a big one only as far as
    // the resolver reads it, which is all its early stop saves.
    const size = Number(headers.get("content-length"));
    if (size > 0 && size <= WHOLE) {
      const [mine, theirs] = response.body.tee();
      void new Response(mine).arrayBuffer().then(
        (bytes) => keep([new Uint8Array(bytes)]),
        () => {},
      );
      return new Response(theirs, { status, statusText, headers });
    }
    const chunks: Uint8Array[] = [];
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          chunks.push(chunk);
          controller.enqueue(chunk);
        },
        flush: () => keep(chunks),
      }),
    );
    return new Response(body, { status, statusText, headers });
  };
}

/** How long a version's own document is kept: published, it never changes but for `deprecated`. */
const DAY = 24 * 60 * 60;
/** Documents up to this size are kept even when the resolver stops reading them early. */
const WHOLE = 256 * 1024;

/** Whether a url is a published version's own document: `/<name>/<version>`. */
function pinned(url: string): boolean {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return parts.length === 2 && /^\d+\.\d+\.\d+/.test(parts[1]!);
}

interface Head {
  url: string;
  accept: string;
  type: string;
  at: number;
  maxAge: number;
}

let docs: Promise<FileSystemDirectoryHandle | undefined> | undefined;

async function openDocs(): Promise<FileSystemDirectoryHandle | undefined> {
  const writable =
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype;
  if (!writable) return undefined;
  try {
    const dir = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("upm-docs", {
      create: true,
    });
    void sweep(dir);
    return dir;
  } catch {
    return undefined;
  }
}

/** A kept document still fresh, or undefined. A torn or foreign file is a miss. */
async function readDoc(
  dir: FileSystemDirectoryHandle,
  name: string,
  url: string,
  accept: string,
): Promise<{ type: string; body: Uint8Array } | undefined> {
  const data = await read(dir, name);
  const end = data?.indexOf(10) ?? -1;
  if (!data || end < 0) return undefined;
  try {
    const head = JSON.parse(new TextDecoder().decode(data.subarray(0, end))) as Head;
    if (head.url !== url || head.accept !== accept) return undefined;
    if (Date.now() - head.at >= head.maxAge * 1000) return undefined;
    return { type: head.type, body: data.subarray(end + 1) };
  } catch {
    return undefined;
  }
}

/** Once a load, in the background: a document older than any it keeps is dead. */
async function sweep(dir: FileSystemDirectoryHandle): Promise<void> {
  const old = Date.now() - DAY * 1000;
  try {
    const files: FileSystemFileHandle[] = [];
    for await (const handle of dir.values()) if (handle.kind === "file") files.push(handle);
    for (const handle of files) {
      await lane(async () => {
        if ((await handle.getFile()).lastModified < old) await dir.removeEntry(handle.name);
      }, LATER);
    }
  } catch {}
}

// --- Inspect and clear ---

export interface OpfsReport {
  /** The top-level entries, not yet walked: see `measure`. */
  entries: FileSystemHandle[];
  /** What the browser counts for this origin, OPFS and the rest. Undefined where it won't say. */
  usage?: number;
  quota?: number;
  persisted?: boolean;
}

/** A top-level entry's file count and size. */
export interface OpfsSize {
  files: number;
  bytes: number;
}

/** OPFS's top-level entries, or undefined where there is no OPFS. Walks nothing. */
export async function inspect(): Promise<OpfsReport | undefined> {
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    return undefined;
  }
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate?.().catch(() => undefined),
    navigator.storage.persisted?.().catch(() => undefined),
  ]);
  const entries: FileSystemHandle[] = [];
  for await (const handle of root.values()) entries.push(handle);
  return { entries, usage: estimate?.usage, quota: estimate?.quota, persisted };
}

/**
 * A top-level entry's file count and size. The store's comes from its package indexes, which
 * name each blob with its size, so its blobs are never opened one by one; a blob no index names
 * yet is not counted.
 */
export async function measure(handle: FileSystemHandle, signal?: AbortSignal): Promise<OpfsSize> {
  if (handle.kind === "file") {
    return { files: 1, bytes: (await (handle as FileSystemFileHandle).getFile()).size };
  }
  const dir = handle as FileSystemDirectoryHandle;
  const sum = { files: 0, bytes: 0 };
  if (dir.name !== DIR) {
    await walk(dir, sum, signal);
    return sum;
  }
  const blobs = new Map<string, number>();
  for (const index of await storeIndexes(dir, signal)) {
    sum.files++;
    sum.bytes += index.size;
    for (const [hash, size] of index.blobs) blobs.set(hash, size);
  }
  sum.files += blobs.size;
  for (const size of blobs.values()) sum.bytes += size;
  return sum;
}

/**
 * OPFS's size without a walk, as the browser counts it: Chrome says it apart, others give all the
 * site keeps, which here is OPFS but for a little.
 */
export async function opfsSize(): Promise<number | undefined> {
  try {
    const estimate = await navigator.storage.estimate();
    const details = (estimate as { usageDetails?: { fileSystem?: number } }).usageDetails;
    return details ? (details.fileSystem ?? 0) : estimate.usage;
  } catch {
    return undefined;
  }
}

async function walk(
  dir: FileSystemDirectoryHandle,
  sum: OpfsSize,
  signal?: AbortSignal,
): Promise<void> {
  const dirs: FileSystemDirectoryHandle[] = [];
  const files: Promise<void>[] = [];
  for await (const handle of dir.values()) {
    if (handle.kind === "directory") dirs.push(handle);
    else {
      files.push(
        lane(async () => {
          if (signal?.aborted) return;
          // One removed meanwhile is not counted.
          const file = await handle.getFile().catch(() => undefined);
          if (!file) return;
          sum.files++;
          sum.bytes += file.size;
        }, LATER),
      );
    }
  }
  await Promise.all(files);
  signal?.throwIfAborted();
  for (const handle of dirs) await walk(handle, sum, signal);
}

/** A package the store keeps, from its index. */
export interface KeptPackage {
  integrity: string;
  name?: string;
  version?: string;
  files: number;
  bytes: number;
}

/** A store index as `measure` and `keptPackages` need it: its own size and its blobs. */
interface StoreIndex {
  size: number;
  blobs: [hash: string, size: number][];
  package: KeptPackage;
}

/** Each index read so far, by file name. A key's value never changes, so it is read once. */
const indexes = new Map<string, StoreIndex>();

/** The store's indexes, reading only those not read before; a torn one is left out. */
async function storeIndexes(
  home: FileSystemDirectoryHandle,
  signal?: AbortSignal,
): Promise<StoreIndex[]> {
  const dir = await home.getDirectoryHandle("index").catch(() => undefined);
  if (!dir) return [];
  const names: string[] = [];
  for await (const handle of dir.values()) if (handle.kind === "file") names.push(handle.name);
  const fresh = names.filter((name) => !indexes.has(name));
  await Promise.all(
    fresh.map((name) =>
      lane(async () => {
        if (signal?.aborted) return;
        const data = await read(dir, name);
        if (!data) return;
        try {
          const index = JSON.parse(new TextDecoder().decode(data)) as BackendIndex;
          indexes.set(name, {
            size: data.length,
            blobs: index.files.map((file) => [file.hash, file.size]),
            package: {
              integrity: index.integrity,
              name: index.name,
              version: index.version,
              files: index.files.length,
              bytes: index.unpackedSize,
            },
          });
        } catch {}
      }, LATER),
    ),
  );
  signal?.throwIfAborted();
  return names.flatMap((name) => indexes.get(name) ?? []);
}

/** The packages in the store; one whose index is torn is left out. */
export async function keptPackages(): Promise<KeptPackage[]> {
  const home = await (opened ??= open());
  if (!home) return [];
  const packages = (await storeIndexes(home)).map((index) => index.package);
  return packages.sort((a, b) => (a.name ?? "~").localeCompare(b.name ?? "~"));
}

/** A registry document kept for the resolver, from its head. */
export interface KeptDocument extends Head {
  bytes: number;
}

/** Bytes read for a document's head: a url and a few short fields. */
const HEAD = 4096;

/** The registry documents kept, newest first; a torn one is left out. Reads only their heads. */
export async function keptDocuments(): Promise<KeptDocument[]> {
  const dir = await (docs ??= openDocs());
  if (!dir) return [];
  const files: FileSystemFileHandle[] = [];
  for await (const handle of dir.values()) if (handle.kind === "file") files.push(handle);
  const documents = await Promise.all(
    files.map((handle) =>
      lane(async () => {
        const file = await handle.getFile().catch(() => undefined);
        if (!file) return undefined;
        const data = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
        const end = data.indexOf(10);
        if (end < 0) return undefined;
        try {
          const head = JSON.parse(new TextDecoder().decode(data.subarray(0, end))) as Head;
          return { ...head, bytes: file.size - end - 1 };
        } catch {
          return undefined;
        }
      }, LATER),
    ),
  );
  return documents.filter((doc) => doc !== undefined).sort((a, b) => b.at - a.at);
}

/**
 * Remove a top-level entry of OPFS, or all of them. The next install and the next request open
 * theirs afresh; one under way when it goes loses what it was writing.
 */
export async function clear(name?: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const names: string[] = [];
  if (name) names.push(name);
  else for await (const handle of root.values()) names.push(handle.name);
  opened = docs = undefined;
  indexes.clear();
  const failed = (
    await Promise.allSettled(names.map((n) => root.removeEntry(n, { recursive: true })))
  ).find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

// --- Lanes ---

/** What the page waits on goes first; writes behind it. */
const NOW = 0;
const LATER = 1;

let busy = 0;
const waiting: [(() => void)[], (() => void)[]] = [[], []];

/** Run `task` in one of the `LANES`, shared by every call of this module. */
async function lane<T>(task: () => Promise<T>, priority = NOW): Promise<T> {
  if (busy >= LANES) await new Promise<void>((go) => waiting[priority]!.push(go));
  else busy++;
  try {
    return await task();
  } finally {
    const next = waiting[NOW].shift() ?? waiting[LATER].shift();
    if (next) next();
    else busy--;
  }
}
