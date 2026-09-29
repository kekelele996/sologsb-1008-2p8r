// 双标签页完整保存竞态：模拟"标签页 A 先存、标签页 B 后存"的真实流程
import { mergeProjects, persistProject, readPersisted } from "../src/storage";
import { createSeedProject } from "../src/data";
import type { SignProject } from "../src/types";

class Store {
  map = new Map<string, string>(); quota = Infinity;
  setItem(k: string, v: string) {
    const cur = this.map.get(k)?.length ?? 0;
    const used = [...this.map.values()].reduce((s, x) => s + x.length, 0);
    if (used - cur + v.length > this.quota) {
      const e = new Error("q") as Error & { name: string };
      e.name = "QuotaExceededError"; throw e;
    }
    this.map.set(k, v);
  }
  getItem(k: string) { return this.map.get(k) ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
}
(globalThis as { localStorage: unknown }).localStorage = new Store();

const seed = createSeedProject();
seed.revision = 0;
const sign = seed.signs[0]!;

// 两个标签页都从 rev 0 打开
const tabA = structuredClone(seed);
const tabB = structuredClone(seed);
const base = structuredClone(seed);

// A 改译文并保存 → rev 1
tabA.signs[0]!.targetText = "A 的译文";
const aSaved = { ...structuredClone(tabA), revision: 1, updatedAt: new Date().toISOString() } satisfies SignProject;
persistProject(aSaved);
console.log("A 保存后：", readPersisted()!.revision);

// B 同时改了审校状态和第二条标识的场景，保存时发现本地落后 → 三方合并
tabB.signs[0]!.status = "confirmed";
tabB.signs[1]!.scenario = "B 改的另一条";
const stored = readPersisted()!;
const result = mergeProjects(base, tabB, stored, stored.resolutions ?? []);
result.merged.revision = stored.revision + 1;
const outcome = persistProject(result.merged);
const final = readPersisted()!;

let ok = 0;
const check = (c: boolean, m: string) => { console.log(c ? `  ✓ ${m}` : `  ✗ ${m}`); ok += c ? 1 : 0; };
check(outcome.status === "saved", "B 正常保存（未触发回收）");
check(final.revision === 2, "修订号推进到 2");
check(final.signs[0]!.targetText === "A 的译文", "A 的译文没有被 B 盖掉");
check(final.signs[0]!.status === "confirmed", "B 改的审校状态并入");
check(final.signs[1]!.scenario === "B 改的另一条", "B 改的另一条标识并入");
check(final.pendingConflicts.length === 0, "不同字段/不同条目不产生待确认");

// 再来一轮：B 在 rev2 上继续改译文并先存成 rev3；A 仍在 rev1 基线上也改了同一译文 → 冲突双份保留
const remote3 = structuredClone(readPersisted()!);
remote3.signs[0]!.targetText = "B 后来又改的译文";
remote3.revision = 3;
persistProject(remote3);
const tabA2 = structuredClone(aSaved);
tabA2.signs[0]!.targetText = "A 再次改的译文";
const base2 = structuredClone(aSaved);
const stored2 = readPersisted()!;
const r2 = mergeProjects(base2, tabA2, stored2, stored2.resolutions);
check(r2.newConflicts.length === 1, "同一译文两边都动 → 1 个待确认");
check(r2.merged.pendingConflicts[0]!.localText.includes("A 再次改的译文"), "冲突保留 A 的版本");
check(r2.merged.pendingConflicts[0]!.remoteText.includes("B 后来又改的译文"), "冲突保留 B 的版本");
console.log(ok === 9 ? "\n端到端竞态全部通过" : "\n有失败");
