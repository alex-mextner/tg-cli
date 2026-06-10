import { expect, test } from 'bun:test';
import { parseControlConfig, resolveControlConfig } from '../features/tg-ctl/config';
import { DEFAULT_CONTROL } from '../features/tg-ctl/types';

// --- parseControlConfig: control: block parsing (hand-rolled, no yaml dep) ---

test('parseControlConfig reads a full control block with snake_case → camelCase mapping', () => {
  const yaml = [
    'features:',
    '  auto-attach: true',
    'control:',
    '  enabled: true',
    '  transport: tmux',
    '  session: agents',
    '  inject_wrap: "[TG from {name}] {msg}"',
    '  staleness_sec: 600',
    '  idle_exit_min: 15',
    '  allowed_senders: 111, 222',
    '',
  ].join('\n');
  expect(parseControlConfig(yaml)).toEqual({
    enabled: true,
    transport: 'tmux',
    session: 'agents',
    injectWrap: '[TG from {name}] {msg}',
    stalenessSec: 600,
    idleExitMin: 15,
    allowedSenders: [111, 222],
  });
});

test('parseControlConfig with missing block returns an empty partial', () => {
  expect(parseControlConfig('')).toEqual({});
  expect(parseControlConfig('features:\n  auto-attach: true\n')).toEqual({});
});

test('parseControlConfig tolerates blank lines and comments', () => {
  const yaml = 'control:\n\n  # gate inbound\n  enabled: yes  # inline comment\n';
  expect(parseControlConfig(yaml)).toEqual({ enabled: true });
});

test('parseControlConfig booleans use the feature-flags token sets', () => {
  for (const v of ['true', 'yes', 'on', '1']) {
    expect(parseControlConfig(`control:\n  enabled: ${v}\n`)).toEqual({ enabled: true });
  }
  for (const v of ['false', 'no', 'off', '0']) {
    expect(parseControlConfig(`control:\n  enabled: ${v}\n`)).toEqual({ enabled: false });
  }
  // unrecognized boolean value → ignore (don't guess)
  expect(parseControlConfig('control:\n  enabled: maybe\n')).toEqual({});
});

test('parseControlConfig strips surrounding quotes from string values', () => {
  const yaml = "control:\n  session: 'my session'\n  inject_wrap: \"{name}: {msg}\"\n";
  expect(parseControlConfig(yaml)).toEqual({
    session: 'my session',
    injectWrap: '{name}: {msg}',
  });
});

test('parseControlConfig ignores non-numeric int values', () => {
  expect(parseControlConfig('control:\n  staleness_sec: soon\n  idle_exit_min: 1h\n')).toEqual({});
  expect(parseControlConfig('control:\n  staleness_sec: -5\n')).toEqual({});
  expect(parseControlConfig('control:\n  idle_exit_min: 4.5\n')).toEqual({});
});

test('parseControlConfig allowed_senders keeps ints, drops non-numeric entries', () => {
  expect(parseControlConfig('control:\n  allowed_senders: 1, x, 2,, -3\n')).toEqual({
    allowedSenders: [1, 2],
  });
  expect(parseControlConfig('control:\n  allowed_senders: 42\n')).toEqual({
    allowedSenders: [42],
  });
});

test('parseControlConfig stops at the next top-level key', () => {
  const yaml = 'control:\n  enabled: true\nother:\n  staleness_sec: 60\n';
  expect(parseControlConfig(yaml)).toEqual({ enabled: true });
});

test('parseControlConfig ignores unknown keys inside control', () => {
  expect(parseControlConfig('control:\n  bogus: 1\n  enabled: true\n')).toEqual({
    enabled: true,
  });
});

// --- resolveControlConfig: merge over DEFAULT_CONTROL with validation ---

test('resolveControlConfig of an empty partial yields the defaults', () => {
  expect(resolveControlConfig({})).toEqual(DEFAULT_CONTROL);
});

test('resolveControlConfig: partial fields override defaults, the rest stay', () => {
  const r = resolveControlConfig({ enabled: true, stalenessSec: 60, allowedSenders: [42] });
  expect(r.enabled).toBe(true);
  expect(r.stalenessSec).toBe(60);
  expect(r.allowedSenders).toEqual([42]);
  expect(r.idleExitMin).toBe(DEFAULT_CONTROL.idleExitMin);
  expect(r.injectWrap).toBe(DEFAULT_CONTROL.injectWrap);
  expect(r.transport).toBe('auto');
});

test('resolveControlConfig: transport outside the union falls back to auto', () => {
  // The parser passes raw strings through; resolve normalizes garbage.
  expect(resolveControlConfig({ transport: 'teleport' as never }).transport).toBe('auto');
  expect(resolveControlConfig({ transport: 'tmux' }).transport).toBe('tmux');
  // 'channel' is type-valid (reserved for v1.2+) — kept, not rewritten.
  expect(resolveControlConfig({ transport: 'channel' }).transport).toBe('channel');
});

test('resolveControlConfig: non-positive or non-integer ints fall back to defaults', () => {
  expect(resolveControlConfig({ stalenessSec: 0 }).stalenessSec).toBe(DEFAULT_CONTROL.stalenessSec);
  expect(resolveControlConfig({ idleExitMin: -1 }).idleExitMin).toBe(DEFAULT_CONTROL.idleExitMin);
  expect(resolveControlConfig({ stalenessSec: 1.5 }).stalenessSec).toBe(
    DEFAULT_CONTROL.stalenessSec
  );
  expect(resolveControlConfig({ stalenessSec: 1 }).stalenessSec).toBe(1);
});

test('resolveControlConfig: session only present when configured', () => {
  expect(resolveControlConfig({}).session).toBeUndefined();
  expect(resolveControlConfig({ session: 'agents' }).session).toBe('agents');
});

test('resolveControlConfig never aliases the DEFAULT_CONTROL senders array', () => {
  const r = resolveControlConfig({});
  r.allowedSenders.push(1);
  expect(DEFAULT_CONTROL.allowedSenders).toEqual([]);
});

// --- full precedence: parse → resolve round trip ---

test('parse + resolve: config values win, invalid values heal to defaults', () => {
  const yaml = [
    'control:',
    '  enabled: yes',
    '  transport: zigbee',
    '  staleness_sec: 0',
    '  idle_exit_min: 45',
  ].join('\n');
  const r = resolveControlConfig(parseControlConfig(yaml));
  expect(r.enabled).toBe(true);
  expect(r.transport).toBe('auto'); // zigbee is not a transport
  expect(r.stalenessSec).toBe(DEFAULT_CONTROL.stalenessSec); // 0 is not positive
  expect(r.idleExitMin).toBe(45);
});
