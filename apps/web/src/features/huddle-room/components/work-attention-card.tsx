/**
 * @module web/features/huddle-room/work-attention-card
 * @description 工单 `awaiting_answer` 统一确认与自定义回复卡片（复用至个人工作台详情、群聊时间线里程碑卡与右侧任务抽屉）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严禁嵌套 `backdrop-blur`：统一采用实底中性表面（日光白/浅灰、暗夜 `#1E1E22` 卡片底 + `#161619` 输入底）与单像素边框，保证三端滚动帧率与暗夜对比度。
 * 2. 严禁使用 `.oh-workbench-note` 类名：避免触发移动端软键盘下隐藏概览区的规则，确保问题正文与输入框在软键盘弹起后始终完整可见。
 * 3. 前后端长度一致：自定义回复严格约束 `maxLength={240}`，与协议 `AnswerWorkAttentionBodySchema.choice` 一致，杜绝 400 校验报错。
 * 4. 占位选项防呆：命中引导自定义输入的备选项时仅聚焦下方输入框并提示填写，绝不把占位文案直接发给 Agent。
 */
import { ChevronRight, CircleAlert, Loader2, Pencil } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AppButton, cn, toast } from "../../../components/primitives/index.js";
import { isCoarsePointerDevice, isImeComposing } from "../../../lib/viewport-sync.js";
import { useWorkbenchI18n } from "../i18n/workbench.js";

const MAX_ATTENTION_CHOICE_LENGTH = 240;
const COUNTER_WARNING_REMAINING = 30;
const CUSTOM_SUBMIT_SOURCE = "__custom_reply__";

// 协议级启发式匹配表：识别 Agent 在中/英文环境下生成的「引导下方自定义输入」占位选项（非界面展示文案）
const CUSTOM_REPLY_EXACT_MATCHES = new Set([
  /* i18n-ignore */ "补充说明后继续",
  /* i18n-ignore */ "补充说明",
  /* i18n-ignore */ "其他说明",
  /* i18n-ignore */ "其他",
  /* i18n-ignore */ "自定义回复",
  /* i18n-ignore */ "自定义回复其他方案",
  /* i18n-ignore */ "手动输入",
  /* i18n-ignore */ "手动输入分支名",
  "other",
  "other (specify)",
  "other(specify)",
  "custom reply",
  "custom input",
]);

