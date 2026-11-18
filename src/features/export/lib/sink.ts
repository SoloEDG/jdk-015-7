import type { MuxSink } from "./encode";

export interface ExportSink {
  sink: MuxSink;
  /** Random-access file in OPFS; null when the export had to stay in memory. */
  handle: FileSystemFileHandle | null;
  fileName: string;
  /** The finished bytes, for the in-memory fallback only. */
  memory: () => Uint8Array | null;
  size: () => number;
  dispose: () => Promise<void>;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

/** Random-access sink backed by a temporary OPFS file. */
async function createFileSink(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<ExportSink> {
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  let tail: Promise<void> = Promise.resolve();
  let bytes = 0;
  let closed = false;
  let removed = false;

  async function remove() {
    if (removed) return;
    removed = true;
    await root.removeEntry(name).catch(() => {});
  }

  function write(position: number, data: Uint8Array) {
    // Positioned writes are chained: the muxer may rewrite its header after
    // clusters were already streamed out, and both must land in order.
    tail = tail.then(async () => {
      if (closed) return;
      await writable.write({
        type: "write",
        position,
        data: data as Uint8Array<ArrayBuffer>,
      });
      bytes = Math.max(bytes, position + data.byteLength);
    });
    return tail;
  }

  return {
    sink: {
      write,
      async finalize() {
        await tail;
        if (!closed) {
          closed = true;
          await writable.close();
        }
      },
      async abort() {
        await tail.catch(() => {});
        if (!closed) {
          closed = true;
          await writable.abort().catch(() => {});
        }
        await remove();
      },
    },
    handle,
    fileName: name,
    memory: () => null,
    size: () => bytes,
    dispose: remove,
  };
}

/** Fallback for browsers without OPFS: a growable, randomly-writable buffer. */
function createMemorySink(name: string): ExportSink {
  let buffer = new Uint8Array(1 << 20);
  let bytes = 0;
  let tail: Promise<void> = Promise.resolve();

  function ensure(size: number) {
    if (size <= buffer.length) return;
    let next = buffer.length;
    while (next < size) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(buffer.subarray(0, bytes));
    buffer = grown;
  }

  function write(position: number, data: Uint8Array) {
    tail = tail.then(() => {
      ensure(position + data.byteLength);
      buffer.set(data, position);
      bytes = Math.max(bytes, position + data.byteLength);
    });
    return tail;
  }

  return {
    sink: {
      write,
      async finalize() {
        await tail;
      },
      async abort() {
        await tail.catch(() => {});
        buffer = new Uint8Array(0);
        bytes = 0;
      },
    },
    handle: null,
    fileName: name,
    memory: () => buffer.subarray(0, bytes),
    size: () => bytes,
    dispose: async () => {
      buffer = new Uint8Array(0);
    },
  };
}

export async function createExportSink(fileName: string): Promise<ExportSink> {
  const root = await opfsRoot();
  if (!root) return createMemorySink(fileName);
  try {
    return await createFileSink(root, fileName);
  } catch {
    return createMemorySink(fileName);
  }
}

/** Remove an exported file from OPFS once the user deletes the take. */
export async function deleteExportFile(
  handle: FileSystemFileHandle,
): Promise<void> {
  const root = await opfsRoot();
  await root?.removeEntry(handle.name).catch(() => {});
}
