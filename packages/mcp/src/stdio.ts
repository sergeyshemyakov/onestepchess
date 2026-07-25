#!/usr/bin/env node

import { startStdio } from "./stdio-server.js";

void startStdio().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(`onestepchess MCP: ${message}\n`);
  process.exitCode = 1;
});
