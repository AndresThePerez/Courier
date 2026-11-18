// shim.mjs — a small fake browser, so the frontend modules run unmodified
// under `node --test` with no package.json, no npm and no bundler.
//
// It is a fake, not an emulator: it models the parts of the DOM and the
// browser the modules actually lean on, and it throws on anything it does not
// model (an unsupported selector, innerHTML) rather than quietly answering
// wrong. A test that passes against a shim which guesses is worse than no test.
//
// Importing this module installs the globals. resetBrowser() puts every one of
// them back to a fresh page between tests.
//
// What it models:
//   - document: parsed from web/index.html (so every id="..." in the page is
//     there with its real tag and attributes), createElement, createTextNode,
//     createDocumentFragment, getElementById, querySelector(All), activeElement.
//   - Elements: attributes, reflected properties (id, className, hidden,
//     disabled, title, type, ...), classList, dataset, style, value / checked /
//     selected, select.value over its options, textContent, children, tree
//     edits, matches / closest, focus / blur, click with default actions
//     (checkbox and radio toggling, in-page anchor navigation).
//   - Events: capture, target and bubble phases from an element up through
//     document to window; once; stopPropagation; preventDefault on cancelable
//     events. KeyboardEvent, MouseEvent, FocusEvent, StorageEvent and
//     HashChangeEvent constructors.
//   - window (=== globalThis): add/removeEventListener, dispatchEvent,
//     matchMedia with scriptable matches, location with hashchange.
//   - localStorage / sessionStorage: Map-backed, each method can be told to
//     throw; a write "from another tab" fires a storage event here.
//   - fetch: per-URL scripted responses, rejections and deferred responses,
//     with every call recorded. An unscripted URL rejects loudly.
//   - EventSource: every instance recorded; tests open it, emit named events,
//     fire errors, and read how many were opened and closed.
//   - navigator.clipboard.writeText, recording what was written.
//
// Selectors: tag, *, #id, .class, [attr], [attr="v"] (also unquoted and
// single-quoted), any compound of those, the descendant and child (>)
// combinators, and comma lists. Anything else throws.

import { readFileSync } from 'node:fs';

const INDEX_HTML = new URL('../index.html', import.meta.url);
const BASE_URL = 'http://192.0.2.10/';

// ------------------------------------------------------------------ events

const listenerStore = new WeakMap();

function listenersOf(target) {
  let map = listenerStore.get(target);
  if (!map) {
    map = new Map();
    listenerStore.set(target, map);
  }
  return map;
}

function addListener(target, type, fn, options) {
  if (!fn) return;
  const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
  const once = Boolean(options && typeof options === 'object' && options.once);
  const map = listenersOf(target);
  const list = map.get(type) || [];
  if (list.some((l) => l.fn === fn && l.capture === capture)) return;
  list.push({ fn, capture, once });
  map.set(type, list);
}

function removeListener(target, type, fn, options) {
  const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
  const map = listenersOf(target);
  const list = map.get(type);
  if (!list) return;
  const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
  if (i >= 0) list.splice(i, 1);
}

function invoke(target, event, phase) {
  const list = (listenersOf(target).get(event.type) || []).slice();
  for (const l of list) {
    if (event.__stopImmediate) return;
    if (phase === 1 && !l.capture) continue;
    if (phase === 3 && l.capture) continue;
    if (l.once) removeListener(target, event.type, l.fn, { capture: l.capture });
    Object.defineProperty(event, 'currentTarget', { value: target, configurable: true });
    try {
      if (typeof l.fn === 'function') l.fn.call(target, event);
      else l.fn.handleEvent(event);
    } catch (err) {
      reportError(err);
    }
  }
}

// dispatch runs the three DOM phases over target's ancestors, then document,
// then window. Listeners that throw are reported, not propagated, matching a
// browser: one broken handler does not abort the dispatch.
function dispatch(target, event) {
  const path = [target];
  if (target instanceof FakeNode) {
    let node = target.parentNode;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    if (path[path.length - 1] instanceof FakeDocument) path.push(globalThis);
  }

  let stopped = false;
  const stop = event.stopPropagation;
  const stopImmediate = event.stopImmediatePropagation;
  event.stopPropagation = function stopPropagation() {
    stopped = true;
    return stop.call(this);
  };
  event.stopImmediatePropagation = function stopImmediatePropagation() {
    stopped = true;
    this.__stopImmediate = true;
    return stopImmediate.call(this);
  };
  Object.defineProperty(event, 'target', { value: target, configurable: true });
  Object.defineProperty(event, 'srcElement', { value: target, configurable: true });

  const safely = (node, phase) => {
    Object.defineProperty(event, 'eventPhase', { value: phase, configurable: true });
    invoke(node, event, phase);
  };

  for (let i = path.length - 1; i > 0 && !stopped; i -= 1) safely(path[i], 1);
  if (!stopped) safely(target, 2);
  if (event.bubbles) {
    for (let i = 1; i < path.length && !stopped; i += 1) safely(path[i], 3);
  }

  Object.defineProperty(event, 'eventPhase', { value: 0, configurable: true });
  Object.defineProperty(event, 'currentTarget', { value: null, configurable: true });
  delete event.__stopImmediate;
  return !event.defaultPrevented;
}

