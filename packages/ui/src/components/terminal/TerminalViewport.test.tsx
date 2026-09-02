import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { TerminalChunk } from '@/stores/useTerminalStore';

const terminalEvents: Array<{ type: 'write'; data: string } | { type: 'reset' }> = [];

class GhosttyTerminalDouble {
  public options: { cursorBlink: boolean };
  public cols = 80;
  public rows = 24;

  constructor(options: { cursorBlink?: boolean }) {
    this.options = { cursorBlink: options.cursorBlink ?? false };
  }

  loadAddon() {}
  open() {}
  onData() {
    return { dispose() {} };
  }
  write(data: string, callback?: () => void) {
    terminalEvents.push({ type: 'write', data });
    callback?.();
  }
  reset() {
    terminalEvents.push({ type: 'reset' });
  }
  focus() {}
  dispose() {}
}

class FitAddonDouble {
  fit() {}
}

mock.module('ghostty-web', () => ({
  Ghostty: { load: async () => ({}) },
  Terminal: GhosttyTerminalDouble,
  FitAddon: FitAddonDouble,
}));

const { TerminalViewport } = await import('./TerminalViewport');

const theme = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: '#334155',
  selectionForeground: '#ffffff',
  black: '#111111',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#ffffff',
  brightBlack: '#666666',
  brightRed: '#ff0000',
  brightGreen: '#00ff00',
  brightYellow: '#ffff00',
  brightBlue: '#0000ff',
  brightMagenta: '#ff00ff',
  brightCyan: '#00ffff',
  brightWhite: '#ffffff',
} as const;

const flushGhosttyLoad = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderViewport = (root: Root, chunks: TerminalChunk[]) => act(async () => {
  root.render(
    <TerminalViewport
      sessionKey="session-1"
      chunks={chunks}
      onInput={() => undefined}
      onResize={() => undefined}
      theme={theme}
      fontFamily="Geist Mono"
      fontSize={14}
    />,
  );
});

describe('TerminalViewport chunk replay integration', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    terminalEvents.length = 0;
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      InputEvent: windowInstance.InputEvent,
      KeyboardEvent: windowInstance.KeyboardEvent,
      MouseEvent: windowInstance.MouseEvent,
      FocusEvent: windowInstance.FocusEvent,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.defineProperty(windowInstance.document, 'hasFocus', {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(windowInstance.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
      },
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  test('replays authoritative replacement history after a reset and resumes live-only appends', async () => {
    const initialChunks: TerminalChunk[] = [
      { id: 1, data: 'initial-live\n', replayData: 'initial-replay\n', byteLength: 13 },
    ];
    const appendedChunks: TerminalChunk[] = [
      ...initialChunks,
      { id: 2, data: 'append-live\n', replayData: 'append-replay\n', byteLength: 12 },
    ];
    const replacementChunks: TerminalChunk[] = [
      { id: 3, data: 'history-live\n', replayData: 'history-replay\n', byteLength: 13 },
    ];
    const resumedChunks: TerminalChunk[] = [
      ...replacementChunks,
      { id: 4, data: 'tail-live\n', replayData: 'tail-replay\n', byteLength: 10 },
    ];

    await renderViewport(root, initialChunks);
    await flushGhosttyLoad();
    terminalEvents.length = 0;

    await renderViewport(root, appendedChunks);
    expect(terminalEvents).toEqual([{ type: 'write', data: 'append-live\n' }]);

    terminalEvents.length = 0;
    await renderViewport(root, replacementChunks);
    expect(terminalEvents.some((event) => event.type === 'reset')).toBe(true);
    expect(terminalEvents.some((event) => event.type === 'write' && event.data === 'history-replay\n')).toBe(true);
    expect(terminalEvents.some((event) => event.type === 'write' && event.data === 'history-live\n')).toBe(false);

    terminalEvents.length = 0;
    await renderViewport(root, resumedChunks);
    expect(terminalEvents).toEqual([{ type: 'write', data: 'tail-live\n' }]);
  });
});
