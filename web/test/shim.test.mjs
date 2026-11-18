// The fake browser is test infrastructure every frontend test stands on, so
// its own behaviour is pinned here: a shim that drifted from what a browser
// does would let a frontend test pass for the wrong reason.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resetBrowser, localStorage, fetchStub, eventSources, media, keydown, typeInto, flush, listenerErrors,
} from './shim.mjs';

beforeEach(() => {
  resetBrowser();
});

test('every id in index.html is reachable through getElementById', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 50);
  for (const id of ids) {
    const node = document.getElementById(id);
    assert.ok(node, `#${id} is in the fake document`);
    assert.equal(node.id, id);
  }
  assert.equal(document.getElementById('editor-name').localName, 'input');
  assert.equal(document.getElementById('editor-name').getAttribute('maxlength'), '120');
  assert.equal(document.getElementById('sequence-note').hidden, true);
  assert.equal(document.getElementById('nope'), null);
});

test('createElement nodes are found by id only once they are in the document', () => {
  const div = document.createElement('div');
  div.id = 'late';
  assert.equal(document.getElementById('late'), null);
  document.getElementById('app').appendChild(div);
  assert.equal(document.getElementById('late'), div);
  div.remove();
  assert.equal(document.getElementById('late'), null);
});

test('querySelector handles tags, attributes, compounds, classes and combinators', () => {
  const tree = document.getElementById('collections-tree');
  for (const id of ['a', 'b']) {
    const details = document.createElement('details');
    details.dataset.id = id;
    const btn = document.createElement('button');
    btn.setAttribute('data-focus-key', `add:${id}:r1`);
    details.appendChild(btn);
    tree.appendChild(details);
  }
  tree.appendChild(document.createElement('details'));

  assert.equal(tree.querySelectorAll('details').length, 3);
  assert.equal(tree.querySelectorAll('details[data-id]').length, 2);
  assert.equal(tree.querySelector('details[data-id="b"]').dataset.id, 'b');
  assert.equal(tree.querySelector("[data-id='a']").dataset.id, 'a');
  assert.equal(document.querySelector('[data-focus-key="add:b:r1"]').parentNode.dataset.id, 'b');
  assert.equal(document.querySelectorAll('nav#collections-tree > details[data-id] button').length, 2);
  assert.equal(document.querySelector('.skip-link').getAttribute('href'), '#panel-main');
  assert.equal(document.querySelectorAll('#mode-functional, #mode-performance').length, 2);
  assert.equal(tree.querySelector('button').closest('details').dataset.id, 'a');
  assert.ok(tree.querySelector('button').matches('details > button[data-focus-key]'));
});

test('a selector the shim does not model throws instead of guessing', () => {
  assert.throws(() => document.querySelector('button:focus'), SyntaxError);
  assert.throws(() => document.querySelector('[data-id^="a"]'), SyntaxError);
  assert.throws(() => document.querySelector('a + b'), SyntaxError);
});

test('innerHTML is refused', () => {
  const div = document.createElement('div');
  assert.throws(() => { div.innerHTML = '<b>x</b>'; }, /innerHTML/);
});

test('classList, dataset, style and reflected properties track attributes', () => {
  const el = document.createElement('button');
  el.className = 'btn';
  el.classList.add('is-on');
  assert.equal(el.getAttribute('class'), 'btn is-on');
  assert.equal(el.classList.toggle('is-on'), false);
  assert.equal(el.className, 'btn');

  el.dataset.focusKey = 'seq-up:seq-1';
  assert.equal(el.getAttribute('data-focus-key'), 'seq-up:seq-1');
  assert.deepEqual(Object.keys(el.dataset), ['focusKey']);

  el.hidden = true;
  assert.equal(el.getAttribute('hidden'), '');
  el.hidden = false;
  assert.equal(el.hasAttribute('hidden'), false);

  el.style.width = '40%';
  assert.equal(el.style.width, '40%');
  assert.equal(el.type, 'submit');
});

test('textContent replaces children and reads text back', () => {
  const p = document.getElementById('sequence-note');
  p.appendChild(document.createElement('span'));
  p.textContent = 'hello';
  assert.equal(p.childNodes.length, 1);
  assert.equal(p.textContent, 'hello');
  assert.equal(document.getElementById('sidebar-toggle').textContent, '☰');
});

test('input value, caret and select value behave like a browser', () => {
  const input = document.getElementById('editor-name');
  typeInto(input, 'abc');
  assert.equal(input.value, 'abc');
  assert.equal(input.selectionStart, 3);
  input.setSelectionRange(1, 2);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 2]);

  const box = document.getElementById('stop-on-failure');
  assert.throws(() => box.setSelectionRange(0, 0), (err) => err.name === 'InvalidStateError');

  const select = document.createElement('select');
  for (const v of ['eq', 'neq']) {
    const opt = document.createElement('option');
    opt.setAttribute('value', v);
    select.appendChild(opt);
  }
  assert.equal(select.value, 'eq');
  select.value = 'neq';
  assert.equal(select.value, 'neq');
  assert.equal(select.selectedIndex, 1);
});

