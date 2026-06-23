import type { DetectedCandidate, DetectedDetailPlan, DetectedField, DetectedFieldDiagnostics, DetectedPagination, DetectedVisualElement } from './types.js';
import { buildTaskFromCandidate } from './xml.js';
import type {
  AgentDetailPlan,
  AgentFieldPlan,
  AgentPlan,
  AgentPlanPreview,
  AgentPreviewField,
  DetectAgentContext
} from './agent-types.js';

export function previewAgentPlan(options: { context: DetectAgentContext; plan: AgentPlan }): AgentPlanPreview {
  const candidateId = options.plan.selection?.candidateId ?? options.plan.candidateId;
  if (!candidateId) throw new Error('Agent plan 缺少 selection.candidateId。');
  const base = options.context.candidates.find((candidate) => candidate.id === candidateId);
  if (!base) throw new Error(`Agent plan 指定的候选区不存在: ${candidateId}`);
  if (base.type === 'form') throw new Error('表单候选区不能直接生成采集任务。');
  const candidate = applyAgentPlanToCandidate(base, options.plan);
  const warnings: string[] = [];
  const recommendedFixes: string[] = [];
  const fields = previewFields(candidate.fields, base.fields);
  const detailFields = candidate.detailPlan ? previewFields(candidate.detailPlan.fields, base.detailPlan?.fields ?? []) : [];
  collectAgentVisualReviewWarnings(warnings, recommendedFixes, options.context, options.plan, candidate.id);
  collectAgentPreviewWarnings(warnings, recommendedFixes, candidate, fields, detailFields);
  const dedupedWarnings = Array.from(new Set(warnings));
  const dedupedFixes = Array.from(new Set(recommendedFixes));
  return {
    schemaVersion: 'octopus.detect.agent-preview.v1',
    candidateId: candidate.id,
    candidate: {
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      confidence: candidate.confidence,
      itemCount: candidate.itemCount,
      ...(candidate.diagnostics ? { diagnostics: candidate.diagnostics } : {})
    },
    ...(options.plan.visualReview ? { visualReview: options.plan.visualReview } : {}),
    fields,
    ...(candidate.detailPlan ? {
      detail: {
        mode: candidate.detailPlan.mode,
        urlField: candidate.detailPlan.urlField,
        sampleUrls: candidate.detailPlan.sampleUrls,
        fields: detailFields
      }
    } : {}),
    ...(candidate.pagination ? { pagination: candidate.pagination } : {}),
    warnings: dedupedWarnings,
    recommendedFixes: dedupedFixes,
    ...(dedupedWarnings.length || dedupedFixes.length ? { repairInstruction: buildAgentRepairInstruction(dedupedWarnings, dedupedFixes) } : {}),
    pass: !hasBlockingAgentPreviewRisk(fields, detailFields) && !hasBlockingVisualReviewRisk(options.context, options.plan, candidate.id)
  };
}

export function buildTaskFromAgentPlan(options: {
  context: DetectAgentContext;
  plan: AgentPlan;
  taskId: string;
  taskName: string;
}) {
  const candidateId = options.plan.selection?.candidateId ?? options.plan.candidateId;
  if (!candidateId) throw new Error('Agent plan 缺少 selection.candidateId。');
  const base = options.context.candidates.find((candidate) => candidate.id === candidateId);
  if (!base) throw new Error(`Agent plan 指定的候选区不存在: ${candidateId}`);
  if (base.type === 'form') throw new Error('表单候选区不能直接生成采集任务。');
  const candidate = applyAgentPlanToCandidate(base, options.plan);
  return buildTaskFromCandidate({
    url: options.context.finalUrl,
    taskId: options.taskId,
    taskName: options.taskName,
    candidate,
    popupDismissals: options.context.popupDismissals,
    session: options.context.savedSession,
    searchPlan: options.context.searchPlan
  });
}

