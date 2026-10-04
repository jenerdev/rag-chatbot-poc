// tables-phase0-tools.mjs — print a tenant's tool DEFINITIONS, for the diff
// against plan/baseline/*-tools-*.txt (plan/tables.md Rule 3). Run from
// packages/rag:  node --conditions=react-server --env-file=../../.env ../../plan/tables-phase0-tools.mjs villa
import { loadTenant, toolsFor } from '../packages/rag/dist/index.js';
const tenant = await loadTenant(process.argv[2] ?? 'villa');
const { definitions } = await toolsFor(tenant);
process.stdout.write(JSON.stringify(definitions, null, 2) + '\n');
