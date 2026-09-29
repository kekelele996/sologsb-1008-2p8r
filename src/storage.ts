import type {
  ConflictAction,
  ConflictResolution,
  PendingConflict,
  SignItem,
  SignProject,
  TermBinding,
} from "./types";

export const STORAGE_KEY = "sologsb-1008-project-v1";

/* ------------------------------------------------------------------ */
/* 旧数据兼容：没有修订号的存档在打开时直接接入为第 0 版基线            */
/* ------------------------------------------------------------------ */

type LegacyPersisted = { schema?: number; project?: Partial<SignProject> };

export function migrateProject(raw: unknown): SignProject | null {
  if (!raw || typeof raw !== "object") return null;
  const wrapper = raw as LegacyPersisted;
  const candidate = (wrapper.project ?? wrapper) as Partial<SignProject> | null;
  if (!candidate || !Array.isArray(candidate.signs) || candidate.signs.length === 0) {
    return null;
  }
  const project = candidate as SignProject;
  if (typeof project.revision !== "number") {
    // 旧版本没有修订号：视为第 0 版基线，之后的修改从 1 开始记账。
    project.revision = 0;
  }
  if (!Array.isArray(project.pendingConflicts)) project.pendingConflicts = [];
  if (!Array.isArray(project.resolutions)) project.resolutions = [];
  for (const sign of project.signs) {
    if (!Array.isArray(sign.terms)) sign.terms = [];
    if (!Array.isArray(sign.comments)) sign.comments = [];
    if (!Array.isArray(sign.versions)) sign.versions = [];
  }
  return project;
}

/* ------------------------------------------------------------------ */
/* 通用比较                                                            */
/* ------------------------------------------------------------------ */

function sameValue(a: unknown, b: unknown) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

const DELETE_MARKER = "__deleted__";

function termValue(term: TermBinding): Pick<TermBinding, "source" | "target" | "required" | "confirmed"> {
  return { source: term.source, target: term.target, required: term.required, confirmed: term.confirmed };
}

/* ------------------------------------------------------------------ */
/* 冲突文案                                                            */
/* ------------------------------------------------------------------ */

const PROJECT_FIELD_LABELS: Record<string, string> = {
  title: "项目名称",
  location: "项目地点",
};

const SIGN_FIELD_LABELS: Record<string, string> = {
  sourceText: "中文原文",
  targetText: "译文",
  status: "审校状态",
  targetLanguage: "目标语言",
  scenario: "适用场景",
  regulation: "法规提示",
  emergencyRevision: "紧急修订标记",
};

const TERM_FIELD_LABELS: Record<string, string> = {
  source: "术语原文",
  target: "术语译法",
  required: "必选标记",
  confirmed: "术语确认",
};

const STATUS_TEXT: Record<string, string> = {
  draft: "草稿",
  pending: "待确认",
  confirmed: "已确认",
  changes: "需修改",
};

