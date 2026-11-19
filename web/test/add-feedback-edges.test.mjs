// The add feedback, the kept focus, the queued marks and the method badges,
// pushed at their edges: odd ids and names, a focus the visitor placed
// somewhere else, a catalog that changes underneath, the cap, and a preset
// pressed over a full queue. Every check reads what the page shows.
//
// The page is built the way main.js builds it (see live-page.test.mjs).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors, localStorage, eventSources } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as workspace from '../js/workspace.js';
import * as sidebar from '../js/render-sidebar.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const SETUP_KEY = 'courier.runner.v1';
const WS_KEY = 'courier.workspace.v1';
const byId = (id) => document.getElementById(id);
const req = (n, extra = {}) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [], ...extra });
const tab = () => byId('tab-runner').textContent;
const note = () => byId('add-note').textContent;
const focusKey = () => (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focusKey || '' : '');
const keyed = (key) => [...document.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === key);
const curated = () => byId('collections-tree');
const seqRows = () => byId('sequence-list').querySelectorAll('.seq-row');
const knee = (workers) => [...byId('knee-buttons').querySelectorAll('button')].find((b) => b.textContent.startsWith(`${workers} worker`));
const marksTotal = () => [...byId('panel-sidebar').querySelectorAll('.in-run')]
  .reduce((sum, m) => sum + (m.textContent === 'in run' ? 1 : Number(m.textContent.replace('in run x', ''))), 0);

let renderErrors = [];

function makeServer() {
  const server = {
    status: { running: false, budget_balance: 1500 },
    catalog: {
      collections: [
        { id: 'search-basics', name: 'Search basics', requests: [req(1), req(2), req(3), req(4), req(5)] },
        { id: 'other', name: 'Other', requests: [req(6), req(2)] },
      ],
      endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }],
      target: 'pokesearch',
    },
    catalogDown: 0,
    hold: null,
  };
  fetchStub.serve('/api/collections', () => {
    if (server.hold) return server.hold;
    if (server.catalogDown > 0) {
      server.catalogDown -= 1;
      throw new TypeError('Failed to fetch');
    }
    return { status: 200, body: server.catalog };
  }, { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: server.status }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [] } }), { method: 'GET' });
  fetchStub.serve(/^\/api\/runs\/[^/]+$/, () => ({ status: 404, body: { error: 'no run' } }), { method: 'GET' });
  return server;
}

let unsubscribe = null;
let page = null;

async function bootPage(t, server, { before } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const showTab = (name) => set({ activeTab: name });
  page = createLive({ api, get, set, showTab });
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init(page.hooks.runner);
  sidebar.init({
    select: (request) => {
      editor.onSelect();
      sidebar.selectRequest(request);
      showTab('editor');
    },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
    ...page.hooks.sidebar,
  });
  unsubscribe = subscribe((state) => {
    sidebar.render(state);
    editor.render(state);
    runner.render(state);
    results.render(state);
    page.scheduleSync();
  });
  set({ activeTab: 'runner' });
  if (before) before();
  await page.boot();
  await flush();
  return server;
}

async function poll(t) {
  t.mock.timers.tick(3000);
  await flush();
}

function openAll() {
  for (const d of document.querySelectorAll('#panel-sidebar details')) d.open = true;
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  renderErrors = [];
  // The store logs a render module that threw and carries on; that is a
  // broken page all the same.
  t.mock.method(console, 'error', (...args) => { renderErrors.push(args.map(String).join(' ')); });
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (page) page.stop();
  page = null;
  workspace.stop();
  api.onRunStarted(() => {});
});

// ------------------------------------------------------------------ focus

