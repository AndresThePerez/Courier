// dom.js — the tiny DOM helpers every render module shares.
//
// There is exactly one rule here and it is a security rule: text goes in
// through textContent, never inner-HTML. Every string this page renders is
// either a visitor's own input or a response body from the target, so an
// inner-HTML assignment anywhere is a stored-XSS hole with a curated collection as the
// delivery mechanism.

export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.id) node.id = opts.id;
  if (opts.text !== undefined) node.textContent = String(opts.text);
  if (opts.title) node.title = opts.title;
  if (opts.type) node.type = opts.type;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === false || v === null || v === undefined) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (opts.on) {
    for (const [event, fn] of Object.entries(opts.on)) node.addEventListener(event, fn);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node, children) {
  clear(node);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child);
  }
}

export function byId(id) {
  return document.getElementById(id);
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${Number(ms).toFixed(ms < 10 ? 2 : 1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString();
}
