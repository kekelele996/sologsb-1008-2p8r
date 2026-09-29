import { uid } from "./data";
import type {
  PersistedProject,
  ReviewStatus,
  SignConflict,
  SignItem,
  SignProject,
  TermBinding,
} from "./types";

export const STORAGE_KEY = "sologsb-1008-project-v1";
export const MAX_VERSIONS = 12;

export interface LoadedProject {
  project: SignProject;
  /** 旧数据没有修订号，按 0 接入 */
  revision: number;
}

export interface SaveOutcome {
  ok: boolean;
  /** 成功时为新修订号；失败时为当前已存储的修订号 */
  revision: number;
  /** 实际写入存储的项目（可能因回收快照而被裁剪），应用它作为内存状态 */
  writtenProject: SignProject;
  /** 若发生了并发合并，这里是合并后的项目 */
  mergedProject: SignProject | null;
  /** 发生冲突的标识 id 列表 */
  conflicts: string[];
  /** 是否回收了最早的版本快照才写入成功 */
  reclaimed: boolean;
  /** 存储已满、编辑仅保留在内存中 */
  degraded: boolean;
}

/* ------------------------------------------------------------------ */
/* 读取与兼容                                                          */
/* ------------------------------------------------------------------ */

/** 从 localStorage 读取项目，兼容没有修订号的旧数据。 */
export function loadFromStorage(): LoadedProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedProject>;
    if (parsed.schema !== 1 || !parsed.project?.signs?.length) return null;
    const project = parsed.project;
    // 旧数据没有 conflicts 字段，补齐为空数组
    for (const sign of project.signs) {
      if (!Array.isArray(sign.conflicts)) sign.conflicts = [];
    }
    const revision = typeof parsed.revision === "number" && Number.isFinite(parsed.revision) ? parsed.revision : 0;
    return { project, revision };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 写入与配额处理                                                      */
/* ------------------------------------------------------------------ */

function persist(data: PersistedProject): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** 回收最早的版本快照：每个标识去掉最旧的一个快照，返回新对象；没有可回收时返回 null。 */
function pruneOldestSnapshots(data: PersistedProject): PersistedProject | null {
  let removed = false;
  const project: SignProject = {
    ...data.project,
    signs: data.project.signs.map((sign) => {
      if (sign.versions.length === 0) return sign;
      removed = true;
      return { ...sign, versions: sign.versions.slice(0, -1) };
    }),
  };
  return removed ? { ...data, project } : null;
}