function displayValue(value: unknown, field?: string) {
  if (field === "status" && typeof value === "string") return STATUS_TEXT[value] ?? value;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return value === "" ? "（空）" : value;
  if (value === undefined || value === null) return "（无）";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function conflictId(parts: (string | undefined)[]) {
  return `conflict-${parts.filter(Boolean).join("~")}`;
}

function makeFieldConflict(
  scope: "project" | "sign",
  sign: SignItem | undefined,
  field: string,
  label: string,
  localValue: unknown,
  remoteValue: unknown,
  at: string,
): PendingConflict {
  const mk = (value: unknown): ConflictAction => ({ type: "setField", scope, signId: sign?.id, field, value });
  return {
    id: conflictId(["field", scope, sign?.id, field]),
    scope,
    kind: "field",
    signId: sign?.id,
    field,
    label,
    localText: displayValue(localValue, field),
    remoteText: displayValue(remoteValue, field),
    localAction: mk(localValue),
    remoteAction: mk(remoteValue),
    createdAt: at,
  };
}

function makeTermConflict(
  sign: SignItem,
  termId: string,
  local: TermBinding | undefined,
  remote: TermBinding | undefined,
  at: string,
  divergentFields: string[],
): PendingConflict {
  const text = (term: TermBinding | undefined) =>
    term
      ? `${term.source} → ${term.target}${term.required ? " · 必选" : ""}${term.confirmed ? " · 已确认" : " · 未确认"}`
      : "（已删除）";
  const sourceName = local?.source ?? remote?.source ?? termId;
  const detail = divergentFields.length ? `（分歧：${divergentFields.map((name) => TERM_FIELD_LABELS[name] ?? name).join("、")}）` : "";
  return {
    id: conflictId(["term", sign.id, termId]),
    scope: "sign",
    kind: "term",
    signId: sign.id,
    termId,
    label: `${sign.code} · 术语「${sourceName}」${detail}`,
    localText: text(local),
    remoteText: text(remote),
    localAction: local
      ? { type: "setTerm", signId: sign.id, termId, value: termValue(local) }
      : { type: "deleteTerm", signId: sign.id, termId },
    remoteAction: remote
      ? { type: "setTerm", signId: sign.id, termId, value: termValue(remote) }
      : { type: "deleteTerm", signId: sign.id, termId },
    createdAt: at,
  };
}

/* ------------------------------------------------------------------ */
/* 裁定记录：用来拦住落后标签页把已裁定的旧值再写回来                   */
/* ------------------------------------------------------------------ */

function resolutionMatches(
  resolutions: ConflictResolution[],
  scope: "project" | "sign",
  signId: string | undefined,
  key: string,
  droppedValue: unknown,
) {
  return resolutions.some(
    (record) =>
      record.scope === scope &&
      record.signId === signId &&
      (record.field ?? record.termId) === key &&
      sameValue(record.droppedValue, droppedValue),
  );
}

/* ------------------------------------------------------------------ */
/* 三方合并                                                             */
/* ------------------------------------------------------------------ */

const PROJECT_FIELDS = ["title", "location"] as const;
const SIGN_FIELDS = [
  "sourceText",
  "targetText",
  "targetLanguage",
  "scenario",
  "regulation",
  "status",
  "emergencyRevision",
] as const;
const TERM_FIELDS = ["source", "target", "required", "confirmed"] as const;

export interface MergeResult {
  merged: SignProject;
  newConflicts: PendingConflict[];
}

/**
 * 以先保存的 remote 为底，只把落后一方（local）相对共同祖先 base
 * 真正改过的条目和字段并进去；同一字段两边都改成不同值时挂待确认冲突。
 */
export function mergeProjects(
  base: SignProject,
  local: SignProject,
  remote: SignProject,
  resolutions: ConflictResolution[] = remote.resolutions ?? [],
): MergeResult {
  const merged: SignProject = structuredClone(remote);
  const newConflicts: PendingConflict[] = [];
  const now = new Date().toISOString();

  const addConflict = (conflict: PendingConflict) => {
    if (!newConflicts.some((item) => item.id === conflict.id)) newConflicts.push(conflict);
  };

  // 项目级字段
  for (const field of PROJECT_FIELDS) {
    const b = (base as unknown as Record<string, unknown>)[field];
    const l = (local as unknown as Record<string, unknown>)[field];
    const r = (merged as unknown as Record<string, unknown>)[field];
    if (sameValue(l, b) || sameValue(l, r)) continue; // 本地没改 / 两边一致
    if (sameValue(r, b)) {
      // 只有本地改了，但先确认这不是已被人工裁定掉的旧值回流
      if (resolutionMatches(resolutions, "project", undefined, field, l)) continue;
      (merged as unknown as Record<string, unknown>)[field] = l;
    } else {
      // 双方都改成不同值；若本地持有的正是已被裁定舍弃的旧值，按裁定结果走
      if (resolutionMatches(resolutions, "project", undefined, field, l)) continue;
      addConflict(
        makeFieldConflict("project", undefined, field, PROJECT_FIELD_LABELS[field] ?? field, l, r, now),
      );
    }
  }

  for (const baseSign of base.signs) {
    const localSign = local.signs.find((sign) => sign.id === baseSign.id);
    const mergedSign = merged.signs.find((sign) => sign.id === baseSign.id);
    if (!localSign || !mergedSign) continue;

    // 标识级标量字段
    for (const field of SIGN_FIELDS) {
      const b = (baseSign as unknown as Record<string, unknown>)[field];
      const l = (localSign as unknown as Record<string, unknown>)[field];
      const r = (mergedSign as unknown as Record<string, unknown>)[field];
      if (sameValue(l, b)) continue;
      if (sameValue(l, r)) continue;
      if (sameValue(r, b)) {
        if (resolutionMatches(resolutions, "sign", mergedSign.id, field, l)) continue;
        (mergedSign as unknown as Record<string, unknown>)[field] = l;
      } else {
        if (resolutionMatches(resolutions, "sign", mergedSign.id, field, l)) continue;
        addConflict(
          makeFieldConflict(
            "sign",
            mergedSign,
            field,
            `${mergedSign.code} · ${SIGN_FIELD_LABELS[field] ?? field}`,
            l,
            r,
            now,
          ),
        );
      }
    }

    // updatedAt 取较新
    if (localSign.updatedAt > mergedSign.updatedAt) mergedSign.updatedAt = localSign.updatedAt;

    mergeTerms(baseSign, localSign, mergedSign, resolutions, addConflict, now);
    mergeComments(baseSign, localSign, mergedSign, resolutions, addConflict, now);
    mergeVersions(localSign, mergedSign);
  }

  // 本页选中的标识属于本页视图状态，不作为冲突
  if (merged.signs.some((sign) => sign.id === local.activeSignId)) {
    merged.activeSignId = local.activeSignId;
  } else if (!merged.signs.some((sign) => sign.id === merged.activeSignId)) {
    merged.activeSignId = merged.signs[0]?.id ?? "";
  }

  merged.pendingConflicts = pruneResolvedConflicts(
    dedupeConflicts(merged.pendingConflicts ?? [], newConflicts),
  );
  merged.resolutions = remote.resolutions ?? [];
  return { merged, newConflicts };
}

function dedupeConflicts(existing: PendingConflict[], additions: PendingConflict[]) {
  const seen = new Set(existing.map((conflict) => conflict.id));
  for (const conflict of additions) {
    if (!seen.has(conflict.id)) {
      existing.push(conflict);
      seen.add(conflict.id);
    }
  }
  return existing;
}

/** 两边的待确认值已经趋同（后来又改成一致）的冲突自动消失。 */
function pruneResolvedConflicts(conflicts: PendingConflict[]) {
  return conflicts.filter((conflict) => {
    const a = conflict.localAction;
    const b = conflict.remoteAction;
    if (a.type === "setField" && b.type === "setField") return !sameValue(a.value, b.value);
    if (a.type === "setTerm" && b.type === "setTerm") return !sameValue(a.value, b.value);
    return true; // 删除 vs 保留必须人工裁定
  });
}

function mergeTerms(
  baseSign: SignItem,
  localSign: SignItem,
  mergedSign: SignItem,
  resolutions: ConflictResolution[],
  addConflict: (conflict: PendingConflict) => void,
  now: string,
) {
  const baseMap = new Map(baseSign.terms.map((term) => [term.id, term]));
  const localMap = new Map(localSign.terms.map((term) => [term.id, term]));
  const remoteMap = new Map(mergedSign.terms.map((term) => [term.id, term]));
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  for (const termId of ids) {
    const bt = baseMap.get(termId);
    const lt = localMap.get(termId);
    const rt = remoteMap.get(termId);

    const localChanged = (!bt && lt) || (bt && !lt) || (bt && lt && !sameValue(termValue(bt), termValue(lt)));
    const remoteChanged = (!bt && rt) || (bt && !rt) || (bt && rt && !sameValue(termValue(bt), termValue(rt)));
    if (!localChanged) continue;

    const localDropped = resolutionMatches(
      resolutions,
      "sign",
      mergedSign.id,
      termId,
      lt ? termValue(lt) : DELETE_MARKER,
    );
    if (!remoteChanged || sameValue(lt, rt)) {
      if (localDropped && !sameValue(lt, rt)) continue; // 旧值已被裁定掉
      applyTermState(mergedSign, termId, lt);
      continue;
    }

    if (localDropped) continue;

    if (!lt || !rt) {
      // 一边删除、一边编辑/新增：两份都留着待确认
      addConflict(makeTermConflict(mergedSign, termId, lt, rt, now, []));
      continue;
    }

    // 两边都改了：逐字段自动合并，只对真正分歧的字段挂冲突
    const mergedTerm: TermBinding = { ...rt };
    const divergent: string[] = [];
    for (const field of TERM_FIELDS) {
      const bv = bt ? (bt as unknown as Record<string, unknown>)[field] : undefined;
      const lv = (lt as unknown as Record<string, unknown>)[field];
      const rv = (rt as unknown as Record<string, unknown>)[field];
      if (sameValue(lv, bv) || sameValue(lv, rv)) continue;
      if (sameValue(rv, bv)) mergedTerm[field] = lv as never;
      else divergent.push(field);
    }
    applyTermState(mergedSign, termId, mergedTerm);
    if (divergent.length) addConflict(makeTermConflict(mergedSign, termId, lt, rt, now, divergent));
  }
}

function applyTermState(sign: SignItem, termId: string, term: TermBinding | undefined) {
  if (!term) {
    sign.terms = sign.terms.filter((item) => item.id !== termId);
    return;
  }
  const index = sign.terms.findIndex((item) => item.id === termId);
  if (index >= 0) sign.terms[index] = term;
  else sign.terms.push(term);
}

function mergeComments(
  baseSign: SignItem,
  localSign: SignItem,
  mergedSign: SignItem,
  resolutions: ConflictResolution[],
  addConflict: (conflict: PendingConflict) => void,
  now: string,
) {
  // 新增意见整条并入（按 id 去重）
  for (const comment of localSign.comments) {
    if (!mergedSign.comments.some((item) => item.id === comment.id)) {
      mergedSign.comments.push(structuredClone(comment));
    }
  }
  // 回复整条并入；resolved 状态三方合并
  for (const localComment of localSign.comments) {
    const baseComment = baseSign.comments.find((item) => item.id === localComment.id);
    const remoteComment = mergedSign.comments.find((item) => item.id === localComment.id);
    if (!remoteComment) continue;
    for (const reply of localComment.replies) {
      if (!remoteComment.replies.some((item) => item.id === reply.id)) {
        remoteComment.replies.push(structuredClone(reply));
      }
    }
    if (!baseComment) continue;
    if (localComment.resolved !== baseComment.resolved) {
      const field = `commentResolved:${localComment.id}`;
      const stale = resolutionMatches(resolutions, "sign", mergedSign.id, field, localComment.resolved);
      if (stale) continue;
      if (remoteComment.resolved === baseComment.resolved && localComment.resolved !== remoteComment.resolved) {
        remoteComment.resolved = localComment.resolved;
      } else if (localComment.resolved !== remoteComment.resolved) {
        const field = `commentResolved:${localComment.id}`;
        const conflict = makeFieldConflict(
          "sign",
          mergedSign,
          field,
          `${mergedSign.code} · 审校意见「${localComment.body.slice(0, 12)}…」解决状态`,
          localComment.resolved,
          remoteComment.resolved,
          now,
        );
        addConflict(conflict);
      }
    }
  }
  mergedSign.comments.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function mergeVersions(localSign: SignItem, mergedSign: SignItem) {
  for (const version of localSign.versions) {
    if (!mergedSign.versions.some((item) => item.id === version.id)) {
      mergedSign.versions.push(structuredClone(version));
    }
  }
  mergedSign.versions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  mergedSign.versions = mergedSign.versions.slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* 冲突裁定                                                            */
/* ------------------------------------------------------------------ */

export function applyConflictAction(project: SignProject, action: ConflictAction) {
  if (action.type === "setField") {
    if (action.scope === "project") {
      (project as unknown as Record<string, unknown>)[action.field] = action.value;
      return;
    }
    const sign = project.signs.find((item) => item.id === action.signId);
    if (!sign) return;
    if (action.field.startsWith("commentResolved:")) {
      const commentId = action.field.split(":")[1];
      const comment = sign.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = Boolean(action.value);
    } else {
      (sign as unknown as Record<string, unknown>)[action.field] = action.value;
    }
    return;
  }
  const sign = project.signs.find((item) => item.id === action.signId);
  if (!sign) return;
  if (action.type === "setTerm") {
    const index = sign.terms.findIndex((term) => term.id === action.termId);
    if (index >= 0) sign.terms[index] = { ...sign.terms[index], ...action.value };
    else sign.terms.push({ id: action.termId, ...action.value });
  } else if (action.type === "deleteTerm") {
    sign.terms = sign.terms.filter((term) => term.id !== action.termId);
  }
}

/** 生成裁定记录：记录被舍弃的一方旧值，拦住落后标签页把它再写回来。 */
export function buildResolution(conflict: PendingConflict, accepted: "local" | "remote"): ConflictResolution {
  const rejected = accepted === "local" ? conflict.remoteAction : conflict.localAction;
  const droppedValue =
    rejected.type === "deleteTerm"
      ? DELETE_MARKER
      : rejected.type === "setTerm"
        ? rejected.value
        : rejected.value;
  return {
    id: `resolve-${conflict.id}`,
    scope: conflict.scope,
    kind: conflict.kind,
    signId: conflict.signId,
    termId: conflict.termId,
    field: conflict.field,
    droppedValue,
    at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* 带配额回收与自动重试的本地写入                                      */
/* ------------------------------------------------------------------ */

export interface SaveOutcome {
  status: "saved" | "recovered" | "memory";
  /** 实际落盘的项目（可能因回收快照与入参略有差异） */
  project: SignProject;
  prunedSnapshots: number;
  retried: boolean;
  error?: string;
}

function isQuotaError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; code?: number };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

/**
 * 写入主档：
 * 1. 直接写；
 * 2. 配额不足时先回收全项目最早的一条版本快照，再写，仍不够就继续回收；
 * 3. 快照回收完仍失败，自动重试一次；
 * 4. 再不行返回 memory，由调用方把当前编辑留在内存里并明示用户。
 */
export function persistProject(input: SignProject): SaveOutcome {
  let working: SignProject = structuredClone(input);
  let prunedSnapshots = 0;
  let reclaimed = false;
  let retried = false;

  const serialize = () => JSON.stringify({ schema: 2, project: working });

  const pruneOldestSnapshot = (): boolean => {
    let oldest: { signId: string; versionId: string; createdAt: string } | null = null;
    for (const sign of working.signs) {
      for (const version of sign.versions) {
        if (!oldest || version.createdAt < oldest.createdAt) {
          oldest = { signId: sign.id, versionId: version.id, createdAt: version.createdAt };
        }
      }
    }
    if (!oldest) return false;
    const sign = working.signs.find((item) => item.id === oldest!.signId);
    if (!sign) return false;
    sign.versions = sign.versions.filter((version) => version.id !== oldest!.versionId);
    prunedSnapshots += 1;
    reclaimed = true;
    return true;
  };

  // 状态机：尝试写 → 配额不足就回收一条最早快照再试；快照回收完后整体重试一次
  let success = false;
  let nonQuotaFailure: unknown = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
      success = true;
      break;
    } catch (error) {
      if (!isQuotaError(error)) {
        nonQuotaFailure = error;
        break;
      }
      if (pruneOldestSnapshot()) continue;
      if (!retried) {
        retried = true;
        continue;
      }
      break;
    }
  }

  try {
    if (nonQuotaFailure) throw nonQuotaFailure;
    if (success) {
      return {
        status: reclaimed ? "recovered" : "saved",
        project: working,
        prunedSnapshots,
        retried,
      };
    }
    return {
      status: "memory",
      project: working,
      prunedSnapshots,
      retried,
      error: "本地存储空间不足，回收全部快照并重试后仍无法写入",
    };
  } catch (error) {
    return {
      status: "memory",
      project: working,
      prunedSnapshots,
      retried,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readPersisted(): SignProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrateProject(JSON.parse(raw));
  } catch {
    return null;
  }
}