// Thrown listener errors are collected so a test can assert there were none;
// they are not rethrown into the code that dispatched the event.
export const listenerErrors = [];

function reportError(err) {
  listenerErrors.push(err);
}

export class UIEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail ?? 0;
  }
}

export class MouseEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.button = init.button ?? 0;
    this.altKey = Boolean(init.altKey);
    this.ctrlKey = Boolean(init.ctrlKey);
    this.metaKey = Boolean(init.metaKey);
    this.shiftKey = Boolean(init.shiftKey);
  }
}

export class KeyboardEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.altKey = Boolean(init.altKey);
    this.ctrlKey = Boolean(init.ctrlKey);
    this.metaKey = Boolean(init.metaKey);
    this.shiftKey = Boolean(init.shiftKey);
    this.repeat = Boolean(init.repeat);
  }
}

export class FocusEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.relatedTarget = init.relatedTarget ?? null;
  }
}

export class StorageEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key ?? null;
    this.oldValue = init.oldValue ?? null;
    this.newValue = init.newValue ?? null;
    this.url = init.url ?? BASE_URL;
    this.storageArea = init.storageArea ?? null;
  }
}

export class HashChangeEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.oldURL = init.oldURL ?? '';
    this.newURL = init.newURL ?? '';
  }
}

// ------------------------------------------------------------------ nodes

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    return sibs[sibs.indexOf(this) + 1] || null;
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    return sibs[sibs.indexOf(this) - 1] || null;
  }

  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node instanceof FakeDocument;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    const text = value === null || value === undefined ? '' : String(value);
    if (text !== '') this.appendChild(this.ownerDocument.createTextNode(text));
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  appendChild(child) {
    return this.insertBefore(child, null);
  }

  insertBefore(child, ref) {
    if (!(child instanceof FakeNode)) throw new TypeError('shim: insertBefore takes a node');
    if (child.contains(this)) throw new DOMException('the new child contains the parent', 'HierarchyRequestError');
    if (ref && ref.parentNode !== this) throw new DOMException('reference node is not a child', 'NotFoundError');
    if (child instanceof FakeFragment) {
      for (const c of child.childNodes.slice()) this.insertBefore(c, ref);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new DOMException('not a child of this node', 'NotFoundError');
    const doc = this.ownerDocument || this;
    // A browser moves focus to <body> when the focused element leaves the
    // document; focus-restoring code depends on seeing exactly that.
    const lostFocus = doc.activeElement && child.contains(doc.activeElement);
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    if (lostFocus) doc.activeElement = doc.body;
    return child;
  }

  replaceChild(next, old) {
    this.insertBefore(next, old);
    return this.removeChild(old);
  }

  replaceChildren(...nodes) {
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    this.append(...nodes);
  }

  append(...nodes) {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? (this.ownerDocument || this).createTextNode(n) : n);
    }
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  addEventListener(type, fn, options) {
    addListener(this, type, fn, options);
  }

  removeEventListener(type, fn, options) {
    removeListener(this, type, fn, options);
  }

  dispatchEvent(event) {
    return dispatch(this, event);
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.data = String(data);
  }

  get nodeType() {
    return 3;
  }

  get nodeName() {
    return '#text';
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = value === null || value === undefined ? '' : String(value);
  }

  get nodeValue() {
    return this.data;
  }
}

