// storage.js — reading, writing and following one localStorage key, for any
// module that keeps visitor data in this browser.
//
// Every call here answers instead of throwing. A browser can refuse storage at
// any of these points (disabled storage throws on the localStorage getter
// itself, a full one throws on setItem, a privacy mode on getItem), and a page
// whose saved data cannot be read or written must still work.
//
// The storage is passed in, either as the object or as a function returning
// it, so tests can run two "tabs" over one fake storage and the page can defer
// touching window.localStorage until it is actually needed.

function resolve(storage) {
  return typeof storage === 'function' ? storage() : storage;
}

// read returns { ok: true, value } with the raw string (null when the key is
// absent) or { ok: false, error } when the browser refused the read.
export function read(storage, key) {
  try {
    return { ok: true, value: resolve(storage).getItem(key) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function write(storage, key, value) {
  try {
    resolve(storage).setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function remove(storage, key) {
  try {
    resolve(storage).removeItem(key);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// parseJSON never throws: anything that is not JSON reads as null, the same as
// an absent key.
export function parseJSON(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// update is the only safe way for two tabs to share a key: it re-reads the
// value as it is now and writes fn(current) in the same synchronous turn, so a
// tab never writes back a copy it loaded minutes ago over another tab's
// changes. localStorage has no compare-and-set; nothing else on this page can
// run between the read and the write, which is as strong as synchronous
// storage allows.
//
// When the read is refused nothing is written: merging into a value we could
// not see would overwrite whatever another tab stored. fn returning undefined
// writes nothing. The result says which step failed:
// { ok, read: { ok, value }, value?, error? }.
export function update(storage, key, fn) {
  const current = read(storage, key);
  if (!current.ok) return { ok: false, read: current, error: current.error };
  const next = fn(current.value);
  if (next === undefined) return { ok: true, read: current, value: current.value };
  const written = write(storage, key, next);
  return { ok: written.ok, read: current, value: next, error: written.error };
}

// subscribe calls fn(value, { current }) whenever another tab changes key. A
// browser fires `storage` only in the other tabs, never in the one that wrote.
// A clear() elsewhere arrives with key null and counts as the key removed;
// events for another storage area (sessionStorage) are ignored.
//
// The event is queued after the shared value has changed, and this page may
// have written in between, so its newValue can be older than what is stored.
// The value handed on is therefore the key as stored now; newValue stands in
// only when the browser refuses the read, and then current is false so the
// caller knows the value may be stale.
export function subscribe(target, storage, key, fn) {
  const onStorage = (event) => {
    if (event.key !== key && event.key !== null) return;
    if (event.storageArea) {
      let area = null;
      try {
        area = resolve(storage);
      } catch {
        return;
      }
      if (event.storageArea !== area) return;
    }
    const now = read(storage, key);
    if (now.ok) fn(now.value, { current: true });
    else fn(event.key === null ? null : event.newValue ?? null, { current: false });
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}
