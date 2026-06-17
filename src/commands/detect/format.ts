import type { AgentPlanPreview } from '../../runtime/detector/agent-types.js';
import type { DetectedAgentScreenshot, PageDetectionResult } from '../../runtime/detector/types.js';
import { recommendedCandidate } from '../../runtime/detector/agent-context.js';

export function printDetectHuman(result: PageDetectionResult): void {
  console.log(`URL: ${result.finalUrl}`);
  console.log(`Title: ${result.title || '(untitled)'}`);
  console.log('');
  if (!result.candidates.length) {
    console.log('没有检测到可采集候选区。可以尝试增加 --scrolls，或打开搜索/列表结果页后重试。');
    return;
  }
  const selectedIds = result.selectedCandidateIds?.length
    ? result.selectedCandidateIds
    : result.selectedCandidateId ? [result.selectedCandidateId] : [];
  const selectedSet = new Set(selectedIds);
  const visibleCandidates = selectedSet.size
    ? result.candidates.filter((candidate) => selectedSet.has(candidate.id))
    : result.candidates;
  const recommended = selectedSet.size
    ? visibleCandidates[0] ?? recommendedCandidate(result.candidates)
    : recommendedCandidate(result.candidates);
  if (!recommended) return;
  if (selectedSet.size) {
    console.log(`已选择 ${visibleCandidates.length} 个候选区: ${visibleCandidates.map((candidate) => candidate.id).join(', ')}`);
  } else {
    console.log(`检测到 ${result.candidates.length} 个候选区。候选区不是最终任务，先选你想采的数据。`);
  }
  if (result.popupDismissals?.length) {
    console.log(`已处理弹窗: ${result.popupDismissals.map((item) => `${popupTypeLabel(item.type)}/${item.action}`).join(', ')}`);
  }
  console.log('');
  console.log('建议：');
  if (recommended.type === 'form') {
    console.log('  这个页面主要是搜索/输入入口。先在浏览器打开搜索结果页，再对结果页运行 detect。');
  } else {
    console.log(`  优先看 [${recommended.id}] ${candidateTypeLabel(recommended.type)}。`);
    console.log(`  生成任务: octopus detect ${shellArg(result.finalUrl)} --select ${recommended.id} --output task.json`);
    console.log('  注意: task.json 是实际文件名，不要输入尖括号。');
  }
  for (const candidate of visibleCandidates) {
    console.log('');
    const scoreText = candidate.goalScore !== undefined
      ? `匹配度=${formatConfidence(candidate.goalScore)}  置信度=${formatConfidence(candidate.confidence)}`
      : `置信度=${formatConfidence(candidate.confidence)}`;
    console.log(`[${candidate.id}] ${candidateTypeLabel(candidate.type)}  ${scoreText}`);
    console.log(`    ${candidateHint(candidate)}`);
    if (candidate.layout) {
      console.log(`    区域=${candidateLayoutLabel(candidate.layout.role)} 主内容=${formatConfidence(candidate.layout.mainScore)} 链接密度=${formatConfidence(candidate.layout.linkDensity)}`);
    }
    if (candidate.pagination) {
      const paginationMode = candidate.pagination.revealByScroll ? '，先滚动揭露' : '';
      console.log(`    翻页=${paginationLabel(candidate.pagination.type)}${paginationMode} ${candidate.pagination.text ? `(${truncate(candidate.pagination.text, 40)})` : ''}  置信度=${formatConfidence(candidate.pagination.confidence)}`);
    }
    console.log(`    数量=${candidate.itemCount} 字段=${candidate.fields.map((field) => field.name).join(', ')}`);
    const sample = candidate.sampleRows[0];
    if (sample) console.log(`    样例=${formatSample(sample)}`);
    if (candidate.type === 'form') {
      console.log('    下一步: octopus detect <url> --input wd=关键词');
    } else {
      console.log(`    生成: octopus detect ${shellArg(result.finalUrl)} --select ${candidate.id} --output task.json`);
    }
  }
}

