import fs from "node:fs";
import path from "node:path";
import { getWindowsAgentSettings } from "../run/windowsAgentSettings.js";
import { windowsNativePowerShellExecutable } from "./windowsNativeSandbox.js";

export function usesNativeWindowsAgent(): boolean {
  return process.platform === "win32" && getWindowsAgentSettings().environment === "native";
}

export function agentShellInvocation(command: string): { executable: string; args: string[] } {
  if (usesNativeWindowsAgent()) return powerShellInvocation(command);
  return { executable: process.platform === "win32" ? "/bin/bash" : "/bin/sh", args: ["-c", command] };
}

export function powerShellInvocation(command: string): { executable: string; args: string[] } {
  return { executable: windowsNativePowerShellExecutable(), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command] };
}

function literal(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

/** Auto-approved argv queries must never resolve an executable from the project. */
function systemExecutable(name: string, workspace: string): string {
  const root = fs.realpathSync.native(workspace).toLowerCase();
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const suffix = path.relative(root, directory.toLowerCase());
    if (!suffix || (!suffix.startsWith(`..${path.sep}`) && suffix !== ".." && !path.isAbsolute(suffix))) continue;
    for (const extension of [".exe", ".cmd", ".bat"]) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        const file = fs.realpathSync.native(candidate);
        const relative = path.relative(root, file.toLowerCase());
        if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) continue;
        if (fs.statSync(file).isFile()) return file;
      } catch { /* Check the next trusted tool directory. */ }
    }
  }
  throw new Error(`A system executable is unavailable for the read-only query: ${name}`);
}

/** The policy parser authorizes tokens before this fixed PowerShell projection. */
export function windowsInspectionInvocation(executable: string, args: readonly string[], workspace: string): { executable: string; args: string[] } {
  const name = executable.toLowerCase();
  let source: string;
  if (name === "pwd" || name === "get-location") source = "(Microsoft.PowerShell.Management\\Get-Location).Path";
  else if (name === "ls" || name === "get-childitem") {
    const paths = args.filter((argument) => !argument.startsWith("-"));
    const namesOnly = args.some((argument) => argument.toLowerCase() === "-name") ? " -Name" : "";
    source = (paths.length ? paths : ["."]).map((item) => `Microsoft.PowerShell.Management\\Get-ChildItem -LiteralPath ${literal(item)} -Force${namesOnly}`).join("\n");
  } else if (["cat", "get-content", "head", "tail"].includes(name)) {
    let count = 10; let contentOption = "-Raw"; const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (["-n", "-TotalCount", "-Tail"].some((flag) => flag.toLowerCase() === args[i].toLowerCase())) {
        const flag = args[i].toLowerCase(); count = Number(args[++i]); contentOption = flag === "-tail" ? `-Tail ${count}` : `-TotalCount ${count}`; continue;
      }
      if (!args[i].startsWith("-")) paths.push(args[i]);
    }
    if (!paths.length) throw new Error("File inspection requires a literal workspace file");
    const option = name === "head" ? `-TotalCount ${count}` : name === "tail" ? `-Tail ${count}` : contentOption;
    source = paths.map((item) => `Microsoft.PowerShell.Management\\Get-Content -LiteralPath ${literal(item)} ${option}`).join("\n");
  } else {
    if (["sed", "find", "grep", "wc"].includes(name)) throw new Error("Use native PowerShell inspection commands in the Windows environment, or select WSL for POSIX tools");
    const trusted = systemExecutable(executable, workspace);
    source = `& ${literal(trusted)} ${args.map(literal).join(" ")}`;
  }
  return powerShellInvocation(source);
}