function previewFields(fields: DetectedField[], sourceFields: DetectedField[]): AgentPreviewField[] {
  return fields.map((field) => {
    const source = findPreviewSourceField(field, sourceFields);
    const diagnostics = field.diagnostics ?? source?.diagnostics;
    const runtimeScope = field.relativeXPath ? 'loop_item' : 'page';
    const warnings = (diagnostics?.warnings ?? []).filter((warning) => !isAcceptableLoopFieldWarning(warning, field));
    const notes = diagnostics?.warnings?.some((warning) => isAcceptableLoopFieldWarning(warning, field))
      ? ['XPath matches multiple page elements, but the generated runtime uses this field relative to each loop item.']
      : undefined;
    return {
      name: field.name,
      ...(source && source.name !== field.name ? { sourceName: source.name } : {}),
      kind: field.kind,
      xpath: field.xpath,
      samples: field.samples.slice(0, 3),
      ...(diagnostics ? { diagnostics } : {}),
      warnings,
      runtimeScope,
      ...(notes?.length ? { notes } : {})
    };
  });
}

function findPreviewSourceField(field: DetectedField, sourceFields: DetectedField[]): DetectedField | undefined {
  return sourceFields.find((item) => item === field)
    ?? sourceFields.find((item) => field.elementId && item.elementId === field.elementId)
    ?? sourceFields.find((item) => field.fieldId && item.fieldId === field.fieldId)
    ?? sourceFields.find((item) => item.name === field.name)
    ?? sourceFields.find((item) => item.xpath === field.xpath && item.kind === field.kind)
    ?? sourceFields.find((item) => item.xpath === field.xpath);
}

function isAcceptableLoopFieldWarning(warning: string, field: DetectedField): boolean {
  return Boolean(field.relativeXPath)
    && /xpath matched \d+ elements/i.test(warning)
    && /runtime may use the first element/i.test(warning);
}

function collectAgentVisualReviewWarnings(
  warnings: string[],
  recommendedFixes: string[],
  context: DetectAgentContext,
  plan: AgentPlan,
  selectedCandidateId: string
): void {
  if (!context.screenshot?.path) return;
  const review = plan.visualReview;
  if (!review?.reviewed) {
    warnings.push('visualReview: plan does not confirm that context.screenshot.path was opened and reviewed before choosing fields');
    recommendedFixes.push('在写 plan 前打开 context.screenshot.path，用长截图确认候选区和字段位置，并在 plan.visualReview 中记录 reviewed=true 和 evidence。');
    return;
  }
  if (review.screenshotPath && review.screenshotPath !== context.screenshot.path) {
    warnings.push(`visualReview: screenshotPath does not match context.screenshot.path (${context.screenshot.path})`);
    recommendedFixes.push('把 plan.visualReview.screenshotPath 设为 context.screenshot.path，避免复用旧截图或错误页面。');
  }
  if (review.annotatedScreenshotPath && review.annotatedScreenshotPath !== context.screenshot.annotatedPath) {
    warnings.push(`visualReview: annotatedScreenshotPath does not match context.screenshot.annotatedPath (${context.screenshot.annotatedPath ?? 'not available'})`);
    recommendedFixes.push('把 plan.visualReview.annotatedScreenshotPath 设为 context.screenshot.annotatedPath，或删除这个字段。');
  }
  const selectedCrop = context.screenshot.candidateScreenshots?.find((item) => item.candidateId === selectedCandidateId);
  if (review.candidateScreenshotPath && selectedCrop && review.candidateScreenshotPath !== selectedCrop.path) {
    warnings.push(`visualReview: candidateScreenshotPath does not match the selected candidate crop (${selectedCrop.path})`);
    recommendedFixes.push('把 plan.visualReview.candidateScreenshotPath 设为所选 candidate 的 crop 截图路径，避免看错候选区。');
  }
  if (review.selectedCandidateId && review.selectedCandidateId !== selectedCandidateId) {
    warnings.push(`visualReview: selectedCandidateId ${review.selectedCandidateId} does not match selection.candidateId ${selectedCandidateId}`);
    recommendedFixes.push('确认长截图中实际要采集的区域，并让 visualReview.selectedCandidateId 与 selection.candidateId 保持一致。');
  }
  if (!review.evidence?.length) {
    warnings.push('visualReview: evidence is missing; the plan should state what was visually verified');
    recommendedFixes.push('在 plan.visualReview.evidence 中写明截图上确认了主列表位置、关键字段位置、详情/翻页控件或排除广告侧栏的证据。');
  }
  if (!review.checks) {
    warnings.push('visualReview: checks is missing; structured visual confirmations make the plan easier to audit');
    recommendedFixes.push('建议在 plan.visualReview.checks 中明确 mainRegionVerified、fieldsVerified、paginationVerified/detailLinksVerified 和 excludedRegions。');
  } else {
    if (review.checks.mainRegionVerified === false) {
      warnings.push('visualReview: mainRegionVerified is false');
      recommendedFixes.push('先用标注截图确认 selection.candidateId 对应主采集区域，再设置 mainRegionVerified=true。');
    }
    if (review.checks.fieldsVerified === false) {
      warnings.push('visualReview: fieldsVerified is false');
      recommendedFixes.push('先用候选区 crop 确认字段位置和语义，再设置 fieldsVerified=true。');
    }
  }
}

