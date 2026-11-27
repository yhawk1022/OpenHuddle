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
import { useWorkbenchI18n } from "../i18n/workbench.js";
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
  const { t } = useWorkbenchI18n();
  const initWs = props.initialWorkspace;
  const reducedMotion = usePrefersReducedMotion();
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const workspaceKindTabs = useMemo<ReadonlyArray<SegmentedTabItem<WorkspaceKind>>>(
    () => [
      { value: "git_repo", label: t("wsModal.kind.gitRepo") },
      { value: "multi_root", label: t("wsModal.kind.multiRoot") },
      { value: "folder", label: t("wsModal.kind.folder") },
    ],
    [t],
  );

  const hostModeTabs = useMemo<ReadonlyArray<SegmentedTabItem<WorkspaceHostMode>>>(
    () => [
      { value: "local_machine", label: t("wsModal.host.localMachine") },
      { value: "personal_remote", label: t("wsModal.host.personalRemote") },
      { value: "shared_container", label: t("wsModal.host.sharedContainer") },
    ],
    [t],
  );

  const gitSandboxTabs = useMemo<ReadonlyArray<SegmentedTabItem<WorkspaceSandboxMode>>>(
    () => [
      { value: "worktree_pool", label: t("sandbox.worktreePool") },
      { value: "in_place", label: t("sandbox.inPlace") },
      { value: "read_only", label: t("sandbox.readOnly") },
    ],
    [t],
  );

  const folderSandboxTabs = useMemo<ReadonlyArray<SegmentedTabItem<WorkspaceSandboxMode>>>(
    () => [
      { value: "in_place", label: t("sandbox.inPlace") },
      { value: "read_only", label: t("sandbox.readOnly") },
    ],
    [t],
  );

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
    () => [
      {
        value: "direct",
        label: t("topology.direct.label"),
        description: t("topology.direct.description"),
      },
      {
        value: "verify_loop",
        label: t("topology.verifyLoop.label"),
        description: t("topology.verifyLoop.description"),
      },
      {
        value: "swarm",
        label: t("topology.swarm.label"),
        description: supportsSwarm
          ? t("topology.swarm.description")
          : t("topology.swarm.disabledReason"),
        ...(!supportsSwarm ? { disabled: true } : {}),
      },
    ],
    [supportsSwarm, t],
  );

  const workerOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: "auto", label: t("assign.auto") },
      ...props.ownedAgents.map((a) => ({
        value: a.id,
        label: stripAgentOwnerPrefix(a.displayName, props.ownerDisplayName),
      })),
    ],
    [props.ownedAgents, props.ownerDisplayName, t],
  );

  const cleanName = name.trim();
  const hostSummaryLabel =
    hostModeTabs.find((item) => item.value === hostMode)?.label ?? t("wsModal.host.localMachine");
  const sandboxSummaryLabel =
    (kind === "folder" ? folderSandboxTabs : gitSandboxTabs).find(
      (item) => item.value === sandboxMode,
    )?.label ?? t("sandbox.worktreePool");
  const workerSummaryLabel =
    workerOptions.find((item) => item.value === defaultWorkerId)?.label ?? t("assign.auto");
  const advancedSummary = `${String(hostSummaryLabel)} · ${String(sandboxSummaryLabel)} · ${workerSummaryLabel}`;

  const getPathPlaceholder = (idx: number): string => {
    const projectPlaceholder = cleanName
      ? sanitizeWorkspaceDirSegment(cleanName)
      : t("wsModal.pathPlaceholderProject");
    if (kind === "folder") {
      return t("wsModal.pathPlaceholderFolder", { project: projectPlaceholder });
    }
    if (kind === "multi_root") {
      if (roots.some((row) => row.localPath.trim())) {
        return t("wsModal.pathPlaceholderMultiRootOptional");
      }
      const suffix = idx === 0 ? "api" : idx === 1 ? "web" : `part-${String(idx + 1)}`;
      return t("wsModal.pathPlaceholderDev", {
        project: cleanName ? `${projectPlaceholder}-${suffix}` : `service-${suffix}`,
      });
    }
    return t("wsModal.pathPlaceholderDev", { project: projectPlaceholder });
  };

  const handleSave = async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }
    if (cleanName.length === 0) {
      toast.info(t("wsModal.toast.nameRequired"));
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

      toast.success(
        initWs
          ? t("wsModal.toast.updated", { name: saved.name })
          : t("wsModal.toast.created", { name: saved.name }),
      );
      props.onSaved(saved);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("wsModal.toast.saveFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title={initWs ? t("wsModal.titleEdit", { name: initWs.name }) : t("wsModal.titleCreate")}
      subtitle={initWs ? t("wsModal.subtitleEdit") : t("wsModal.subtitleCreate")}
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
                      toast.info(t("wsModal.toast.removed", { name: initWs.name }));
                      props.onDeleted();
                    })
                    .catch((err: unknown) => {
                      toast.error(
                        err instanceof Error ? err.message : t("wsModal.toast.removeFailed"),
                      );
                    })
                    .finally(() => {
                      setIsSubmitting(false);
                    });
                }}
              >
                {t("wsModal.removeWorkspace")}
              </AppButton>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <AppButton size="sm" variant="ghost" disabled={isSubmitting} onClick={props.onClose}>
              {t("detail.cancel")}
            </AppButton>
            <AppButton
              size="sm"
              variant="primary"
              disabled={isSubmitting}
              onClick={() => void handleSave()}
            >
              {isSubmitting
                ? t("wsModal.saving")
                : initWs
                  ? t("wsModal.saveChanges")
                  : t("wsModal.createWorkspace")}
            </AppButton>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
            {t("wsModal.nameLabel")}
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
                ? t("wsModal.namePlaceholderMultiRoot")
                : kind === "folder"
                  ? t("wsModal.namePlaceholderFolder")
                  : t("wsModal.namePlaceholderGitRepo")
            }
          />
        </div>

        <div className="space-y-1.5">
          <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
            {t("wsModal.kindLabel")}
          </span>
          <SegmentedTabs
            size="xs"
            items={workspaceKindTabs}
            value={kind}
            onValueChange={handleChangeKind}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
              {kind === "multi_root"
                ? t("wsModal.pathLabelMultiRoot")
                : t("wsModal.pathLabelSingle")}
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
                <span>{t("wsModal.addRoot")}</span>
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
                    label={t("wsModal.removeRootAriaLabel")}
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
            {t("wsModal.pathHelper")}
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
                <span>{t("wsModal.advancedHeading")}</span>
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
                      {t("wsModal.hostLabel")}
                    </span>
                    <SegmentedTabs
                      size="xs"
                      items={hostModeTabs}
                      value={hostMode}
                      onValueChange={setHostMode}
                    />
                    <p className="text-[11.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                      {hostMode === "local_machine"
                        ? t("wsModal.hostDescLocal")
                        : hostMode === "personal_remote"
                          ? t("wsModal.hostDescRemote")
                          : t("wsModal.hostDescShared")}
                    </p>
                  </div>

                  {kind !== "folder" ? (
                    <div className="space-y-1.5">
                      <span className="block text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                        {t("wsModal.defaultBranchLabel")}
                      </span>
                      <div className="space-y-2">
                        {roots.map((rootRow, idx) => (
                          <div
                            key={`branch-${rootRow.localId}`}
                            className="flex items-center gap-2"
                          >
                            {roots.length > 1 ? (
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#687082] dark:text-[#8E8E96]">
                                {rootRow.localPath.trim() ||
                                  t("wsModal.directoryFallback", { index: idx + 1 })}
                              </span>
                            ) : null}
                            <div className={roots.length > 1 ? "w-28 shrink-0" : "w-full"}>
                              <AppInput
                                size="sm"
                                aria-label={
                                  roots.length > 1
                                    ? t("wsModal.directoryBranchAriaLabel", { index: idx + 1 })
                                    : t("wsModal.defaultBranchLabel")
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
                      {t("wsModal.sandboxLabel")}
                    </span>
                    <SegmentedTabs
                      size="xs"
                      items={kind === "folder" ? folderSandboxTabs : gitSandboxTabs}
                      value={sandboxMode}
                      onValueChange={setSandboxMode}
                    />
                    <p className="text-[11.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                      {sandboxMode === "worktree_pool"
                        ? t("wsModal.sandboxDescWorktree")
                        : sandboxMode === "in_place"
                          ? t("wsModal.sandboxDescInPlace")
                          : t("wsModal.sandboxDescReadOnly")}
                    </p>
                  </div>

                  {kind !== "folder" && sandboxMode !== "read_only" ? (
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <div className="space-y-1">
                        <span className="block text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                          {t("wsModal.setupCommandLabel")}
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
                          {t("wsModal.verifyCommandLabel")}
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
                        {t("wsModal.defaultTopologyLabel")}
                      </span>
                      <AppSelect
                        size="sm"
                        ariaLabel={t("wsModal.defaultTopologyLabel")}
                        value={effectiveTopology}
                        onValueChange={setDefaultTopology}
                        options={topologyOptions}
                      />
                    </div>

                    <div className="space-y-1">
                      <span className="block text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                        {t("wsModal.defaultWorkerLabel")}
                      </span>
                      <AppSelect
                        size="sm"
                        ariaLabel={t("wsModal.defaultWorkerLabel")}
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
