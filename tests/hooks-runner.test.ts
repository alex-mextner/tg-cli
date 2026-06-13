import { expect, test } from 'bun:test';
import {
  orderDescriptors,
  resolveTrust,
  runHooks,
  validateDescriptor,
  type AuditLine,
  type RunnerDeps,
  type SpawnResult,
} from '../features/hooks/runner';
import { HOOK_API, type HookDescriptor, type HookEvent, type LoadedDescriptor } from '../features/hooks/types';

// --- helpers ---------------------------------------------------------------

function desc(over: Partial<HookDescriptor> = {}): HookDescriptor {
  return { id: 'h', point: 'pre-send-photo', cmd: '/bin/hook', ...over };
}

function loaded(over: Partial<HookDescriptor> = {}, file = 'a.json'): LoadedDescriptor {
  return { descriptor: desc(over), file };
}

function evt(): HookEvent {
  return {
    hook_api: HOOK_API,
    event_id: 'e1',
    tool: 'tg',
    point: 'pre-send-photo',
    command: 'send-photo',
    cwd: '/tmp',
    args: { image_path: '/tmp/x.png', caption: '', chat_id: '' },
  };
}

interface MockOpts {
  spawn?: (cmd: string) => SpawnResult;
  trust?: Record<
    string,
    { cmd_sha256: string; invocation_sha256?: string; point: string; on_error: 'open' | 'closed' }
  >;
  trustAuto?: boolean;
  sha?: (path: string) => string | null;
}

function mkDeps(opts: MockOpts = {}): { deps: RunnerDeps; warns: string[]; audits: AuditLine[] } {
  const warns: string[] = [];
  const audits: AuditLine[] = [];
  const deps: RunnerDeps = {
    trust: opts.trust ?? {},
    trustAuto: opts.trustAuto ?? false,
    sha256: opts.sha ?? (() => 'SHA'),
    sha256Str: () => 'INV',
    spawn: opts.spawn ?? (() => ({ exitCode: 0, stdout: '{"decision":"allow"}', stderr: '', timedOut: false })),
    audit: (l) => audits.push(l),
    warn: (m) => warns.push(m),
    now: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
    isoNow: () => '2026-01-01T00:00:00Z',
  };
  return { deps, warns, audits };
}

// A trust pin matching the default mock sha 'SHA'.
const trustOk = {
  'h.pre-send-photo': {
    cmd_sha256: 'SHA',
    invocation_sha256: 'INV',
    point: 'pre-send-photo',
    on_error: 'open' as const,
  },
};

// --- ordering --------------------------------------------------------------

test('orderDescriptors sorts by priority then filename', () => {
  const a = loaded({ priority: 10 }, 'z.json');
  const b = loaded({ priority: 5 }, 'b.json');
  const c = loaded({ priority: 5 }, 'a.json');
  const out = orderDescriptors([a, b, c]).map((d) => d.file);
  expect(out).toEqual(['a.json', 'b.json', 'z.json']);
});

// --- trust -----------------------------------------------------------------

test('resolveTrust: unseen descriptor is quarantined-new', () => {
  const r = resolveTrust(desc(), 'SHA', 'INV', { trust: {}, trustAuto: false });
  expect(r.state).toBe('quarantined-new');
});

test('resolveTrust: matching pin is trusted and carries on_error', () => {
  const r = resolveTrust(desc(), 'SHA', 'INV', { trust: trustOk, trustAuto: false });
  expect(r.state).toBe('trusted');
  expect(r.pinnedOnError).toBe('open');
});

test('resolveTrust: changed sha re-quarantines', () => {
  const r = resolveTrust(desc(), 'DIFFERENT', 'INV', { trust: trustOk, trustAuto: false });
  expect(r.state).toBe('quarantined-changed');
});

test('resolveTrust: changed INVOCATION (cmd+args) re-quarantines even if cmd sha matches', () => {
  // The executable bytes are unchanged ('SHA') but args were repointed, so the
  // invocation digest no longer matches the pin → re-trust required.
  const r = resolveTrust(desc(), 'SHA', 'DIFFERENT_INV', { trust: trustOk, trustAuto: false });
  expect(r.state).toBe('quarantined-changed');
});

test('resolveTrust: missing cmd → untrusted-missing-cmd', () => {
  const r = resolveTrust(desc(), null, 'INV', { trust: trustOk, trustAuto: false });
  expect(r.state).toBe('untrusted-missing-cmd');
});

test('resolveTrust: trustAuto bypasses pins', () => {
  const r = resolveTrust(desc(), 'whatever', 'whatever', { trust: {}, trustAuto: true });
  expect(r.state).toBe('auto');
});

// --- quarantine = absent (never runs, never blocks) ------------------------

test('quarantined-new descriptor does NOT run and does NOT block', () => {
  let ran = false;
  const { deps, warns } = mkDeps({
    spawn: () => {
      ran = true;
      return { exitCode: 10, stdout: '', stderr: '', timedOut: false };
    },
  });
  const v = runHooks([loaded()], evt, deps);
  expect(ran).toBe(false);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('NEW HOOK'))).toBe(true);
});

// --- block via exit 10 -----------------------------------------------------

test('exit 10 blocks (canonical) with message from stdout JSON', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 10, stdout: '{"message":"unstyled render"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toBe('unstyled render');
});

test('exit 10 blocks even with MALFORMED stdout (no silent bypass)', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 10, stdout: 'not json at all', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toBe('blocked by hook');
});

// --- allow -----------------------------------------------------------------

test('exit 0 allows the send', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"allow"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(false);
});

test('exit 0 with stdout decision:block also blocks (belt & suspenders)', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"block","message":"x"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toBe('x');
});

