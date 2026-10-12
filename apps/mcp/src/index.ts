#!/usr/bin/env node
// POII MCP server over stdio. Configuration from the environment: POII_API_URL and POII_TOKEN (an owner token with
// scope read). stdout carries the protocol only; diagnostics go to stderr and never include the token.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv, createApiClient } from './api.js';
import { createPoiiServer } from './server.js';

let config;
try {
  config = configFromEnv();
} catch (error) {
  process.stderr.write(`poii-mcp: ${(error as Error).message}\n`);
  process.exit(1);
}
const server = createPoiiServer(createApiClient(config));
await server.connect(new StdioServerTransport());
process.stderr.write(`poii-mcp: ready (API ${config.apiUrl}, read tools only)\n`);