test('+ on a stored request whose id holds a quote or a bracket adds it, keeps focus, and breaks no render', async (t) => {
  localStorage.setItem(WS_KEY, JSON.stringify({ version: 1, requests: [
    { id: 'ws-"q', name: 'Quote', endpoint: 'search', params: {}, assertions: [] },
    { id: 'ws-]b', name: 'Bracket', endpoint: 'search', params: {}, assertions: [] },
    { id: 'ws-plain', name: 'Plain', endpoint: 'search', params: {}, assertions: [] },
  ] }));
  const server = makeServer();
  await bootPage(t, server);
  let n = 0;
  for (const id of ['ws-"q', 'ws-]b', 'ws-plain']) {
    const plus = keyed(`add:workspace:${id}`);
    assert.ok(plus, id);
    plus.focus();
    plus.click();
    n += 1;
    assert.equal(focusKey(), `add:workspace:${id}`, `focus kept on the + for ${id}`);
    assert.equal(tab(), `Runner (${n})`);
    assert.equal(seqRows().length, n, `the sequence shows ${n}`);
    assert.equal(byId('sequence-count').textContent, `${n} of 50 - ${n} selected`);
    assert.equal(byId('start-run').disabled, false, `Start is offered for what is queued, after + on ${id}`);
  }
  assert.deepEqual(renderErrors, [], 'no render module threw');
  assert.deepEqual(listenerErrors, []);
});

test('focus the visitor placed outside the sidebar, caret included, stays put through polls, storage events, Add all, a Retry landing and a live run', async (t) => {
  const server = makeServer();
  server.catalogDown = 1;
  await bootPage(t, server);
  workspace.save({ id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] });
  keyed('open:workspace:ws-1').click();
  const name = byId('editor-name');
  const startFocus = [
    () => { name.focus(); name.setSelectionRange(2, 2); return name; },
    () => { byId('delay-ms').focus(); return byId('delay-ms'); },
    () => { byId('tab-results').focus(); return byId('tab-results'); },
    () => { document.activeElement.blur && document.activeElement.blur(); return document.body; },
  ];
  for (const place of startFocus) {
    const where = place();
    const caret = where === name ? [name.selectionStart, name.selectionEnd] : null;
    const check = (what) => {
      assert.ok(document.activeElement === where, `${where.id || 'body'} after ${what}`);
      if (caret) assert.deepEqual([name.selectionStart, name.selectionEnd], caret, `caret after ${what}`);
    };
    for (let i = 0; i < 10; i += 1) {
      server.status = { running: false, budget_balance: 1500 - i };
      await poll(t);
    }
    check('ten polls');
    localStorage.writeFromAnotherTab(WS_KEY, JSON.stringify({ version: 1, requests: [
      { id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] },
      { id: 'ws-2', name: 'From the other tab', endpoint: 'search', params: {}, assertions: [] },
    ] }));
    await flush();
    check('a storage event');
    if (get().collections.length === 0) {
      page.hooks.sidebar.retryCatalog();
      await flush();
      assert.equal(get().collections.length, 2);
      check('a Retry landing');
    }
    runner.addAll(get().collections[1]);
    check('Add all');
    set({ sequence: [] });
  }
  // Another visitor's run going live.
  name.focus();
  server.status = { running: true, run_id: 'run-x', mode: 'functional', started_at: '2026-11-18T10:00:00Z', budget_balance: 1400 };
  await poll(t);
  assert.ok(document.activeElement === name, 'a run going live');
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

test('the same request listed in two collections keeps focus on the + pressed, not on its twin', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  openAll();
  const twin = keyed('add:other:r2');
  assert.ok(twin);
  twin.focus();
  twin.click();
  assert.equal(focusKey(), 'add:other:r2');
  assert.ok(document.activeElement.closest('details').textContent.includes('Other'));
  await poll(t);
  assert.equal(focusKey(), 'add:other:r2');
  const marks = [...curated().querySelectorAll('.in-run')].map((m) => m.textContent);
  assert.deepEqual(marks, ['in run', 'in run'], 'both listings of r2 are marked');
  assert.deepEqual(renderErrors, []);
});

test('Retry pressed again while its load is out starts no second load', async (t) => {
  const server = makeServer();
  server.catalogDown = 1;
  await bootPage(t, server);
  const calls = () => fetchStub.calls.filter((c) => c.url.endsWith('/api/collections')).length;
  const before = calls();
  let release;
  server.hold = new Promise((resolve) => { release = () => { server.hold = null; resolve({ status: 200, body: server.catalog }); }; });
  const retry = keyed('catalog-retry');
  retry.focus();
  retry.click();
  await flush();
  assert.equal(keyed('catalog-retry').getAttribute('aria-disabled'), 'true');
  assert.equal(focusKey(), 'catalog-retry');
  keyed('catalog-retry').click();
  keyed('catalog-retry').click();
  await flush();
  assert.equal(calls(), before + 1, 'one load');
  release();
  await flush();
  assert.match(curated().textContent, /Search basics/);
  assert.ok(curated().contains(document.activeElement));
  assert.deepEqual(renderErrors, []);
});

