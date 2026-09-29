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

/**
 * 同一标识在多个标签页被同时修改时保留的冲突副本。
 * 只记录会触发冲突的三个字段：译文、术语确认、审校状态。
 * 合并时以较新的远端版本为底，本地副本保存在这里，状态强制为待确认。
 */
export interface SignConflict {
  id: string;
  detectedAt: string;
  /** 触发冲突的字段说明，如「译文」「审校状态」「术语确认」 */
  reasons: string[];
  /** 落后一方（本地）在这三个字段上的值，用于「留两份」 */
  local: {
    targetText?: string;
    status?: ReviewStatus;
    /** termId -> confirmed，仅记录被改动过的术语确认 */
    termConfirmed?: Record<string, boolean>;
  };
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
  /** 多标签页合并时留下的冲突副本，空数组表示无冲突 */
  conflicts: SignConflict[];
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  updatedAt: string;
}

export interface PersistedProject {
  schema: 1;
  /** 单调递增的修订号，用于检测并发修改并触发按条目合并；旧数据可能缺失，按 0 兼容 */
  revision: number;
  project: SignProject;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
