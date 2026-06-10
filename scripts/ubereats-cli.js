#!/usr/bin/env node
// Simple CLI to exercise the Uber Eats connector from the terminal.
//
// Usage:
//   node scripts/ubereats-cli.js <tool> ['<json args>'] [--user <id>]
//
// Examples:
//   node scripts/ubereats-cli.js status
//   node scripts/ubereats-cli.js search '{"query":"pizza"}'
//   node scripts/ubereats-cli.js get_restaurant '{"restaurantId":"abc123"}'
//   node scripts/ubereats-cli.js add_to_cart '{"restaurantId":"abc123","itemName":"Margherita"}'
//   node scripts/ubereats-cli.js view_cart
//   node scripts/ubereats-cli.js checkout            # confirm:false preview
//   node scripts/ubereats-cli.js checkout '{"confirm":true}'   # PLACES A REAL ORDER
//
// --user lets you simulate different people (each gets its own login):
//   node scripts/ubereats-cli.js status --user alice
//   node scripts/ubereats-cli.js status --user bob

const { callTool } = require('../connectors/mcp/ubereats-client');

function parseArgs(argv) {
  const args = argv.slice(2);
  let user = 'cli-user';
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') { user = args[++i] || user; continue; }
    rest.push(args[i]);
  }
  const tool = rest[0];
  let toolArgs = {};
  if (rest[1]) {
    try {
      toolArgs = JSON.parse(rest[1]);
    } catch (e) {
      console.error(`Could not parse JSON args: ${rest[1]}\n${e.message}`);
      process.exit(1);
    }
  }
  return { user, tool, toolArgs };
}

(async () => {
  const { user, tool, toolArgs } = parseArgs(process.argv);
  if (!tool) {
    console.error('Usage: node scripts/ubereats-cli.js <tool> [\'<json args>\'] [--user <id>]');
    console.error('Tools: status, set_address, search, get_restaurant, add_to_cart, view_cart, clear_cart, checkout, track_order');
    process.exit(1);
  }
  const toolName = tool.startsWith('ubereats_') ? tool : `ubereats_${tool}`;
  try {
    console.log(`→ ${toolName}  (user: ${user})  args: ${JSON.stringify(toolArgs)}\n`);
    const res = await callTool(user, toolName, toolArgs);
    console.log(res.isError ? 'ERROR:' : 'OK:');
    console.log(res.text || '(no text)');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
})();
