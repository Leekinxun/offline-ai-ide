import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { createDeflateRaw } from "zlib";

interface ZipSourceEntry {
  archivePath: string;
  fullPath: string;
  isDirectory: boolean;
  mtime: Date;
  size: number;
}

interface DosTimestamp {
  date: number;
  time: number;
}

interface ZipDirectoryEntry {
  archivePath: string;
  compressedSize: number;
  crc32: number;
  externalAttributes: number;
  flags: number;
  localHeaderOffset: number;
  mtime: Date;
  uncompressedSize: number;
}

const ZIP_VERSION = 20;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const DIRECTORY_ATTRIBUTES = 0x10;
const FILE_ATTRIBUTES = 0x20;
const CRC32_TABLE = buildCrc32Table();

export function createDirectoryZipStream(
  directoryPath: string,
  archiveRoot: string
): Readable {
  const entries = collectDirectoryEntries(directoryPath, archiveRoot);
  return Readable.from(streamZip(entries));
}

function collectDirectoryEntries(
  directoryPath: string,
  archiveRoot: string
): ZipSourceEntry[] {
  const rootStat = fs.lstatSync(directoryPath);
  if (!rootStat.isDirectory()) {
    throw new Error("Directory not found");
  }

  const entries: ZipSourceEntry[] = [
    {
      archivePath: ensureDirectoryPath(archiveRoot),
      fullPath: directoryPath,
      isDirectory: true,
      mtime: rootStat.mtime,
      size: 0,
    },
  ];

  const walk = (currentFullPath: string, currentArchivePath: string) => {
    const items = fs.readdirSync(currentFullPath).sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase())
    );

    for (const name of items) {
      const fullPath = path.join(currentFullPath, name);
      let stat: fs.Stats;

      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        continue;
      }

      const archivePath = path.posix.join(currentArchivePath, name);
      if (stat.isDirectory()) {
        const directoryArchivePath = ensureDirectoryPath(archivePath);
        entries.push({
          archivePath: directoryArchivePath,
          fullPath,
          isDirectory: true,
          mtime: stat.mtime,
          size: 0,
        });
        walk(fullPath, directoryArchivePath);
        continue;
      }

      if (!stat.isFile()) {
        continue;
      }

      entries.push({
        archivePath,
        fullPath,
        isDirectory: false,
        mtime: stat.mtime,
        size: stat.size,
      });
    }
  };

  walk(directoryPath, ensureDirectoryPath(archiveRoot));
  return entries;
}

