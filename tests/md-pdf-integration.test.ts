import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { convertMdToPdf, findChrome, type ConvertDeps } from '../features/md-pdf/convert';

// Real-tool integration: requires pandoc + Chrome. Skipped cleanly when either
// is missing so CI on a bare box stays green.

const realDeps: ConvertDeps = {
  run: (cmd, timeoutMs) => {
    try {
      const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
      return { exitCode: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
    } catch {
      return null;
    }
  },
  makeTempDir: () => mkdtempSync(join(tmpdir(), 'tg-mdpdf-test-')),
  writeFile: (path, content) => writeFileSync(path, content),
  readFile: (path) => readFileSync(path, 'utf8'),
  fileExists: (path) => existsSync(path),
  fileSize: (path) => {
    try {
      return Bun.file(path).size;
    } catch {
      return -1;
    }
  },
  whichCmd: (name) => Bun.which(name),
  env: process.env as Record<string, string | undefined>,
};

const pandocAvailable = realDeps.run(['pandoc', '--version'], 5000) !== null;
const chromeAvailable = findChrome(realDeps) !== null;
const available = pandocAvailable && chromeAvailable;

test.skipIf(!available)(
  'integration: Cyrillic+emoji markdown converts to a real PDF',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-mdpdf-src-'));
    const mdPath = join(dir, 'отчёт тест.md');
    writeFileSync(mdPath, '# Отчёт 🚁\n\nПривет, проверка — ёжик, объём. ✅🔥\n');
    const { pdfPath, error } = convertMdToPdf(mdPath, realDeps);
    expect(error).toBeNull();
    expect(pdfPath).not.toBeNull();
    expect(pdfPath!.endsWith('отчёт тест.pdf')).toBe(true);
    const head = readFileSync(pdfPath!).subarray(0, 5).toString();
    expect(head).toBe('%PDF-');
  },
  60_000,
);

test('integration: conversion failure reports an error, no pdf, and the tmp dir for cleanup', () => {
  const failingDeps: ConvertDeps = { ...realDeps, run: () => ({ exitCode: 1, stderr: 'boom' }) };
  const dir = mkdtempSync(join(tmpdir(), 'tg-mdpdf-src-'));
  const mdPath = join(dir, 'x.md');
  writeFileSync(mdPath, '# x');
  const { pdfPath, error, tmpDir } = convertMdToPdf(mdPath, failingDeps);
  expect(pdfPath).toBeNull();
  expect(error).toContain('pandoc failed');
  expect(tmpDir).not.toBeNull();
});

test('integration: zero-byte PDF output is a failure, not a success', () => {
  const deps: ConvertDeps = {
    ...realDeps,
    run: () => ({ exitCode: 0, stderr: '' }), // both tools "succeed"
    fileSize: () => 0, // ...but the PDF is empty
  };
  const dir = mkdtempSync(join(tmpdir(), 'tg-mdpdf-src-'));
  const mdPath = join(dir, 'x.md');
  writeFileSync(mdPath, '# x');
  const { pdfPath, error } = convertMdToPdf(mdPath, deps);
  expect(pdfPath).toBeNull();
  expect(error).toContain('empty PDF');
});

test('integration: pandoc is invoked with --embed-resources rooted at the md dir', () => {
  const calls: string[][] = [];
  const deps: ConvertDeps = {
    ...realDeps,
    run: (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stderr: '' };
    },
    fileSize: () => 100,
  };
  convertMdToPdf('/some/dir/doc.md', deps);
  const pandoc = calls[0];
  expect(pandoc).toContain('--embed-resources');
  const rp = pandoc.indexOf('--resource-path');
  expect(pandoc[rp + 1]).toBe('/some/dir');
});
