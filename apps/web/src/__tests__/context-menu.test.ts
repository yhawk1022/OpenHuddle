/**
 * @module web/tests/context-menu
 * @description 验证 Gmail 风格右键菜单 `normalizeContextMenuEntries` 对分割线折叠、空子菜单裁剪及孤立分组标签清理的不变量。
 */
import { describe, expect, it } from "vitest";
import {
  type AppContextMenuEntry,
  normalizeContextMenuEntries,
} from "../components/primitives/overlays.js";

const noop = (): void => undefined;

describe("@openhuddle/web — AppContextMenu entry normalization", () => {
  it("strips leading/trailing separators and collapses consecutive separators", () => {
    const entries: ReadonlyArray<AppContextMenuEntry> = [
      { kind: "separator", id: "s1" },
      { id: "open", label: "打开群聊", onSelect: noop },
      { kind: "separator", id: "s2" },
      { kind: "separator", id: "s3" },
      { id: "copy", label: "复制链接", onSelect: noop },
      { kind: "separator", id: "s4" },
    ];

    const normalized = normalizeContextMenuEntries(entries);
    expect(normalized.map((e) => e.id)).toEqual(["open", "s2", "copy"]);
  });

  it("recursively normalizes submenus and drops empty submenus", () => {
    const entries: ReadonlyArray<AppContextMenuEntry> = [
      { id: "reply", label: "回复", onSelect: noop },
      { kind: "separator", id: "s1" },
      {
        kind: "submenu",
        id: "empty-sub",
        label: "空子菜单",
        items: [
          { kind: "separator", id: "sub-s1" },
          { kind: "label", id: "sub-l1", label: "空标题" },
        ],
      },
      { kind: "separator", id: "s2" },
      {
        kind: "submenu",
        id: "valid-sub",
        label: "讨论节奏",
        items: [
          { kind: "separator", id: "sub-s2" },
          { id: "free", label: "自由讨论", onSelect: noop },
          { kind: "separator", id: "sub-s3" },
          { kind: "separator", id: "sub-s4" },
          { id: "round", label: "圆桌轮流", onSelect: noop },
          { kind: "separator", id: "sub-s5" },
        ],
      },
    ];

    const normalized = normalizeContextMenuEntries(entries);
    expect(normalized.map((e) => e.id)).toEqual(["reply", "s1", "valid-sub"]);
    const validSub = normalized[2];
    expect(validSub?.kind).toBe("submenu");
    if (validSub?.kind === "submenu") {
      expect(validSub.items.map((e) => e.id)).toEqual(["free", "sub-s3", "round"]);
    }
  });

  it("drops orphan section labels that have no actionable items in their section", () => {
    const entries: ReadonlyArray<AppContextMenuEntry> = [
      { kind: "label", id: "empty-head", label: "无操作" },
      { kind: "separator", id: "s1" },
      { kind: "label", id: "active-head", label: "常用" },
      { id: "copy", label: "复制", onSelect: noop },
      { kind: "separator", id: "s2" },
      { kind: "label", id: "trailing-head", label: "尾部空组" },
    ];

    const normalized = normalizeContextMenuEntries(entries);
    expect(normalized.map((e) => e.id)).toEqual(["active-head", "copy"]);
  });
});
