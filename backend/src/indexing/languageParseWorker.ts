import { parentPort, workerData } from "node:worker_threads";
import { indexLanguageFile } from "./languageAdapters.js";

interface ParseInput {
  files: Array<{ path: string; content: string }>;
}

const input = workerData as ParseInput;
const files = input.files.map((file) => ({
  path: file.path,
  indexed: indexLanguageFile(file.path, file.content),
}));

parentPort?.postMessage({ files });