const CUSTOM_REPLY_PATTERN =
  /^(?:(?:补充说明|其他说明|自定义回复|手动输入)(?:后继续)?(?:\s*[:：\-—·(（….]|$)|(?:other\s*\(\s*specify\s*\)|custom\s+reply|custom\s+input)(?:\s*[:\-—(.….]|$))/i;

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 判断澄清备选项是否属于「引导人类在下方自定义输入」的占位选项。
 *
 * @param option - 备选项文本
 * @returns 命中占位引导项返回 `true`（点击时仅聚焦输入框而不直接提交）
 */
export function isCustomReplyPlaceholderOption(option: string): boolean {
  const normalized = option.trim();
  if (normalized.length === 0) {
    return false;
  }
  if (CUSTOM_REPLY_EXACT_MATCHES.has(normalized.toLowerCase())) {
    return true;
  }
  return CUSTOM_REPLY_PATTERN.test(normalized);
}

/** `WorkAttentionCard` 承载场景变体 */
export type WorkAttentionCardVariant = "detail" | "timeline" | "inspector";

/** `WorkAttentionCard` 组件属性 */
export interface WorkAttentionCardProps {
  /** 承载位置变体，控制内边距、字号与表面层色阶 */
  readonly variant: WorkAttentionCardVariant;
  /** 提问 Agent 展示名称 */
  readonly askedByName: string;
  /** 待确认问题正文 */
  readonly question: string;
  /** 可选快捷回复备选项列表 */
  readonly options: ReadonlyArray<string>;
  /** 提交回答回调（支持异步 Promise，等待完成后再反馈结果） */
  readonly onSubmitAnswer: (choice: string) => Promise<void> | void;
  /** 附加外层容器类名 */
  readonly className?: string | undefined;
}

const VARIANT_CLASSES: Record<
  WorkAttentionCardVariant,
  {
    readonly card: string;
    readonly header: string;
    readonly questionText: string;
    readonly optionButton: string;
    readonly replyArea: string;
  }
> = {
  detail: {
    card: "border-black/[0.08] bg-white dark:border-white/[0.1] dark:bg-[#1E1E22]",
    header: "px-3.5 py-2.5",
    questionText: "text-[12.5px]",
    optionButton: "min-h-[44px] px-3.5 py-2.5 text-[12.5px] md:min-h-0",
    replyArea: "px-3.5 py-2.5",
  },
  timeline: {
    card: "border-black/[0.08] bg-[#F8F9FA] dark:border-white/[0.1] dark:bg-[#1E1E22]",
    header: "px-3 py-2",
    questionText: "text-[12.5px]",
    optionButton: "min-h-[44px] px-3 py-2 text-[12px] md:min-h-0",
    replyArea: "px-3 py-2",
  },
  inspector: {
    card: "border-black/[0.08] bg-white dark:border-white/[0.1] dark:bg-[#1E1E22]",
    header: "px-2.5 py-2",
    questionText: "text-[12px]",
    optionButton: "min-h-[44px] px-2.5 py-2 text-[11.5px] md:min-h-0",
    replyArea: "px-2.5 py-2",
  },
};

/**
 * 渲染工单 `awaiting_answer` 统一澄清与内联自定义回复卡片。
 */
export function WorkAttentionCard(props: WorkAttentionCardProps) {
  const { t } = useWorkbenchI18n();
  const { variant, askedByName, question, options, onSubmitAnswer, className } = props;
  const styles = VARIANT_CLASSES[variant];

  const [draft, setDraft] = useState<string>("");
  const [customReplyGuided, setCustomReplyGuided] = useState<boolean>(false);
  const [highlightRing, setHighlightRing] = useState<boolean>(false);
  const [submittingSource, setSubmittingSource] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef<boolean>(true);
  const submittingRef = useRef<boolean>(false);
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submittingRef.current = false;
      if (highlightTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el || typeof window === "undefined") {
      return;
    }
    el.style.height = "auto";
    const computed = window.getComputedStyle(el);
    const parsedLineHeight = Number.parseFloat(computed.lineHeight);
    const parsedPadTop = Number.parseFloat(computed.paddingTop);
    const parsedPadBottom = Number.parseFloat(computed.paddingBottom);
    const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : 20;
    const verticalPad =
      (Number.isFinite(parsedPadTop) ? parsedPadTop : 6) +
      (Number.isFinite(parsedPadBottom) ? parsedPadBottom : 6);
    const maxHeight = Math.round(lineHeight * 3 + verticalPad);
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${String(nextHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useIsomorphicLayoutEffect(() => {
    void draft;
    resizeTextarea();
  }, [draft, resizeTextarea]);

  const isSubmitting = submittingSource !== null;
  const trimmedDraft = draft.trim();
  const remainingChars = MAX_ATTENTION_CHOICE_LENGTH - draft.length;
  const showCharCounter = remainingChars <= COUNTER_WARNING_REMAINING;
  const coarsePointer = isCoarsePointerDevice();

  const submitAnswer = async (rawChoice: string, source: string): Promise<void> => {
    const clean = rawChoice.trim().slice(0, MAX_ATTENTION_CHOICE_LENGTH);
    if (clean.length === 0 || submittingRef.current || submittingSource !== null) {
      return;
    }
    submittingRef.current = true;
    setSubmittingSource(source);
    try {
      await onSubmitAnswer(clean);
      toast.success(t("attention.toast.replied"));
      if (mountedRef.current && source === CUSTOM_SUBMIT_SOURCE) {
        setDraft("");
        setCustomReplyGuided(false);
        setHighlightRing(false);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("attention.toast.replyFailed"));
      if (mountedRef.current && source === CUSTOM_SUBMIT_SOURCE && typeof window !== "undefined") {
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) {
        setSubmittingSource(null);
      }
    }
  };

  const handleGuideCustomReply = (): void => {
    if (isSubmitting) {
      return;
    }
    setCustomReplyGuided(true);
    setHighlightRing(true);
    if (typeof window !== "undefined") {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => {
        highlightTimerRef.current = null;
        if (mountedRef.current) {
          setHighlightRing(false);
        }
      }, 1_600);
    }
    const el = textareaRef.current;
    if (el) {
      el.focus();
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest" });
      }
    }
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitAnswer(draft, CUSTOM_SUBMIT_SOURCE);
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isImeComposing(event)) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (isCoarsePointerDevice() && !event.metaKey && !event.ctrlKey) {
        return;
      }
      event.preventDefault();
      void submitAnswer(draft, CUSTOM_SUBMIT_SOURCE);
    }
  };

  return (
    <div
      data-attention-card={variant}
      aria-busy={isSubmitting || undefined}
      className={cn(
        "oh-work-attention-card overflow-hidden rounded-xl border",
        styles.card,
        className,
      )}
    >
      <div
        className={cn(
          "flex items-start gap-2 border-b border-black/[0.05] dark:border-white/[0.07]",
          styles.header,
        )}
      >
        <CircleAlert
          aria-hidden="true"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#D97706] dark:text-[#FBBF24]"
        />
        <p
          className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap break-words font-medium leading-relaxed text-[#111318] dark:text-[#F2F2F4]",
            styles.questionText,
          )}
        >
          {t("attention.askedBy", { name: askedByName, question })}
        </p>
      </div>

      {options.length > 0 ? (
        <div className="divide-y divide-black/[0.05] border-b border-black/[0.05] dark:divide-white/[0.06] dark:border-white/[0.07]">
          {options.map((opt, idx) => {
            const isPlaceholderOption = isCustomReplyPlaceholderOption(opt);
            const optionSource = `opt:${String(idx)}:${opt}`;
            const isThisSubmitting = submittingSource === optionSource;
            return (
              <button
                key={optionSource}
                type="button"
                disabled={isSubmitting}
                data-attention-option={isPlaceholderOption ? "custom-guide" : "direct"}
                onClick={() => {
                  if (isPlaceholderOption) {
                    handleGuideCustomReply();
                  } else {
                    void submitAnswer(opt, optionSource);
                  }
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-2.5 text-left text-[#181B22] transition hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-55 dark:text-[#ECECEF] dark:hover:bg-white/[0.04]",
                  styles.optionButton,
                )}
              >
                <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">
                  {opt}
                </span>
                {isThisSubmitting ? (
                  <Loader2
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 animate-spin text-[#687082] dark:text-[#8E8E96]"
                  />
                ) : isPlaceholderOption ? (
                  <Pencil
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#8E8E96]"
                  />
                ) : (
                  <ChevronRight
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-[#94A3B8] dark:text-[#71717A]"
                  />
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      <form onSubmit={handleFormSubmit} className={styles.replyArea}>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            aria-label={t("attention.replyAriaLabel")}
            rows={1}
            maxLength={MAX_ATTENTION_CHOICE_LENGTH}
            enterKeyHint={coarsePointer ? "enter" : "send"}
            disabled={isSubmitting}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (highlightRing) {
                setHighlightRing(false);
              }
            }}
            onBlur={() => {
              if (highlightRing) {
                setHighlightRing(false);
              }
            }}
            onKeyDown={handleTextareaKeyDown}
            placeholder={
              customReplyGuided
                ? t("attention.placeholderGuided")
                : t("attention.placeholderDefault")
            }
            className={cn(
              "app-no-drag min-h-[44px] min-w-0 flex-1 resize-none rounded-lg border px-2.5 py-2 text-[16px] leading-snug outline-none transition-[border-color,box-shadow,background-color] duration-150 md:min-h-[30px] md:py-1.5 md:text-[12.5px]",
              "border-black/[0.09] bg-[#F4F5F7] text-[#111318] placeholder:text-[14px] placeholder:text-[#8E96A6] md:placeholder:text-[12px]",
              "focus:border-[#181B22]/30 focus:bg-white focus:ring-2 focus:ring-[#181B22]/[0.08]",
              "dark:border-white/[0.1] dark:bg-[#161619] dark:text-[#F2F2F4] dark:placeholder:text-[#71717A]",
              "dark:focus:border-white/[0.24] dark:focus:bg-[#161619] dark:focus:ring-white/[0.1]",
              "disabled:cursor-not-allowed disabled:opacity-55",
              highlightRing &&
                "border-[#D97706]/55 ring-2 ring-[#D97706]/30 dark:border-[#FBBF24]/50 dark:ring-[#FBBF24]/25",
            )}
          />
          <AppButton
            type="submit"
            size="xs"
            variant="primary"
            isLoading={submittingSource === CUSTOM_SUBMIT_SOURCE}
            disabled={isSubmitting || trimmedDraft.length === 0}
            className="h-11 shrink-0 whitespace-nowrap px-3.5 md:h-7 md:px-3"
          >
            {t("attention.reply")}
          </AppButton>
        </div>

        {showCharCounter ? (
          <p className="mt-1 text-right font-mono text-[11px] tabular-nums text-[#687082] dark:text-[#8E8E96]">
            {t("attention.charCounter", {
              count: draft.length,
              max: MAX_ATTENTION_CHOICE_LENGTH,
            })}
          </p>
        ) : null}
      </form>
    </div>
  );
}