function buildAgentRepairInstruction(warnings: string[], recommendedFixes: string[]): string {
  return [
    'Revise the agent plan before applying it.',
    warnings.length ? `Warnings: ${warnings.slice(0, 5).join(' | ')}` : '',
    recommendedFixes.length ? `Recommended fixes: ${recommendedFixes.slice(0, 5).join(' | ')}` : '',
    'Open the annotated screenshot and selected candidate crop, then update selection.candidateId, selection.fields, pagination/detail, and visualReview evidence/checks.'
  ].filter(Boolean).join(' ');
}

function collectAgentPreviewWarnings(
  warnings: string[],
  recommendedFixes: string[],
  candidate: DetectedCandidate,
  fields: AgentPreviewField[],
  detailFields: AgentPreviewField[]
): void {
  if (candidate.diagnostics?.warnings.length) warnings.push(...candidate.diagnostics.warnings.map((item) => `candidate: ${item}`));
  for (const field of [...fields, ...detailFields]) {
    const prefix = detailFields.includes(field) ? `detail.${field.name}` : field.name;
    for (const warning of field.warnings) warnings.push(`${prefix}: ${warning}`);
    if (field.diagnostics?.hasStyleNoise) {
      recommendedFixes.push(`${prefix}: 当前 XPath 可能选到了 style/css 容器，改选正文可见容器。`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.textLength ?? maxSampleLength(field.samples)) < 300) {
      recommendedFixes.push(`${prefix}: 正文长度偏短，优先选择 article/main 下包含多段 <p> 的父容器。`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.paragraphCount ?? 2) <= 1) {
      recommendedFixes.push(`${prefix}: 正文段落数偏少，可能只选中了单段正文，需要改成完整正文容器。`);
    }
    if ((field.diagnostics?.matchCount ?? 1) > 1 && field.runtimeScope !== 'loop_item') {
      recommendedFixes.push(`${prefix}: XPath 命中多个元素，若运行时只取第一个，应改成父容器 XPath 或明确合并多段文本。`);
    }
  }
  if (!candidate.detailPlan && fields.some((field) => field.kind === 'href' || field.name === 'url')) {
    warnings.push('plan has list URL fields but no detail plan');
    recommendedFixes.push('如果目标包含详情正文，请添加 detail.mode=list_with_detail、urlField=url 和 detail.fields。');
  }
}

function hasBlockingVisualReviewRisk(context: DetectAgentContext, plan: AgentPlan, selectedCandidateId: string): boolean {
  if (!context.screenshot?.path) return false;
  const review = plan.visualReview;
  return !review?.reviewed
    || !review.evidence?.length
    || Boolean(review.screenshotPath && review.screenshotPath !== context.screenshot.path)
    || Boolean(review.annotatedScreenshotPath && review.annotatedScreenshotPath !== context.screenshot.annotatedPath)
    || Boolean(review.candidateScreenshotPath && context.screenshot.candidateScreenshots?.some((item) => item.candidateId === selectedCandidateId) && review.candidateScreenshotPath !== context.screenshot.candidateScreenshots.find((item) => item.candidateId === selectedCandidateId)?.path)
    || Boolean(review.selectedCandidateId && review.selectedCandidateId !== selectedCandidateId);
}

