import { packageDesktop } from "./package.mjs";

// The remote client has no server-native modules to stage or rebuild. Cross-built
// installers still require installation and runtime acceptance on their target OS.
await packageDesktop(process.argv[2], { cross: true, unpacked: process.argv.includes("--dir") });
