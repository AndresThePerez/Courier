// One whole visit through the page's own entry file: the real index.html in
// the document and the real main.js imported, against a scripted server. The
// stored workspace and run setup are on screen before the catalog arrives;
// then the catalog loads, a curated request is added to the run, its row's
// Edit opens it, a parameter is changed and saved, the row shows the change,
// and Start runs it, with the run's results and verdict painted.
//
// main.js boots on import and a module is evaluated once per process, so this
// file holds a single test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localStorage, fetchStub, eventSources, flush, listenerErrors, typeInto } from './shim.mjs';

const byId = (id) => document.getElementById(id);
const RUN = 'run-boot-1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const curated = { id: 'find-pikachu', name: 'Find pikachu', endpoint: 'search', params: { q: 'pikachu' }, assertions: [{ type: 'status', op: 'eq', value: 200 }] };
const saved = { id: 'ws-saved', name: 'Saved probe', endpoint: 'search', params: { q: 'eevee' }, assertions: [] };
const restored = { id: 'ws-restored', name: 'Restored probe', endpoint: 'search', params: { q: 'mew' }, assertions: [] };

const seqRows = () => [...byId('sequence-list').querySelectorAll('.seq-row')];
const buttonIn = (node, text) => [...node.querySelectorAll('button')].find((b) => b.textContent === text);
// shown is the tab whose panel is on screen, as the tab strip says and the
// panel is drawn.
const shown = () => ['runner', 'editor', 'results'].filter((name) => byId(`tab-${name}`).getAttribute('aria-selected') === 'true' && byId(`panel-${name}`).classList.contains('is-active'));

test('a visit through index.html and main.js: restore, catalog, add, edit, save, start, results', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  localStorage.setItem('courier.workspace.v1', JSON.stringify({ version: 1, requests: [saved] }));
  localStorage.setItem('courier.runner.v1', JSON.stringify({
    version: 1, mode: 'functional', options: {}, sequence: [{ enabled: false, request: restored }],
  }));

  let status = { running: false, budget_balance: 1500 };
  let report = null;
  const catalog = fetchStub.defer('/api/collections', { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: status }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [] } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => {
    status = { running: true, run_id: RUN, mode: 'functional', started_at: '2026-11-19T10:00:00Z', budget_balance: 1500 };
    return { status: 202, body: { run_id: RUN } };
  }, { method: 'POST' });
  fetchStub.serve(`/api/runs/${RUN}`, () => ({ status: 200, body: report }), { method: 'GET' });

  await import('../js/main.js');

  // Before the catalog answers: what this browser kept is already drawn.
  assert.equal(catalog.requested, true, 'the catalog was not asked for');
  assert.match(byId('collections-tree').textContent, /Loading collections/);
  assert.deepEqual([...byId('workspace-tree').querySelectorAll('.req-open')].map((b) => b.title), ['Saved probe']);
  assert.deepEqual(seqRows().map((r) => r.querySelector('.seq-name').textContent), ['Restored probe']);
  assert.equal(byId('tab-runner').textContent, 'Runner (1)');
  assert.deepEqual(shown(), ['runner'], 'the runner is not the tab shown first');
  // The tab strip answers while the catalog is still out.
  byId('tab-results').click();
  assert.deepEqual(shown(), ['results'], 'the tabs do not answer before the catalog arrives');
  byId('tab-runner').click();
  assert.deepEqual(shown(), ['runner']);
  // And so does the editor: a saved request opens and takes an edit.
  [...byId('workspace-tree').querySelectorAll('.req-open')][0].click();
  assert.deepEqual(shown(), ['editor']);
  typeInto(byId('editor-name'), 'Saved probe, renamed');
  assert.deepEqual([...byId('workspace-tree').querySelectorAll('.req-open')].map((b) => b.title), ['Saved probe, renamed']);
  byId('tab-runner').click();

  // The catalog arrives.
  catalog.resolve({ status: 200, body: { collections: [{ id: 'search-basics', name: 'Search basics', description: '', requests: [curated] }], endpoints, target: 'search.example' } });
  await flush();
  assert.equal(byId('run-state').textContent, 'idle', 'the top bar does not say the server is idle');
  const find = [...byId('collections-tree').querySelectorAll('.req-row')].find((r) => r.textContent.includes('Find pikachu'));
  assert.ok(find, 'the curated request is not listed');

  // Added to the run with its +.
  find.querySelector('.req-add').click();
  assert.match(byId('add-note').textContent, /^Added "Find pikachu" to the run - 2 queued\.$/);
  assert.equal(seqRows().length, 2);

  // Its row's Edit opens it in the editor.
  buttonIn(seqRows()[1], 'Edit').click();
  await flush();
  assert.deepEqual(shown(), ['editor'], 'the editor is not shown');
  assert.equal(byId('editor-form').hidden, false);
  const name = byId('editor-name').value;
  assert.match(name, /^Find pikachu/);
  const value = byId('param-rows').querySelector('.param-value');
  assert.equal(value.value, 'pikachu');

  // A parameter changed and saved: the row shows the change.
  typeInto(value, 'raichu');
  byId('save-request').click();
  assert.match(byId('editor-note').textContent, /^Saved ".+" to My Workspace and to request 2 in the run\.$/);
  assert.equal(seqRows()[1].querySelector('.seq-target').textContent, 'search?q=raichu');
  assert.equal(seqRows()[0].querySelector('.seq-target').textContent, 'search?q=mew', 'the other row changed');

  // Start runs the checked request as saved.
  byId('start-run').click();
  await flush();
  const posted = fetchStub.calls.filter((c) => c.url === '/api/runs' && c.method === 'POST');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].json().sequence.map((r) => r.params), [{ q: 'raichu' }]);

  // The scripted run: its stream, then its finished report.
  assert.equal(byId('run-state').textContent, 'run in progress - functional', 'the top bar does not say a run is live');
  const stream = eventSources.instances.find((s) => s.url.endsWith(`/api/runs/${RUN}/stream`));
  assert.ok(stream, 'no stream was opened for the run');
  const frame = (type, data) => ({ type, run_id: RUN, data });
  const row = { index: 0, name, endpoint: 'search', query: '?q=raichu', status: 200, latency_ms: 12, size_bytes: 40, passed: true, skipped: false, assertions: [{ assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' }] };
  stream.emit('run_started', frame('run_started', { mode: 'functional', total: 1, started_at: '2026-11-19T10:00:00Z', config: {}, entries: [{ index: 0, name: row.name }] }));
  stream.emit('request_result', frame('request_result', row));
  status = { running: false, budget_balance: 1490 };
  report = { id: RUN, mode: 'functional', status: 'completed', started_at: '2026-11-19T10:00:00Z', duration_ms: 40, config: {}, entries: [{ index: 0, name: row.name }], functional: { verdict: 'PASS', results: [{ ...row, body_preview: '{"total":1}' }] } };
  stream.emit('run_finished', frame('run_finished', { status: 'completed', duration_ms: 40, verdict: 'PASS' }));
  await flush(10);

  assert.deepEqual(shown(), ['results'], 'the results are not shown');
  const results = [...byId('results-rows').querySelectorAll('.res-row')];
  assert.equal(results.length, 1);
  assert.match(results[0].textContent, /raichu/);
  const verdict = byId('results-summary').querySelector('.run-verdict');
  assert.ok(verdict, 'no verdict is painted');
  assert.equal(verdict.textContent, 'PASS');

  assert.deepEqual(errors, [], 'a render module threw');
  assert.deepEqual(listenerErrors, []);
  assert.deepEqual(fetchStub.unmatched.map((c) => `${c.method} ${c.url}`), []);
});
