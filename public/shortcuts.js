/* Centralised keyboard shortcut manager.
 *
 * One keydown listener for the whole app (installed with attach(), removed with detach(); both idempotent).
 * Bindings declare their keys, group and help text, plus an `enabled()` predicate: the help dialog is generated from the
 * bindings that are enabled, so it can never advertise a shortcut the current player does not support.
 *
 * Ownership rules, in order:
 *  1. Already-handled events (defaultPrevented) and IME composition are ignored.
 *  2. Text-editing targets (input/textarea/select/contenteditable) only receive bindings flagged `inText`.
 *  3. While a modal <dialog> is open only bindings flagged `inModal` run.
 *  4. Native controls keep their own keys: Space/Enter on buttons and links, arrows on range sliders and tabs.
 *  5. Ctrl/Cmd/Alt combos are left to the browser unless a binding explicitly asks for `mod`.
 */
(function (root) {
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', 'date', 'time', '']);
  const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

  function isTextTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((t.getAttribute('type') || '').toLowerCase());
    return false;
  }

  function nativeOwnsKey(t, key) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    const role = t.getAttribute && t.getAttribute('role');
    if ((key === ' ' || key === 'Enter') && (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || role === 'button' || role === 'tab' || role === 'switch')) return true;
    if (tag === 'INPUT' && /^(range|checkbox|radio)$/i.test(t.getAttribute('type') || '') && (ARROWS.has(key) || key === ' ')) return true;
    if (role === 'tab' && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End')) return true;
    return false;
  }

  class ShortcutManager {
    constructor({ isModalOpen = () => false } = {}) {
      this.bindings = [];
      this.isModalOpen = isModalOpen;
      this.ctrl = null;
      this.onKey = this.onKey.bind(this);
    }

    /** binding: { id, group, label, hint: ['Space','K'], keys: [{key, shift?, mod?}], enabled?, noRepeat?, inText?, inModal?, run } */
    add(b) { this.bindings.push({ enabled: () => true, ...b }); return this; }

    attach() {
      if (this.ctrl) return;
      this.ctrl = new AbortController();
      document.addEventListener('keydown', this.onKey, { signal: this.ctrl.signal });
    }
    detach() { if (this.ctrl) { this.ctrl.abort(); this.ctrl = null; } }
    get attached() { return !!this.ctrl; }

    /** Help content: only bindings that are currently supported. */
    help() {
      const groups = new Map();
      for (const b of this.bindings) {
        if (!b.label || !(b.supported ? b.supported() : b.enabled())) continue;
        if (!groups.has(b.group)) groups.set(b.group, []);
        groups.get(b.group).push(b);
      }
      return groups;
    }

    static normalize(e) {
      // Shift + the physical Slash key is '?' on US-style layouts even when a synthetic/remote event reports key '/'.
      // Layouts where '/' needs Shift use a different physical key, so they are unaffected.
      let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (e.code === 'Slash' && e.shiftKey) key = '?';
      return { key, shift: e.shiftKey, mod: e.ctrlKey || e.metaKey, alt: e.altKey };
    }

    static matches(k, spec) {
      if (k.key !== spec.key) return false;
      if (!!spec.mod !== k.mod) return false;
      if (k.alt) return false;
      if (spec.shift !== undefined && spec.shift !== k.shift) return false;
      return true;
    }

    onKey(e) {
      if (e.defaultPrevented || e.isComposing || e.key === 'Process' || e.key === 'Dead') return;
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      const t = e.target;
      const k = ShortcutManager.normalize(e);
      const typing = isTextTarget(t);
      const modal = this.isModalOpen();
      if (!typing && nativeOwnsKey(t, e.key)) return;
      for (const b of this.bindings) {
        if (!b.keys.some((spec) => ShortcutManager.matches(k, spec))) continue;
        if (typing && !b.inText) continue;
        if (modal && !b.inModal) continue;
        if (b.noRepeat && e.repeat) { e.preventDefault(); return; }
        if (!b.enabled()) continue;
        const handled = b.run(e);
        if (handled !== false) e.preventDefault();
        return;
      }
    }
  }

  root.ShortcutManager = ShortcutManager;
})(window);