test('focus moves document.activeElement, and leaving the document drops it', () => {
  assert.equal(document.activeElement, document.body);
  const seen = [];
  const btn = document.getElementById('start-run');
  btn.addEventListener('focus', () => seen.push('focus'));
  btn.addEventListener('blur', () => seen.push('blur'));

  btn.focus();
  assert.equal(document.activeElement, btn);
  document.getElementById('panel-main').focus();
  assert.equal(document.activeElement.id, 'panel-main', 'tabindex makes an element focusable');
  assert.deepEqual(seen, ['focus', 'blur']);

  document.getElementById('brand').focus();
  assert.equal(document.activeElement.id, 'panel-main', 'a heading without tabindex takes no focus');

  btn.disabled = true;
  btn.focus();
  assert.equal(document.activeElement.id, 'panel-main', 'a disabled control takes no focus');

  const list = document.getElementById('sequence-list');
  const row = document.createElement('button');
  list.appendChild(row);
  row.focus();
  assert.equal(document.activeElement, row);
  list.removeChild(row);
  assert.equal(document.activeElement, document.body);
});

test('click and keydown bubble, and preventDefault is observable', () => {
  const app = document.getElementById('app');
  const btn = document.getElementById('start-run');
  const order = [];
  app.addEventListener('click', () => order.push('app capture'), { capture: true });
  app.addEventListener('click', (e) => {
    order.push(`app bubble ${e.target.id} ${e.currentTarget.id}`);
    e.preventDefault();
  });
  btn.addEventListener('click', () => order.push('button'));
  window.addEventListener('click', () => order.push('window'));

  assert.equal(btn.click(), false);
  assert.deepEqual(order, ['app capture', 'button', 'app bubble start-run app', 'window']);

  const tabs = document.getElementById('tabs');
  tabs.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') e.preventDefault();
  });
  assert.equal(keydown(document.getElementById('tab-runner'), 'ArrowRight').defaultPrevented, true);
  assert.equal(keydown(document.getElementById('tab-runner'), 'a').defaultPrevented, false);
});

test('stopPropagation stops the bubble and once listeners fire once', () => {
  const app = document.getElementById('app');
  const btn = document.getElementById('start-run');
  let outer = 0;
  let inner = 0;
  app.addEventListener('click', () => { outer += 1; });
  btn.addEventListener('click', (e) => { inner += 1; e.stopPropagation(); }, { once: true });
  btn.click();
  btn.click();
  assert.equal(inner, 1);
  assert.equal(outer, 1);
});

test('a disabled button gets no click; a checkbox toggles and fires change', () => {
  const btn = document.getElementById('start-run');
  let clicks = 0;
  btn.addEventListener('click', () => { clicks += 1; });
  btn.disabled = true;
  btn.click();
  assert.equal(clicks, 0);

  const box = document.getElementById('stop-on-failure');
  let changes = 0;
  box.addEventListener('change', () => { changes += 1; });
  box.click();
  assert.equal(box.checked, true);
  assert.equal(changes, 1);

  box.addEventListener('click', (e) => e.preventDefault());
  box.click();
  assert.equal(box.checked, true, 'a cancelled click flips the box back');
  assert.equal(changes, 1);
});

test('radio buttons in one group uncheck each other', () => {
  const fn = document.getElementById('mode-functional');
  const perf = document.getElementById('mode-performance');
  fn.checked = true;
  perf.click();
  assert.equal(perf.checked, true);
  assert.equal(fn.checked, false);
});

test('a link click navigates to its hash unless cancelled', () => {
  const link = document.querySelector('.skip-link');
  const hashes = [];
  window.addEventListener('hashchange', (e) => hashes.push(new URL(e.newURL).hash));

  link.click();
  assert.equal(location.hash, '#panel-main');
  assert.deepEqual(hashes, ['#panel-main']);

  location.hash = '#results';
  link.addEventListener('click', (e) => e.preventDefault());
  assert.equal(link.click(), false);
  assert.equal(location.hash, '#results');
  assert.deepEqual(hashes, ['#panel-main', '#results']);
});

test('window listeners receive storage events with key and newValue', () => {
  const seen = [];
  window.addEventListener('storage', (e) => seen.push([e.key, e.oldValue, e.newValue, e.storageArea === localStorage]));
  localStorage.setItem('k', 'one');
  assert.deepEqual(seen, [], 'a write from this tab fires nothing here');

  localStorage.writeFromAnotherTab('k', 'two');
  assert.equal(localStorage.getItem('k'), 'two');
  localStorage.writeFromAnotherTab('k', null);
  assert.equal(localStorage.getItem('k'), null);
  assert.deepEqual(seen, [['k', 'one', 'two', true], ['k', 'two', null, true]]);

  window.dispatchEvent(new StorageEvent('storage', { key: 'x', newValue: 'y' }));
  assert.deepEqual(seen.at(-1), ['x', null, 'y', false]);
});

