# dict-resources

词典资源包仓库。GitHub Actions 每周自动同步上游词库，经裁剪打包后以 PR 形式提交，人工审阅后合并。

> ⚠️ 私有仓库，勿转公开、勿外发产物。

## 结构

```
sources.json              上游清单（repo/branch/词表路径/分类映射）
scripts/pack.mjs          SVPX 容器（deflate-raw + XOR，混淆非加密）
scripts/sync.mjs          同步主流程
data/dict-pack.bin        产物（SVPX 容器，无明文）
data/pack-meta.json       版本元数据（时间/源 SHA/统计/sha256）
data/sync-report.md       人审报告（各源状态 + 增删统计与样例）
.github/workflows/sync.yml 每周一定时任务（可手动触发）
```

## 审阅流程

1. 每周一 workflow 自动运行，有变化时开 PR（`chore/data-refresh` 分支）
2. 审阅 `data/sync-report.md`（diff 中可直接看增删统计与样例）
3. 合并即生效；消费端按 `pack-meta.json.sha256` 校验产物

## 消费端解包（Node）

```js
import { unpack } from './scripts/pack.mjs';
const { items } = unpack(readFileSync('data/dict-pack.bin')); // { category: words[] }
```
