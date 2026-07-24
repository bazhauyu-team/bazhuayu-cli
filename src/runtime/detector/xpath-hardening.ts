import type { DetectedCandidate, DetectedField } from './types.js';

/**
 * Harden list candidates so generated tasks remain re-runnable.
 * Primary targets:
 * - SPA session roots like //div[@id="mount_0_0_XX"]/...
 * - extremely deep positional absolute paths
 * - class-soup relative field paths for img/a/time
 */
export function hardenDetectedCandidate(candidate: DetectedCandidate): DetectedCandidate {
  if (candidate.type === 'detail' || candidate.type === 'form') {
    return hardenCandidateFieldsOnly(candidate);
  }

  const originalItemXPath = candidate.itemXPath || candidate.xpath;
  let itemXPath = originalItemXPath;
  let fields = candidate.fields;
  let xpath = candidate.xpath;
  const itemXPathWasCandidateRoot = normalizeXPath(originalItemXPath) === normalizeXPath(candidate.xpath);

  const hardenedOriginal = hardenRuntimeItemXPath(originalItemXPath, fields);
  if (hardenedOriginal && hardenedOriginal !== originalItemXPath) {
    itemXPath = hardenedOriginal;
    if (itemXPathWasCandidateRoot) {
      xpath = stableContainerXPathFromItemXPath(itemXPath) ?? itemXPath;
    }
    fields = fields.map((field) => ({
      ...field,
      relativeXPath: field.relativeXPath || relativeXPathFromBase(originalItemXPath, field.xpath)
    }));
  } else if (normalizeXPath(itemXPath) === normalizeXPath(candidate.xpath)) {
    const inferred = inferItemXPathFromFields(candidate);
    if (inferred && normalizeXPath(inferred) !== normalizeXPath(candidate.xpath)) {
      itemXPath = inferred;
      fields = fields.map((field) => ({
        ...field,
        relativeXPath: field.relativeXPath || relativeXPathFromBase(inferred, field.xpath)
      }));
      const hardenedInferred = hardenRuntimeItemXPath(itemXPath, fields);
      if (hardenedInferred && hardenedInferred !== itemXPath) {
        itemXPath = hardenedInferred;
      }
    }
  }

  // Keep container xpath aligned when it was the brittle mount path too.
  if (isBrittleAbsoluteXPath(xpath)) {
    const hardenedContainer = hardenRuntimeItemXPath(xpath, fields);
    if (hardenedContainer) xpath = hardenedContainer;
    else {
      const stripped = stripVolatileMountIds(xpath);
      if (stripped !== xpath) xpath = stripped;
    }
  }

  fields = fields.map((field) => hardenRuntimeField(field, itemXPath));

  if (
    itemXPath === originalItemXPath
    && xpath === candidate.xpath
    && fields === candidate.fields
  ) {
    return candidate;
  }

  return {
    ...candidate,
    xpath,
    itemXPath,
    fields
  };
}

function hardenCandidateFieldsOnly(candidate: DetectedCandidate): DetectedCandidate {
  const itemXPath = candidate.itemXPath || candidate.xpath;
  const fields = candidate.fields.map((field) => hardenRuntimeField(field, itemXPath));
  if (fields.every((field, index) => field === candidate.fields[index])) return candidate;
  return { ...candidate, fields };
}

function inferItemXPathFromFields(candidate: DetectedCandidate): string | undefined {
  const candidateRoot = candidate.xpath.trim();
  const inferred = candidate.fields
    .map(inferItemXPathCandidateFromField)
    .filter((item): item is InferredItemXPath => Boolean(item))
    .filter((item) => item.xpath.startsWith(candidateRoot))
    .filter((item) => normalizeXPath(item.xpath) !== normalizeXPath(candidateRoot));
  const supported = selectSupportedItemXPath(inferred);
  if (supported) return supported;

  const fallback = candidate.fields
    .filter((field) => !(field.relativeXPath || '').trim())
    .map((field) => inferNestedItemXPathFromAbsolute(candidateRoot, field.xpath))
    .filter((item): item is InferredItemXPath => Boolean(item));
  return selectSupportedItemXPath(fallback);
}

interface InferredItemXPath {
  xpath: string;
  fromSiblingAxis: boolean;
}

