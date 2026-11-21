import assert from 'node:assert/strict';
import test from 'node:test';
import { installExclusivePlayback } from '../src/exclusivePlayback';

function fakeMedia(paused: boolean) {
  return { paused, pauseCalls: 0, pause() { this.paused = true; this.pauseCalls++; } };
}

function fakeRoot(media: ReturnType<typeof fakeMedia>[]) {
  const listeners: { listener: (event: { target: unknown }) => void; capture: boolean }[] = [];
  return {
    listeners,
    addEventListener: (_type: 'play', listener: (event: { target: unknown }) => void, capture: boolean) => { listeners.push({ listener, capture }); },
    removeEventListener: (_type: 'play', listener: (event: { target: unknown }) => void) => {
      listeners.splice(listeners.findIndex(entry => entry.listener === listener), 1);
    },
    querySelectorAll: (selectors: string) => { assert.equal(selectors, 'audio, video'); return media; },
    play(target: unknown) { for (const entry of listeners) entry.listener({ target }); },
  };
}

test('starting playback pauses every other playing media element', () => {
  const current = fakeMedia(false);
  const other = fakeMedia(false);
  const idle = fakeMedia(true);
  const next = fakeMedia(false);
  const root = fakeRoot([current, other, idle, next]);
  installExclusivePlayback(root);
  assert.equal(root.listeners[0].capture, true);

  root.play(next);

  assert.equal(current.paused, true);
  assert.equal(other.paused, true);
  assert.equal(idle.pauseCalls, 0);
  assert.equal(next.paused, false);
  assert.equal(next.pauseCalls, 0);
});

test('uninstall stops pausing other media', () => {
  const current = fakeMedia(false);
  const next = fakeMedia(false);
  const root = fakeRoot([current, next]);
  installExclusivePlayback(root)();

  root.play(next);

  assert.equal(current.paused, false);
});
