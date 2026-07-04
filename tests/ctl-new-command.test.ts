// Tests for the flat-chat `/new` command PURE module (issue #27): the arg parser, the
// parents-aware LRU/MRU dir ranker, name-uniqueness, and the inline-button keyboards/callbacks.

import { describe, expect, test } from 'bun:test';
import {
  MAX_NEW_DIR_CHOICES,
  NEW_DIR_CALLBACK_PREFIX,
  NEW_MODEL_CALLBACK_PREFIX,
  buildNewDirKeyboard,
  buildNewHarnessKeyboard,
  buildNewModelKeyboard,
  nameCollides,
  parentDirs,
  parseNewCommand,
  parseNewDirCallback,
  parseNewHarnessCallback,
  parseNewModelCallback,
  rankNewDirChoices,
  resolveHarnessToken,
  resolveModelToken,
  NEW_HARNESS_CALLBACK_PREFIX,
} from '../features/tg-ctl/new-command';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, modelsForHarness } from '../features/tg-ctl/models';

describe('parseNewCommand', () => {
  test('name only — model + dir omitted', () => {
    expect(parseNewCommand('/new myproj')).toEqual({ harness: null, model: null, dir: null, name: 'myproj', task: '' });
  });

  test('name + task', () => {
    expect(parseNewCommand('/new myproj fix the build')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'myproj',
      task: 'fix the build',
    });
  });

  test('model alias + name', () => {
    expect(parseNewCommand('/new opus myproj')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: 'myproj',
      task: '',
    });
  });

  test('full id model + abs dir + name + task', () => {
    expect(parseNewCommand('/new claude-sonnet /Users/me/app api do the thing')).toEqual({
      harness: 'claude',
      model: 'claude-sonnet',
      dir: '/Users/me/app',
      name: 'api',
      task: 'do the thing',
    });
  });

  test('dir before model (order-tolerant)', () => {
    expect(parseNewCommand('/new /Users/me/app opus api')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: '/Users/me/app',
      name: 'api',
      task: '',
    });
  });

  test('no name → empty name (caller shows usage)', () => {
    expect(parseNewCommand('/new').name).toBe('');
    expect(parseNewCommand('/new   ').name).toBe('');
  });

  test('a name that LOOKS like a model is still the name once the slot is taken', () => {
    // `opus` is consumed as the model; the second `opus` token can't be a second model,
    // so it becomes the name.
    expect(parseNewCommand('/new opus opus')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: 'opus',
      task: '',
    });
  });

  test('a lone model alias is reclaimed as the NAME (review #1): /new opus names the session opus', () => {
    expect(parseNewCommand('/new opus')).toEqual({ harness: null, model: null, dir: null, name: 'opus', task: '' });
    expect(parseNewCommand('/new sonnet')).toEqual({ harness: null, model: null, dir: null, name: 'sonnet', task: '' });
  });

  test('model + lone-dir reclaims the dir as the name, keeping the model', () => {
    // `/new opus /Users/me/app` — model=opus consumed, then /Users/me/app consumed as dir, nothing
    // left for a name → the dir token is reclaimed as the name, model stays.
    expect(parseNewCommand('/new opus /Users/me/app')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: '/Users/me/app',
      task: '',
    });
  });

  test('extra whitespace is collapsed', () => {
    expect(parseNewCommand('/new   sonnet   myproj   hello   world')).toEqual({
      harness: 'claude',
      model: 'claude-sonnet',
      dir: null,
      name: 'myproj',
      task: 'hello world',
    });
  });

  test('tolerates /new@botname', () => {
    expect(parseNewCommand('/new@mybot myproj').name).toBe('myproj');
  });

  test('a non-abs path token is NOT a dir — it becomes the name', () => {
    expect(parseNewCommand('/new relative/path')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'relative/path',
      task: '',
    });
  });

  test('harness before name: /new codex task-cli msg keeps codex as harness, not name', () => {
    expect(parseNewCommand('/new codex task-cli msg')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
  });

  test('claude is a harness token, not a default-model alias', () => {
    expect(parseNewCommand('/new claude task-cli msg')).toEqual({
      harness: 'claude',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
    expect(parseNewCommand('/new task-cli claude msg')).toEqual({
      harness: 'claude',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
  });

  test('harness after name is also accepted', () => {
    expect(parseNewCommand('/new task-cli codex msg')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
  });

  test('opencode harness aliases are accepted before or after the name', () => {
    expect(parseNewCommand('/new oc task-cli msg')).toEqual({
      harness: 'opencode',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
    expect(parseNewCommand('/new task-cli opencode msg')).toEqual({
      harness: 'opencode',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
  });

  test('a concrete model token infers its harness', () => {
    expect(parseNewCommand('/new gpt-5.5 task-cli msg')).toEqual({
      harness: 'codex',
      model: 'codex-gpt-5.5',
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
    expect(parseNewCommand('/new task-cli glm-5.2 msg')).toEqual({
      harness: 'opencode',
      model: 'opencode-zai-glm-5.2',
      dir: null,
      name: 'task-cli',
      task: 'msg',
    });
  });

  test('soft model aliases after the name stay in the task, not silently consumed', () => {
    expect(parseNewCommand('/new api default behavior is broken')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'api',
      task: 'default behavior is broken',
    });
    expect(parseNewCommand('/new api spark joy')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'api',
      task: 'spark joy',
    });
  });

  test('a path-like token after the name stays in the task unless it came before the name', () => {
    expect(parseNewCommand('/new api /tmp/do it')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'api',
      task: '/tmp/do it',
    });
  });

  test('a pre-name harness does not force a mismatched soft model alias to become a model', () => {
    expect(parseNewCommand('/new codex opus')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'opus',
      task: '',
    });
  });

  test('a pre-name model wins; a later harness-looking token becomes the name', () => {
    expect(parseNewCommand('/new opus codex')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: 'codex',
      task: '',
    });
  });

  test('only one selector is consumed after the name; the rest is task text', () => {
    expect(parseNewCommand('/new task-cli codex glm-5.2 msg')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'glm-5.2 msg',
    });
    expect(parseNewCommand('/new task-cli claude opus msg')).toEqual({
      harness: 'claude',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'opus msg',
    });
  });
});

describe('resolveHarnessToken', () => {
  test('harness aliases resolve', () => {
    expect(resolveHarnessToken('codex')).toBe('codex');
    expect(resolveHarnessToken('CLAUDE')).toBe('claude');
    expect(resolveHarnessToken('Codex')).toBe('codex');
    expect(resolveHarnessToken('oc')).toBe('opencode');
    expect(resolveHarnessToken('opencode')).toBe('opencode');
  });

  test('unknown token → null', () => {
    expect(resolveHarnessToken('task-cli')).toBeNull();
  });
});

describe('resolveModelToken', () => {
  test('exact catalog id resolves', () => {
    expect(resolveModelToken(DEFAULT_MODEL_ID)).toBe(DEFAULT_MODEL_ID);
  });
  test('aliases resolve', () => {
    expect(resolveModelToken('opus')).toBe('claude-opus');
    expect(resolveModelToken('OPUS')).toBe('claude-opus');
    expect(resolveModelToken('default')).toBe('claude-default');
    expect(resolveModelToken('gpt-5.5')).toBe('codex-gpt-5.5');
    expect(resolveModelToken('glm-5.2')).toBe('opencode-zai-glm-5.2');
    expect(resolveModelToken('moonshotai/Kimi-K2.7-Code')).toBe('opencode-kimi');
    expect(resolveModelToken('deepseek/deepseek-v4-pro')).toBe('opencode-deepseek');
    expect(resolveModelToken('Qwen/Qwen3.7-Max')).toBe('opencode-qwen');
  });
  test('unknown token → null', () => {
    expect(resolveModelToken('claude')).toBeNull();
    expect(resolveModelToken('gpt-9')).toBeNull();
    expect(resolveModelToken('myproj')).toBeNull();
  });
});

describe('parentDirs', () => {
  test('lists ancestors nearest-first, stopping above root', () => {
    expect(parentDirs('/a/b/c')).toEqual(['/a/b', '/a']);
  });
  test('trailing slash is ignored', () => {
    expect(parentDirs('/a/b/c/')).toEqual(['/a/b', '/a']);
  });
  test('one-level path has no listed parent (would be root)', () => {
    expect(parentDirs('/a')).toEqual([]);
  });
  test('root itself has none', () => {
    expect(parentDirs('/')).toEqual([]);
  });
});

describe('rankNewDirChoices', () => {
  const allDirs = (_p: string): boolean => true;

  test('adds parents and keeps a child ahead of its parent', () => {
    expect(rankNewDirChoices(['/Users/me/app'], allDirs)).toEqual([
      '/Users/me/app',
      '/Users/me',
      '/Users',
    ]);
  });

  test('LRU/MRU: newer cwd outranks older, dedup keeps first (newest) mention', () => {
    // app is newest, lib is older; both share /Users/me. The shared parent keeps the rank of
    // its FIRST (newest) appearance — right after app, before lib.
    expect(rankNewDirChoices(['/Users/me/app', '/Users/me/lib'], allDirs)).toEqual([
      '/Users/me/app',
      '/Users/me',
      '/Users',
      '/Users/me/lib',
    ]);
  });

  test('non-existing dirs are filtered out', () => {
    const onlyApp = (p: string): boolean => p === '/Users/me/app';
    expect(rankNewDirChoices(['/Users/me/app'], onlyApp)).toEqual(['/Users/me/app']);
  });

  test('relative / empty / undefined candidates are skipped', () => {
    expect(rankNewDirChoices(['relative', '', undefined, '/abs/x'], allDirs)).toEqual([
      '/abs/x',
      '/abs',
    ]);
  });

  test('capped at MAX_NEW_DIR_CHOICES', () => {
    const many = Array.from({ length: 20 }, (_v, i) => `/d${i}/deep/nested`);
    const out = rankNewDirChoices(many, allDirs);
    expect(out.length).toBe(MAX_NEW_DIR_CHOICES);
  });

  test('a single deep cwd expands at most MAX_PARENTS_PER_CWD parents (review #4: no menu starvation)', () => {
    // /a/b/c/d/e/f → the cwd + only its 2 nearest parents (/a/b/c/d/e, /a/b/c/d), not the whole chain.
    expect(rankNewDirChoices(['/a/b/c/d/e/f'], allDirs)).toEqual(['/a/b/c/d/e/f', '/a/b/c/d/e', '/a/b/c/d']);
  });

  test('a deep cwd does NOT crowd a sibling project out of the menu (review #4)', () => {
    // With the parent cap, the second project still appears even after a deep first one.
    const out = rankNewDirChoices(['/a/b/c/d/e/f', '/proj/two'], allDirs);
    expect(out).toContain('/proj/two');
  });
});

describe('nameCollides', () => {
  test('true when the slug matches a live window name', () => {
    expect(nameCollides('myproj', ['rig', 'myproj', '3d'])).toBe(true);
  });
  test('false when no match', () => {
    expect(nameCollides('myproj', ['rig', '3d'])).toBe(false);
  });
});

describe('flat /new callbacks', () => {
  test('parseNewHarnessCallback round-trips', () => {
    expect(parseNewHarnessCallback(`${NEW_HARNESS_CALLBACK_PREFIX}:abc:codex`)).toEqual({
      token: 'abc',
      harness: 'codex',
    });
  });
  test('parseNewHarnessCallback rejects malformed', () => {
    expect(parseNewHarnessCallback('tnh:abc')).toBeNull();
    expect(parseNewHarnessCallback('tnh:abc:nope')).toBeNull();
    expect(parseNewHarnessCallback('tgm:abc:codex')).toBeNull();
    expect(parseNewHarnessCallback(undefined)).toBeNull();
  });
  test('parseNewModelCallback round-trips', () => {
    expect(parseNewModelCallback(`${NEW_MODEL_CALLBACK_PREFIX}:abc:claude-opus`)).toEqual({
      token: 'abc',
      modelId: 'claude-opus',
    });
  });
  test('parseNewModelCallback rejects malformed', () => {
    expect(parseNewModelCallback('tnm:abc')).toBeNull();
    expect(parseNewModelCallback('tgm:abc:claude-opus')).toBeNull(); // topic prefix, not ours
    expect(parseNewModelCallback(undefined)).toBeNull();
  });
  test('parseNewDirCallback round-trips', () => {
    expect(parseNewDirCallback(`${NEW_DIR_CALLBACK_PREFIX}:abc:0`)).toEqual({ token: 'abc', index: 0 });
    expect(parseNewDirCallback(`${NEW_DIR_CALLBACK_PREFIX}:abc:3`)).toEqual({ token: 'abc', index: 3 });
  });
  test('parseNewDirCallback rejects a leading-zero / non-numeric index', () => {
    expect(parseNewDirCallback('tnp:abc:01')).toBeNull();
    expect(parseNewDirCallback('tnp:abc:x')).toBeNull();
    expect(parseNewDirCallback('tnp:abc:-1')).toBeNull();
  });
});

describe('keyboards', () => {
  test('harness keyboard has one button per supported harness with the tnh: callback', () => {
    const kb = buildNewHarnessKeyboard('tok');
    expect(kb.map((row) => row[0].callback_data)).toEqual([
      `${NEW_HARNESS_CALLBACK_PREFIX}:tok:claude`,
      `${NEW_HARNESS_CALLBACK_PREFIX}:tok:codex`,
      `${NEW_HARNESS_CALLBACK_PREFIX}:tok:opencode`,
    ]);
  });
  test('model keyboard has one button per catalog model with the tnm: callback', () => {
    const kb = buildNewModelKeyboard('tok');
    expect(kb.length).toBe(MODEL_CATALOG.length);
    expect(kb[0][0].callback_data).toBe(`${NEW_MODEL_CALLBACK_PREFIX}:tok:${MODEL_CATALOG[0].id}`);
    expect(kb[0][0].text).toBe(MODEL_CATALOG[0].label);
  });
  test('model keyboard can be filtered to a harness', () => {
    const kb = buildNewModelKeyboard('tok', modelsForHarness('codex'));
    expect(kb.length).toBeGreaterThan(0);
    expect(kb.every((row) => row[0].callback_data.includes(':codex-'))).toBe(true);
  });
  test('dir keyboard has one button per choice with the tnp:<token>:<index> callback', () => {
    const kb = buildNewDirKeyboard('tok', ['/a', '/b']);
    expect(kb).toEqual([
      [{ text: '/a', callback_data: 'tnp:tok:0' }],
      [{ text: '/b', callback_data: 'tnp:tok:1' }],
    ]);
  });
  test('dir keyboard is empty for no choices', () => {
    expect(buildNewDirKeyboard('tok', [])).toEqual([]);
  });
});