// ------------------------------------------------------------------ count, note and marks agree

test('the tab count, the note, the sequence rows and the marks agree after every change, and the note never outlives its count', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const agree = (what) => {
    const n = get().sequence.length;
    assert.equal(tab(), n === 0 ? 'Runner' : `Runner (${n})`, what);
    assert.equal(seqRows().length, n, what);
    // Every queued request here is listed in a tree (r2 twice).
    const listed = get().sequence.reduce((sum, e) => sum + (e.request.id === 'r2' ? 2 : ['r1', 'r3', 'r4', 'r5', 'r6'].includes(e.request.id) ? 1 : 0), 0);
    assert.equal(marksTotal(), listed, `marks after ${what}`);
    const said = /- (\d+) queued/.exec(note());
    if (said) assert.equal(Number(said[1]), n, `the note's count after ${what}`);
    if (/holds 50/.test(note())) assert.equal(n, 50, what);
  };
  const remove = () => [...byId('sequence-list').querySelectorAll('button')].find((b) => b.title === 'Remove from the run').click();

  for (let i = 0; i < 3; i += 1) {
    const before = byId('add-note').textContent;
    runner.add(server.catalog.collections[0].requests[0]);
    assert.notEqual(note(), before, 'the same request again changes the note');
    agree(`add ${i + 1}`);
  }
  assert.equal(note(), 'Added "Request 1" to the run - 3 queued.');
  runner.addAll(server.catalog.collections[1]);
  agree('add all');
  byId('sequence-list').querySelector('input[type="checkbox"]').click();
  agree('uncheck');
  assert.match(note(), /5 queued/);
  remove();
  agree('remove');
  assert.equal(note(), '');

  // Fill to 48, then Add all of 5 takes 2.
  set({ sequence: [...get().sequence, ...Array.from({ length: 44 }, (_, i) => ({ key: `f${i}`, enabled: true, request: req(100 + i) }))] });
  assert.equal(get().sequence.length, 48);
  runner.addAll(server.catalog.collections[0]);
  agree('partial add all');
  assert.equal(note(), 'Added 2 of the 5 requests in "Search basics" to the run - 50 queued, the cap.');
  runner.add(req(6));
  agree('refused add');
  assert.equal(note(), 'Could not add "Request 6" - the run already holds 50 requests, the cap.');
  assert.match(byId('sequence-note').textContent, /50 requests is the cap/);

  // A preset over a full queue in Performance mode.
  set({ mode: 'performance' });
  const writes = [];
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { writes.push(k); return real(k, v); };
  try {
    knee(25).focus();
    knee(25).click();
  } finally {
    delete localStorage.setItem;
  }
  assert.deepEqual(writes, [SETUP_KEY], 'one write of the run setup');
  assert.equal(byId('knee-note').textContent, 'Replaced the 50 queued requests with the 5 search-basics requests at 25 workers for 10s. Press Start run to take your own reading.');
  assert.equal(note(), '');
  assert.ok(document.activeElement === knee(25));
  agree('knee preset');
  assert.equal(tab(), 'Runner (5)');

  // Ten unrelated renders leave the note's text node alone.
  runner.add(req(3));
  const node = byId('add-note').firstChild;
  for (let i = 0; i < 10; i += 1) set({ selectedId: `r${i}` });
  assert.ok(byId('add-note').firstChild === node);
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ names are text

test('names with quotes, markup, entities, newlines, RTL marks and an emoji are text in the note, the + label, the title and the marks', async (t) => {
  const names = ['a "b" c', '<img src=x onerror=alert(1)>', '&amp; &lt;', 'line\nbreak', '‮evil‬', `${'x'.repeat(118)}\u{1F600}`];
  const server = makeServer();
  server.catalog.collections = [{ id: 'odd', name: '<b>Odd</b> "set"', requests: names.map((name, i) => req(i + 1, { name })) }];
  await bootPage(t, server);
  openAll();
  for (const [i, name] of names.entries()) {
    const plus = keyed(`add:odd:r${i + 1}`);
    assert.equal(plus.getAttribute('aria-label'), `Add ${name} to the run`);
    assert.equal(keyed(`open:odd:r${i + 1}`).title, name);
    plus.click();
    assert.equal(note(), `Added "${name}" to the run - ${i + 1} queued.`);
  }
  runner.addAll(get().collections[0]);
  assert.equal(note(), `Added the ${names.length} requests in "<b>Odd</b> "set"" to the run - ${names.length * 2} queued.`);
  assert.equal(byId('add-note').children.length, 0);
  assert.equal(byId('panel-sidebar').querySelectorAll('img, b').length, 0, 'no element made from a name');
  assert.deepEqual(renderErrors, []);
});

// ------------------------------------------------------------------ badges

test('badges never read a guessed, prototype or stringified method, in the tree, the sequence and result rows, and follow the catalog as it fails and returns', async (t) => {
  const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'missing', 'num', 'nul', 'long', 'markup', 'blank', 'post', 'patch'];
  const server = makeServer();
  server.catalogDown = 1;
  server.catalog.collections = [{ id: 'b', name: 'B', requests: odd.map((endpoint, i) => req(i + 1, { endpoint, name: `E ${endpoint}` })) }];
  server.catalog.endpoints = [
    { id: 'num', method: 42 }, { id: 'nul', method: null }, { id: 'long', method: 'X'.repeat(40) },
    { id: 'markup', method: '<b>GET</b>' }, { id: 'blank', method: '   ' }, { id: 'post', method: ' Post ' }, { id: 'patch', method: 'patch' },
  ];
  const expected = {
    __proto__: null, constructor: null, toString: null, hasOwnProperty: null, missing: null, num: null, nul: null, blank: null,
    long: ['XXXXXXX', 'method-other'], markup: ['<B>GET<', 'method-other'], post: ['POST', 'method-post'], patch: ['PATCH', 'method-other'],
  };
  await bootPage(t, server);
  // Queued before the catalog is in: every badge is the placeholder.
  for (const [i] of odd.entries()) runner.add(req(i + 1, { endpoint: odd[i], name: `E ${odd[i]}` }));
  const results_ = odd.map((endpoint, i) => ({ index: i, name: `E ${endpoint}`, endpoint, status: 200, passed: true, assertions: [] }));
  set({ results: results_, run: { id: 'run-1', mode: 'functional', total: odd.length, started_at: '', config: {}, entries: [] } });
  const badges = (root) => [...root.querySelectorAll('.method')].filter((b) => b.closest('.seq-row, .res-head, .req-row'));
  for (const b of [...badges(byId('sequence-list')), ...badges(byId('results-rows'))]) {
    assert.equal(b.textContent, '---');
    assert.equal(b.className, 'method method-none');
  }
  page.hooks.sidebar.retryCatalog();
  await flush();
  openAll();
  const check = (root, label) => {
    const rows = [...root.querySelectorAll('.seq-row, .res-head, .req-row')];
    assert.equal(rows.length, odd.length, label);
    for (const [i, endpoint] of odd.entries()) {
      const b = rows[i].querySelector('.method');
      const want = expected[endpoint];
      assert.doesNotMatch(b.textContent, /undefined|null|object|function|\d/, `${label} ${endpoint}`);
      if (!want) {
        assert.equal(b.textContent, '---', `${label} ${endpoint}`);
        assert.equal(b.className, 'method method-none', `${label} ${endpoint}`);
        assert.equal(b.getAttribute('aria-label'), 'Method unknown');
      } else {
        assert.deepEqual([b.textContent, b.className], [want[0], `method ${want[1]}`], `${label} ${endpoint}`);
      }
      assert.equal(b.children.length, 0);
    }
  };
  check(curated(), 'tree');
  check(byId('sequence-list'), 'sequence');
  check(byId('results-rows'), 'results');
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
  assert.ok(eventSources);
});
