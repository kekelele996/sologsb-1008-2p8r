// 三方合并与存储健壮性验证（不入构建产物）
import { mergeProjects, migrateProject, persistProject, buildResolution, applyConflictAction, readPersisted } from "../src/storage";
import { createSeedProject } from "../src/data";
import type { SignProject } from "../src/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, message: string) {
  if (cond) { pass += 1; console.log(`  ✓ ${message}`); }
  else { fail += 1; console.error(`  ✗ ${message}`); }
}

function clone<T>(value: T): T { return structuredClone(value); }
function rev(project: SignProject, revision: number): SignProject {
  project.revision = revision;
  return project;
}

// --- localStorage shim ------------------------------------------------
class StorageShim {
  map = new Map<string, string>();
  quotaBytes = Infinity;
  setItem(key: string, value: string) {
    const current = this.map.get(key)?.length ?? 0;
    const used = [...this.map.values()].reduce((s, v) => s + v.length, 0);
    if (used - current + value.length > this.quotaBytes) {
      const error = new Error("quota");
      (error as DOMException).name = "QuotaExceededError";
      throw error;
    }
    this.map.set(key, value);
  }
  getItem(key: string) { return this.map.get(key) ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  clear() { this.map.clear(); }
}

// --- 1. 旧数据（无修订号）兼容接入 -----------------------------------
console.log("旧数据兼容：");
const legacy = { schema: 1, project: { ...createSeedProject() } as Partial<SignProject> };
delete (legacy.project as SignProject).revision;
delete (legacy.project as SignProject).pendingConflicts;
const migrated = migrateProject(legacy)!;
assert(migrated.revision === 0, "无修订号旧档被接入为 revision 0");
assert(Array.isArray(migrated.pendingConflicts) && migrated.pendingConflicts.length === 0, "补出空冲突列表");

// --- 2. 不相交字段：落后方只并入自己改过的 ---------------------------
console.log("按条目/字段合并：");
{
  const base = rev(createSeedProject(), 3);
  const signId = base.signs[0].id;
  const otherSign = base.signs[1].id;
  const remote = rev(clone(base), 4);
  remote.signs[0]!.targetText = "REMOTE 改了译文";
  remote.signs[0]!.updatedAt = new Date().toISOString();
  const local = rev(clone(base), 3);
  local.signs[0]!.status = "confirmed";
  local.signs[1]!.scenario = "本地改了另一条场景";

  const { merged, newConflicts } = mergeProjects(base, local, remote);
  const m0 = merged.signs.find((s) => s.id === signId)!;
  assert(m0.targetText === "REMOTE 改了译文", "对方的译文保留");
  assert(m0.status === "confirmed", "本地的审校状态并入");
  const m1 = merged.signs.find((s) => s.id === otherSign)!;
  assert(m1.scenario === "本地改了另一条场景", "本地改过的另一条标识也并入");
  assert(newConflicts.length === 0, "没有冲突");
}

// --- 3. 同一字段双方都改 → 两份保留为待确认 --------------------------
console.log("双方同改 → 待确认：");
{
  const base = rev(createSeedProject(), 5);
  const remote = rev(clone(base), 6);
  remote.signs[0]!.targetText = "Remote translation";
  const local = rev(clone(base), 5);
  local.signs[0]!.targetText = "本地译文";
  const { merged, newConflicts } = mergeProjects(base, local, remote);
  assert(newConflicts.length === 1, "产生 1 个冲突");
  assert(merged.signs[0]!.targetText === "Remote translation", "以先到的对方译文为底，等待裁定");
  const conflict = newConflicts[0]!;
  assert(conflict.localText.includes("本地译文") && conflict.remoteText.includes("Remote translation"), "两份内容都保留");
  assert(merged.pendingConflicts.length === 1, "冲突挂到项目上");

  // 裁定：采用本地
  const resolution = buildResolution(conflict, "local");
  applyConflictAction(merged, conflict.localAction);
  merged.pendingConflicts = merged.pendingConflicts.filter((c) => c.id !== conflict.id);
  merged.resolutions = [resolution];
  assert(merged.signs[0]!.targetText === "本地译文", "裁定后采用本地译文");

  // 落后标签页（仍持旧 remote 值）之后再来保存，不该把本地译文盖掉
  const staleLocal = rev(clone(base), 5);
  staleLocal.signs[0]!.targetText = "Remote translation";
  const merge2 = mergeProjects(base, staleLocal, merged, merged.resolutions);
  assert(merge2.merged.signs[0]!.targetText === "本地译文", "已裁定掉的旧值不回流");
  assert(merge2.newConflicts.length === 0, "已裁定的分歧不重复产生冲突");
}

// --- 4. 术语逐字段合并：译法两边都改 → 待确认；确认单边改 → 并入 ----
console.log("术语合并：");
{
  const base = rev(createSeedProject(), 2);
  const termId = base.signs[0]!.terms[0]!.id;
  const remote = rev(clone(base), 3);
  remote.signs[0]!.terms[0]!.target = "Remote term";
  remote.signs[0]!.terms[0]!.confirmed = true;
  const local = rev(clone(base), 2);
  local.signs[0]!.terms[0]!.target = "本地术语译法";
  const { merged, newConflicts } = mergeProjects(base, local, remote);
  const term = merged.signs[0]!.terms.find((t) => t.id === termId)!;
  assert(term.confirmed === true, "术语确认只有对方改，自动并入");
  assert(newConflicts.length === 1, "术语译法两边都动 → 待确认");
  assert(term.target === "Remote term", "分歧字段暂取对方值，等待人工裁定");
}

// --- 5. 一边删术语、一边改术语 → 待确认 ------------------------------
console.log("术语删除冲突：");
{
  const base = rev(createSeedProject(), 2);
  const termId = base.signs[0]!.terms[0]!.id;
  const remote = rev(clone(base), 3);
  remote.signs[0]!.terms = remote.signs[0]!.terms.filter((t) => t.id !== termId);
  const local = rev(clone(base), 2);
  local.signs[0]!.terms[0]!.target = "改了";
  const { newConflicts } = mergeProjects(base, local, remote);
  assert(newConflicts.length === 1 && newConflicts[0]!.kind === "term", "删改冲突保留两份");
}

// --- 6. 审校意见与快照并集合并 ---------------------------------------
console.log("意见/版本快照：");
{
  const base = rev(createSeedProject(), 1);
  const remote = rev(clone(base), 2);
  remote.signs[0]!.comments.push({ id: "c-remote", author: "A", body: "对方意见", createdAt: new Date().toISOString(), resolved: false, replies: [] });
  const local = rev(clone(base), 1);
  local.signs[0]!.comments.push({ id: "c-local", author: "B", body: "本地意见", createdAt: new Date().toISOString(), resolved: false, replies: [{ id: "r1", author: "B", body: "本地回复", createdAt: new Date().toISOString() }] });
  const { merged } = mergeProjects(base, local, remote);
  const ids = merged.signs[0]!.comments.map((c) => c.id);
  assert(ids.includes("c-remote") && ids.includes("c-local"), "双方新增意见都保留");

  local.signs[0]!.versions.push({ id: "v-local", label: "版本", createdAt: "2026-09-01T00:00:00Z", sourceText: "s", targetText: "t", status: "draft", terms: [] });
  remote.signs[0]!.versions.push({ id: "v-remote", label: "版本", createdAt: "2026-09-02T00:00:00Z", sourceText: "s", targetText: "t2", status: "draft", terms: [] });
  const merge2 = mergeProjects(base, local, remote);
  const vids = merge2.merged.signs[0]!.versions.map((v) => v.id);
  assert(vids.includes("v-local") && vids.includes("v-remote"), "双方快照都保留");
}

// --- 7. 审校状态两边都改 → 待确认 ------------------------------------
console.log("审校状态冲突：");
{
  const base = rev(createSeedProject(), 1);
  const remote = rev(clone(base), 2);
  remote.signs[0]!.status = "confirmed";
  const local = rev(clone(base), 1);
  local.signs[0]!.status = "changes";
  const { newConflicts } = mergeProjects(base, local, remote);
  assert(newConflicts.some((c) => c.field === "status"), "审校状态分歧列为待确认");
}

// --- 8. 配额不足：回收最早快照后成功、再不行留内存 --------------------
console.log("空间回收与内存兜底：");
{
  const shim = new StorageShim();
  (globalThis as { localStorage: unknown }).localStorage = shim;

  // 塞满：一个大旧快照（旧日期）+ 项目本体放不下新保存
  const project = createSeedProject();
  const oldSnap = "X".repeat(400);
  const freshSnap = "Y".repeat(200);
  project.signs[0]!.versions = [
    { id: "old", label: "最早快照", createdAt: "2020-01-01T00:00:00Z", sourceText: "", targetText: oldSnap, status: "draft", terms: [] },
    { id: "new", label: "新快照", createdAt: "2026-09-01T00:00:00Z", sourceText: "", targetText: freshSnap, status: "draft", terms: [] },
  ];
  const wrappedSize = JSON.stringify({ schema: 2, project }).length;
  const pruned = clone(project);
  pruned.signs[0]!.versions = pruned.signs[0]!.versions.filter((v) => v.id !== "old");
  const prunedSize = JSON.stringify({ schema: 2, project: pruned }).length;
  const freed = wrappedSize - prunedSize;
  // 占用空间介于“回收后能放”与“不回收放不下”之间
  shim.quotaBytes = wrappedSize;
  shim.setItem("other-key", "1".repeat(freed - 50));
  assert(prunedSize + freed - 50 <= wrappedSize, "前置：回收旧快照后空间足够");

  const outcome = persistProject(project);
  assert(outcome.status === "recovered", `回收快照后保存成功（实际：${outcome.status}）`);
  assert(outcome.prunedSnapshots === 1, "回收了 1 条最早快照");
  const stored = readPersisted()!;
  const versions = stored.signs[0]!.versions;
  assert(versions.length === 1 && versions[0]!.id === "new", "最早快照被回收，较新的保留");

  // 配额极小、无快照可回收 → memory 兜底
  shim.clear();
  shim.quotaBytes = 10;
  const big = clone(stored);
  big.signs[0]!.versions = [];
  const failOutcome = persistProject(big);
  assert(failOutcome.status === "memory", "彻底写不下时返回 memory，编辑留在内存");
  assert(Boolean(failOutcome.error), "带回失败原因");
  shim.clear();
}

// --- 9. 修订号递增 ----------------------------------------------------
console.log("修订号：");
{
  const shim = new StorageShim();
  (globalThis as { localStorage: unknown }).localStorage = shim;
  const base = rev(createSeedProject(), 10);
  const remote = rev(clone(base), 11);
  remote.title = "对方改的";
  const local = rev(clone(base), 10);
  local.location = "本地改的";
  const result = mergeProjects(base, local, remote);
  assert(result.merged.revision === 11, "合并结果沿用先到方修订号，落盘前再 +1");
  const toSave = clone(result.merged);
  toSave.revision = remote.revision + 1;
  persistProject(toSave);
  assert(readPersisted()!.revision === 12, "保存后修订号为 12");
}

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
