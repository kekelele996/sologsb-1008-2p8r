export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface TermBinding {
  id: string;
  source: string;
  target: string;
  required: boolean;
  confirmed: boolean;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
}

export interface SignItem {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  emergencyRevision: boolean;
  updatedAt: string;
}

/**
 * 并发保存时双方都改动过同一字段，自动合并无法取舍，
 * 于是把两边的值都留成待确认冲突，由人选择采用哪一份。
 */
export type ConflictScope = "project" | "sign";
export type ConflictKind = "field" | "term";

export interface SetFieldConflictAction {
  type: "setField";
  scope: ConflictScope;
  signId?: string;
  field: string;
  value: unknown;
}

export interface SetTermConflictAction {
  type: "setTerm";
  signId: string;
  termId: string;
  value: Pick<TermBinding, "source" | "target" | "required" | "confirmed">;
}

export interface DeleteTermConflictAction {
  type: "deleteTerm";
  signId: string;
  termId: string;
}

export type ConflictAction =
  | SetFieldConflictAction
  | SetTermConflictAction
  | DeleteTermConflictAction;

export interface PendingConflict {
  /** 确定性 ID：同一处分歧在多次合并间保持稳定，避免重复堆积 */
  id: string;
  scope: ConflictScope;
  kind: ConflictKind;
  signId?: string;
  termId?: string;
  field?: string;
  label: string;
  localText: string;
  remoteText: string;
  localAction: ConflictAction;
  remoteAction: ConflictAction;
  createdAt: string;
}

/** 人工裁定记录：记下被舍弃的旧值，防止落后标签页把旧值再并回来。 */
export interface ConflictResolution {
  id: string;
  scope: ConflictScope;
  kind: ConflictKind;
  signId?: string;
  termId?: string;
  field?: string;
  droppedValue: unknown;
  at: string;
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  /** 单调递增修订号：每次成功写入本地 +1 */
  revision: number;
  /** 尚未人工裁定的并发冲突 */
  pendingConflicts: PendingConflict[];
  /** 冲突裁定历史，用于拦截旧值回流 */
  resolutions: ConflictResolution[];
  updatedAt: string;
}

export interface PersistedProject {
  schema: 2;
  project: SignProject;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
