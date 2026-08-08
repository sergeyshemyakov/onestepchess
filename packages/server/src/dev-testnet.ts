import { type SpawnOptions, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export type TestnetDevLaunch = {
  readonly command: string;
  readonly args: string[];
  readonly options: SpawnOptions;
};

export function createTestnetDevLaunch(
  options: {
    readonly root?: string;
    readonly runtimeEnv?: Readonly<Record<string, string | undefined>>;
    readonly readProfile?: (path: string) => string;
  } = {},
): TestnetDevLaunch {
  const root = options.root ?? repositoryRoot;
  const runtimeEnv = Object.fromEntries(
    Object.entries(options.runtimeEnv ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const profile = parseEnv(
    (options.readProfile ?? ((path) => readFileSync(path, "utf8")))(
      resolve(root, ".env.testnet"),
    ),
  );

  return {
    command: "pnpm",
    args: ["-r", "--parallel", "run", "dev"],
    options: {
      cwd: root,
      env: { ...profile, ...runtimeEnv },
      stdio: "inherit",
    },
  };
}

export function main(): void {
  const launch = createTestnetDevLaunch();
  const child = spawn(launch.command, launch.args, launch.options);
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