function hasBlockingAgentPreviewRisk(fields: AgentPreviewField[], detailFields: AgentPreviewField[]): boolean {
  return [...fields, ...detailFields].some((field) => {
    if (!isContentPreviewField(field)) return false;
    const diagnostics = field.diagnostics;
    const textLength = diagnostics?.textLength ?? maxSampleLength(field.samples);
    const paragraphCount = diagnostics?.paragraphCount ?? 2;
    return diagnostics?.hasStyleNoise || textLength < 300 || paragraphCount <= 1;
  });
}

function isContentPreviewField(field: AgentPreviewField): boolean {
  return /(^|_)(content|body|article|正文)(_|$)/i.test(field.name)
    || /(^|_)(content|body|article|正文)(_|$)/i.test(field.sourceName ?? '');
}

function maxSampleLength(samples: string[]): number {
  return samples.reduce((max, sample) => Math.max(max, String(sample ?? '').length), 0);
}

function applyAgentPlanToCandidate(candidate: DetectedCandidate, plan: AgentPlan): DetectedCandidate {
  const selection = plan.selection ?? {};
  const fieldsPlan = selection.fields ?? plan.fields;
  const detailPlan = selection.detail !== undefined ? selection.detail : plan.detail;
  const paginationPlan = selection.pagination !== undefined ? selection.pagination : plan.pagination;
  return {
    ...candidate,
    fields: fieldsPlan ? applyAgentFieldPlan(candidate.fields, fieldsPlan, 'field', candidate.visualElements ?? []) : candidate.fields,
    ...(paginationPlan !== undefined ? { pagination: normalizeAgentPagination(paginationPlan) } : {}),
    ...(detailPlan !== undefined ? { detailPlan: normalizeAgentDetailPlan(candidate, detailPlan) } : {})
  };
}

function applyAgentFieldPlan(
  fields: DetectedField[],
  plan: AgentFieldPlan[],
  fallbackPrefix: string,
  visualElements: DetectedVisualElement[] = []
): DetectedField[] {
  return plan.map((item, index) => {
    if (typeof item === 'string') {
      const field = fields.find((candidate) => candidate.name === item || candidate.elementId === item || candidate.fieldId === item)
        ?? visualElementToField(visualElements.find((element) => element.id === item || element.fieldId === item), item);
      if (!field) throw new Error(`Agent plan 引用了不存在的字段或元素: ${item}`);
      return field;
    }
    const source = item.elementId ?? item.fieldId ?? item.source ?? item.name;
    const sourceField = source ? fields.find((field) => field.elementId === source || field.fieldId === source || field.name === source) : undefined;
    const sourceElementField = sourceField ? undefined : visualElementToField(
      source ? visualElements.find((element) => element.id === source || element.fieldId === source || element.fieldName === source || element.label === source) : undefined,
      item.as ?? item.name ?? source ?? `${fallbackPrefix}_${index + 1}`,
      item.kind
    );
    if (!sourceField && !sourceElementField && !item.xpath) throw new Error(`Agent plan 字段缺少 elementId、source 或 xpath: ${item.as ?? item.name ?? `${fallbackPrefix}_${index + 1}`}`);
    return {
      ...(sourceField ?? sourceElementField ?? {
        kind: item.kind ?? 'text',
        selector: item.selector ?? '',
        xpath: item.xpath ?? '',
        samples: item.samples ?? []
      }),
      name: item.as ?? item.name ?? sourceField?.name ?? sourceElementField?.name ?? `${fallbackPrefix}_${index + 1}`,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.selector ? { selector: item.selector } : {}),
      ...(item.xpath ? { xpath: item.xpath } : {}),
      ...(item.relativeXPath ? { relativeXPath: item.relativeXPath } : {}),
      ...(item.samples ? { samples: item.samples } : {}),
      ...(item.operations ? { operations: item.operations } : {})
    };
  });
}

