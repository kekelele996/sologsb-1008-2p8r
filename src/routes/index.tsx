import { $, component$, useSignal, useVisibleTask$, type QRL } from "@builder.io/qwik";
import { type DocumentHead } from "@builder.io/qwik-city";
import { createSeedProject, STATUS_LABELS, uid } from "../data";
import type { PendingConflict, ReviewStatus, SignItem, SignProject } from "../types";
import { analyzeSign, cloneTerms, diffText } from "../utils";
import {
  STORAGE_KEY,
  applyConflictAction,
  buildResolution,
  mergeProjects,
  migrateProject,
  persistProject,
  readPersisted,
} from "../storage";

const WIDTHS = [320, 480, 720, 960] as const;

export const head: DocumentHead = {
  title: "公共标识多语言校对台",
  meta: [
    { name: "description", content: "公共标识译文、术语、版本和版面风险校对工作台" },
  ],
};

function statusClass(status: ReviewStatus) {
  if (status === "confirmed") return "badge-success";
  if (status === "changes") return "badge-error";
  if (status === "pending") return "badge-warning";
  return "badge-neutral";
}

/**
 * 以共同祖先 base 为参照，把本页编辑并入已存档版本并分配新修订号。
 * 纯函数，页面卸载前的同步保存也走这里。
 */
function prepareSave(base: SignProject, localDraft: SignProject, stored: SignProject | null) {
  let next: SignProject = structuredClone(localDraft);
  let mergedIn = false;
  let conflictCount = 0;
  if (stored && stored.revision > base.revision) {
    const result = mergeProjects(base, next, stored, stored.resolutions ?? []);
    next = result.merged;
    mergedIn = true;
    conflictCount = result.newConflicts.length;
  }
  next.revision = (stored ? stored.revision : base.revision) + 1;
  next.updatedAt = new Date().toISOString();
  return { next, mergedIn, conflictCount, storedRevision: stored ? stored.revision : base.revision };
}

