import type { DetectedCandidate, DetectedField } from './types.js';
import type { RawCandidate } from './page-detector-shared.js';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function defaultUserAgent(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
}

export function normalizeFieldName(value: string, fallback: string): string {
  const ascii = value.trim().toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return ascii || fallback;
}

export function rowToSample(fields: DetectedField[], row: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  fields.forEach((field, index) => {
    record[field.name] = row[index] ?? '';
  });
  return record;
}

export function scoreCandidate(input: { itemCount: number; fieldCount: number; semantic: number; penalty: number }): number {
  const itemScore = Math.min(0.35, input.itemCount * 0.04);
  const fieldScore = Math.min(0.25, input.fieldCount * 0.06);
  const semanticScore = Math.min(0.25, input.semantic * 0.1);
  return Number(Math.max(0.1, Math.min(0.98, 0.25 + itemScore + fieldScore + semanticScore - input.penalty)).toFixed(2));
}

export function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

export function xpathStringLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.split("'").join(`',"'",'`)}')`;
}

export function appendRelativeXPath(itemXPath: string, relativeXPath: string): string {
  if (!relativeXPath || relativeXPath === '.') return itemXPath;
  if (relativeXPath.startsWith('.//')) return `${itemXPath}//${relativeXPath.slice(3)}`;
  if (relativeXPath.startsWith('./')) return `${itemXPath}/${relativeXPath.slice(2)}`;
  return `${itemXPath}/${relativeXPath.replace(/^\/+/, '')}`;
}

export function cookieMatchesHost(domain: string | undefined, host: string): boolean {
  const normalized = (domain || '').replace(/^\./, '').toLowerCase();
  const normalizedHost = host.toLowerCase();
  if (!normalized) return false;
  return normalized === normalizedHost || normalizedHost.endsWith(`.${normalized}`);
}

export function hostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function candidateTitle(candidate: RawCandidate): string {
  if (candidate.type === 'table') return `Table (${candidate.itemCount} rows)`;
  if (candidate.type === 'search_results') return `Search/list results (${candidate.itemCount} items)`;
  if (candidate.type === 'repeated_card') return `Repeated cards (${candidate.itemCount} items)`;
  if (candidate.type === 'form') return 'Search/input form';
  if (candidate.type === 'link_collection') return `Link collection (${candidate.itemCount} links)`;
  return 'Detail content';
}

export function detectorCandidateTypeLabel(type: DetectedCandidate['type']): string {
  if (type === 'table') return '表格';
  if (type === 'search_results') return '结果列表';
  if (type === 'repeated_card') return '重复卡片';
  if (type === 'link_collection') return '链接集合';
  if (type === 'detail') return '详情页';
  if (type === 'form') return '输入/搜索框';
  return type;
}
