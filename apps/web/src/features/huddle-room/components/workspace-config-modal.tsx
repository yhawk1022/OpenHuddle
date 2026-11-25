/**
 * @module web/features/huddle-room/workspace-config-modal
 * @description 工作区新建与配置弹窗。管理受控目录列表、执行宿主来源、沙盒隔离策略与校验钩子命令。
 */
import type { AgentId, OwnedAgentSummaryDto } from "@openhuddle/protocol";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  toast,
} from "../../../components/primitives/index.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import type {
  AgentWorkspace,
  WorkspaceHostMode,
  WorkspaceKind,
  WorkspaceSandboxMode,
} from "../work/solo-workbench-store.js";
import { deleteWorkspaceOnServer, saveWorkspaceOnServer } from "../work/work-server-sync.js";
import type { WorkTopology } from "../work/work-types.js";
import { stripAgentOwnerPrefix } from "../work/work-utils.js";

interface EditableRootRow {
  readonly localId: string;
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

/**
 * 新建或编辑工作区偏好弹窗。
 */
export function WorkspaceConfigModal(props: WorkspaceConfigModalProps) {
  const initWs = props.initialWorkspace;
  const [name, setName] = useState<string>(initWs?.name ?? "");
  const [kind, setKind] = useState<WorkspaceKind>(initWs?.kind ?? "git_repo");
  const [hostMode, setHostMode] = useState<WorkspaceHostMode>(initWs?.host.mode ?? "local_machine");
  const [roots, setRoots] = useState<ReadonlyArray<EditableRootRow>>(() => {
    if (initWs && initWs.roots.length > 0) {
      return initWs.roots.map((r) => ({
        localId: r.id,
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
    initWs?.defaultTopology ?? "verify_loop",
  );
  const [defaultWorkerId, setDefaultWorkerId] = useState<string>(initWs?.defaultWorkerId ?? "auto");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

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
    } else if (nextKind === "multi_root" && roots.length < 2) {
      setRoots((prev) => [
        ...prev,
        {
          localId: `draft-root-${String(Date.now())}`,
          localPath: "",
          defaultBranch: "main",
        },
      ]);
      setSandboxMode("worktree_pool");
    }
  };

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

  const handleSave = async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }
    const cleanName = name.trim();
    if (cleanName.length === 0) {
      toast.info("请填写工作区名称");
      return;
    }
    const validRoots = roots
      .map((r) => ({
        localPath: r.localPath.trim(),
        defaultBranch: r.defaultBranch.trim() || "main",
      }))
      .filter((r) => r.localPath.length > 0);

    setIsSubmitting(true);
    try {
      const saved = await saveWorkspaceOnServer({
        ...(initWs !== null ? { id: initWs.id } : {}),
        name: cleanName,
        kind,
        hostMode,
        roots:
          validRoots.length > 0
            ? validRoots
            : [
                {
                  localPath:
                    kind === "folder" ? `~/Documents/${cleanName}` : `~/Developer/${cleanName}`,
                  defaultBranch: "main",
                },
              ],
        sandboxMode,
        ...(kind !== "folder" && sandboxMode !== "read_only"
          ? {
              setupCommand,
              verifyCommand,
            }
          : {}),
        defaultTopology,
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
      subtitle="定义受控本地目录边界、并发隔离策略与交付校验命令"
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
            size="sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              kind === "multi_root"
                ? "例如：前后端联调空间"
                : kind === "folder"
                  ? "例如：产品需求与调研库"
                  : "例如：OpenHuddle"
            }
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          </div>
        </div>

        <p className="-mt-2 text-[11.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
          {hostMode === "local_machine"
            ? "仅本机上的本人 Agent 访问；工作记录脱敏落盘至 ~/.openhuddle/ 仓外目录。"
            : hostMode === "personal_remote"
              ? "本人跨设备或远程环境 Agent 可连入同一沙箱接力；各环境同步保存脱敏会话记录与滚动记忆。"
              : "运行于隔离容器且不含私人凭据，授权后允许群内协作者 Agent 按单写租约锁共同操作。"}
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
              {kind === "multi_root" ? "关联本机目录列表 (Multi-root)" : "本机受控目录路径"}
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
                className="inline-flex cursor-pointer items-center gap-1 text-[11.5px] font-medium text-[#2563EB] hover:underline dark:text-[#60A5FA]"
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
                          r.localId === rootRow.localId ? { ...r, localPath: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder={
                      kind === "folder"
                        ? "~/Documents/Product-Specs"
                        : idx === 0
                          ? "~/Developer/service-api"
                          : "~/Developer/service-web"
                    }
                  />
                </div>
                {kind !== "folder" ? (
                  <div className="w-24 shrink-0">
                    <AppInput
                      size="sm"
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
                ) : null}
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
        </div>

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
              value={defaultTopology}
              onValueChange={setDefaultTopology}
              options={TOPOLOGY_OPTIONS}
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
    </ModalDialog>
  );
}
