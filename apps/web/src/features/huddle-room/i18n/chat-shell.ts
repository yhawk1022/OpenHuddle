/**
 * @module web/features/huddle-room/i18n/chat-shell
 * @description 聊天主壳层强类型双语词典与作用域翻译器出口（含 `⌘K` 命令面板跨语种检索别名表）。
 */
import {
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
} from "../../../lib/i18n/index.js";
import { chatShellEn, chatShellPluralsEn } from "./chat-shell.en.js";
import { chatShellPluralsZhCN, chatShellZhCN } from "./chat-shell.zh-CN.js";

/** 聊天主壳层平铺双语词典（编译期强制中英文键集合及插值占位符一致）。 */
export const chatShellCatalog = defineCatalog(chatShellZhCN, chatShellEn);

/** 聊天主壳层复数双语词典（覆盖单复数英文语法与中文计数展示）。 */
export const chatShellPluralCatalog = definePluralCatalog(chatShellPluralsZhCN, chatShellPluralsEn);

const chatShellScoped = createScopedTranslator(chatShellCatalog, chatShellPluralCatalog);

/** 在非 React 场景或目标语切换瞬间获取聊天主壳层翻译器。 */
export const getChatShellTranslator = chatShellScoped.getTranslator;

/** 在 React 组件中订阅语种并获取聊天主壳层稳定引用翻译器。 */
export const useChatShellI18n = chatShellScoped.useI18n;

/**
 * `⌘K` 命令面板全量双语检索别名表。
 * 无论当前界面处于中文还是英文，均保留双语关键词以便用户跨语种搜索命令与语言切换项。
 */
export const CHAT_SHELL_COMMAND_KEYWORDS = {
  workbench: [
    "workbench",
    "solo",
    "multica",
    "swarm",
    /* i18n-ignore */ "工作台",
    /* i18n-ignore */ "看板",
    /* i18n-ignore */ "并发",
    /* i18n-ignore */ "派活",
  ],
  synthesize: [
    "synthesize",
    "proposal",
    /* i18n-ignore */ "提案",
    /* i18n-ignore */ "总结",
    /* i18n-ignore */ "整理",
  ],
  deleteRoom: [
    "delete",
    "remove",
    "room",
    /* i18n-ignore */ "删除",
    /* i18n-ignore */ "解散",
    /* i18n-ignore */ "群聊",
    /* i18n-ignore */ "单聊",
  ],
  addFriend: [
    "friend",
    "dm",
    "user",
    "search",
    /* i18n-ignore */ "好友",
    /* i18n-ignore */ "私聊",
    /* i18n-ignore */ "单聊",
    /* i18n-ignore */ "添加",
  ],
  connectAgent: [
    "agent",
    "connect",
    "pair",
    "cli",
    "mcp",
    /* i18n-ignore */ "配对",
    /* i18n-ignore */ "接入",
  ],
  createRoom: [
    "create",
    "new",
    "room",
    /* i18n-ignore */ "新建",
    /* i18n-ignore */ "建群",
    /* i18n-ignore */ "群聊",
  ],
  joinRoom: ["join", "invite", "token", /* i18n-ignore */ "加入", /* i18n-ignore */ "邀请码"],
  admin: [
    "admin",
    "console",
    "stats",
    "users",
    /* i18n-ignore */ "后台",
    /* i18n-ignore */ "管理",
    /* i18n-ignore */ "统计",
  ],
  accountSettings: [
    "account",
    "password",
    "security",
    "settings",
    "profile",
    /* i18n-ignore */ "账号",
    /* i18n-ignore */ "设置",
    /* i18n-ignore */ "密码",
    /* i18n-ignore */ "安全",
    /* i18n-ignore */ "昵称",
  ],
  welcome: [
    "welcome",
    "about",
    "portal",
    "author",
    "contact",
    "email",
    /* i18n-ignore */ "介绍",
    /* i18n-ignore */ "关于",
    /* i18n-ignore */ "门户",
    /* i18n-ignore */ "作者",
    /* i18n-ignore */ "联系",
    /* i18n-ignore */ "邮箱",
  ],
  themeToggle: [
    "theme",
    "dark",
    "light",
    /* i18n-ignore */ "主题",
    /* i18n-ignore */ "深色",
    /* i18n-ignore */ "浅色",
  ],
  themeAuto: ["theme", "auto", /* i18n-ignore */ "主题", /* i18n-ignore */ "自动"],
  refreshRate: [
    "fps",
    "hz",
    "promotion",
    "120hz",
    "144hz",
    "240hz",
    /* i18n-ignore */ "刷新率",
    /* i18n-ignore */ "帧率",
    /* i18n-ignore */ "高刷",
  ],
  language: [
    "lang",
    "language",
    "locale",
    /* i18n-ignore */ "语言",
    /* i18n-ignore */ "中文",
    "chinese",
    "zh",
    "english",
    /* i18n-ignore */ "英文",
    "en",
    "auto",
    /* i18n-ignore */ "自动",
  ],
  room: ["room", /* i18n-ignore */ "群聊", /* i18n-ignore */ "单聊"],
  friend: ["friend", "dm", /* i18n-ignore */ "好友", /* i18n-ignore */ "私聊"],
  agent: ["agent", /* i18n-ignore */ "单聊", "dm"],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>;
