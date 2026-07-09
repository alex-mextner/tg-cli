/**
 * @file Detects outbound messages that are long enough to need visible structure.
 *
 * Accessed via: the `tg` entrypoint after argument parsing and escape decoding,
 * before the Bot API transmit step.
 *
 * Assumptions: media and `--table` sends already have a distinct readable
 * artifact, so this helper only evaluates plain text-only sends.
 */
import type { Format } from './args';

const LONG_MESSAGE_MIN_CHARS = 500;
const SENTENCE_LIKE_LABEL_STARTS = new Set([
  'After',
  'Although',
  'And',
  'As',
  'Because',
  'Before',
  'But',
  'If',
  'Once',
  'Since',
  'So',
  'Then',
  'When',
  'While',
]);
const COMMON_HEADING_STARTS = new Set([
  'Action',
  'Build',
  'Context',
  'Decision',
  'Details',
  'Findings',
  'Impact',
  'Implementation',
  'Improvements',
  'Next',
  'Notes',
  'Plan',
  'Questions',
  'Recommendation',
  'Results',
  'Risks',
  'Status',
  'Summary',
  'Testing',
]);

export const LONG_UNSTRUCTURED_MESSAGE_WARNING =
  'tg: warning: long plain message has little visible structure. Use headings, blank-line paragraphs, lists/tables, or --format html / tg --table for readable Telegram reports. This warning does not block the send.';

export interface MessageStructureWarningInput {
  text?: string;
  format: Format;
  table?: true;
  items?: { readonly length: number };
}

function normalizedVisibleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasParagraphBreak(text: string): boolean {
  return /\r?\n[ \t]*\r?\n/.test(text);
}

function firstCodePoint(text: string): string {
  return Array.from(text)[0] ?? '';
}

function startsWithLowercaseLetter(word: string): boolean {
  return /^\p{Ll}$/u.test(firstCodePoint(word));
}

function startsWithTitleLead(word: string): boolean {
  const first = firstCodePoint(word);
  return /^[0-9]$/.test(first) || /^\p{Lu}$/u.test(first);
}

function isTitleLikeLabel(label: string): boolean {
  if (!/^[\p{L}0-9][\p{L}\p{N} /,()._-]{0,47}$/u.test(label)) return false;
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;
  const firstWord = words[0].replace(/^[^\p{L}0-9]+|[^\p{L}0-9]+$/gu, '');
  if (startsWithLowercaseLetter(firstWord)) return false;
  if (/^[A-Za-z]+$/.test(firstWord)) {
    if (SENTENCE_LIKE_LABEL_STARTS.has(firstWord)) return false;
    if (COMMON_HEADING_STARTS.has(firstWord)) return true;
  }
  if (/[^\x00-\x7F]/.test(label)) {
    if (words.length === 1) return true;
    const lowercaseContinuationWords = words.slice(1).filter(startsWithLowercaseLetter).length;
    const titleLeadWords = words.filter(startsWithTitleLead).length;
    return lowercaseContinuationWords === 0 && titleLeadWords >= Math.ceil(words.length / 2);
  }
  if (words.length === 1) return false;
  const lowercaseContinuationWords = words.slice(1).filter((word) => /^[a-z]/.test(word)).length;
  const uppercaseLeadWords = words.filter((word) => /^[A-Z0-9]/.test(word)).length;
  return lowercaseContinuationWords <= 1 || uppercaseLeadWords >= Math.ceil(words.length / 2);
}

function hasHeading(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (/^#{1,6}\s+\S/.test(trimmed)) return true;
    const styled = trimmed.match(/^<(b|strong|i|em|u|ins)\b[^>]*>\s*([^<]{1,80}?)\s*<\/\1>:?(?:\s|$)/i);
    if (styled?.[2] && isTitleLikeLabel(styled[2].trim().replace(/:$/, ''))) return true;
    const label = trimmed.endsWith(':') ? trimmed.slice(0, -1) : '';
    return isTitleLikeLabel(label);
  });
}

function hasList(text: string): boolean {
  return /(^|\n)[ \t]*(?:[-*+\u2022\u2023\u2043\u25E6]\s+\S|\d{1,3}[.)]\s+\S|\[[ xX]\]\s+\S|>\s+\S)/.test(text);
}

function nonEmptyCellCount(line: string, delimiter: string): number {
  return line.split(delimiter).map((cell) => cell.trim()).filter(Boolean).length;
}

function hasConsistentRows(cellCounts: number[]): boolean {
  if (cellCounts.length < 2) return false;
  const first = cellCounts[0];
  return first >= 2 && cellCounts.every((count) => count === first);
}

function isMarkdownTableDivider(line: string): boolean {
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line);
}

function hasTableishStructure(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const boxRows = lines.filter((line) => /[┌┬┐├┼┤└┴┘│]/.test(line));
  if (boxRows.length >= 2 && boxRows.some((line) => /[┌┬┐├┼┤└┴┘]/.test(line))) return true;
  const tabCellCounts = lines.filter((line) => line.includes('\t')).map((line) => nonEmptyCellCount(line, '\t'));
  if (hasConsistentRows(tabCellCounts)) return true;

  const pipeRows = lines.filter(
    (line) => isMarkdownTableDivider(line) || line.startsWith('|') || line.endsWith('|') || /\s\|\s/.test(line),
  );
  const hasDivider = pipeRows.some(isMarkdownTableDivider);
  const pipeCellCounts = pipeRows
    .filter((line) => !isMarkdownTableDivider(line))
    .map((line) => nonEmptyCellCount(line, '|'));
  return hasDivider ? pipeCellCounts.length >= 1 && pipeCellCounts.some((count) => count >= 2) : hasConsistentRows(pipeCellCounts);
}

function hasCodeBlock(text: string): boolean {
  return /(^|\n)```/.test(text) || /<pre\b/i.test(text);
}

function hasBlockquote(text: string): boolean {
  return /<blockquote\b/i.test(text);
}

function hasVisibleStructure(text: string): boolean {
  return (
    hasParagraphBreak(text) ||
    hasHeading(text) ||
    hasList(text) ||
    hasTableishStructure(text) ||
    hasCodeBlock(text) ||
    hasBlockquote(text)
  );
}

export function shouldWarnLongUnstructuredPlainMessage(input: MessageStructureWarningInput): boolean {
  if (input.format !== 'plain') return false;
  if (input.table) return false;
  if ((input.items?.length ?? 0) > 0) return false;

  const text = input.text ?? '';
  const visible = normalizedVisibleText(text);
  if (visible.length < LONG_MESSAGE_MIN_CHARS) return false;

  return !hasVisibleStructure(text);
}
