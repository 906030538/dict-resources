// 每周同步：拉上游 → 裁剪 → 对比 → 打包 → 生成人审报告
// 纪律：产物无明文（SVPX 容器）；单源失败不中断；词表无变化不开 PR
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, unpack } from './pack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const TMP = join(ROOT, '.tmp');
const PACK_PATH = join(DATA, 'dict-pack.bin');
const META_PATH = join(DATA, 'pack-meta.json');
const REPORT_PATH = join(DATA, 'sync-report.md');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', ...opts }).toString().trim();
const nowIso = () => new Date().toISOString();

/** 行文本 → 裁剪后的词数组 */
function loadWords(path, { minLen, maxLen }) {
  const raw = readFileSync(path, 'utf8').normalize('NFC');
  const out = [];
  for (const line of raw.split('\n')) {
    const w = line.replace(/[\u0000-\u001f\u007f]/g, '').trim(); // 去控制字符
    if (w.length >= minLen && w.length <= maxLen) out.push(w);
  }
  return out;
}

function cloneSource(src) {
  const dir = join(TMP, src.id);
  rmSync(dir, { recursive: true, force: true });
  console.log(`[clone] ${src.id} start`);
  sh('git', ['-c', 'credential.helper=', 'clone', '--depth', '1', '--quiet',
    '--branch', src.branch, `https://github.com/${src.repo}.git`, dir]);
  console.log(`[clone] ${src.id} done`);
  return sh('git', ['-C', dir, 'rev-parse', 'HEAD']);
}

function main() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8'));
  const rules = cfg.rules;
  mkdirSync(DATA, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  // 1. 拉上游 + 裁剪
  const items = {};                                    // category -> Map(word -> sourceId)
  const sourceStatus = [];
  for (const src of cfg.sources) {
    const st = { id: src.id, repo: src.repo, ok: false };
    try {
      st.sha = cloneSource(src);
      st.ok = true;
    } catch (e) {
      st.error = String(e.message).split('\n')[0];
      sourceStatus.push(st);
      console.warn(`[warn] source ${src.id} failed: ${st.error}`);
      continue;
    }
    let n = 0;
    for (const f of src.files) {
      const p = join(TMP, src.id, f.path);
      if (!existsSync(p)) {
        console.warn(`[warn] ${src.id}/${f.path} missing, skipped`);
        st.warnings ??= [];
        st.warnings.push(`missing file: ${f.path}`);
        continue;
      }
      for (const w of loadWords(p, rules)) {
        if (!items[f.category]) items[f.category] = new Map();
        if (!items[f.category].has(w)) { items[f.category].set(w, src.id); n++; }
      }
    }
    st.words = n;
    sourceStatus.push(st);
    console.log(`[ok] ${src.id} @ ${st.sha.slice(0, 9)}: ${n} words`);
  }

  const flat = Object.fromEntries(Object.entries(items).map(([c, m]) => [c, [...m.keys()].sort()]));
  const totalNew = Object.values(flat).reduce((s, a) => s + a.length, 0);
  console.log(`[trim] done: ${totalNew} words`);

  // 2. 与当前包对比
  let report = { added: {}, removed: {}, totalOld: 0, totalNew, unchanged: false };
  if (existsSync(PACK_PATH)) {
    const old = unpack(readFileSync(PACK_PATH)).items;
    report.totalOld = Object.values(old).reduce((s, a) => s + a.length, 0);
    for (const [c, words] of Object.entries(flat)) {
      const oldSet = new Set(old[c] ?? []);
      const wordSet = new Set(words); // 提到回调外：循环内 new Set 是 O(n²) 灾难
      const add = words.filter(w => !oldSet.has(w));
      const rm = (old[c] ?? []).filter(w => !wordSet.has(w));
      if (add.length) report.added[c] = add;
      if (rm.length) report.removed[c] = rm;
    }
    for (const c of Object.keys(old)) if (!(c in flat) && old[c].length)
      report.removed[c] = [...old[c]];
  } else {
    report.baseline = true; // 首次构建，无历史包
  }
  const diffCount = Object.values(report.added).reduce((s, a) => s + a.length, 0)
    + Object.values(report.removed).reduce((s, a) => s + a.length, 0);
  console.log(`[diff] done: diffCount=${diffCount}`);

  // 3. 无变化 → 不产新包（避免随机 key 造成假 diff）
  if (existsSync(PACK_PATH) && diffCount === 0) {
    report.unchanged = true;
    console.log(`no change (${totalNew} words)`);
    writeFileSync(REPORT_PATH, renderReport(sourceStatus, report, cfg));
    rmSync(TMP, { recursive: true, force: true });
    return;
  }

  // 4. 打包 + meta + 报告
  const buf = pack(flat);
  writeFileSync(PACK_PATH, buf);
  const meta = {
    version: 1,
    generatedAt: nowIso(),
    words: totalNew,
    categories: Object.fromEntries(Object.entries(flat).map(([c, a]) => [c, a.length])),
    sources: sourceStatus.map(({ id, repo, sha, ok, words, error }) => ({ id, repo, sha, ok, words, error })),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
  writeFileSync(REPORT_PATH, renderReport(sourceStatus, report, cfg));
  console.log(`packed ${totalNew} words -> ${(statSync(PACK_PATH).size / 1024).toFixed(0)}KB (diff: +${Object.values(report.added).reduce((s, a) => s + a.length, 0)}/-${Object.values(report.removed).reduce((s, a) => s + a.length, 0)})`);
  rmSync(TMP, { recursive: true, force: true });
}

function renderReport(sources, r, cfg) {
  const L = [];
  L.push(`# sync report`, '', `- time: ${nowIso()}`);
  L.push(`- words: ${r.totalOld} -> ${r.totalNew} (${r.unchanged ? 'no change' : 'changed'})`);
  if (r.baseline) L.push(`- baseline: 首次构建，无历史包对比`);
  L.push('');
  L.push(`## sources`, '', `| id | repo | sha | ok | words |`, `|---|---|---|---|---|`);
  for (const s of sources)
    L.push(`| ${s.id} | ${s.repo} | ${s.sha ? s.sha.slice(0, 9) : '-'} | ${s.ok ? '✓' : '✗ ' + (s.error ?? '')} | ${s.words ?? '-'} |`);
  const sample = (obj, title) => {
    L.push('', `## ${title}`, '');
    const entries = Object.entries(obj).filter(([, words]) => words.length);
    if (!entries.length) { L.push('(none)', ''); return; }
    // 敏感词不进报告（PR diff 明文可见）——只出分类计数，抽查走本地解包
    L.push(`| category | count |`, `|---|---|`);
    for (const [c, words] of entries) L.push(`| ${c} | ${words.length} |`);
    L.push('');
  };
  sample(r.added, 'added');
  sample(r.removed, 'removed');
  return L.join('\n') + '\n';
}

main();