/** 配额重试：先整体写入，失败则回收最早快照后重试，再失败则清空全部快照最后一试。 */
function writeWithQuotaRetry(data: PersistedProject): { written: PersistedProject; reclaimed: boolean } | null {
  try {
    persist(data);
    return { written: data, reclaimed: false };
  } catch {
    const pruned = pruneOldestSnapshots(data);
    if (pruned) {
      try {
        persist(pruned);
        return { written: pruned, reclaimed: true };
      } catch {
        // 继续往下走：清空全部快照
      }
    }
    const stripped: PersistedProject = {
      ...data,
      project: {
        ...data.project,
        signs: data.project.signs.map((sign) => ({ ...sign, versions: [] })),
      },
    };
    try {
      persist(stripped);
      return { written: stripped, reclaimed: true };
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 按条目合并                                                          */
/* ------------------------------------------------------------------ */

/** 合并术语：以远端为底，并入本地新增与确认改动；两边都改了确认则记为冲突。 */
function mergeTerms(
  base: TermBinding[],
  remote: TermBinding[],
  local: TermBinding[],
): { terms: TermBinding[]; conflict: boolean; localConfirmed: Record<string, boolean> } {
  const result = structuredClone(remote);
  const baseMap = new Map(base.map((t) => [t.id, t]));
  const remoteMap = new Map(remote.map((t) => [t.id, t]));
  let conflict = false;
  const localConfirmed: Record<string, boolean> = {};

  for (const lt of local) {
    const bt = baseMap.get(lt.id);
    const rt = remoteMap.get(lt.id);
    if (!bt) {
      // 本地新增的术语，远端也没有 → 并入
      if (!rt) result.push(structuredClone(lt));
      continue;
    }
    // 术语在 base 中存在
    const localConfirmedChanged = bt.confirmed !== lt.confirmed;
    const remoteConfirmedChanged = rt ? bt.confirmed !== rt.confirmed : false;
    if (localConfirmedChanged && remoteConfirmedChanged) {
      conflict = true;
      localConfirmed[lt.id] = lt.confirmed;
    } else if (localConfirmedChanged) {
      const target = result.find((t) => t.id === lt.id);
      if (target) target.confirmed = lt.confirmed;
    }
    // 其他字段（source/target/required）：仅本地改动时并入
    for (const field of ["source", "target", "required"] as const) {
      const localChanged = bt[field] !== lt[field];
      const remoteChanged = rt ? bt[field] !== rt[field] : false;
      if (localChanged && !remoteChanged) {
        const target = result.find((t) => t.id === lt.id);
        if (target) (target as unknown as Record<string, unknown>)[field] = lt[field];
      }
    }
  }

  // 本地删除、远端未改动的术语 → 应用本地删除；远端改动过的保留远端
  for (let i = result.length - 1; i >= 0; i -= 1) {
    const term = result[i];
    const bt = baseMap.get(term.id);
    const localHas = local.some((t) => t.id === term.id);
    const remoteHas = remoteMap.has(term.id);
    if (bt && !localHas && !remoteHas) {
      result.splice(i, 1);
    }
  }

  return { terms: result, conflict, localConfirmed };
}

/** 按 id 合并评论/版本等带 id 的条目：以远端为底，并入本地新增。 */
function unionById<T extends { id: string }>(base: T[], remote: T[], local: T[]): T[] {
  const result = structuredClone(remote);
  const resultIds = new Set(result.map((item) => item.id));
  const baseIds = new Set(base.map((item) => item.id));
  for (const item of local) {
    if (resultIds.has(item.id)) continue;
    // 远端已删除（base 有、remote 无）的不重新并入；本地新增的并入
    if (!baseIds.has(item.id)) {
      result.push(structuredClone(item));
      resultIds.add(item.id);
    }
  }
  return result;
}

function latestIso(a: string, b: string, c: string): string {
  return [a, b, c].sort().at(-1) ?? a;
}

/** 合并单个标识。以远端（较新保存）为底，只并入本地真正改过的字段。 */
function mergeSign(base: SignItem, remote: SignItem, local: SignItem): { sign: SignItem; conflict: SignConflict | null } {
  const merged: SignItem = structuredClone(remote);
  const reasons: string[] = [];
  const localCopy: SignConflict["local"] = {};

  // 译文
  const localTargetChanged = base.targetText !== local.targetText;
  const remoteTargetChanged = base.targetText !== remote.targetText;
  if (localTargetChanged && remoteTargetChanged) {
    reasons.push("译文");
    localCopy.targetText = local.targetText;
  } else if (localTargetChanged) {
    merged.targetText = local.targetText;
  }

  // 审校状态
  const localStatusChanged = base.status !== local.status;
  const remoteStatusChanged = base.status !== remote.status;
  if (localStatusChanged && remoteStatusChanged) {
    reasons.push("审校状态");
    localCopy.status = local.status;
  } else if (localStatusChanged) {
    merged.status = local.status;
  }

  // 术语确认
  const termMerge = mergeTerms(base.terms, remote.terms, local.terms);
  merged.terms = termMerge.terms;
  if (termMerge.conflict) {
    reasons.push("术语确认");
    localCopy.termConfirmed = termMerge.localConfirmed;
  }

  // 评论与版本：按 id 合并，保留双方新增
  merged.comments = unionById(base.comments, remote.comments, local.comments);
  merged.versions = unionById(base.versions, remote.versions, local.versions).slice(0, MAX_VERSIONS);

  // 非冲突标量字段：仅本地改动时并入；远端也动过则保留远端
  for (const field of ["sourceText", "targetLanguage", "scenario", "regulation", "emergencyRevision"] as const) {
    const localChanged = base[field] !== local[field];
    const remoteChanged = base[field] !== remote[field];
    if (localChanged && !remoteChanged) {
      (merged as unknown as Record<string, unknown>)[field] = local[field];
    }
  }

  merged.updatedAt = latestIso(base.updatedAt, remote.updatedAt, local.updatedAt);

  let conflict: SignConflict | null = null;
  if (reasons.length > 0) {
    conflict = {
      id: uid("conflict"),
      detectedAt: new Date().toISOString(),
      reasons,
      local: localCopy,
    };
    merged.status = "pending";
    merged.conflicts = [...(Array.isArray(merged.conflicts) ? merged.conflicts : []), conflict];
  }

  return { sign: merged, conflict };
}

/** 合并两个项目：base 是本地基于的旧状态，remote 是存储中较新的状态，local 是当前编辑。 */
export function mergeProjects(
  base: SignProject,
  remote: SignProject,
  local: SignProject,
): { project: SignProject; conflicts: string[] } {
  const merged: SignProject = structuredClone(remote);
  const conflicts: string[] = [];

  // 项目级标量字段：仅本地改动时并入
  for (const field of ["title", "location"] as const) {
    const localChanged = base[field] !== local[field];
    const remoteChanged = base[field] !== remote[field];
    if (localChanged && !remoteChanged) {
      merged[field] = local[field];
    }
  }
  const localActiveChanged = base.activeSignId !== local.activeSignId;
  const remoteActiveChanged = base.activeSignId !== remote.activeSignId;
  if (localActiveChanged && !remoteActiveChanged) {
    merged.activeSignId = local.activeSignId;
  }

  const baseMap = new Map(base.signs.map((s) => [s.id, s]));
  const mergedSigns: SignItem[] = [];
  const processed = new Set<string>();

  // 以远端标识为底
  for (const remoteSign of remote.signs) {
    const localSign = local.signs.find((s) => s.id === remoteSign.id);
    const baseSign = baseMap.get(remoteSign.id);
    if (localSign && baseSign) {
      const { sign, conflict } = mergeSign(baseSign, remoteSign, localSign);
      mergedSigns.push(sign);
      if (conflict) conflicts.push(remoteSign.id);
    } else {
      mergedSigns.push(structuredClone(remoteSign));
    }
    processed.add(remoteSign.id);
  }

  // 本地新增的标识（远端没有、base 也没有）→ 并入
  for (const localSign of local.signs) {
    if (processed.has(localSign.id)) continue;
    const baseSign = baseMap.get(localSign.id);
    if (!baseSign) {
      mergedSigns.push(structuredClone(localSign));
    }
  }

  merged.signs = mergedSigns;
  merged.updatedAt = new Date().toISOString();
  return { project: merged, conflicts };
}

/* ------------------------------------------------------------------ */
/* 保存入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 保存当前编辑。
 * - 存储修订号 === 本地基于的修订号：无并发，直接写入。
 * - 存储修订号 > 本地基于的修订号：按条目合并后写入。
 * - 写入失败：回收最早快照重试；仍失败则把编辑留在内存并标记 degraded。
 */
export function saveProject(
  local: SignProject,
  baseRevision: number,
  baseProject: SignProject,
): SaveOutcome {
  const stored = loadFromStorage();
  const storedRevision = stored?.revision ?? 0;

  if (!stored || storedRevision <= baseRevision) {
    // 无并发修改
    const nextRevision = Math.max(storedRevision, baseRevision) + 1;
    const data: PersistedProject = { schema: 1, revision: nextRevision, project: local };
    const attempt = writeWithQuotaRetry(data);
    if (attempt) {
      return {
        ok: true,
        revision: nextRevision,
        writtenProject: attempt.written.project,
        mergedProject: null,
        conflicts: [],
        reclaimed: attempt.reclaimed,
        degraded: false,
      };
    }
    // 写不进：留在内存
    return {
      ok: false,
      revision: storedRevision,
      writtenProject: local,
      mergedProject: null,
      conflicts: [],
      reclaimed: false,
      degraded: true,
    };
  }

  // 并发修改：合并
  const { project: merged, conflicts } = mergeProjects(baseProject, stored.project, local);
  const nextRevision = storedRevision + 1;
  const data: PersistedProject = { schema: 1, revision: nextRevision, project: merged };
  const attempt = writeWithQuotaRetry(data);
  if (attempt) {
    return {
      ok: true,
      revision: nextRevision,
      writtenProject: attempt.written.project,
      mergedProject: attempt.written.project,
      conflicts,
      reclaimed: attempt.reclaimed,
      degraded: false,
    };
  }
  // 合并后仍写不进：把合并结果留在内存
  return {
    ok: false,
    revision: storedRevision,
    writtenProject: merged,
    mergedProject: merged,
    conflicts,
    reclaimed: false,
    degraded: true,
  };
}

/** 判断两个项目是否实质相同（用于跳过无意义的重复保存）。 */
export function projectsEqual(a: SignProject, b: SignProject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