class FakeFragment extends FakeNode {
  get nodeType() {
    return 11;
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const BOOLEAN_PROPS = { hidden: 'hidden', disabled: 'disabled', open: 'open', required: 'required', readOnly: 'readonly', multiple: 'multiple', autofocus: 'autofocus' };
const STRING_PROPS = { id: 'id', className: 'class', title: 'title', name: 'name', placeholder: 'placeholder', href: 'href', src: 'src', htmlFor: 'for', lang: 'lang', alt: 'alt', role: 'role' };
const TEXT_CONTROLS = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

function camelToData(prop) {
  return `data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function dataToCamel(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  tokens() {
    return (this.element.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  write(tokens) {
    this.element.setAttribute('class', tokens.join(' '));
  }

  get length() {
    return this.tokens().length;
  }

  get value() {
    return this.element.getAttribute('class') || '';
  }

  item(i) {
    return this.tokens()[i] ?? null;
  }

  contains(token) {
    return this.tokens().includes(token);
  }

  add(...tokens) {
    const now = this.tokens();
    for (const t of tokens) if (!now.includes(t)) now.push(t);
    this.write(now);
  }

  remove(...tokens) {
    this.write(this.tokens().filter((t) => !tokens.includes(t)));
  }

  toggle(token, force) {
    const has = this.contains(token);
    const want = force === undefined ? !has : Boolean(force);
    if (want && !has) this.add(token);
    if (!want && has) this.remove(token);
    return want;
  }

  replace(oldToken, newToken) {
    if (!this.contains(oldToken)) return false;
    this.write(this.tokens().map((t) => (t === oldToken ? newToken : t)));
    return true;
  }

  forEach(fn) {
    this.tokens().forEach(fn);
  }

  [Symbol.iterator]() {
    return this.tokens()[Symbol.iterator]();
  }

  toString() {
    return this.value;
  }
}

function makeDataset(element) {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      const v = element.getAttribute(camelToData(prop));
      return v === null ? undefined : v;
    },
    set(_, prop, value) {
      element.setAttribute(camelToData(prop), String(value));
      return true;
    },
    has(_, prop) {
      return typeof prop === 'string' && element.hasAttribute(camelToData(prop));
    },
    deleteProperty(_, prop) {
      element.removeAttribute(camelToData(prop));
      return true;
    },
    ownKeys() {
      return element.getAttributeNames().filter((n) => n.startsWith('data-')).map(dataToCamel);
    },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop !== 'string' || !element.hasAttribute(camelToData(prop))) return undefined;
      return { value: element.getAttribute(camelToData(prop)), writable: true, enumerable: true, configurable: true };
    },
  });
}

function makeStyle() {
  const style = {};
  Object.defineProperties(style, {
    setProperty: { value(name, value) { style[name] = String(value); } },
    getPropertyValue: { value(name) { return style[name] ?? ''; } },
    removeProperty: { value(name) { const old = style[name] ?? ''; delete style[name]; return old; } },
  });
  return style;
}

class FakeElement extends FakeNode {
  constructor(doc, tagName) {
    super(doc);
    this.localName = String(tagName).toLowerCase();
    this.attrs = new Map();
    this.style = makeStyle();
    this.classList = new FakeClassList(this);
    this.dataset = makeDataset(this);
    this.dirtyValue = null;
    this.dirtyChecked = null;
    this.dirtySelected = null;
    this.selectionStart = null;
    this.selectionEnd = null;
  }

  get nodeType() {
    return 1;
  }

  get tagName() {
    return this.localName.toUpperCase();
  }

  get nodeName() {
    return this.tagName;
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }

  get childElementCount() {
    return this.children.length;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get lastElementChild() {
    const kids = this.children;
    return kids[kids.length - 1] || null;
  }

  // ---------------------------------------------------------- attributes

  getAttribute(name) {
    const v = this.attrs.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }

  setAttribute(name, value) {
    this.attrs.set(String(name).toLowerCase(), String(value));
  }

  hasAttribute(name) {
    return this.attrs.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attrs.delete(String(name).toLowerCase());
  }

  toggleAttribute(name, force) {
    const has = this.hasAttribute(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want && !has) this.setAttribute(name, '');
    if (!want && has) this.removeAttribute(name);
    return want;
  }

  getAttributeNames() {
    return [...this.attrs.keys()];
  }

  // innerHTML is banned in the client (TestNoInnerHTML); the fake refuses it
  // too, so a test can never pass by way of it.
  get innerHTML() {
    throw new Error('shim: innerHTML is not supported - the client renders through textContent');
  }

  set innerHTML(_) {
    throw new Error('shim: innerHTML is not supported - the client renders through textContent');
  }

  // ---------------------------------------------------------- form state

  get type() {
    const t = this.getAttribute('type');
    if (this.localName === 'input') return (t || 'text').toLowerCase();
    if (this.localName === 'button') return (t || 'submit').toLowerCase();
    if (this.localName === 'select') return this.multiple ? 'select-multiple' : 'select-one';
    return t || '';
  }

  set type(value) {
    this.setAttribute('type', value);
  }

  get value() {
    if (this.localName === 'select') {
      const opt = this.selectedOption();
      return opt ? opt.value : '';
    }
    if (this.localName === 'option') {
      const v = this.getAttribute('value');
      return v === null ? this.textContent.trim() : v;
    }
    if (this.localName === 'textarea') return this.dirtyValue ?? this.textContent;
    return this.dirtyValue ?? this.getAttribute('value') ?? '';
  }

  set value(v) {
    const text = v === null || v === undefined ? '' : String(v);
    if (this.localName === 'select') {
      for (const opt of this.options) opt.dirtySelected = opt.value === text;
      return;
    }
    if (this.localName === 'option') {
      this.setAttribute('value', text);
      return;
    }
    this.dirtyValue = text;
    // Assigning a value puts the caret at the end, as a browser does.
    this.selectionStart = text.length;
    this.selectionEnd = text.length;
  }

  get options() {
    return this.localName === 'select' ? this.querySelectorAll('option') : undefined;
  }

  selectedOption() {
    const opts = this.options;
    return opts.find((o) => o.selected) || opts[0] || null;
  }

  get selectedIndex() {
    if (this.localName !== 'select') return undefined;
    const opts = this.options;
    const i = opts.findIndex((o) => o.selected);
    return i >= 0 ? i : (opts.length ? 0 : -1);
  }

  set selectedIndex(i) {
    this.options.forEach((o, j) => { o.dirtySelected = j === i; });
  }

  get selected() {
    return this.dirtySelected ?? this.hasAttribute('selected');
  }

  set selected(on) {
    const select = this.closest('select');
    if (on && select && !select.multiple) for (const o of select.options) o.dirtySelected = false;
    this.dirtySelected = Boolean(on);
  }

  get checked() {
    return this.dirtyChecked ?? this.hasAttribute('checked');
  }

  set checked(on) {
    this.dirtyChecked = Boolean(on);
    if (on && this.type === 'radio' && this.name) {
      for (const other of radioGroup(this)) if (other !== this) other.dirtyChecked = false;
    }
  }

  setSelectionRange(start, end) {
    if (!(this.localName === 'textarea' || (this.localName === 'input' && TEXT_CONTROLS.has(this.type)))) {
      throw new DOMException('this control has no text selection', 'InvalidStateError');
    }
    const len = this.value.length;
    this.selectionStart = Math.min(start, len);
    this.selectionEnd = Math.min(end ?? start, len);
  }

  get tabIndex() {
    const raw = this.getAttribute('tabindex');
    if (raw !== null && /^-?\d+$/.test(raw.trim())) return Number(raw);
    return isNativelyFocusable(this) ? 0 : -1;
  }

  set tabIndex(n) {
    this.setAttribute('tabindex', String(n));
  }

  // ---------------------------------------------------------- selectors

  matches(selector) {
    return parseSelector(selector).some((complex) => matchesComplex(this, complex, complex.length - 1));
  }

  closest(selector) {
    const groups = parseSelector(selector);
    for (let n = this; n instanceof FakeElement; n = n.parentNode) {
      if (groups.some((complex) => matchesComplex(n, complex, complex.length - 1))) return n;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  // ---------------------------------------------------------- focus and click

  focus() {
    const doc = this.ownerDocument;
    if (!this.isConnected || this.disabled || !isFocusable(this)) return;
    if (doc.activeElement === this) return;
    const prev = doc.activeElement;
    if (prev && prev !== doc.body) {
      doc.activeElement = doc.body;
      prev.dispatchEvent(new FocusEvent('blur', { relatedTarget: this }));
      prev.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: this }));
    }
    doc.activeElement = this;
    this.dispatchEvent(new FocusEvent('focus', { relatedTarget: prev }));
    this.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: prev }));
  }

  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.dispatchEvent(new FocusEvent('blur'));
    this.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  // click() follows the browser's activation behaviour: a disabled control
  // gets no event at all; a checkbox or radio flips before listeners run and
  // flips back if one of them cancels; an in-page link navigates to its hash
  // unless a listener cancels.
  click() {
    if (this.disabled && isFormControl(this)) return true;
    const toggles = this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio');
    const before = toggles ? radioSnapshot(this) : null;
    if (toggles) this.checked = this.type === 'checkbox' ? !this.checked : true;

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const proceed = this.dispatchEvent(event);

    if (toggles) {
      if (!proceed) {
        restoreRadioSnapshot(before);
      } else if (before.some(([el, was]) => el.checked !== was)) {
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return proceed;
    }
    if (proceed) {
      const link = this.closest('a[href]');
      const href = link && link.getAttribute('href');
      if (href && href.startsWith('#')) globalThis.location.hash = href;
    }
    return proceed;
  }
}

function isFormControl(el) {
  return ['input', 'button', 'select', 'textarea', 'option', 'fieldset'].includes(el.localName);
}

function isNativelyFocusable(el) {
  if (['input', 'button', 'select', 'textarea'].includes(el.localName)) return true;
  if (el.localName === 'a' && el.hasAttribute('href')) return true;
  if (el.localName === 'summary') return true;
  return false;
}

function isFocusable(el) {
  return isNativelyFocusable(el) || el.hasAttribute('tabindex');
}

function radioGroup(el) {
  const doc = el.ownerDocument;
  const root = el.closest('form') || doc;
  return root.querySelectorAll('input').filter((i) => i.type === 'radio' && i.name === el.name);
}

function radioSnapshot(el) {
  const group = el.type === 'radio' && el.name ? radioGroup(el) : [el];
  if (!group.includes(el)) group.push(el);
  return group.map((i) => [i, i.checked]);
}

function restoreRadioSnapshot(snapshot) {
  for (const [el, was] of snapshot) el.dirtyChecked = was;
}

for (const [prop, attr] of Object.entries(BOOLEAN_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this.hasAttribute(attr); },
    set(on) { this.toggleAttribute(attr, Boolean(on)); },
    configurable: true,
  });
}

for (const [prop, attr] of Object.entries(STRING_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this.getAttribute(attr) ?? ''; },
    set(value) { this.setAttribute(attr, value === null || value === undefined ? '' : String(value)); },
    configurable: true,
  });
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.activeElement = null;
    this.title = '';
  }

  get nodeType() {
    return 9;
  }

  get documentElement() {
    return this.childNodes.find((c) => c instanceof FakeElement) || null;
  }

  get head() {
    return this.querySelector('head');
  }

  get body() {
    return this.querySelector('body');
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(text) {
    return new FakeText(this, text);
  }

  createDocumentFragment() {
    const frag = new FakeFragment(this);
    return frag;
  }

  getElementById(id) {
    const want = String(id);
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (!(c instanceof FakeElement)) continue;
        if (c.getAttribute('id') === want) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
}

// ------------------------------------------------------------------ selectors

function splitTopLevel(text, sep) {
  const out = [];
  let quote = '';
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
    } else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const COMPOUND_PART = [
  [/^\*/, () => ({ kind: 'any' })],
  [/^[a-zA-Z][\w-]*/, (m) => ({ kind: 'tag', name: m[0].toLowerCase() })],
  [/^#([\w-]+)/, (m) => ({ kind: 'id', value: m[1] })],
  [/^\.([\w-]+)/, (m) => ({ kind: 'class', value: m[1] })],
  [/^\[\s*([\w:-]+)\s*\]/, (m) => ({ kind: 'attr', name: m[1].toLowerCase(), value: null })],
  [/^\[\s*([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*\]/,
    (m) => ({ kind: 'attr', name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] })],
];

function parseCompound(text, whole) {
  const parts = [];
  let rest = text;
  while (rest) {
    let matched = false;
    for (const [re, build] of COMPOUND_PART) {
      const m = re.exec(rest);
      if (!m) continue;
      if ((parts.length > 0) && (build(m).kind === 'tag' || build(m).kind === 'any')) break;
      parts.push(build(m));
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
    if (!matched) throw new SyntaxError(`shim: unsupported selector "${whole}" (at "${rest}")`);
  }
  return parts;
}

// parseSelector returns a list (one per comma) of complex selectors, each an
// array of { parts, combinator } read left to right; combinator is how this
// compound relates to the one before it (' ' or '>').
function parseSelector(selector) {
  const whole = String(selector);
  return splitTopLevel(whole, ',').map((group) => {
    const text = group.trim();
    if (!text) throw new SyntaxError(`shim: empty selector in "${whole}"`);
    const complex = [];
    let i = 0;
    let combinator = null;
    while (i < text.length) {
      let sawSpace = false;
      while (i < text.length && /\s/.test(text[i])) {
        sawSpace = true;
        i += 1;
      }
      if (text[i] === '>') {
        combinator = '>';
        i += 1;
        continue;
      }
      if (i >= text.length) break;
      if (sawSpace && complex.length && !combinator) combinator = ' ';
      let j = i;
      let quote = '';
      let depth = 0;
      while (j < text.length) {
        const ch = text[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (depth === 0 && (/\s/.test(ch) || ch === '>')) break;
        j += 1;
      }
      if (complex.length && !combinator) throw new SyntaxError(`shim: unsupported selector "${whole}"`);
      complex.push({ parts: parseCompound(text.slice(i, j), whole), combinator: complex.length ? combinator : null });
      combinator = null;
      i = j;
    }
    if (combinator || complex.length === 0) throw new SyntaxError(`shim: unsupported selector "${whole}"`);
    return complex;
  });
}

function matchesCompound(el, parts) {
  return parts.every((p) => {
    switch (p.kind) {
      case 'any': return true;
      case 'tag': return el.localName === p.name;
      case 'id': return el.getAttribute('id') === p.value;
      case 'class': return el.classList.contains(p.value);
      case 'attr': return p.value === null ? el.hasAttribute(p.name) : el.getAttribute(p.name) === p.value;
      default: return false;
    }
  });
}

function matchesComplex(el, complex, i) {
  if (!(el instanceof FakeElement) || !matchesCompound(el, complex[i].parts)) return false;
  if (i === 0) return true;
  const comb = complex[i].combinator;
  if (comb === '>') return matchesComplex(el.parentNode, complex, i - 1);
  for (let n = el.parentNode; n instanceof FakeElement; n = n.parentNode) {
    if (matchesComplex(n, complex, i - 1)) return true;
  }
  return false;
}

function queryAll(root, selector) {
  const groups = parseSelector(selector);
  const out = [];
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (!(c instanceof FakeElement)) continue;
      if (groups.some((complex) => matchesComplex(c, complex, complex.length - 1))) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

// ------------------------------------------------------------------ HTML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', times: '×', middot: '·', rarr: '→', larr: '←', uarr: '↑', darr: '↓', copy: '©' };

function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// parseHTML is a tolerant tokenizer for well-formed pages like index.html:
// elements, attributes, text, comments, void and raw-text elements. An end tag
// closes the nearest open element of its name; a stray one is ignored.
function parseHTML(doc, html) {
  const stack = [doc];
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|[^<]+|</gy;
  const attr = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while (token.lastIndex < html.length && (m = token.exec(html))) {
    const top = stack[stack.length - 1];
    const [whole, endName, startName, attrText, selfClose] = m;
    if (whole.startsWith('<!')) continue;
    if (endName) {
      const name = endName.toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].localName === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (startName) {
      const el = doc.createElement(startName);
      for (const a of attrText.matchAll(attr)) el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
      top.appendChild(el);
      if (RAW_TEXT_TAGS.has(el.localName)) {
        const close = html.toLowerCase().indexOf(`</${el.localName}`, token.lastIndex);
        const end = close < 0 ? html.length : close;
        const text = html.slice(token.lastIndex, end);
        if (text) el.appendChild(doc.createTextNode(el.localName === 'textarea' || el.localName === 'title' ? decodeEntities(text) : text));
        token.lastIndex = end;
        continue;
      }
      if (!VOID_TAGS.has(el.localName) && !selfClose) stack.push(el);
      continue;
    }
    top.appendChild(doc.createTextNode(decodeEntities(whole)));
  }
  return doc;
}

function freshDocument() {
  const doc = parseHTML(new FakeDocument(), readFileSync(INDEX_HTML, 'utf8'));
  const title = doc.querySelector('title');
  doc.title = title ? title.textContent : '';
  doc.activeElement = doc.body;
  return doc;
}

// ------------------------------------------------------------------ storage

const storageErrors = {
  getItem: () => new DOMException('The operation is insecure.', 'SecurityError'),
  setItem: () => new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
  removeItem: () => new DOMException('The operation is insecure.', 'SecurityError'),
  clear: () => new DOMException('The operation is insecure.', 'SecurityError'),
  key: () => new DOMException('The operation is insecure.', 'SecurityError'),
};

export class FakeStorage {
  #items = new Map();
  #failures = new Map();

  get length() {
    return this.#items.size;
  }

  key(i) {
    this.#maybeThrow('key');
    return [...this.#items.keys()][i] ?? null;
  }

  getItem(key) {
    this.#maybeThrow('getItem');
    const v = this.#items.get(String(key));
    return v === undefined ? null : v;
  }

  setItem(key, value) {
    this.#maybeThrow('setItem');
    this.#items.set(String(key), String(value));
  }

  removeItem(key) {
    this.#maybeThrow('removeItem');
    this.#items.delete(String(key));
  }

  clear() {
    this.#maybeThrow('clear');
    this.#items.clear();
  }

  // failOn makes one method throw until heal(). With no error given it throws
  // what a browser throws: QuotaExceededError for a full store on setItem,
  // SecurityError for storage disabled on everything else.
  failOn(method, error) {
    if (!(method in storageErrors)) throw new Error(`shim: storage has no ${method}`);
    this.#failures.set(method, error === undefined ? storageErrors[method] : () => error);
  }

  heal(method) {
    if (method === undefined) this.#failures.clear();
    else this.#failures.delete(method);
  }

  // snapshot and peek read the backing map without going through the failure
  // switches, so a test can inspect what was stored while a method is broken.
  snapshot() {
    return Object.fromEntries(this.#items);
  }

  peek(key) {
    const v = this.#items.get(String(key));
    return v === undefined ? null : v;
  }

  // writeFromAnotherTab changes the store as another tab of the same origin
  // would, which is the only case a browser fires a storage event here: a
  // write from this tab never does. newValue null removes the key.
  writeFromAnotherTab(key, newValue) {
    const k = String(key);
    const oldValue = this.peek(k);
    if (newValue === null) this.#items.delete(k);
    else this.#items.set(k, String(newValue));
    const event = new StorageEvent('storage', {
      key: k,
      oldValue,
      newValue: newValue === null ? null : String(newValue),
      storageArea: this,
      url: globalThis.location.href,
    });
    return dispatch(globalThis, event);
  }

  reset() {
    this.#items.clear();
    this.#failures.clear();
  }

  #maybeThrow(method) {
    const make = this.#failures.get(method);
    if (make) throw make();
  }
}

// ------------------------------------------------------------------ fetch

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function headersObject(h) {
  if (!h) return {};
  return Object.fromEntries(new Headers(h).entries());
}

function buildResponse(spec = {}) {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers || {});
  let body = spec.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    body = JSON.stringify(body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  if ([101, 204, 205, 304].includes(status)) body = null;
  return new Response(body ?? null, { status, statusText: spec.statusText ?? '', headers });
}

// FetchStub is the scriptable fetch. Routes are keyed by URL (exactly as the
// module passes it) and optionally by method; each scripted answer is used
// `times` times (default once) in the order it was scripted.
export class FetchStub {
  calls = [];
  unmatched = [];
  #routes = [];

  respond(url, spec = {}, { method, times = 1 } = {}) {
    this.#routes.push({ url, method: method && method.toUpperCase(), times, answer: () => Promise.resolve(buildResponse(spec)) });
    return this;
  }

  reject(url, error = new TypeError('Failed to fetch'), { method, times = 1 } = {}) {
    this.#routes.push({ url, method: method && method.toUpperCase(), times, answer: () => Promise.reject(error) });
    return this;
  }

  // defer scripts one answer the test settles later; `requested` turns true
  // once the module has actually called fetch for it.
  defer(url, { method } = {}) {
    const handle = { requested: false };
    let settle;
    const pending = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    handle.resolve = (spec) => settle.resolve(buildResponse(spec));
    handle.reject = (error = new TypeError('Failed to fetch')) => settle.reject(error);
    this.#routes.push({
      url,
      method: method && method.toUpperCase(),
      times: 1,
      answer: () => {
        handle.requested = true;
        return pending;
      },
    });
    return handle;
  }

  pending() {
    return this.#routes.map((r) => `${r.method || '*'} ${r.url}`);
  }

  fetch = (input, init = {}) => {
    const url = urlOf(input);
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    const body = init.body === undefined ? null : init.body;
    const call = {
      url,
      method,
      headers: headersObject(init.headers),
      body,
      json() {
        return JSON.parse(body);
      },
    };
    this.calls.push(call);
    const i = this.#routes.findIndex((r) => r.url === url && (!r.method || r.method === method));
    if (i < 0) {
      this.unmatched.push(call);
      return Promise.reject(new TypeError(`shim fetch: nothing scripted for ${method} ${url}`));
    }
    const route = this.#routes[i];
    route.times -= 1;
    if (route.times <= 0) this.#routes.splice(i, 1);
    return route.answer();
  };

  reset() {
    this.calls.length = 0;
    this.unmatched.length = 0;
    this.#routes.length = 0;
  }
}

// ------------------------------------------------------------------ EventSource

export const eventSources = {
  instances: [],
  opened: 0,
  closed: 0,
  latest() {
    return this.instances[this.instances.length - 1] || null;
  },
  live() {
    return this.instances.filter((s) => s.readyState !== FakeEventSource.CLOSED);
  },
  reset() {
    this.instances.length = 0;
    this.opened = 0;
    this.closed = 0;
  },
};

export class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url, init = {}) {
    this.url = new URL(String(url), globalThis.location.href).href;
    this.withCredentials = Boolean(init.withCredentials);
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    eventSources.instances.push(this);
    eventSources.opened += 1;
  }

  addEventListener(type, fn, options) {
    addListener(this, type, fn, options);
  }

  removeEventListener(type, fn, options) {
    removeListener(this, type, fn, options);
  }

  dispatchEvent(event) {
    const handler = this[`on${event.type}`];
    const ok = dispatch(this, event);
    if (typeof handler === 'function') {
      Object.defineProperty(event, 'currentTarget', { value: this, configurable: true });
      try {
        handler.call(this, event);
      } catch (err) {
        reportError(err);
      }
    }
    return ok;
  }

  close() {
    if (this.readyState === FakeEventSource.CLOSED) return;
    this.readyState = FakeEventSource.CLOSED;
    eventSources.closed += 1;
  }

  // ---- test controls

  open() {
    if (this.readyState === FakeEventSource.CLOSED) return false;
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
    return true;
  }

  // emit delivers one frame. A named type reaches only that type's
  // listeners; 'message' also reaches onmessage, exactly as a browser splits
  // them. A closed source delivers nothing. Objects are sent as JSON text.
  emit(type, data, { lastEventId = '' } = {}) {
    if (this.readyState === FakeEventSource.CLOSED) return false;
    this.readyState = FakeEventSource.OPEN;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    this.dispatchEvent(new MessageEvent(type, { data: text, lastEventId: String(lastEventId), origin: new URL(this.url).origin }));
    return true;
  }

  // fail fires the bare error a browser fires. A fatal failure leaves the
  // source CLOSED (the browser gave up); otherwise it is CONNECTING again
  // (the browser will retry on its own).
  fail({ fatal = false } = {}) {
    if (this.readyState === FakeEventSource.CLOSED) return false;
    this.readyState = fatal ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
    return true;
  }
}

// ------------------------------------------------------------------ window

class MediaQueryList {
  constructor(query) {
    this.media = query;
    this.onchange = null;
  }

  get matches() {
    return Boolean(media.matching.get(this.media));
  }

  addEventListener(type, fn, options) {
    addListener(this, type, fn, options);
  }

  removeEventListener(type, fn, options) {
    removeListener(this, type, fn, options);
  }

  addListener(fn) {
    addListener(this, 'change', fn);
  }

  removeListener(fn) {
    removeListener(this, 'change', fn);
  }

  dispatchEvent(event) {
    const ok = dispatch(this, event);
    if (typeof this.onchange === 'function') this.onchange(event);
    return ok;
  }
}

// media scripts matchMedia: set(query, true) makes every list for that exact
// query string match and fires change on the ones whose answer moved.
export const media = {
  matching: new Map(),
  lists: [],
  set(query, matches) {
    const was = Boolean(this.matching.get(query));
    this.matching.set(query, Boolean(matches));
    if (was === Boolean(matches)) return;
    for (const list of this.lists.filter((l) => l.media === query)) {
      const event = new Event('change');
      event.matches = Boolean(matches);
      event.media = query;
      list.dispatchEvent(event);
    }
  },
  reset() {
    this.matching.clear();
    this.lists.length = 0;
  },
};

function matchMedia(query) {
  const list = new MediaQueryList(String(query));
  media.lists.push(list);
  return list;
}

// location fires hashchange synchronously when the hash moves. A browser
// queues it as a task; tests read the effect right after the assignment.
function makeLocation() {
  let url = new URL(BASE_URL);
  const loc = {
    reloads: 0,
    get href() { return url.href; },
    set href(next) { navigate(new URL(String(next), url)); },
    get origin() { return url.origin; },
    get protocol() { return url.protocol; },
    get host() { return url.host; },
    get hostname() { return url.hostname; },
    get port() { return url.port; },
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get hash() { return url.hash; },
    set hash(h) {
      const next = new URL(url.href);
      const text = String(h);
      next.hash = text.startsWith('#') ? text.slice(1) : text;
      navigate(next);
    },
    assign(next) { this.href = next; },
    replace(next) { this.href = next; },
    reload() { this.reloads += 1; },
    toString() { return url.href; },
  };
  function navigate(next) {
    const old = url;
    const sameDocument = old.origin === next.origin && old.pathname === next.pathname && old.search === next.search;
    url = next;
    if (sameDocument && old.hash !== next.hash) {
      dispatch(globalThis, new HashChangeEvent('hashchange', { oldURL: old.href, newURL: next.href }));
    }
  }
  return loc;
}

export const clipboard = {
  texts: [],
  refuse: null,
  async writeText(text) {
    if (this.refuse) throw this.refuse;
    this.texts.push(String(text));
  },
  reset() {
    this.texts.length = 0;
    this.refuse = null;
  },
};

// ------------------------------------------------------------------ install

export const localStorage = new FakeStorage();
export const sessionStorage = new FakeStorage();
export const fetchStub = new FetchStub();

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
}

// resetBrowser gives the next test a fresh page: a newly parsed document, empty
// storage with no failures armed, no scripted fetches, no event sources, no
// window listeners, no media matches, and the location back at the root.
export function resetBrowser() {
  listenerStore.delete(globalThis);
  define('document', freshDocument());
  define('location', makeLocation());
  localStorage.reset();
  sessionStorage.reset();
  fetchStub.reset();
  eventSources.reset();
  media.reset();
  clipboard.reset();
  listenerErrors.length = 0;
}

define('window', globalThis);
define('addEventListener', (type, fn, options) => addListener(globalThis, type, fn, options));
define('removeEventListener', (type, fn, options) => removeListener(globalThis, type, fn, options));
define('dispatchEvent', (event) => dispatch(globalThis, event));
define('matchMedia', matchMedia);
define('localStorage', localStorage);
define('sessionStorage', sessionStorage);
define('fetch', fetchStub.fetch);
define('EventSource', FakeEventSource);
define('UIEvent', UIEvent);
define('MouseEvent', MouseEvent);
define('KeyboardEvent', KeyboardEvent);
define('FocusEvent', FocusEvent);
define('StorageEvent', StorageEvent);
define('HashChangeEvent', HashChangeEvent);
define('Node', FakeNode);
define('Element', FakeElement);
define('HTMLElement', FakeElement);
Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboard, configurable: true });
resetBrowser();

// ------------------------------------------------------------------ helpers

// keydown dispatches a cancelable, bubbling keydown and returns the event, so
// a test can read defaultPrevented.
export function keydown(target, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

// typeInto sets a control's value the way typing does and fires input.
export function typeInto(target, value) {
  target.value = value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

// flush lets queued promise callbacks (awaited fetches, response bodies) run.
// It uses setImmediate, which node:test mock timers leave alone unless a test
// asks for it.
export async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
