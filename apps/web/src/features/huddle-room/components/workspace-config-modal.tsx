/**
 * @module web/features/huddle-room/workspace-config-modal
 * @description 工作区新建与配置弹窗。新建首屏采用「零配置、托管直达」极简表单，将宿主、分支、隔离策略与门禁命令收纳至可折叠高级设置区。
 */
import type { AgentId, OwnedAgentSummaryDto } from "@openhuddle/protocol";
import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  INSTANT_TRANSITION,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { isCoarsePointerDevice, isImeComposing } from "../../../lib/viewport-sync.js";
import type {
  AgentWorkspace,
  WorkspaceHostMode,
  WorkspaceKind,
  WorkspaceSandboxMode,
} from "../work/solo-workbench-store.js";
import { deleteWorkspaceOnServer, saveWorkspaceOnServer } from "../work/work-server-sync.js";
import type { WorkTopology } from "../work/work-types.js";
import {
  normalizeWorkspaceRoots,
  resolveEffectiveDispatchTopology,
  sanitizeWorkspaceDirSegment,
  stripAgentOwnerPrefix,
  workspaceSupportsSwarm,
} from "../work/work-utils.js";

interface EditableRootRow {
  readonly localId: string;
  readonly name?: string | undefined;
  readonly localPath: string;
  readonly defaultBranch: string;
}

/** `WorkspaceConfigModal` 组件属性 */
export interface WorkspaceConfigModalProps {
  readonly open: boolean;
  readonly initialWorkspace: AgentWorkspace | null;
  readonly canDelete: boolean;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly ownerDisplayName: string;
  readonly onClose: () => void;
  readonly onSaved: (workspace: AgentWorkspace) => void;
  readonly onDeleted: () => void;
}

const SWARM_DISABLED_REASON = "仅多目录组合且非只读工作区支持";

const TOPOLOGY_OPTIONS: ReadonlyArray<AppSelectOption<WorkTopology>> = [
  { value: "direct", label: "单人执行", description: "单个 Agent 直接完成改动" },
  { value: "verify_loop", label: "双人复核", description: "完成后由另一 Agent 独立检查" },
  { value: "swarm", label: "多路并行", description: "按目录拆分并行处理后汇总" },
];

const WORKSPACE_KIND_TABS: ReadonlyArray<SegmentedTabItem<WorkspaceKind>> = [
  { value: "git_repo", label: "单代码仓" },
  { value: "multi_root", label: "多目录组合" },
  { value: "folder", label: "普通文件夹" },
];

const HOST_MODE_TABS: ReadonlyArray<SegmentedTabItem<WorkspaceHostMode>> = [
  { value: "local_machine", label: "本机目录" },
  { value: "personal_remote", label: "远程沙箱" },
  { value: "shared_container", label: "多人容器" },
];

const GIT_SANDBOX_TABS: ReadonlyArray<SegmentedTabItem<WorkspaceSandboxMode>> = [
  { value: "worktree_pool", label: "Worktree 隔离" },
  { value: "in_place", label: "原地目录" },
  { value: "read_only", label: "只读围栏" },
];

const FOLDER_SANDBOX_TABS: ReadonlyArray<SegmentedTabItem<WorkspaceSandboxMode>> = [
  { value: "in_place", label: "原地目录" },
  { value: "read_only", label: "只读围栏" },
];

function inferSmartDefaultTopology(kind: WorkspaceKind, ownedAgentCount: number): WorkTopology {
  if (kind === "folder" || ownedAgentCount <= 1) {
    return "direct";
  }
  return "verify_loop";
}

/**
 * 新建或编辑工作区偏好弹窗。
 */
