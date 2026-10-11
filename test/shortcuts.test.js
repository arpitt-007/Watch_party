'use strict';
// Unit tests for the keyboard shortcut manager's ownership rules, with a minimal DOM stub (no browser needed).
const test = require('node:test');
const assert = require('node:assert');

let listener = null;
global.window = global;
global.document = { addEventListener(type, fn) { listener = fn; }, querySelector() { return null; } };
const ShortcutManager = require('../public/shortcuts.js') && global.ShortcutManager;

const el = (tag, attrs = {}, extra = {}) => ({ tagName: tag.toUpperCase(), getAttribute: (k) => attrs[k] || null, isContentEditable: false, ...extra });
const BODY = el('body');
function ev(key, o = {}) {
  return { key, code: o.code || '', shiftKey: !!o.shift, ctrlKey: !!o.ctrl, metaKey: !!o.meta, altKey: !!o.alt, repeat: !!o.repeat, isComposing: false, defaultPrevented: false, target: o.target || BODY, preventDefault() { this.defaultPrevented = true; } };
}
function build({ modal = false } = {}) {
  const calls = [];
  const sm = new ShortcutManager({ isModalOpen: () => modal });
  const rec = (id) => () => { calls.push(id); };
  sm.add({ id: 'play', group: 'Playback', label: 'Play', hint: [['Space'], ['K']], keys: [{ key: ' ' }, { key: 'k' }], noRepeat: true, run: rec('play') })
    .add({ id: 'l5', group: 'Playback', label: 'Back 5', hint: [['←']], keys: [{ key: 'ArrowLeft', shift: false }], run: rec('left5') })
    .add({ id: 'l10', group: 'Playback', label: 'Back 10', hint: [['Shift', '←'], ['J']], keys: [{ key: 'ArrowLeft', shift: true }, { key: 'j' }], run: rec('left10') })
    .add({ id: 'esc', group: 'Display', label: 'Esc', hint: [['Esc']], keys: [{ key: 'Escape' }], inText: true, inModal: true, run: rec('esc') })
    .add({ id: 'help', group: 'Display', label: 'Help', hint: [['?']], keys: [{ key: '?' }], inModal: true, run: rec('help') })
    .add({ id: 'send', group: 'Chat', label: 'Send', hint: [['Ctrl', 'Enter']], keys: [{ key: 'Enter', mod: true }], inText: true, run: rec('send') })
    .add({ id: 'ignore', group: 'Display', label: 'Declined', hint: [['X']], keys: [{ key: 'x' }], run: () => false })
    .add({ id: 'off', group: 'Display', label: 'Unsupported', hint: [['Z']], keys: [{ key: 'z' }], enabled: () => false, run: rec('off') });
  sm.attach();
  return { sm, calls, fire: (e) => { listener(e); return e; } };
}

test('letters match case-insensitively and Space/K both play; defaults are prevented only when handled', () => {
  const { calls, fire } = build();
  assert.ok(fire(ev('k')).defaultPrevented); fire(ev('K')); fire(ev(' '));
  assert.deepStrictEqual(calls, ['play', 'play', 'play']);
  assert.ok(!fire(ev('q')).defaultPrevented, 'unbound keys are untouched');
  assert.ok(!fire(ev('x')).defaultPrevented, 'a handler returning false leaves the default alone');
});

test('Shift distinguishes 5 s from 10 s seeks; J works too', () => {
  const { calls, fire } = build();
  fire(ev('ArrowLeft')); fire(ev('ArrowLeft', { shift: true })); fire(ev('j')); fire(ev('J', { shift: true }));
  assert.deepStrictEqual(calls, ['left5', 'left10', 'left10', 'left10']);
});

test('text fields own the keyboard, except bindings flagged inText', () => {
  const { calls, fire } = build();
  for (const t of [el('textarea'), el('input', { type: 'text' }), el('input'), el('input', { type: 'search' }), el('select'), el('div', {}, { isContentEditable: true })]) {
    assert.ok(!fire(ev('k', { target: t })).defaultPrevented);
    fire(ev('ArrowLeft', { target: t }));
  }
  assert.deepStrictEqual(calls, []);
  fire(ev('Enter', { ctrl: true, target: el('textarea') }));
  fire(ev('Enter', { meta: true, target: el('textarea') }));
  fire(ev('Escape', { target: el('textarea') }));
  assert.deepStrictEqual(calls, ['send', 'send', 'esc']);
});

test('modal dialogs own the keyboard except Escape and ?', () => {
  const { calls, fire } = build({ modal: true });
  fire(ev('k')); fire(ev(' ')); fire(ev('ArrowLeft'));
  fire(ev('?', { shift: true })); fire(ev('Escape'));
  assert.deepStrictEqual(calls, ['help', 'esc']);
});

test('native controls keep their keys (Space/Enter on buttons, arrows on sliders and tabs)', () => {
  const { calls, fire } = build();
  assert.ok(!fire(ev(' ', { target: el('button') })).defaultPrevented);
  assert.ok(!fire(ev(' ', { target: el('a') })).defaultPrevented);
  assert.ok(!fire(ev(' ', { target: el('div', { role: 'button' }) })).defaultPrevented);
  assert.ok(!fire(ev('ArrowLeft', { target: el('input', { type: 'range' }) })).defaultPrevented);
  assert.ok(!fire(ev('ArrowLeft', { target: el('button', { role: 'tab' }) })).defaultPrevented);
  assert.deepStrictEqual(calls, []);
  fire(ev('k', { target: el('button') })); // letters on a focused button are still shortcuts
  fire(ev('ArrowLeft', { target: el('div', { role: 'slider' }) })); // custom slider: keys reach the manager
  assert.deepStrictEqual(calls, ['play', 'left5']);
});

test('Ctrl/Cmd/Alt combos are left to the browser; repeats only for repeatable keys; disabled bindings are skipped', () => {
  const { calls, fire } = build();
  assert.ok(!fire(ev('k', { ctrl: true })).defaultPrevented); assert.ok(!fire(ev('k', { meta: true })).defaultPrevented);
  assert.ok(!fire(ev('ArrowLeft', { alt: true })).defaultPrevented);
  fire(ev('k', { repeat: true })); fire(ev('ArrowLeft', { repeat: true })); fire(ev('ArrowLeft', { repeat: true }));
  assert.deepStrictEqual(calls, ['left5', 'left5'], 'toggle ignores key repeat, seek accepts it');
  assert.ok(!fire(ev('z')).defaultPrevented); assert.deepStrictEqual(calls.includes('off'), false);
});

test('Shift+Slash is "?" (US layouts / remote events) and IME composition is ignored', () => {
  const { calls, fire } = build();
  fire(ev('/', { shift: true, code: 'Slash' }));
  assert.deepStrictEqual(calls, ['help']);
  const e = ev('k'); e.isComposing = true; fire(e);
  const d = ev('k'); d.defaultPrevented = true; fire(d); // already handled by someone else
  assert.deepStrictEqual(calls, ['help']);
});

test('attach/detach are idempotent and help() lists only supported bindings', () => {
  const { sm } = build();
  const before = listener; sm.attach(); assert.strictEqual(listener, before); assert.ok(sm.attached);
  sm.detach(); sm.detach(); assert.ok(!sm.attached);
  const labels = [...sm.help().values()].flat().map((b) => b.label);
  assert.ok(labels.includes('Play') && !labels.includes('Unsupported'));
  assert.deepStrictEqual([...sm.help().keys()], ['Playback', 'Display', 'Chat']);
});