async function* streamZip(entries: ZipSourceEntry[]): AsyncGenerator<Buffer> {
  const centralDirectoryEntries: ZipDirectoryEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(normalizeArchivePath(entry.archivePath), "utf8");
    assertZip32(fileName.length, "Entry name is too long for zip32");

    const flags = UTF8_FLAG | (entry.isDirectory ? 0 : DATA_DESCRIPTOR_FLAG);
    const compressionMethod = entry.isDirectory ? STORE_METHOD : DEFLATE_METHOD;
    const timestamp = toDosTimestamp(entry.mtime);
    const localHeaderOffset = offset;

    const localHeader = buildLocalFileHeader({
      compressedSize: 0,
      compressionMethod,
      crc32: 0,
      fileName,
      flags,
      timestamp,
      uncompressedSize: 0,
    });

    yield localHeader;
    offset += localHeader.length;

    let crc32 = 0;
    let compressedSize = 0;

    if (!entry.isDirectory) {
      let crcState = 0xffffffff;
      const crcTracker = new Transform({
        transform(chunk, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          crcState = updateCrc32(crcState, buffer);
          callback(null, buffer);
        },
      });

      const compressedStream = fs
        .createReadStream(entry.fullPath)
        .pipe(crcTracker)
        .pipe(createDeflateRaw());

      for await (const chunk of compressedStream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        compressedSize += buffer.length;
        yield buffer;
        offset += buffer.length;
      }

      crc32 = finalizeCrc32(crcState);
      assertZip32(compressedSize, "Compressed file is too large for zip32");
      assertZip32(entry.size, "File is too large for zip32");

      const descriptor = buildDataDescriptor({
        compressedSize,
        crc32,
        uncompressedSize: entry.size,
      });

      yield descriptor;
      offset += descriptor.length;
    }

    centralDirectoryEntries.push({
      archivePath: entry.archivePath,
      compressedSize,
      crc32,
      externalAttributes: entry.isDirectory
        ? DIRECTORY_ATTRIBUTES
        : FILE_ATTRIBUTES,
      flags,
      localHeaderOffset,
      mtime: entry.mtime,
      uncompressedSize: entry.size,
    });
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryRecords = centralDirectoryEntries.map((entry) =>
    buildCentralDirectoryHeader(entry)
  );

  for (const record of centralDirectoryRecords) {
    yield record;
    offset += record.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  assertZip32(centralDirectoryOffset, "Zip archive is too large for zip32");
  assertZip32(centralDirectorySize, "Zip central directory is too large");
  if (centralDirectoryEntries.length > 0xffff) {
    throw new Error("Zip archive contains too many entries for zip32");
  }

  yield buildEndOfCentralDirectory({
    centralDirectoryOffset,
    centralDirectorySize,
    entryCount: centralDirectoryEntries.length,
  });
}

function normalizeArchivePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function ensureDirectoryPath(value: string): string {
  const normalized = normalizeArchivePath(value).replace(/\/+$/, "");
  return normalized ? `${normalized}/` : "";
}

function buildLocalFileHeader({
  compressedSize,
  compressionMethod,
  crc32,
  fileName,
  flags,
  timestamp,
  uncompressedSize,
}: {
  compressedSize: number;
  compressionMethod: number;
  crc32: number;
  fileName: Buffer;
  flags: number;
  timestamp: DosTimestamp;
  uncompressedSize: number;
}): Buffer {
  const header = Buffer.alloc(30 + fileName.length);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(compressionMethod, 8);
  header.writeUInt16LE(timestamp.time, 10);
  header.writeUInt16LE(timestamp.date, 12);
  header.writeUInt32LE(crc32 >>> 0, 14);
  header.writeUInt32LE(compressedSize >>> 0, 18);
  header.writeUInt32LE(uncompressedSize >>> 0, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);
  fileName.copy(header, 30);
  return header;
}

function buildDataDescriptor({
  compressedSize,
  crc32,
  uncompressedSize,
}: {
  compressedSize: number;
  crc32: number;
  uncompressedSize: number;
}): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc32 >>> 0, 4);
  descriptor.writeUInt32LE(compressedSize >>> 0, 8);
  descriptor.writeUInt32LE(uncompressedSize >>> 0, 12);
  return descriptor;
}

function buildCentralDirectoryHeader(entry: ZipDirectoryEntry): Buffer {
  const fileName = Buffer.from(normalizeArchivePath(entry.archivePath), "utf8");
  assertZip32(fileName.length, "Entry name is too long for zip32");
  assertZip32(entry.localHeaderOffset, "Zip entry offset is too large");
  assertZip32(entry.compressedSize, "Compressed file is too large for zip32");
  assertZip32(entry.uncompressedSize, "File is too large for zip32");

  const timestamp = toDosTimestamp(entry.mtime);
  const header = Buffer.alloc(46 + fileName.length);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(
    entry.archivePath.endsWith("/") ? STORE_METHOD : DEFLATE_METHOD,
    10
  );
  header.writeUInt16LE(timestamp.time, 12);
  header.writeUInt16LE(timestamp.date, 14);
  header.writeUInt32LE(entry.crc32 >>> 0, 16);
  header.writeUInt32LE(entry.compressedSize >>> 0, 20);
  header.writeUInt32LE(entry.uncompressedSize >>> 0, 24);
  header.writeUInt16LE(fileName.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(entry.externalAttributes >>> 0, 38);
  header.writeUInt32LE(entry.localHeaderOffset >>> 0, 42);
  fileName.copy(header, 46);
  return header;
}

function buildEndOfCentralDirectory({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
}: {
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
}): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralDirectorySize >>> 0, 12);
  record.writeUInt32LE(centralDirectoryOffset >>> 0, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function toDosTimestamp(date: Date): DosTimestamp {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    date:
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  };
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(crc: number, chunk: Buffer): number {
  let next = crc >>> 0;
  for (let index = 0; index < chunk.length; index += 1) {
    next = CRC32_TABLE[(next ^ chunk[index]) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

function finalizeCrc32(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

function assertZip32(value: number, message: string) {
  if (value > 0xffffffff) {
    throw new Error(message);
  }
}