/** 模块级纯函数：供 useVisibleTask$ 闭包使用，避免被 Qwik 状态序列化器当成函数捕获 */
function projectUnchanged(a: SignProject, b: SignProject) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default component$(() => {
  const project = useSignal<SignProject>(createSeedProject());
  /** 本标签页加载/上次成功保存时的共同祖先，三方合并靠它区分“谁真改过” */
  const baseline = useSignal<SignProject>(structuredClone(project.value));
  const past = useSignal<SignProject[]>([]);
  const future = useSignal<SignProject[]>([]);
  const hydrated = useSignal(false);
  const online = useSignal(true);
  const saving = useSignal(false);
  const saveState = useSignal<"" | "recovered" | "memory">("");
  const saveDetail = useSignal("");
  const mergeNote = useSignal("");
  const remoteSavedNotice = useSignal(false);
  const previewWidth = useSignal(480);
  const previewFont = useSignal(42);
  const selectedVersionId = useSignal("");
  const termSource = useSignal("");
  const termTarget = useSignal("");
  const commentDraft = useSignal("");
  const replyDraft = useSignal("");
  const replyingTo = useSignal("");
  const toast = useSignal("");
  const previewId = useSignal("");
  const readOnly = useSignal(false);
  const active = () => project.value.signs.find((sign) => sign.id === (previewId.value || project.value.activeSignId)) ?? project.value.signs[0];

  /** 保存：检测更新的存档→按条目合并→落盘；空间不足时回收+重试，再不行留在内存。 */
  const persistNow: QRL<() => void> = $(() => {
    if (!hydrated.value || readOnly.value || saving.value) return;
    if (projectUnchanged(project.value, baseline.value)) return;
    saving.value = true;
    try {
      const stored = readPersisted();
      const { next, mergedIn, conflictCount, storedRevision } = prepareSave(baseline.value, project.value, stored);
      const outcome = persistProject(next);
      if (outcome.status === "memory") {
        // 写入彻底失败：当前编辑继续留在内存（页面仍可编辑），并明示用户。
        // 修订号不推进，等真正落盘成功时再占用下一个号，避免重试导致跳号。
        outcome.project.revision = storedRevision;
        project.value = outcome.project;
        saveState.value = "memory";
        saveDetail.value = outcome.error ?? "本地存储空间不足";
      } else {
        project.value = outcome.project;
        baseline.value = structuredClone(outcome.project);
        if (outcome.status === "recovered") {
          saveState.value = "recovered";
          saveDetail.value = `本地空间不足，已回收最早的 ${outcome.prunedSnapshots} 条版本快照后完成保存`;
        } else if (saveState.value === "memory") {
          // 之前写不下、只在内存里的编辑终于落盘，明确告知用户
          saveState.value = "recovered";
          saveDetail.value = "存储空间已恢复，此前只保留在内存中的改动现已保存";
        } else {
          saveDetail.value = "";
        }
        if (mergedIn) {
          mergeNote.value = conflictCount
            ? `已并入另一处保存的改动，其中 ${conflictCount} 处双方都改过，已列为待确认`
            : "已并入另一处保存的改动";
          toast.value = mergeNote.value;
        }
      }
    } finally {
      saving.value = false;
    }
  });

  const resolveConflict = $((conflictId: string, side: "local" | "remote") => {
    const conflict = project.value.pendingConflicts.find((item) => item.id === conflictId);
    if (!conflict) return;
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = [];
    const draft = structuredClone(project.value);
    const current = draft.pendingConflicts.find((item) => item.id === conflictId)!;
    applyConflictAction(draft, side === "local" ? current.localAction : current.remoteAction);
    const resolution = buildResolution(current, side);
    draft.resolutions = [...draft.resolutions.filter((item) => item.id !== resolution.id), resolution].slice(-100);
    draft.pendingConflicts = draft.pendingConflicts.filter((item) => item.id !== conflictId);
    draft.updatedAt = new Date().toISOString();
    project.value = draft;
    toast.value = "已按所选内容采纳，保存后对其他标签页生效";
  });

  const focusConflict = $((conflict: PendingConflict) => {
    if (conflict.signId && project.value.activeSignId !== conflict.signId) {
      const draft = structuredClone(project.value);
      draft.activeSignId = conflict.signId;
      project.value = draft;
    }
    selectedVersionId.value = "";
  });

  const scrollToConflicts = $(() => {
    document.getElementById("conflict-panel")?.scrollIntoView({ behavior: "smooth" });
  });

  const commit = $((label: string, update: (draft: SignProject) => void) => {
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = [];
    const draft = structuredClone(project.value);
    update(draft);
    draft.updatedAt = new Date().toISOString();
    project.value = draft;
  });

  const updateActive = $((label: string, update: (sign: SignItem, draft: SignProject) => void) => {
    commit(label, (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (sign) update(sign, draft);
    });
  });

  const undo = $(() => {
    if (!past.value.length) return;
    const previous = past.value.at(-1)!;
    future.value = [structuredClone(project.value), ...future.value].slice(0, 50);
    past.value = past.value.slice(0, -1);
    project.value = previous;
    toast.value = "已撤销";
  });

  const redo = $(() => {
    if (!future.value.length) return;
    const next = future.value[0];
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = future.value.slice(1);
    project.value = next;
    toast.value = "已重做";
  });

  const navigateSign = $((direction: 1 | -1) => {
    if (readOnly.value) return;
    const signs = project.value.signs;
    const index = Math.max(0, signs.findIndex((sign) => sign.id === project.value.activeSignId));
    const next = signs[(index + direction + signs.length) % signs.length];
    commit("切换标识", (draft) => { draft.activeSignId = next.id; });
    selectedVersionId.value = "";
  });

  const setStatus = $((status: ReviewStatus) => {
    commit("更新审校状态", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      if (sign.emergencyRevision && status === "confirmed") {
        sign.status = "pending";
      } else {
        sign.status = status;
      }
    });
  });

  const toggleEmergency = $(() => {
    commit("切换紧急修订", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      sign.emergencyRevision = !sign.emergencyRevision;
      if (sign.emergencyRevision) sign.status = "changes";
    });
  });

  const saveVersion = $(() => {
    const sign = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!sign) return;
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      const current = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!current) return;
      current.versions.unshift({
        id: versionId,
        label: `版本 ${current.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        sourceText: current.sourceText,
        targetText: current.targetText,
        status: current.status,
        terms: cloneTerms(current.terms),
      });
      current.versions = current.versions.slice(0, 12);
    });
    selectedVersionId.value = versionId;
    toast.value = "版本快照已保存";
  });

  const addTerm = $(() => {
    const source = termSource.value.trim();
    const target = termTarget.value.trim();
    if (!source || !target) return;
    updateActive("绑定术语", (sign) => {
      sign.terms.push({ id: uid("term"), source, target, required: true, confirmed: false });
      sign.status = "pending";
    });
    termSource.value = "";
    termTarget.value = "";
  });

  const addComment = $(() => {
    const body = commentDraft.value.trim();
    if (!body) return;
    updateActive("添加审校意见", (sign) => {
      sign.comments.unshift({
        id: uid("comment"),
        author: "当前审校员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      sign.status = sign.status === "confirmed" ? "changes" : sign.status;
    });
    commentDraft.value = "";
  });

  const addReply = $((commentId: string) => {
    const body = replyDraft.value.trim();
    if (!body) return;
    updateActive("回复审校意见", (sign) => {
      const comment = sign.comments.find((item) => item.id === commentId);
      comment?.replies.push({ id: uid("reply"), author: "当前审校员", body, createdAt: new Date().toISOString() });
    });
    replyDraft.value = "";
    replyingTo.value = "";
  });

  const sharePreview: QRL<() => void> = $(() => {
    const current = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?preview=${encodeURIComponent(current.id)}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    toast.value = "只读预览链接已复制";
  });

  const preview = () => analyzeSign(active(), previewWidth.value, previewFont.value);
  const selectedVersion = () => active().versions.find((version) => version.id === selectedVersionId.value) ?? active().versions[0];
  const comparison = () => {
    const version = selectedVersion();
    return version ? diffText(version.targetText, active().targetText) : [];
  };

  useVisibleTask$(({ track }) => {
    track(() => hydrated.value);
    if (!hydrated.value) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const stored = migrateProject(raw ? JSON.parse(raw) : null);
        if (stored) {
          project.value = stored;
          baseline.value = structuredClone(stored);
        }
        const requestedPreview = new URLSearchParams(window.location.search).get("preview") ?? "";
        previewId.value = requestedPreview;
        readOnly.value = Boolean(requestedPreview);
      } catch {
        // Keep bundled sample data when storage is unavailable or malformed.
      }
      hydrated.value = true;
    }
  });

  // 自动保存：合并别人的保存 → 带修订号落盘；空间不足时存储层自动回收快照并重试
  useVisibleTask$(({ track, cleanup }) => {
    track(() => hydrated.value);
    if (!hydrated.value) return;
    track(() => project.value);
    if (readOnly.value) return;
    const timer = window.setTimeout(() => { void persistNow(); }, 450);
    cleanup(() => window.clearTimeout(timer));
  });

  useVisibleTask$(({ cleanup }) => {
    // 另一标签页完成保存：先提示，等本页下次保存时再做三方合并，避免边输入边替换
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue || readOnly.value) return;
      try {
        const remote = migrateProject(JSON.parse(event.newValue));
        if (remote && remote.revision > baseline.value.revision) {
          remoteSavedNotice.value = true;
        }
      } catch {
        // 存档损坏时忽略，下一次保存以本地为准
      }
    };
    // 内存模式下定期重试落盘；页面重新可见或隐藏（关闭/刷新）前也尝试一次
    const retry = () => {
      if (saveState.value === "memory") void persistNow();
    };
    const flushBeforeUnload = () => {
      if (readOnly.value || projectUnchanged(project.value, baseline.value)) return;
      try {
        const stored = readPersisted();
        const { next } = prepareSave(baseline.value, project.value, stored);
        persistProject(next);
      } catch {
        // 关闭时无法再提示，静默保留内存中的编辑直到真正卸载
      }
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", retry);
    window.addEventListener("pagehide", flushBeforeUnload);
    const interval = window.setInterval(retry, 5000);
    cleanup(() => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", retry);
      window.removeEventListener("pagehide", flushBeforeUnload);
      window.clearInterval(interval);
    });
  });

  useVisibleTask$(({ cleanup }) => {
    const updateOnline = () => { online.value = navigator.onLine; };
    updateOnline();
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? undo() : undo();
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        navigateSign(1);
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigateSign(-1);
      } else if (event.key === "[") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.max(0, index - 1)];
      } else if (event.key === "]") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.min(WIDTHS.length - 1, index + 1)];
      } else if (event.key === "-") {
        previewFont.value = Math.max(28, previewFont.value - 4);
      } else if (event.key === "=") {
        previewFont.value = Math.min(88, previewFont.value + 4);
      }
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("keydown", keydown);
    cleanup(() => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("keydown", keydown);
    });
  });

  if (readOnly.value) {
    const sign = active();
    const analysis = analyzeSign(sign, previewWidth.value, previewFont.value);
    return (
      <main data-theme="corporate" class="min-h-screen bg-slate-100 p-6">
        <div class="mx-auto max-w-5xl">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Read-only preview</div>
              <h1 class="text-2xl font-bold text-slate-800">{sign.code} · {sign.scenario}</h1>
            </div>
            <span class={`badge ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
          </div>
          <section class="rounded-3xl bg-white p-14 shadow-xl">
            <div class="mb-3 text-center text-xs text-slate-400">中文原文</div>
            <p class="mx-auto mb-10 max-w-2xl text-center text-lg text-slate-600">{sign.sourceText}</p>
            <div class="mx-auto border-y-4 border-slate-800 py-10 text-center">
              <p class="whitespace-pre-line font-black leading-tight tracking-wide text-slate-900" style={{ fontSize: `${previewFont.value}px` }}>{analysis.visible.join("\n")}</p>
            </div>
            <div class="mt-5 text-center text-sm text-slate-500">{sign.targetLanguage} · {sign.regulation}</div>
          </section>
          <p class="mt-4 text-center text-xs text-slate-400">此链接读取当前浏览器中的本地版本，仅用于演示只读预览。</p>
        </div>
      </main>
    );
  }

  return (
    <div data-theme="corporate" class="min-h-screen bg-slate-100 pb-9 text-slate-800">
      <header class="navbar sticky top-0 z-40 min-h-16 border-b border-slate-700 bg-[#17324d] px-5 text-white shadow-lg">
        <div class="navbar-start gap-3">
          <div class="grid h-10 w-10 place-items-center rounded-xl border border-white/20 bg-white/10 font-black">译</div>
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-sky-200">Public Sign Review</div>
            <div class="font-bold">公共标识多语言校对台</div>
          </div>
        </div>
        <div class="navbar-center hidden xl:flex">
          <input
            class="input input-sm w-80 border-white/15 bg-white/10 text-white placeholder:text-slate-300"
            value={project.value.title}
            onInput$={(_, element) => commit("修改项目名称", (draft) => { draft.title = element.value; })}
            aria-label="项目名称"
          />
        </div>
        <div class="navbar-end gap-2 flex-wrap">
          <span class={`badge ${online.value ? "badge-success" : "badge-warning"} badge-outline`}>{online.value ? "在线" : "离线草稿"}</span>
          <span class="badge badge-outline border-white/30 text-sky-100" title="本地修订号，每次成功保存 +1">
            修订 #{project.value.revision}
            {saveState.value === "memory" ? " · 未落盘" : ""}
          </span>
          {project.value.pendingConflicts.length > 0 && (
            <button
              class="badge badge-warning gap-1"
              title="查看双方都改动过、等待人工裁定的内容"
              onClick$={scrollToConflicts}
            >
              ⚠ 待确认 {project.value.pendingConflicts.length}
            </button>
          )}
          <button class="btn btn-ghost btn-sm" disabled={!past.value.length} onClick$={undo}>撤销</button>
          <button class="btn btn-ghost btn-sm" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button
            class="btn btn-sm border-white/20 bg-white/10 text-white hover:bg-white/20"
            disabled={saving.value}
            onClick$={persistNow}
            title="立即保存到本地"
          >
            {saving.value ? "保存中…" : "保存"}
          </button>
          <button class="btn btn-sm border-white/20 bg-white/10 text-white hover:bg-white/20" onClick$={sharePreview}>复制只读链接</button>
          <button class={`btn btn-sm ${active().emergencyRevision ? "btn-error" : "btn-warning"}`} onClick$={toggleEmergency}>
            {active().emergencyRevision ? "退出紧急修订" : "紧急修订"}
          </button>
        </div>
      </header>

      {saveState.value === "memory" && (
        <div class="alert alert-error sticky top-16 z-30 rounded-none border-x-0 py-2 text-white">
          <span class="text-lg">!</span>
          <span class="flex-1">
            <strong>本地存储空间已满</strong>：{saveDetail.value || "写入失败"}。已回收最早的版本快照并重试，仍无法保存。
            当前改动只保留在本页面内存中，<strong>请勿关闭或刷新标签页</strong>，清理浏览器存储后：
          </span>
          <button class="btn btn-sm btn-outline border-white text-white hover:bg-white/20" onClick$={persistNow}>重试保存</button>
        </div>
      )}

      {saveState.value === "recovered" && (
        <div class="alert alert-warning sticky top-16 z-30 rounded-none border-x-0 py-2" onClick$={() => { saveState.value = ""; }}>
          <span class="text-lg">⚠</span>
          <span class="flex-1">{saveDetail.value}（修订 #{project.value.revision} 已保存）</span>
          <span class="text-xs underline cursor-pointer">知道了</span>
        </div>
      )}

      {remoteSavedNotice.value && saveState.value !== "memory" && (
        <div class="alert alert-info sticky top-16 z-30 rounded-none border-x-0 py-2 text-white" onClick$={() => { remoteSavedNotice.value = false; }}>
          <span class="flex-1">检测到另一标签页已保存更新的修订，本页下次保存时会自动按条目合并，只有双方都改过的字段才会列为待确认。</span>
          <button class="btn btn-xs btn-outline border-white text-white hover:bg-white/20" onClick$={persistNow}>立即合并保存</button>
          <span class="text-xs underline cursor-pointer">知道了</span>
        </div>
      )}

      {active().emergencyRevision && (
        <div class="alert alert-error sticky top-16 z-30 rounded-none border-x-0 py-2 text-white">
          <span class="text-lg">!</span>
          <span><strong>紧急修订模式</strong>：确认操作已锁定，修改后必须重新审校并保存版本。</span>
        </div>
      )}

      {project.value.pendingConflicts.length > 0 && (
        <div id="conflict-panel" class="border-b-4 border-warning bg-amber-50 px-6 py-4">
          <div class="mx-auto max-w-6xl">
            <div class="mb-3 flex items-center justify-between">
              <div>
                <h2 class="text-base font-bold text-amber-900">⚠ 并发修改待确认（{project.value.pendingConflicts.length}）</h2>
                <p class="text-xs text-amber-800">同一内容两边都改过，自动合并无法取舍。两份内容都已保留，请逐条选择采用哪一份。</p>
              </div>
            </div>
            <div class="grid gap-3 lg:grid-cols-2">
              {project.value.pendingConflicts.map((conflict) => (
                <article key={conflict.id} class="rounded-xl border border-amber-300 bg-white p-3 shadow-sm">
                  <div class="mb-2 flex items-center justify-between gap-2">
                    <strong class="text-sm text-slate-800">{conflict.label}</strong>
                    {conflict.signId && (
                      <button class="btn btn-xs btn-ghost" onClick$={() => focusConflict(conflict)}>定位标识</button>
                    )}
                  </div>
                  <div class="grid grid-cols-2 gap-2 text-xs">
                    <div class="rounded-lg border border-sky-200 bg-sky-50 p-2">
                      <div class="mb-1 font-bold text-sky-700">本标签页</div>
                      <p class="max-h-28 overflow-auto whitespace-pre-wrap break-words text-slate-700">{conflict.localText}</p>
                      <button class="btn btn-xs btn-primary mt-2 w-full" onClick$={() => resolveConflict(conflict.id, "local")}>采用本页这份</button>
                    </div>
                    <div class="rounded-lg border border-slate-300 bg-slate-50 p-2">
                      <div class="mb-1 font-bold text-slate-600">另一标签页</div>
                      <p class="max-h-28 overflow-auto whitespace-pre-wrap break-words text-slate-700">{conflict.remoteText}</p>
                      <button class="btn btn-xs mt-2 w-full border-slate-400 text-slate-700" onClick$={() => resolveConflict(conflict.id, "remote")}>采用对方这份</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      )}

      <div class="grid min-h-[calc(100vh-64px)] grid-cols-[270px_minmax(560px,1fr)_430px] gap-px bg-slate-300">
        <aside class="overflow-y-auto bg-slate-50 p-3">
          <div class="mb-3 rounded-xl bg-white p-4 shadow-sm">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">标识清单</div>
            <div class="mt-1 text-lg font-bold text-slate-800">{project.value.signs.length} 处标识</div>
            <p class="mt-1 text-xs leading-5 text-slate-500">{project.value.location}</p>
          </div>
          <div class="space-y-2">
            {project.value.signs.map((sign, index) => {
              const risk = analyzeSign(sign, previewWidth.value, previewFont.value);
              return (
                <button
                  key={sign.id}
                  class={`w-full rounded-xl border p-3 text-left transition ${sign.id === project.value.activeSignId ? "border-blue-400 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
                  onClick$={() => {
                    commit("切换标识", (draft) => { draft.activeSignId = sign.id; });
                    selectedVersionId.value = "";
                  }}
                >
                  <div class="flex items-center justify-between">
                    <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                    <span class={`badge badge-sm ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
                  </div>
                  <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{sign.sourceText}</div>
                  <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{sign.targetLanguage}</span>
                    <span class={risk.risk === "high" ? "font-bold text-error" : risk.risk === "medium" ? "font-bold text-warning" : "text-success"}>
                      {risk.risk === "high" ? "高风险" : risk.risk === "medium" ? "需留意" : "版面正常"}
                    </span>
                  </div>
                  <span class="sr-only">第 {index + 1} 条</span>
                </button>
              );
            })}
          </div>
        </aside>

        <main class="min-w-0 bg-white">
          <div class="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <div class="flex items-start justify-between gap-5">
              <div>
                <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">{active().code} · {active().scenario}</div>
                <h1 class="mt-1 text-xl font-bold">中文原文与译文校对</h1>
              </div>
              <div class="join">
                {(["draft", "pending", "changes", "confirmed"] as ReviewStatus[]).map((status) => (
                  <button key={status} class={`btn join-item btn-sm ${active().status === status ? "btn-primary" : "btn-outline"}`} onClick$={() => setStatus(status)}>{STATUS_LABELS[status]}</button>
                ))}
              </div>
            </div>
          </div>

          <div class="space-y-5 p-6">
            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Source</div><h2 class="font-bold">中文原文</h2></div>
                  <span class="badge badge-ghost">简体中文</span>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-24 w-full text-base leading-7"
                  value={active().sourceText}
                  onInput$={(_, element) => updateActive("修改中文原文", (sign) => { sign.sourceText = element.value; sign.status = "draft"; })}
                />
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="grid grid-cols-2 gap-4">
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">目标语言</span>
                    <select class="select select-bordered" value={active().targetLanguage} onChange$={(_, element) => updateActive("修改目标语言", (sign) => { sign.targetLanguage = element.value; sign.status = "pending"; })}>
                      {["English", "日本語", "Français", "Deutsch", "한국어", "Español"].map((language) => <option key={language}>{language}</option>)}
                    </select>
                  </label>
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">适用场景</span>
                    <input class="input input-bordered" value={active().scenario} onInput$={(_, element) => updateActive("修改适用场景", (sign) => { sign.scenario = element.value; })} />
                  </label>
                </div>
                <label class="form-control">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">法规或规范提示</span>
                  <input class="input input-bordered" value={active().regulation} onInput$={(_, element) => updateActive("修改法规提示", (sign) => { sign.regulation = element.value; })} />
                </label>
                <div class="divider my-0"></div>
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-500">Target</div><h2 class="font-bold">目标语言译文</h2></div>
                  <button class="btn btn-sm btn-outline" onClick$={saveVersion}>保存版本快照</button>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-36 w-full text-lg leading-8"
                  value={active().targetText}
                  onInput$={(_, element) => updateActive("修改译文", (sign) => { sign.targetText = element.value; sign.status = sign.emergencyRevision ? "changes" : "pending"; })}
                />
                <div class="flex flex-wrap gap-2">
                  {active().terms.map((term) => {
                    const matched = active().targetText.toLocaleLowerCase().includes(term.target.toLocaleLowerCase());
                    return (
                      <button
                        key={term.id}
                        title="点击切换术语确认状态"
                        class={`badge badge-lg gap-1 ${matched && term.confirmed ? "badge-success" : matched ? "badge-warning" : "badge-error"}`}
                        onClick$={() => updateActive("确认术语", (sign) => {
                          const current = sign.terms.find((item) => item.id === term.id);
                          if (current) current.confirmed = !current.confirmed;
                        })}
                      >
                        {term.source} → {term.target} {matched ? (term.confirmed ? "✓" : "!") : "×"}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">术语绑定</h2><p class="text-xs text-slate-500">必选术语未出现在译文中时会实时告警。</p></div>
                  <span class="badge badge-outline">{active().terms.length} 条</span>
                </div>
                <div class="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input class="input input-sm input-bordered" placeholder="中文术语" value={termSource.value} onInput$={(_, element) => termSource.value = element.value} />
                  <input class="input input-sm input-bordered" placeholder="目标语言固定译法" value={termTarget.value} onInput$={(_, element) => termTarget.value = element.value} />
                  <button class="btn btn-sm btn-primary" onClick$={addTerm}>绑定</button>
                </div>
                <div class="mt-3 grid gap-2 md:grid-cols-2">
                  {active().terms.map((term) => (
                    <div key={term.id} class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <div class="min-w-0">
                        <div class="truncate text-xs font-bold">{term.source}</div>
                        <div class="truncate text-xs text-slate-500">{term.target}</div>
                      </div>
                      <div class="flex gap-1">
                        <button class={`btn btn-xs ${term.confirmed ? "btn-success" : "btn-ghost"}`} onClick$={() => updateActive("确认术语", (sign) => { const target = sign.terms.find((item) => item.id === term.id); if (target) target.confirmed = !target.confirmed; })}>确认</button>
                        <button class="btn btn-xs btn-ghost text-error" onClick$={() => updateActive("删除术语", (sign) => { sign.terms = sign.terms.filter((item) => item.id !== term.id); })}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <h2 class="font-bold">审校意见与回复</h2>
                <div class="mt-3 flex gap-2">
                  <textarea class="textarea textarea-bordered min-h-20 flex-1" placeholder="记录措辞、文化适配或法规依据…" value={commentDraft.value} onInput$={(_, element) => commentDraft.value = element.value} />
                  <button class="btn btn-primary self-end" onClick$={addComment}>添加意见</button>
                </div>
                <div class="mt-4 space-y-3">
                  {active().comments.length === 0 && <div class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-400">还没有审校意见。</div>}
                  {active().comments.map((comment) => (
                    <article key={comment.id} class={`rounded-xl border-l-4 bg-slate-50 p-3 ${comment.resolved ? "border-success opacity-60" : "border-warning"}`}>
                      <div class="flex items-center justify-between text-xs"><strong>{comment.author}</strong><span class="text-slate-400">{new Date(comment.createdAt).toLocaleString()}</span></div>
                      <p class="my-2 text-sm">{comment.body}</p>
                      {comment.replies.map((reply) => (
                        <div key={reply.id} class="ml-4 my-1 border-l-2 border-slate-200 pl-3 text-xs"><strong>{reply.author}</strong>：{reply.body}</div>
                      ))}
                      {replyingTo.value === comment.id ? (
                        <div class="mt-2 flex gap-2">
                          <input class="input input-xs input-bordered flex-1" value={replyDraft.value} onInput$={(_, element) => replyDraft.value = element.value} />
                          <button class="btn btn-xs btn-primary" onClick$={() => addReply(comment.id)}>发送</button>
                        </div>
                      ) : (
                        <div class="mt-2 flex gap-2">
                          <button class="btn btn-xs btn-ghost" onClick$={() => { replyingTo.value = comment.id; }}>回复</button>
                          <button class="btn btn-xs btn-ghost" onClick$={() => updateActive("更新意见状态", (sign) => { const item = sign.comments.find((entry) => entry.id === comment.id); if (item) item.resolved = !item.resolved; })}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </main>

        <aside class="overflow-y-auto bg-slate-50 p-4">
          <section class="sticky top-4 space-y-4">
            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Live Preview</div><h2 class="font-bold">版面实时预览</h2></div>
                  <span class={`badge ${preview().risk === "high" ? "badge-error" : preview().risk === "medium" ? "badge-warning" : "badge-success"}`}>
                    {preview().risk === "high" ? "溢出风险" : preview().risk === "medium" ? "接近边界" : "版面安全"}
                  </span>
                </div>
                <div class="mt-3 flex gap-1">
                  {WIDTHS.map((width) => <button key={width} class={`btn btn-xs flex-1 ${previewWidth.value === width ? "btn-primary" : "btn-outline"}`} onClick$={() => previewWidth.value = width}>{width}px</button>)}
                </div>
                <div class="mt-2 flex items-center gap-3 text-xs">
                  <span class="w-20">字号 {previewFont.value}px</span>
                  <input type="range" min="28" max="88" step="2" class="range range-primary range-xs flex-1" value={previewFont.value} onInput$={(_, element) => previewFont.value = Number(element.value)} />
                </div>
                <div class="mt-4 overflow-hidden rounded-xl bg-slate-800 p-3">
                  <div class="mx-auto grid min-h-48 place-items-center overflow-hidden border-4 border-white bg-[#174f3d] p-3 text-center text-white" style={{ width: `${previewWidth.value}px`, maxWidth: "100%" }}>
                    <div>
                      <div style={{ fontSize: `${previewFont.value}px` }} class="font-black leading-[1.18] tracking-wide">{preview().visible.map((line, index) => <div key={index}>{line || "\u00a0"}</div>)}</div>
                    </div>
                  </div>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{preview().lines.length}</strong><span>预计行数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{active().targetText.length}</strong><span>字符数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class={`block text-lg ${preview().missingTerms.length ? "text-error" : "text-success"}`}>{preview().missingTerms.length}</strong><span>缺失术语</span></div>
                </div>
                {(preview().overflow || preview().tooLong) && <div class="alert alert-error mt-3 py-2 text-xs">{preview().overflow ? "当前字号下内容超过三行，可能截断。" : "译文接近标识建议字符上限。"}</div>}
              </div>
            </div>

            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">版本比较</h2><p class="text-xs text-slate-500">旧版快照与当前译文逐词对比。</p></div>
                  <span class="badge badge-outline">{active().versions.length} 版</span>
                </div>
                {active().versions.length ? (
                  <>
                    <select class="select select-sm select-bordered mt-3 w-full" value={selectedVersionId.value || active().versions[0].id} onChange$={(_, element) => selectedVersionId.value = element.value}>
                      {active().versions.map((version) => <option key={version.id} value={version.id}>{`${version.label} · ${new Date(version.createdAt).toLocaleTimeString()}`}</option>)}
                    </select>
                    <div class="mt-3 rounded-lg bg-slate-900 p-3 text-sm leading-7 text-slate-100">
                      {comparison().map((token, index) => (
                        <span key={index} class={token.type === "add" ? "rounded bg-green-400/25 text-green-200" : token.type === "remove" ? "bg-red-400/25 text-red-200 line-through" : ""}>{token.value}</span>
                      ))}
                    </div>
                    <div class="mt-2 flex gap-3 text-[11px]"><span class="text-green-700">绿：新增</span><span class="text-red-700">红：删除</span></div>
                  </>
                ) : (
                  <div class="mt-3 rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">保存当前译文后会在这里生成可比较版本。</div>
                )}
              </div>
            </div>

            <div class="rounded-xl bg-[#17324d] p-4 text-xs text-slate-200">
              <div class="mb-2 font-bold text-white">键盘操作</div>
              <div class="grid grid-cols-2 gap-y-1"><span><kbd class="kbd kbd-xs">J/K</kbd> 切换标识</span><span><kbd class="kbd kbd-xs">[ ]</kbd> 预览宽度</span><span><kbd class="kbd kbd-xs">- =</kbd> 字号</span><span><kbd class="kbd kbd-xs">Ctrl/⌘ Z</kbd> 撤销</span></div>
            </div>
          </section>
        </aside>
      </div>

      {toast.value && <div class="toast toast-end z-50"><div class="alert alert-success"><span>{toast.value}</span></div></div>}
    </div>
  );
});