test('exit 0 with EMPTY stdout → allow (valid: no extra fields)', () => {
  const { deps } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  });
  expect(runHooks([loaded()], evt, deps).blocked).toBe(false);
});

// P2 fix: exit 0 + MALFORMED stdout is a protocol violation = hook error.
test('exit 0 with malformed stdout + on_error open → allow + warn (treated as error)', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: 'random log line, not json', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('malformed'))).toBe(true);
});

test('exit 0 with malformed stdout + on_error closed → BLOCKS (no silent bypass)', () => {
  const pin = {
    'h.pre-send-photo': {
      cmd_sha256: 'SHA',
      invocation_sha256: 'INV',
      point: 'pre-send-photo',
      on_error: 'closed' as const,
    },
  };
  const { deps } = mkDeps({
    trust: pin,
    spawn: () => ({ exitCode: 0, stdout: 'oops not protocol', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(true);
});

test('exit 0 with UNKNOWN decision ("deny") + on_error closed → BLOCKS', () => {
  const pin = {
    'h.pre-send-photo': {
      cmd_sha256: 'SHA',
      invocation_sha256: 'INV',
      point: 'pre-send-photo',
      on_error: 'closed' as const,
    },
  };
  const { deps } = mkDeps({
    trust: pin,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"deny"}', stderr: '', timedOut: false }),
  });
  expect(runHooks([loaded()], evt, deps).blocked).toBe(true);
});

test('exit 0 with UNKNOWN decision + on_error open → allow + warn', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '{"decision":"blocked"}', stderr: '', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('unknown decision'))).toBe(true);
});

// --- fail-open / fail-closed ----------------------------------------------

test('hook error (non-zero exit) with on_error open → allow + warn', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('on_error=open'))).toBe(true);
});

test('hook timeout with on_error open → allow + warn (fail-open default)', () => {
  const { deps, warns } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
  });
  const v = runHooks([loaded()], evt, deps);
  expect(v.blocked).toBe(false);
  expect(warns.some((w) => w.includes('timed out'))).toBe(true);
});

test('hook error with on_error closed → blocks', () => {
  // pin on_error closed (pin is authoritative)
  const pin = {
    'h.pre-send-photo': {
      cmd_sha256: 'SHA',
      invocation_sha256: 'INV',
      point: 'pre-send-photo',
      on_error: 'closed' as const,
    },
  };
  const { deps } = mkDeps({
    trust: pin,
    spawn: () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }),
  });
  const v = runHooks([loaded({ on_error: 'open' })], evt, deps); // descriptor says open, pin says closed
  expect(v.blocked).toBe(true);
});

// --- first block short-circuits -------------------------------------------

test('first blocking hook short-circuits the rest', () => {
  let secondRan = false;
  const { deps } = mkDeps({
    trust: {
      'a.pre-send-photo': { cmd_sha256: 'SHA', invocation_sha256: 'INV', point: 'pre-send-photo', on_error: 'open' },
      'b.pre-send-photo': { cmd_sha256: 'SHA', invocation_sha256: 'INV', point: 'pre-send-photo', on_error: 'open' },
    },
    spawn: (cmd) => {
      if (cmd === '/bin/b') secondRan = true;
      return { exitCode: 10, stdout: '{"message":"stop"}', stderr: '', timedOut: false };
    },
  });
  const a = { descriptor: desc({ id: 'a', cmd: '/bin/a', priority: 1 }), file: 'a.json' };
  const b = { descriptor: desc({ id: 'b', cmd: '/bin/b', priority: 2 }), file: 'b.json' };
  const v = runHooks([a, b], evt, deps);
  expect(v.blocked).toBe(true);
  expect(secondRan).toBe(false);
});

// --- audit -----------------------------------------------------------------

test('every hook firing writes an audit line', () => {
  const { deps, audits } = mkDeps({
    trust: trustOk,
    spawn: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  });
  runHooks([loaded()], evt, deps);
  expect(audits.length).toBe(1);
  expect(audits[0].decision).toBe('allow');
  expect(audits[0].trust_state).toBe('trusted');
});

test('a quarantined hook still writes a quarantined audit line', () => {
  const { deps, audits } = mkDeps();
  runHooks([loaded()], evt, deps);
  expect(audits.length).toBe(1);
  expect(audits[0].decision).toBe('quarantined');
});

// --- descriptor validation -------------------------------------------------

test('validateDescriptor rejects bad shapes, accepts good', () => {
  expect(validateDescriptor(null).ok).toBe(false);
  expect(validateDescriptor({}).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p' }).ok).toBe(false); // no cmd
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/c', on_error: 'maybe' }).ok).toBe(false);
  const ok = validateDescriptor({ id: 'x', point: 'p', cmd: '/c', on_error: 'open', priority: 3 });
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.descriptor.priority).toBe(3);
    expect(ok.descriptor.on_error).toBe('open');
  }
});

test('validateDescriptor rejects a RELATIVE/bare cmd (pin-vs-exec mismatch)', () => {
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: 'review' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: './hook.py' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/abs/hook.py' }).ok).toBe(true);
});

test('validateDescriptor rejects an id/point with shell metacharacters', () => {
  expect(validateDescriptor({ id: "x' && rm -rf ~ #", point: 'p', cmd: '/c' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p; evil', cmd: '/c' }).ok).toBe(false);
  expect(validateDescriptor({ id: 'review-visual', point: 'pre-send-photo', cmd: '/c' }).ok).toBe(true);
});

test('validateDescriptor rejects non-string args entries', () => {
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/c', args: ['ok', 3] }).ok).toBe(false);
  expect(validateDescriptor({ id: 'x', point: 'p', cmd: '/c', args: ['--strict'] }).ok).toBe(true);
});
