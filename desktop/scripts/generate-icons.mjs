import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Icon generation uses macOS sips and iconutil");
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(desktopDir, "..", "frontend", "public", "favicon.svg");
const assetsDir = path.join(desktopDir, "assets");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-icons-"));
const iconset = path.join(tempDir, "icon.iconset");
fs.mkdirSync(iconset);
fs.mkdirSync(assetsDir, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

function png(size, destination) {
  run("sips", ["-s", "format", "png", "-Z", String(size), source, "--out", destination]);
}

try {
  for (const [name, size] of [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
  ]) png(size, path.join(iconset, name));
  run("iconutil", ["-c", "icns", iconset, "-o", path.join(assetsDir, "icon.icns")]);

  const sizes = [16, 32, 48, 256];
  const images = sizes.map((size) => {
    const imagePath = path.join(tempDir, `${size}.png`);
    png(size, imagePath);
    return { size, data: fs.readFileSync(imagePath) };
  });
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  fs.writeFileSync(path.join(assetsDir, "icon.ico"), Buffer.concat([header, ...images.map((image) => image.data)]));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
