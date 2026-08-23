// json-view.js — the collapsible JSON tree every response body is shown in.
//
// Hand-rolled on purpose: no dependency, no build step, and every piece of
// target output enters the DOM through textContent, which is dom.js's one rule
// and the reason this file never assembles a string of markup. Folding is
// native <details>/<summary>, so there is no open/closed state to keep in sync
// and the keyboard and screen-reader behaviour is the platform's rather than a
// worse re-implementation of it.

import { el, replace } from './dom.js';

// A container longer than this starts folded, below the root: a search body
// carrying 24 results should open showing its shape, not three thousand lines.
const FoldAt = 8;
// Nothing nested deeper than this starts open either, however short it is.
const OpenDepth = 2;

// jsonView renders a body as a Tree/Raw toggle plus Copy, and returns the whole
// widget. A body that is not JSON — including one Courier truncated, which is
// perfectly good text and invalid JSON — gets the raw <pre> and no toggle,
// because there is no tree to show and a parse error about our own cut would be
// a lie about the target.
export function jsonView(text, { truncated = false } = {}) {
  const wrap = el('div', { class: 'jsonview' });

  // An empty body is a fact about the response, not a document to explore.
  if (!text) {
    wrap.appendChild(el('pre', { class: 'body-pre mono', text: '(empty body)' }));
    return wrap;
  }

  let data;
  let parsed = false;
  try {
    data = JSON.parse(text);
    parsed = true;
  } catch {
    /* raw it is */
  }

  const copy = copyButton(text);
  const content = el('div', { class: 'jsonview-content' });

  // Both views are built at most once and then swapped in and out, so a trip
  // through Raw and back does not silently re-fold everything the visitor had
  // opened.
  let rawNode = null;
  let treeNode = null;
  const showRaw = () => {
    if (!rawNode) {
      rawNode = el('pre', { class: 'body-pre mono' });
      rawNode.textContent = parsed ? JSON.stringify(data, null, 2) : text;
    }
    replace(content, [rawNode]);
  };
  const showTree = () => {
    if (!treeNode) treeNode = el('div', { class: 'body-pre mono jv-tree' }, [node(null, data, 0)]);
    replace(content, [treeNode]);
  };

  if (!parsed) {
    wrap.appendChild(el('div', { class: 'jsonview-bar' }, [
      el('span', {
        class: 'note',
        text: truncated
          ? 'Cut mid-body, so it no longer parses as JSON - showing the raw text.'
          : 'Not JSON - showing the raw text.',
      }),
      copy,
    ]));
    showRaw();
    wrap.appendChild(content);
    return wrap;
  }

  const treeBtn = el('button', {
    class: 'btn btn-mini is-on', type: 'button', text: 'Tree',
    attrs: { 'aria-pressed': 'true' },
  });
  const rawBtn = el('button', {
    class: 'btn btn-mini', type: 'button', text: 'Raw',
    attrs: { 'aria-pressed': 'false' },
  });
  const pick = (tree) => {
    treeBtn.classList.toggle('is-on', tree);
    rawBtn.classList.toggle('is-on', !tree);
    treeBtn.setAttribute('aria-pressed', tree ? 'true' : 'false');
    rawBtn.setAttribute('aria-pressed', tree ? 'false' : 'true');
    if (tree) showTree();
    else showRaw();
  };
  treeBtn.addEventListener('click', () => pick(true));
  rawBtn.addEventListener('click', () => pick(false));

  wrap.appendChild(el('div', { class: 'jsonview-bar' }, [treeBtn, rawBtn, copy]));
  showTree();
  wrap.appendChild(content);
  return wrap;
}

// copyButton hands over the body exactly as it arrived, not the re-indented
// version: what lands on the clipboard should be what the target sent.
function copyButton(text) {
  let revert = 0;
  const btn = el('button', {
    class: 'btn btn-mini jv-copy',
    type: 'button',
    text: 'Copy',
    attrs: { 'aria-label': 'Copy the response body' },
    on: {
      click: async () => {
        // navigator.clipboard is absent outside a secure context and refusable
        // inside one. Both outcomes are a word on the button for a moment —
        // never a dialog, and never a silent no-op.
        let label = 'Copied';
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          label = 'Copy blocked';
        }
        btn.textContent = label;
        clearTimeout(revert);
        revert = setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      },
    },
  });
  return btn;
}

// node renders one key/value pair. key is null only at the root, which is the
// one value on the page that has no name.
function node(key, value, depth) {
  if (Array.isArray(value)) {
    return container(key, value, depth, '[', ']', `${value.length} item${value.length === 1 ? '' : 's'}`);
  }
  if (value !== null && typeof value === 'object') {
    const n = Object.keys(value).length;
    return container(key, value, depth, '{', '}', `${n} ${n === 1 ? 'key' : 'keys'}`);
  }
  return el('div', { class: 'jv-row' }, [keySpan(key), leaf(value)]);
}

function container(key, value, depth, open, close, count) {
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;

  // An empty container is a leaf: there is nothing behind the triangle.
  if (size === 0) {
    return el('div', { class: 'jv-row' }, [keySpan(key), el('span', { class: 'jv-punct', text: open + close })]);
  }

  const kids = el('div', { class: 'jv-children' });
  const det = el('details', { class: 'jv-node' }, [
    el('summary', { class: 'jv-summary' }, [
      keySpan(key),
      el('span', { class: 'jv-punct', text: open }),
      el('span', { class: 'jv-count', text: ` ${count} ` }),
      el('span', { class: 'jv-punct', text: close }),
    ]),
    kids,
  ]);

  // Children are built the first time a node opens, not when it is created. A
  // whole 256KB body is now the ordinary case rather than the cap, and walking
  // all of it up front would put tens of thousands of elements in the document
  // to display the dozen lines that are actually unfolded.
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    replace(kids, children(value, depth + 1));
  };
  det.addEventListener('toggle', () => { if (det.open) build(); });

  if (opensAt(depth, size)) {
    det.open = true;
    build();
  }
  return det;
}

// opensAt: the root is always open — it is the body itself — and below it a
// container has to be both short and shallow to start that way.
function opensAt(depth, size) {
  if (depth === 0) return true;
  return depth < OpenDepth && size <= FoldAt;
}

function children(value, depth) {
  return Array.isArray(value)
    ? value.map((v, i) => node(String(i), v, depth))
    : Object.entries(value).map(([k, v]) => node(k, v, depth));
}

function keySpan(key) {
  if (key === null) return null;
  return el('span', { class: 'jv-key', text: `${key}: ` });
}

// leaf covers everything JSON.parse can hand back that is not a container.
// Strings go through JSON.stringify so they arrive quoted and escaped — a value
// containing a newline or a quote reads as one value, not as a broken line.
function leaf(value) {
  if (typeof value === 'string') return el('span', { class: 'jv-str', text: JSON.stringify(value) });
  if (typeof value === 'number') return el('span', { class: 'jv-num', text: String(value) });
  if (typeof value === 'boolean') return el('span', { class: 'jv-bool', text: String(value) });
  return el('span', { class: 'jv-null', text: 'null' });
}
