const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ID = '33333333-3333-4333-8333-333333333333';
const at = new Date().toISOString();
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const user = text => ({ type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: text } });
const metadata = { type: 'session_meta', timestamp: at, payload: { id: ID, timestamp: at, originator: 'codex_cli_rs' } };
const connection = root => ({ id: 'source-review', root, connectorId: 'codex-rollout', storageId: root, historyDays: 30, allowAI: false, includeSummary: false });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-out-service-review-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test('service review: replacing an authorized root with a symlink does not grant access to the new target', async t => {
  const directory = await fixture(t), root = path.join(directory, 'authorized'), outside = path.join(directory, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, `rollout-${ID}.jsonl`), jsonl([metadata, user('OUTSIDE_SCOPE_PRIVATE_CONTENT')]));
  // The connection saved this real directory at pairing/configuration time.
  const configured = connection(await fs.realpath(root));
  await fs.rename(root, root + '-previous');
  await fs.symlink(outside, root);
  const { scan } = await import('../service/connectors/registry.mjs');
  let records = [];
  try { records = (await scan(configured)).records; } catch { /* Explicit scope rejection is correct. */ }
  assert.equal(records.length, 0);
});

test('service review: an unrecognized Codex-format file never persists its private body in cursor storage', async t => {
  const root = await fixture(t), marker = 'UNRECOGNIZED_FILE_PRIVATE_CONTENT';
  await fs.writeFile(path.join(root, `rollout-${ID}.jsonl`), jsonl([user(marker)]));
  const cursors = new Map();
  const { scan } = await import('../service/connectors/registry.mjs');
  const result = await scan(connection(root), { loadCursor: key => cursors.get(key), saveCursor: (key, value) => cursors.set(key, value) });
  assert.equal(result.records.length, 0);
  assert.equal(JSON.stringify([...cursors.values()]).includes(marker), false);
});
