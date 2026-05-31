#!/usr/bin/env node
// ops/n8n/n8n-api.mjs — thin n8n REST API client for the TagtoRack backend build.
// Reads N8N_API_KEY from repo-root .mcp.json (gitignored); NEVER prints the key.
//
// Usage:
//   node n8n-api.mjs GET  /workflows
//   node n8n-api.mjs GET  /workflows/<id>
//   node n8n-api.mjs POST /workflows           body.json
//   node n8n-api.mjs POST /workflows/<id>/activate
//   node n8n-api.mjs PUT  /workflows/<id>      body.json
//   node n8n-api.mjs GET  "/executions?includeData=true&limit=1"
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..", "..");
const mcp = JSON.parse(readFileSync(resolve(repoRoot, ".mcp.json"), "utf8"));
const API_KEY = mcp.mcpServers["n8n-mcp"].env.N8N_API_KEY;
const BASE = "http://localhost:5678/api/v1";

const [, , method = "GET", path = "/workflows", bodyFile] = process.argv;
const init = {
  method,
  headers: {
    "X-N8N-API-KEY": API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
};
if (bodyFile) init.body = readFileSync(resolve(process.cwd(), bodyFile), "utf8");

const res = await fetch(BASE + path, init);
const text = await res.text();
process.stderr.write(`HTTP ${res.status}\n`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
if (!res.ok) process.exit(1);
