// Tests for the flat-chat `/new` command PURE module (issue #27): the arg parser, the
// parents-aware LRU/MRU dir ranker, name-uniqueness, and the inline-button keyboards/callbacks.

import { describe, expect, test } from 'bun:test';
import {
  MAX_NEW_DIR_CHOICES,
  NEW_DIR_CALLBACK_PREFIX,
  NEW_MODEL_CALLBACK_PREFIX,
  buildNewDirKeyboard,
  buildNewModelKeyboard,
  nameCollides,
  parentDirs,
  parseNewCommand,
  parseNewDirCallback,
  parseNewModelCallback,
  rankNewDirChoices,
  resolveModelToken,
} from '../features/tg-ctl/new-command';
import { DEFAULT_MODEL_ID, MODEL_CATALOG } from '../features/tg-ctl/models';

describe('parseNewCommand', () => {
  test('name only — model + dir omitted', () => {
    expect(parseNewCommand('/new myproj')).toEqual({ model: null, dir: null, name: 'myproj', task: '' });
  });

  test('name + task', () => {
    expect(parseNewCommand('/new myproj fix the build')).toEqual({
      model: null,
      dir: null,
      name: 'myproj',
      task: 'fix the build',
    });
  });

  test('model alias + name', () => {
    expect(parseNewCommand('/new opus myproj')).toEqual({
      model: 'claude-opus',
      dir: null,
      name: 'myproj',
      task: '',
    });
  });

  test('full id model + abs dir + name + task', () => {
    expect(parseNewCommand('/new claude-sonnet /Users/me/app api do the thing')).toEqual({
      model: 'claude-sonnet',
      dir: '/Users/me/app',
      name: 'api',
      task: 'do the thing',
    });
  });

  test('dir before model (order-tolerant)', () => {
    expect(parseNewCommand('/new /Users/me/app opus api')).toEqual({
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
      model: 'claude-opus',
      dir: null,
      name: 'opus',
      task: '',
    });
  });

  test('a lone model alias is reclaimed as the NAME (review #1): /new opus names the session opus', () => {
    expect(parseNewCommand('/new opus')).toEqual({ model: null, dir: null, name: 'opus', task: '' });
    expect(parseNewCommand('/new sonnet')).toEqual({ model: null, dir: null, name: 'sonnet', task: '' });
  });

  test('model + lone-dir reclaims the dir as the name, keeping the model', () => {
    // `/new opus /Users/me/app` — model=opus consumed, then /Users/me/app consumed as dir, nothing
    // left for a name → the dir token is reclaimed as the name, model stays.
    expect(parseNewCommand('/new opus /Users/me/app')).toEqual({
      model: 'claude-opus',
      dir: null,
      name: '/Users/me/app',
      task: '',
    });
  });

  test('extra whitespace is collapsed', () => {
    expect(parseNewCommand('/new   sonnet   myproj   hello   world')).toEqual({
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
      model: null,
      dir: null,
      name: 'relative/path',
      task: '',
    });
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
  });
  test('unknown token → null', () => {
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
  test('model keyboard has one button per catalog model with the tnm: callback', () => {
    const kb = buildNewModelKeyboard('tok');
    expect(kb.length).toBe(MODEL_CATALOG.length);
    expect(kb[0][0].callback_data).toBe(`${NEW_MODEL_CALLBACK_PREFIX}:tok:${MODEL_CATALOG[0].id}`);
    expect(kb[0][0].text).toBe(MODEL_CATALOG[0].label);
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