function visualElementToField(
  element: DetectedVisualElement | undefined,
  fallbackName: string,
  requestedKind?: DetectedField['kind']
): DetectedField | undefined {
  if (!element) return undefined;
  const kind = requestedKind ?? element.kind;
  const samples = samplesForVisualElementKind(element, kind);
  return {
    fieldId: element.fieldId || element.id,
    elementId: element.id,
    name: element.fieldName || element.label || fallbackName,
    kind,
    selector: element.selector || element.tagName || '',
    xpath: element.xpath,
    ...(element.relativeXPath ? { relativeXPath: element.relativeXPath } : {}),
    samples,
    diagnostics: visualElementDiagnostics(element, samples)
  };
}

function samplesForVisualElementKind(element: DetectedVisualElement, kind: DetectedField['kind']): string[] {
  const byKind = element.samplesByKind?.[kind]?.filter(Boolean);
  if (byKind?.length) return byKind.slice(0, 3);
  if (kind === element.kind && element.samples.length) return element.samples.slice(0, 3);
  if (kind === 'href') {
    const href = element.attributes?.href || '';
    return href ? [href] : [];
  }
  if (kind === 'src') {
    const src = element.attributes?.src || element.attributes?.currentSrc || '';
    return src ? [src] : [];
  }
  if (kind === 'value') {
    const value = element.attributes?.value || element.sample || '';
    return value ? [value] : [];
  }
  return element.samples.length ? element.samples.slice(0, 3) : element.sample ? [element.sample] : [];
}

function visualElementDiagnostics(element: DetectedVisualElement, samples: string[]): DetectedFieldDiagnostics {
  const matchedRows = element.rowCoverage?.matchedRows ?? (element.visible ? 1 : 0);
  const text = samples.join(' ');
  return {
    matchCount: Math.max(1, matchedRows),
    textLength: text.length,
    paragraphCount: Math.max(0, samples.filter(Boolean).length),
    hasStyleNoise: false,
    ...(element.boundingBox ? { boundingBox: element.boundingBox } : {}),
    ...(element.sample ? { sampleText: element.sample } : {}),
    warnings: []
  };
}

function normalizeAgentPagination(value: DetectedPagination | null | false | undefined): DetectedPagination | undefined {
  if (!value) return undefined;
  return {
    type: value.type,
    xpath: value.xpath ?? '',
    text: value.text ?? '',
    confidence: value.confidence ?? 0.9,
    isAjax: value.isAjax ?? value.type !== 'next_page',
    scope: value.scope ?? 'global',
    ...(value.revealByScroll ? { revealByScroll: true } : {}),
    reasons: value.reasons?.length ? value.reasons : ['selected by external agent plan']
  };
}

function normalizeAgentDetailPlan(candidate: DetectedCandidate, value: AgentDetailPlan | null | false | undefined): DetectedDetailPlan | undefined {
  if (!value || value.mode === 'list_only') return undefined;
  const existing = candidate.detailPlan;
  const mode = value.mode ?? existing?.mode ?? 'list_with_detail';
  const existingFields = existing?.fields ?? [];
  const fields = value.fields
    ? applyAgentFieldPlan(existingFields, value.fields, 'detail_field')
    : existingFields;
  if (!fields.length) throw new Error('Agent plan 要求采详情页，但没有提供 detail.fields，也没有可复用的详情字段。');
  return {
    mode,
    urlField: value.urlField ?? existing?.urlField ?? 'url',
    sampleUrls: value.sampleUrls ?? existing?.sampleUrls ?? sampleUrlsForCandidate(candidate),
    fields,
    sampleRows: [Object.fromEntries(fields.map((field) => [field.name, field.samples[0] ?? '']))],
    templateCount: fields.length ? 1 : 0,
    status: 'planned',
    reasons: ['selected by external agent plan']
  };
}

function sampleUrlsForCandidate(candidate: DetectedCandidate): string[] {
  const urlField = candidate.fields.find((field) => field.name === 'url' && field.kind === 'href')
    ?? candidate.fields.find((field) => field.kind === 'href');
  return Array.from(new Set([
    ...candidate.sampleRows.map((row) => typeof row.url === 'string' ? row.url : ''),
    ...(urlField?.samples ?? [])
  ].filter((value) => /^https?:\/\//i.test(value)))).slice(0, 3);
}