function inferItemXPathCandidateFromField(field: DetectedField): InferredItemXPath | undefined {
  const relative = (field.relativeXPath || '').trim();
  if (!relative || /^(?:\.?\/\/|\/?descendant(?:-or-self)?::)/i.test(relative)) return undefined;
  const suffix = engineRelativeSuffix(relative);
  const base = relative === '.'
    ? field.xpath
    : suffix && field.xpath.endsWith(suffix)
      ? field.xpath.slice(0, -suffix.length)
      : '';
  if (!base || !/\/(?:article|li|tr|section|div)(?:\[[^\]]+\])?$/i.test(base)) return undefined;
  return {
    xpath: stripLastIndex(base),
    fromSiblingAxis: /^(?:\.\/)?(?:following|preceding)-sibling::/i.test(relative)
  };
}

function inferNestedItemXPathFromAbsolute(candidateRoot: string, fieldXPath: string): InferredItemXPath | undefined {
  if (!candidateRoot || !fieldXPath.startsWith(candidateRoot)) return undefined;
  const suffix = fieldXPath.slice(candidateRoot.length);
  for (const tag of ['article', 'li', 'tr', 'section', 'div'] as const) {
    const match = suffix.match(new RegExp(`^(.*?\\/${tag}(?:\\[[^\\]]+\\])?)(?=\\/|$)`, 'i'));
    if (!match) continue;
    const xpath = stripLastIndex(`${candidateRoot}${match[1]}`);
    if (normalizeXPath(xpath) !== normalizeXPath(candidateRoot)) return { xpath, fromSiblingAxis: false };
  }
  return undefined;
}

function engineRelativeSuffix(relativeXPath: string): string {
  if (!relativeXPath || relativeXPath === '.' || relativeXPath.includes('|')) return '';
  if (relativeXPath.startsWith('./')) return relativeXPath.slice(1);
  if (relativeXPath.startsWith('/')) return relativeXPath;
  return `/${relativeXPath}`;
}

function selectSupportedItemXPath(items: InferredItemXPath[]): string | undefined {
  const groups = new Map<string, { xpath: string; support: number; siblingSupport: number }>();
  for (const item of items) {
    const key = normalizeXPath(item.xpath).toLowerCase();
    const current = groups.get(key);
    if (current) {
      current.support += 1;
      if (item.fromSiblingAxis) current.siblingSupport += 1;
    } else {
      groups.set(key, { xpath: item.xpath, support: 1, siblingSupport: item.fromSiblingAxis ? 1 : 0 });
    }
  }
  const supported = [...groups.values()].filter((group) => group.support >= 2);
  supported.sort((a, b) => inferredItemXPathScore(b) - inferredItemXPathScore(a));
  return supported[0]?.xpath;
}

function inferredItemXPathScore(item: { xpath: string; support: number; siblingSupport: number }): number {
  const lastSegment = item.xpath.slice(item.xpath.lastIndexOf('/') + 1);
  const semanticPredicate = /\[(?!\d+\])/.test(lastSegment);
  return item.siblingSupport * 1_000 + (semanticPredicate ? 100 : 0) + item.support * 10;
}

export function hardenRuntimeItemXPath(itemXPath: string, fields: DetectedField[] = []): string | undefined {
  const trimmed = itemXPath.trim();
  if (!trimmed) return undefined;
  const carouselScoped = scopeGenericCarouselItemXPath(trimmed, fields);
  if (carouselScoped) return carouselScoped;
  if (!isBrittleAbsoluteXPath(trimmed)) return undefined;
  const trailingItemMatch = trimmed.match(/\/((article|li|tr)(?:\[[^\]]+\])?)$/i);
  if (trailingItemMatch) {
    const trailingItem = trailingItemMatch[1];
    const containerXPath = stableSemanticContainerXPath(trimmed, trailingItemMatch[2]);
    if (containerXPath) return `${containerXPath}//${trailingItem}`;
    const withoutMount = stripVolatileMountIds(trimmed);
    if (withoutMount !== trimmed) return withoutMount;
    const broadItem = `//${trailingItem}`;
    return /^(?:article|li|tr)$/i.test(trailingItem)
      ? scopeItemXPathByField(broadItem, fields) ?? broadItem
      : broadItem;
  }

  for (const field of fields) {
    const fieldItem = field.xpath?.match(/^(\/\/(?:article|li|tr)(?:\[[^\]]+\])?)/i)?.[1];
    if (fieldItem) return fieldItem;
  }

  const fromMain = trimmed.match(/(\/\/(?:main|section)(?:\[[^\]]+\])?(?:\/.+))$/i)?.[1];
  if (fromMain && fromMain.length < trimmed.length * 0.85) return fromMain;

  const withoutMount = stripVolatileMountIds(trimmed);
  if (withoutMount && withoutMount !== trimmed) return withoutMount;

  return undefined;
}