export function WorkspaceConfigModal(props: WorkspaceConfigModalProps) {
  const initWs = props.initialWorkspace;
  const reducedMotion = usePrefersReducedMotion();
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState<string>(initWs?.name ?? "");
  const [kind, setKind] = useState<WorkspaceKind>(initWs?.kind ?? "git_repo");
  const [hostMode, setHostMode] = useState<WorkspaceHostMode>(initWs?.host.mode ?? "local_machine");
  const [roots, setRoots] = useState<ReadonlyArray<EditableRootRow>>(() => {
    if (initWs && initWs.roots.length > 0) {
      return initWs.roots.map((r) => ({
        localId: r.id,
        name: r.name,
        localPath: r.localPath,
        defaultBranch: r.defaultBranch ?? "main",
      }));
    }
    return [
      {
        localId: "draft-root-0",
        localPath: "",
        defaultBranch: "main",
      },
    ];
  });
  const [sandboxMode, setSandboxMode] = useState<WorkspaceSandboxMode>(
    initWs?.sandboxMode ?? "worktree_pool",
  );
  const [setupCommand, setSetupCommand] = useState<string>(initWs?.hooks.setupCommand ?? "");
  const [verifyCommand, setVerifyCommand] = useState<string>(initWs?.hooks.verifyCommand ?? "");
  const [defaultTopology, setDefaultTopology] = useState<WorkTopology>(
    () =>
      initWs?.defaultTopology ??
      inferSmartDefaultTopology(initWs?.kind ?? "git_repo", props.ownedAgents.length),
  );
  const [defaultWorkerId, setDefaultWorkerId] = useState<string>(initWs?.defaultWorkerId ?? "auto");
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(() => initWs !== null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // 桌面端新建工作区时自动聚焦名称输入框，一步回车完成创建
  useEffect(() => {
    if (
      !props.open ||
      initWs !== null ||
      isCoarsePointerDevice() ||
      typeof window === "undefined"
    ) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [initWs, props.open]);

  const handleChangeKind = (nextKind: WorkspaceKind): void => {
    setKind(nextKind);
    if (nextKind === "folder") {
      setRoots((prev) => prev.slice(0, 1));
      if (sandboxMode === "worktree_pool") {
        setSandboxMode("in_place");
      }
      setDefaultTopology("direct");
    } else if (nextKind === "git_repo") {
      setRoots((prev) => prev.slice(0, 1));
      setSandboxMode("worktree_pool");
      if (initWs === null) {
        setDefaultTopology(inferSmartDefaultTopology("git_repo", props.ownedAgents.length));
      }
    } else if (nextKind === "multi_root") {
      if (roots.length < 2) {
        setRoots((prev) => [
          ...prev,
          {
            localId: `draft-root-${String(Date.now())}`,
            localPath: "",
            defaultBranch: "main",
          },
        ]);
      }
      setSandboxMode("worktree_pool");
      if (initWs === null) {
        setDefaultTopology(inferSmartDefaultTopology("multi_root", props.ownedAgents.length));
      }
    }
  };

  const { roots: effectiveRoots, kind: effectiveKind } = normalizeWorkspaceRoots({
    name,
    kind,
    roots,
  });
  const workspace = { roots: effectiveRoots, kind: effectiveKind, sandboxMode };
  const supportsSwarm = workspaceSupportsSwarm(workspace);
  const effectiveTopology = resolveEffectiveDispatchTopology({
    requested: defaultTopology,
    workspace,
    agentCount: props.ownedAgents.length,
  });
  const topologyOptions = useMemo<ReadonlyArray<AppSelectOption<WorkTopology>>>(
    () =>
      TOPOLOGY_OPTIONS.map((opt) =>
        opt.value === "swarm" && !supportsSwarm
          ? {
              ...opt,
              disabled: true,
              description: SWARM_DISABLED_REASON,
            }
          : opt,
      ),
    [supportsSwarm],
  );

  const workerOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: "auto", label: "自动分配" },
      ...props.ownedAgents.map((a) => ({
        value: a.id,
        label: stripAgentOwnerPrefix(a.displayName, props.ownerDisplayName),
      })),
    ],
    [props.ownedAgents, props.ownerDisplayName],
  );

  const cleanName = name.trim();
  const hostSummaryLabel =
    HOST_MODE_TABS.find((item) => item.value === hostMode)?.label ?? "本机目录";
  const sandboxSummaryLabel =
    (kind === "folder" ? FOLDER_SANDBOX_TABS : GIT_SANDBOX_TABS).find(
      (item) => item.value === sandboxMode,
    )?.label ?? "Worktree 隔离";
  const workerSummaryLabel =
    workerOptions.find((item) => item.value === defaultWorkerId)?.label ?? "自动分配";
  const advancedSummary = `${String(hostSummaryLabel)} · ${String(sandboxSummaryLabel)} · ${workerSummaryLabel}`;

  const getPathPlaceholder = (idx: number): string => {
    const projectPlaceholder = cleanName ? sanitizeWorkspaceDirSegment(cleanName) : "项目名";
    if (kind === "folder") {
      return `留空自动创建 ~/Documents/${projectPlaceholder}`;
    }
    if (kind === "multi_root") {
      if (roots.some((row) => row.localPath.trim())) return "填写关联目录，留空则忽略";
      const suffix = idx === 0 ? "api" : idx === 1 ? "web" : `part-${String(idx + 1)}`;
      return `留空自动创建 ~/Developer/${cleanName ? `${projectPlaceholder}-${suffix}` : `service-${suffix}`}`;
    }
    return `留空自动创建 ~/Developer/${projectPlaceholder}`;
  };

  const handleSave = async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }
    if (cleanName.length === 0) {
      toast.info("请填写工作区名称");
      nameInputRef.current?.focus();
      return;
    }
    setIsSubmitting(true);
    try {
      const saved = await saveWorkspaceOnServer({
        ...(initWs !== null ? { id: initWs.id } : {}),
        name: cleanName,
        kind: effectiveKind,
        hostMode,
        roots: effectiveRoots,
        sandboxMode,
        ...(kind !== "folder" && sandboxMode !== "read_only"
          ? {
              setupCommand,
              verifyCommand,
            }
          : {}),
        defaultTopology: effectiveTopology,
        ...(defaultWorkerId !== "auto" ? { defaultWorkerId: defaultWorkerId as AgentId } : {}),
        ...(initWs?.defaultVerifierId !== undefined
          ? { defaultVerifierId: initWs.defaultVerifierId }
          : {}),
      });

      toast.success(initWs ? `已更新工作区「${saved.name}」` : `已新建工作区「${saved.name}」`);
      props.onSaved(saved);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存工作区失败，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title={initWs ? `配置工作区 · ${initWs.name}` : "新建工作区"}
      subtitle={
        initWs
          ? "定义受控本地目录边界、并发隔离策略与交付校验命令"
          : "输入名称即可创建，目录将自动准备，高级策略可随时按需调整"
      }
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div>
            {props.canDelete && initWs !== null ? (
              <AppButton
                size="sm"
                variant="ghost"
                disabled={isSubmitting}
                leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
                className="text-[#DC2626] hover:bg-[#FEE2E2]/60 dark:text-[#F87171] dark:hover:bg-[#31171B]"
                onClick={() => {
                  setIsSubmitting(true);
                  void deleteWorkspaceOnServer(initWs.id)
                    .then(() => {
                      toast.info(`已移除工作区「${initWs.name}」`);
                      props.onDeleted();
                    })
                    .catch((err: unknown) => {
                      toast.error(err instanceof Error ? err.message : "移除工作区失败");
                    })
                    .finally(() => {
                      setIsSubmitting(false);
                    });
                }}
              >
                移除工作区
              </AppButton>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <AppButton size="sm" variant="ghost" disabled={isSubmitting} onClick={props.onClose}>
              取消
            </AppButton>
            <AppButton
              size="sm"
              variant="primary"
              disabled={isSubmitting}
              onClick={() => void handleSave()}
            >
              {isSubmitting ? "保存中…" : initWs ? "保存修改" : "创建工作区"}
            </AppButton>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
            工作区名称
          </span>
          <AppInput
            ref={nameInputRef}
            size="sm"
            autoFocus={initWs === null && !isCoarsePointerDevice()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) {
                e.preventDefault();
                void handleSave();
              }
            }}
            placeholder={
              kind === "multi_root"
                ? "例如：前后端联调空间"
                : kind === "folder"
                  ? "例如：产品需求与调研库"
                  : "例如：OpenHuddle"
            }
          />
        </div>

        <div className="space-y-1.5">
          <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
            目录形态
          </span>
          <SegmentedTabs
            size="xs"
            items={WORKSPACE_KIND_TABS}
            value={kind}
            onValueChange={handleChangeKind}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
              {kind === "multi_root" ? "关联本机目录路径（可选）" : "本机目录路径（可选）"}
            </span>
            {kind === "multi_root" ? (
              <button
                type="button"
                onClick={() =>
                  setRoots((prev) => [
                    ...prev,
                    {
                      localId: `draft-root-${String(Date.now())}-${String(prev.length)}`,
                      localPath: "",
                      defaultBranch: "main",
                    },
                  ])
                }
                className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11.5px] font-medium text-[#2563EB] hover:underline dark:text-[#60A5FA]"
              >
                <Plus className="h-3 w-3" />
                <span>添加关联目录</span>
              </button>
            ) : null}
          </div>

          <div className="space-y-2">
            {roots.map((rootRow, idx) => (
              <div key={rootRow.localId} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <AppInput
                    size="sm"
                    className="font-mono text-[16px] md:text-[12px]"
                    value={rootRow.localPath}
                    onChange={(e) =>
                      setRoots((prev) =>
                        prev.map((r) =>
                          r.localId === rootRow.localId
                            ? { ...r, name: undefined, localPath: e.target.value }
                            : r,
                        ),
                      )
                    }
                    placeholder={getPathPlaceholder(idx)}
                  />
                </div>
                {roots.length > 1 ? (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label="移除目录"
                    onClick={() =>
                      setRoots((prev) => prev.filter((r) => r.localId !== rootRow.localId))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5 text-[#687082]" />
                  </IconButton>
                ) : null}
              </div>
            ))}
          </div>

          <p className="text-[11.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
            若目录尚不存在，将在首次执行时自动创建；任务派发后 Agent
            会自主推进，仅在需要你决策时打扰。
          </p>
        </div>

        {/* 可折叠「高级环境与门禁设置」（新建默认收起并展示策略摘要，编辑默认展开） */}
        <section className="overflow-hidden rounded-[16px] border border-black/[0.06] bg-black/[0.02] dark:border-white/[0.08] dark:bg-white/[0.03]">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            aria-expanded={advancedOpen}
            className="flex w-full cursor-pointer select-none items-center justify-between gap-2 px-3.5 py-2.5 text-left transition hover:bg-black/[0.025] dark:hover:bg-white/[0.04]"
          >
            <div className="min-w-0 flex-1">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#8E8E96]" />
                <span>高级环境与门禁设置</span>
              </span>
              {!advancedOpen ? (
                <p className="mt-0.5 truncate text-[11px] text-[#687082] dark:text-[#8E8E96]">
                  {advancedSummary}
                </p>
              ) : null}
            </div>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-[#687082] transition-transform duration-200 dark:text-[#8E8E96]",
                advancedOpen && "rotate-180",
              )}
            />
          </button>

          <AnimatePresence initial={false}>
            {advancedOpen ? (
              <motion.div
                key="workspace-advanced-body"
                initial={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                transition={
                  reducedMotion ? INSTANT_TRANSITION : { duration: 0.18, ease: "easeOut" }
                }
                className="overflow-hidden border-t border-black/[0.06] dark:border-white/[0.07]"
              >
                <div className="space-y-3.5 p-3.5">
                  <div className="space-y-1.5">
                    <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                      执行宿主来源
                    </span>
                    <SegmentedTabs
                      size="xs"
                      items={HOST_MODE_TABS}
                      value={hostMode}
                      onValueChange={setHostMode}
                    />
                    <p className="text-[11.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                      {hostMode === "local_machine"
                        ? "仅本机上的本人 Agent 访问；工作记录脱敏落盘至 ~/.openhuddle/ 仓外目录。"
                        : hostMode === "personal_remote"
                          ? "本人跨设备或远程环境 Agent 可连入同一沙箱接力；各环境同步保存脱敏会话记录与滚动记忆。"
                          : "运行于隔离容器且不含私人凭据，授权后允许群内协作者 Agent 按单写租约锁共同操作。"}
                    </p>
                  </div>

                  {kind !== "folder" ? (
                    <div className="space-y-1.5">
                      <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                        默认分支
                      </span>
                      <div className="space-y-2">
                        {roots.map((rootRow, idx) => (
                          <div
                            key={`branch-${rootRow.localId}`}
                            className="flex items-center gap-2"
                          >
                            {roots.length > 1 ? (
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#687082] dark:text-[#8E8E96]">
                                {rootRow.localPath.trim() || `目录 ${String(idx + 1)}`}
                              </span>
                            ) : null}
                            <div className={roots.length > 1 ? "w-28 shrink-0" : "w-full"}>
                              <AppInput
                                size="sm"
                                aria-label={
                                  roots.length > 1 ? `目录 ${String(idx + 1)} 默认分支` : "默认分支"
                                }
                                className="font-mono text-[16px] md:text-[12px]"
                                value={rootRow.defaultBranch}
                                onChange={(e) =>
                                  setRoots((prev) =>
                                    prev.map((r) =>
                                      r.localId === rootRow.localId
                                        ? { ...r, defaultBranch: e.target.value }
                                        : r,
                                    ),
                                  )
                                }
                                placeholder="main"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-1.5">
                    <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                      沙盒与隔离策略
                    </span>
                    <SegmentedTabs
                      size="xs"
                      items={kind === "folder" ? FOLDER_SANDBOX_TABS : GIT_SANDBOX_TABS}
                      value={sandboxMode}
                      onValueChange={setSandboxMode}
                    />
                    <p className="text-[11.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                      {sandboxMode === "worktree_pool"
                        ? "每个写任务分配独立 Git Worktree 分支目录，多 Agent 并发互不覆写。"
                        : sandboxMode === "in_place"
                          ? "直接在所选目录内执行，自动启用单写互斥锁防止并发覆写。"
                          : "仅允许 Agent 读取检索目录内容，拦截一切文件修改与写命令。"}
                    </p>
                  </div>

                  {kind !== "folder" && sandboxMode !== "read_only" ? (
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <div className="space-y-1">
                        <span className="block text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                          初始化命令 (Setup)
                        </span>
                        <AppInput
                          size="sm"
                          className="font-mono text-[16px] md:text-[12px]"
                          value={setupCommand}
                          onChange={(e) => setSetupCommand(e.target.value)}
                          placeholder="pnpm install --prefer-offline"
                        />
                      </div>

                      <div className="space-y-1">
                        <span className="block text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                          交付校验命令 (Verify)
                        </span>
                        <AppInput
                          size="sm"
                          className="font-mono text-[16px] md:text-[12px]"
                          value={verifyCommand}
                          onChange={(e) => setVerifyCommand(e.target.value)}
                          placeholder="pnpm verify"
                        />
                      </div>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1">
                      <span className="block text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                        默认协作方式
                      </span>
                      <AppSelect
                        size="sm"
                        ariaLabel="默认协作方式"
                        value={effectiveTopology}
                        onValueChange={setDefaultTopology}
                        options={topologyOptions}
                      />
                    </div>

                    <div className="space-y-1">
                      <span className="block text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                        默认主力 Agent
                      </span>
                      <AppSelect
                        size="sm"
                        ariaLabel="默认主力 Agent"
                        value={defaultWorkerId}
                        onValueChange={setDefaultWorkerId}
                        options={workerOptions}
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
      </div>
    </ModalDialog>
  );
}
