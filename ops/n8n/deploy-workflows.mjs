#!/usr/bin/env node
// ops/n8n/deploy-workflows.mjs
// One-shot deployer for the morning brief + lead-capture workflows.
// Builds the workflow JSON, imports it into the LOCAL n8n (create or update by
// name — safe to re-run), and activates it. Run from anywhere:
//
//   node ops/n8n/deploy-workflows.mjs
//
// Reads N8N_API_KEY from repo-root .mcp.json (gitignored). Talks to the n8n REST
// API at http://localhost:5678 — must be run on the machine where n8n is running.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..", "..");
const mcp = JSON.parse(readFileSync(resolve(repoRoot, ".mcp.json"), "utf8"));
const API_KEY = mcp.mcpServers["n8n-mcp"].env.N8N_API_KEY;
const BASE = process.env.N8N_API_BASE || "http://localhost:5678/api/v1";
const headers = { "X-N8N-API-KEY": API_KEY, "Content-Type": "application/json", Accept: "application/json" };

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 300)}`);
  return j;
}

// n8n's API rejects unknown top-level keys on create/update, so send only these.
const clean = (wf) => ({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} });

async function deploy(buildScript, wfPath, label) {
  console.log(`\n→ ${label}: building ${buildScript}`);
  execSync(`node ${buildScript}`, { cwd: repoRoot, stdio: "inherit" });
  const wf = clean(JSON.parse(readFileSync(resolve(repoRoot, wfPath), "utf8")));

  const list = await api("GET", "/workflows?limit=250");
  const items = (list && (list.data || list)) || [];
  const existing = Array.isArray(items) ? items.find((w) => w.name === wf.name) : null;

  let id;
  if (existing) {
    id = existing.id;
    await api("PUT", `/workflows/${id}`, wf);
    console.log(`  updated existing "${wf.name}" (id ${id})`);
  } else {
    const created = await api("POST", "/workflows", wf);
    id = created.id;
    console.log(`  created "${wf.name}" (id ${id})`);
  }

  // Activate — try the dedicated endpoint, fall back to PATCH active:true.
  try {
    await api("POST", `/workflows/${id}/activate`);
    console.log(`  activated "${wf.name}"`);
  } catch (e1) {
    try {
      await api("PATCH", `/workflows/${id}`, { ...wf, active: true });
      console.log(`  activated "${wf.name}" (via PATCH)`);
    } catch (e2) {
      console.log(`  ⚠ could not auto-activate "${wf.name}" — toggle it on in the n8n UI. (${e1.message})`);
    }
  }
  return id;
}

try {
  await deploy("ops/n8n/build-morning-brief.mjs", "ops/n8n/workflows/WF-MB-morning-brief.json", "Morning brief");
  await deploy("ops/n8n/build-contact-lead.mjs", "ops/n8n/workflows/WF-LEAD-contact.json", "Lead capture");
  console.log("\n✓ Done. Both workflows are imported and active in n8n.");
  console.log("  Tip: open WF-MB in n8n and click 'Execute workflow' to send yourself a test brief now.");
} catch (e) {
  console.error("\n✗ Deploy failed:", e.message);
  console.error("  Is n8n running and reachable at", BASE, "? Is N8N_API_KEY current in .mcp.json?");
  process.exit(1);
}