export function printAgentPlanPreview(preview: AgentPlanPreview, screenshot: DetectedAgentScreenshot | undefined): void {
  console.log(`Agent plan preview: ${preview.candidateId}`);
  console.log(`检查结果: ${preview.pass ? '通过' : '不建议生成任务，需先修正字段'}`);
  console.log(`候选区: ${candidateTypeLabel(preview.candidate.type)}  数量=${preview.candidate.itemCount}  置信度=${formatConfidence(preview.candidate.confidence)}`);
  if (screenshot) console.log(`长截图: ${screenshot.path}`);
  if (preview.visualReview) {
    console.log(`视觉确认: ${preview.visualReview.reviewed ? '已确认' : '未确认'}`);
    if (preview.visualReview.evidence?.length) {
      for (const item of preview.visualReview.evidence) console.log(`  - ${item}`);
    }
  }
  console.log(`列表字段: ${preview.fields.map((field) => field.name).join(', ') || '(none)'}`);
  if (preview.detail) {
    console.log(`详情页: ${detailModeLabel(preview.detail.mode)}  urlField=${preview.detail.urlField}`);
    console.log(`详情字段: ${preview.detail.fields.map((field) => field.name).join(', ') || '(none)'}`);
  }
  if (preview.warnings.length) {
    console.log('');
    console.log('风险:');
    for (const warning of preview.warnings) console.log(`  - ${warning}`);
  }
  if (preview.recommendedFixes.length) {
    console.log('');
    console.log('建议修改:');
    for (const fix of preview.recommendedFixes) console.log(`  - ${fix}`);
  }
}

export function paginationLabel(type: string): string {
  if (type === 'next_page') return '点击下一页';
  if (type === 'load_more') return '点击加载更多';
  if (type === 'scroll') return '滚动加载';
  return type;
}

export function detailModeLabel(mode: string): string {
  if (mode === 'list_with_detail') return '列表 + 详情页';
  if (mode === 'detail_only') return '只采详情页';
  return '只采列表';
}

export function candidateTypeLabel(type: string): string {
  if (type === 'table') return '表格';
  if (type === 'search_results') return '带链接列表/结果列表';
  if (type === 'repeated_card') return '重复卡片/列表';
  if (type === 'link_collection') return '链接集合';
  if (type === 'form') return '搜索/输入框';
  if (type === 'detail') return '详情页';
  return type;
}

function candidateLayoutLabel(role: string): string {
  if (role === 'main') return '主内容';
  if (role === 'sidebar') return '侧边栏';
  if (role === 'header') return '页头';
  if (role === 'footer') return '页脚';
  if (role === 'nav') return '导航';
  if (role === 'ad') return '广告';
  return '未知';
}

function popupTypeLabel(type: string): string {
  if (type === 'login') return '登录';
  if (type === 'cookie') return 'Cookie';
  if (type === 'newsletter') return '订阅';
  if (type === 'ad') return '广告';
  if (type === 'captcha') return '验证码';
  if (type === 'paywall') return '付费墙';
  return '未知';
}

function candidateHint(candidate: PageDetectionResult['candidates'][number]): string {
  if (candidate.type === 'form') return '这是入口，不是数据列表；适合后续生成“输入关键词并搜索”的流程。';
  if (candidate.type === 'link_collection') return '这通常是导航/分类/相关链接；只有想采链接列表时才选它。';
  if (candidate.type === 'table') return '适合采集表格行数据。';
  if (candidate.type === 'search_results') return '适合采集带链接的文章、商品、搜索结果或信息流列表。';
  if (candidate.type === 'repeated_card') return '适合采集重复出现的卡片、文章、商品或列表项。';
  return candidate.title;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSample(sample: Record<string, string>): string {
  const compact: Record<string, string> = {};
  for (const [key, value] of Object.entries(sample)) {
    compact[key] = truncate(value, 90);
  }
  return JSON.stringify(compact);
}

function truncate(value: string, max: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function shellArg(value: string): string {
  if (/^[\w\-./:?=%#]+$/.test(value) && value.length < 140) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