test('localStorage can be told to throw on setItem and on getItem', () => {
  localStorage.setItem('k', 'v');

  localStorage.failOn('setItem');
  assert.throws(() => localStorage.setItem('k', 'w'), (err) => err.name === 'QuotaExceededError');
  assert.equal(localStorage.getItem('k'), 'v');

  localStorage.failOn('getItem');
  assert.throws(() => localStorage.getItem('k'), (err) => err.name === 'SecurityError');
  assert.equal(localStorage.peek('k'), 'v');

  localStorage.heal();
  localStorage.setItem('k', 'w');
  assert.equal(localStorage.getItem('k'), 'w');

  const custom = new Error('custom');
  localStorage.failOn('removeItem', custom);
  assert.throws(() => localStorage.removeItem('k'), custom);
});

test('resetBrowser starts the next test from a fresh page', () => {
  localStorage.setItem('k', 'v');
  localStorage.failOn('getItem');
  window.addEventListener('storage', () => assert.fail('listener survived a reset'));
  document.getElementById('sequence-note').textContent = 'stale';

  resetBrowser();

  assert.equal(localStorage.getItem('k'), null);
  assert.equal(document.getElementById('sequence-note').textContent, '');
  localStorage.writeFromAnotherTab('k', 'v');
});

test('fetch answers per URL and method, once each, and records the call', async () => {
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'r1' } }, { method: 'POST' });
  fetchStub.respond('/api/runs', { status: 200, body: [] });

  const res = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { run_id: 'r1' });
  assert.deepEqual(fetchStub.calls[0].json(), { a: 1 });
  assert.equal(fetchStub.calls[0].headers['content-type'], 'application/json');

  assert.equal((await fetch('/api/runs')).status, 200);
  await assert.rejects(fetch('/api/runs'), /nothing scripted for GET \/api\/runs/);
  assert.equal(fetchStub.unmatched.length, 1);

  fetchStub.respond('/api/x', { status: 204 });
  assert.equal(await (await fetch('/api/x')).text(), '');
});

test('fetch can reject or wait for the test to answer', async () => {
  fetchStub.reject('/api/status');
  await assert.rejects(fetch('/api/status'), TypeError);

  const pending = fetchStub.defer('/api/runs/r1');
  assert.equal(pending.requested, false);
  let answered = null;
  fetch('/api/runs/r1').then((r) => { answered = r.status; });
  assert.equal(pending.requested, true);
  await flush();
  assert.equal(answered, null);
  pending.resolve({ status: 404, body: { error: 'gone' } });
  await flush();
  assert.equal(answered, 404);
});

test('an EventSource can be opened, fed named events, errored and closed', () => {
  const source = new EventSource('/api/runs/r1/stream');
  const got = [];
  let errors = 0;
  source.addEventListener('run_started', (e) => got.push(['named', e.data, e.lastEventId]));
  source.onmessage = (e) => got.push(['message', e.data]);
  source.onerror = () => { errors += 1; };

  assert.equal(eventSources.opened, 1);
  assert.equal(eventSources.latest(), source);
  assert.equal(source.readyState, EventSource.CONNECTING);
  source.open();
  assert.equal(source.readyState, EventSource.OPEN);

  source.emit('run_started', { type: 'run_started' }, { lastEventId: 7 });
  source.emit('message', 'plain');
  assert.deepEqual(got, [['named', '{"type":"run_started"}', '7'], ['message', 'plain']]);

  source.fail();
  assert.equal(errors, 1);
  assert.equal(source.readyState, EventSource.CONNECTING);

  source.close();
  source.close();
  assert.equal(eventSources.closed, 1);
  assert.equal(source.emit('run_started', {}), false, 'a closed source delivers nothing');
  assert.equal(got.length, 2);
});

test('matchMedia answers what the test scripted and fires change', () => {
  const q = '(max-width: 900px)';
  const list = window.matchMedia(q);
  assert.equal(list.matches, false);
  let changes = 0;
  list.addEventListener('change', () => { changes += 1; });
  media.set(q, true);
  assert.equal(list.matches, true);
  assert.equal(window.matchMedia(q).matches, true);
  media.set(q, true);
  assert.equal(changes, 1);
});

test('a throwing listener is recorded and does not stop the others', () => {
  const btn = document.getElementById('start-run');
  let after = 0;
  btn.addEventListener('click', () => { throw new Error('boom'); });
  btn.addEventListener('click', () => { after += 1; });
  btn.click();
  assert.equal(after, 1);
  assert.equal(listenerErrors.length, 1);
});