function scopeGenericCarouselItemXPath(itemXPath: string, fields: DetectedField[]): string | undefined {
  if (!/(?:swiper-slide|slick-slide|owl-item|carousel-item)/i.test(itemXPath)) return undefined;
  return scopeItemXPathByField(itemXPath, fields);
}

function scopeItemXPathByField(itemXPath: string, fields: DetectedField[]): string | undefined {
  const predicates = fields
    .map((field) => ({ field, predicate: fieldPresencePredicate(field, itemXPath) }))
    .filter((entry): entry is { field: DetectedField; predicate: string } => Boolean(entry.predicate))
    .sort((a, b) => fieldPresenceScore(b.field, b.predicate) - fieldPresenceScore(a.field, a.predicate));
  const predicate = predicates[0]?.predicate;
  if (!predicate || itemXPath.includes(predicate)) return undefined;
  return `${itemXPath}[${predicate}]`;
}

function fieldPresencePredicate(field: DetectedField, itemXPath: string): string | undefined {
  const relative = (field.relativeXPath || relativeXPathFromBase(itemXPath, field.xpath)).trim();
  if (!relative || relative === '.' || relative.includes('|') || /(?:following|preceding)-sibling::/i.test(relative)) return undefined;
  if (/^\/descendant-or-self::/i.test(relative)) return relative.slice(1);
  if (/^descendant-or-self::/i.test(relative)) return relative;
  if (/^\.\/\//.test(relative)) return `descendant::${relative.slice(3)}`;
  if (/^\/\//.test(relative)) return `descendant::${relative.slice(2)}`;
  return undefined;
}

function fieldPresenceScore(field: DetectedField, predicate: string): number {
  const populatedSamples = field.samples.filter((sample) => String(sample ?? '').trim()).length;
  const kindScore = field.kind === 'href' ? 50 : field.kind === 'text' ? 30 : field.kind === 'src' ? 10 : 0;
  const semanticScore = /contains\(@class|@(?:itemprop|data-)/i.test(predicate) ? 60 : 0;
  const genericLinkPenalty = /^descendant(?:-or-self)?::a(?:\[1\])?$/i.test(predicate) ? 20 : 0;
  return populatedSamples * 10 + kindScore + semanticScore - genericLinkPenalty - Math.min(predicate.length, 300) / 1_000;
}

export function hardenRuntimeField(field: DetectedField, itemXPath: string): DetectedField {
  let next = field;
  const relative = (field.relativeXPath || '').trim();
  if (relative && isBrittleClassSoupRelativeXPath(relative)) {
    const simplified = simplifyRelativeFieldXPath(field);
    if (simplified && simplified !== relative) {
      next = { ...next, relativeXPath: simplified };
    }
  }

  if (field.xpath && isBrittleAbsoluteXPath(field.xpath)) {
    const rel = (next.relativeXPath || relativeXPathFromItem(field.xpath) || '').trim();
    if (rel && itemXPath) {
      const composed = composeItemRelativeXPath(itemXPath, rel);
      if (composed) next = { ...next, xpath: composed };
    } else {
      const withoutMount = stripVolatileMountIds(field.xpath);
      if (withoutMount && withoutMount !== field.xpath) next = { ...next, xpath: withoutMount };
    }
  }

  return next;
}

function composeItemRelativeXPath(itemXPath: string, relativeXPath: string): string | undefined {
  const item = itemXPath.trim();
  const rel = relativeXPath.trim();
  if (!item || !rel || rel === '.') return item || undefined;
  if (rel.startsWith('/descendant-or-self::')) return `${item}${rel}`;
  if (rel.startsWith('.//')) return `${item}//${rel.slice(3)}`;
  if (rel.startsWith('./')) return `${item}/${rel.slice(2)}`;
  if (rel.startsWith('//')) return `${item}${rel}`;
  if (rel.startsWith('/')) return `${item}${rel}`;
  return `${item}//${rel}`;
}

function simplifyRelativeFieldXPath(field: DetectedField): string | undefined {
  const relative = (field.relativeXPath || '').trim();
  if (!relative) return undefined;

  if (field.kind === 'src') {
    if (/img/i.test(relative)) {
      return relative
        .replace(/IMG\[contains\(@class,["'][^"']+["']\)\]/gi, 'img')
        .replace(/img\[contains\(@class,["'][^"']+["']\)\]/gi, 'img');
    }
    return '/descendant-or-self::img';
  }
  if (field.kind === 'href') {
    if (/\/\/A\[1\]|\/A\[1\]|::a(\[|$)|\/a(\[|$)/i.test(relative)) {
      return relative
        .replace(/A\[contains\(@class,["'][^"']+["']\)\]/gi, 'a')
        .replace(/a\[contains\(@class,["'][^"']+["']\)\]/gi, 'a');
    }
    return '/descendant-or-self::a[1]';
  }
  if (field.kind === 'text') {
    if (/time/i.test(relative) || /时间|date|time/i.test(field.name)) {
      return '/descendant-or-self::time[1]';
    }
    const stripped = relative
      .replace(/\[@class=["'][^"']{80,}["']\]/g, '')
      .replace(/\[contains\(@class,["'][^"']{60,}["']\)\]/g, '');
    if (stripped !== relative && stripped.length >= 3) return stripped;
  }
  return undefined;
}

function stableSemanticContainerXPath(xpath: string, itemTag: string): string | undefined {
  if (!hasVolatileMountRoot(xpath)) return undefined;
  const preferredTags = itemTag.toLowerCase() === 'tr'
    ? ['table', 'main']
    : itemTag.toLowerCase() === 'li'
      ? ['main', 'section', 'ul', 'ol']
      : ['main', 'section'];
  for (const tag of preferredTags) {
    const match = xpath.match(new RegExp(`/${tag}(\\[[^\\]]+\\])?(?=/|$)`, 'i'));
    if (match) return `//${tag}${match[1] ?? ''}`;
  }
  return undefined;
}

function stableContainerXPathFromItemXPath(itemXPath: string): string | undefined {
  return itemXPath.match(/^(\/\/(?:main|section|table|ul|ol)(?:\[[^\]]+\])?)(?=\/)/i)?.[1];
}

export function isBrittleAbsoluteXPath(xpath: string): boolean {
  if (!xpath) return false;
  if (hasVolatileMountRoot(xpath)) return true;
  if (hasVolatileGeneratedId(xpath)) return true;
  const depth = (xpath.match(/\//g) || []).length;
  if (depth >= 12 && /\[\d+\]/.test(xpath)) return true;
  return false;
}

function hasVolatileMountRoot(xpath: string): boolean {
  return /@id=["']mount_0_0_[^"']+["']/i.test(xpath)
    || /@id=["'][^"']*(?:react-root|mount)[^"']*["']/i.test(xpath);
}
function hasVolatileGeneratedId(xpath: string): boolean {
  const matches = xpath.matchAll(/@id=["']([^"']+)["']/gi);
  for (const match of matches) {
    if (isVolatileGeneratedIdValue(match[1])) return true;
  }
  return false;
}

function isVolatileGeneratedIdValue(value: string): boolean {
  if (value.length < 64) return false;
  const digitGroups = value.match(/\d+/g)?.length ?? 0;
  return digitGroups >= 6 || /[\[\]@]/.test(value);
}


export function isBrittleClassSoupRelativeXPath(xpath: string): boolean {
  if (!xpath) return false;
  if (/@class=["'][^"']{80,}["']/.test(xpath)) return true;
  if (/contains\(@class,["'][^"']{60,}["']\)/.test(xpath)) return true;
  if (/x[a-z0-9]{5,}/i.test(xpath) && (xpath.match(/x[a-z0-9]{5,}/gi) || []).length >= 4) return true;
  return false;
}

export function stripVolatileMountIds(xpath: string): string {
  return xpath
    .replace(/\/\/div\[@id=["']mount_0_0_[^"']+["']\]/gi, '//div')
    .replace(/\/div\[@id=["']mount_0_0_[^"']+["']\]/gi, '/div')
    .replace(/\/\/(?:div|main)\[@id=["'](?:react-root|app|root)["']\]/gi, (value) => (
      value.startsWith('//main') ? '//main' : '//div'
    ))
    .replace(/([A-Za-z][\w:-]*)\[@id=(["'])([^"']+)\2\]/g, (value, tag: string, _quote: string, id: string) => (
      isVolatileGeneratedIdValue(id) ? tag : value
    ));
}

function relativeXPathFromBase(baseXPath: string, fieldXPath: string): string {
  if (!fieldXPath.startsWith(baseXPath)) return relativeXPathFromItem(fieldXPath);
  const suffix = fieldXPath.slice(baseXPath.length);
  if (!suffix) return '.';
  return `.${suffix}`;
}

function relativeXPathFromItem(xpath: string): string {
  const trimmed = xpath.trim();
  if (!trimmed) return '';
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) return '';
  const tail = trimmed.slice(lastSlash + 1);
  return tail ? `/${tail}` : '';
}

function normalizeXPath(xpath: string): string {
  return xpath.replace(/\[\d+\]/g, '').replace(/\/+$/, '');
}

function stripLastIndex(xpath: string): string {
  return xpath.replace(/\[\d+\]$/, '');
}
