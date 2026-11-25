/**
 * @module web/lib/external-store
 * @description 面向 React 19 `useSyncExternalStore` 的轻量不可变状态容器工厂。
 *
 * 关键不变量：
 * 1. 引用相等性短路：`Object.is(next, state)` 为真时不触发无效广播，避免订阅组件死循环重渲染。
 * 2. SSR 快照稳定：`getServerSnapshot` 默认复用初始化时的恒定引用，消除水合阶段每次分配新对象触发的 React 告警。
 */

/** 订阅监听器签名 */
export type ExternalStoreListener = () => void;

/** 轻量外部状态容器实例接口 */
export interface ExternalStore<TState> {
  readonly getSnapshot: () => TState;
  readonly getServerSnapshot: () => TState;
  readonly setSnapshot: (next: TState | ((prev: TState) => TState)) => void;
  readonly subscribe: (listener: ExternalStoreListener) => () => void;
}

/**
 * 创建一个供 `useSyncExternalStore` 直接绑定的轻量外部状态容器。
 *
 * @param initialState - 初始不可变状态快照
 * @param serverFallback - 可选 SSR 快照（缺省复用 `initialState`）
 * @returns 包含 `getSnapshot`、`getServerSnapshot`、`setSnapshot` 与 `subscribe` 的容器句柄
 */
export function createExternalStore<TState>(
  initialState: TState,
  serverFallback: TState = initialState,
): ExternalStore<TState> {
  let state = initialState;
  const listeners = new Set<ExternalStoreListener>();

  const getSnapshot = (): TState => state;
  const getServerSnapshot = (): TState => serverFallback;

  const setSnapshot = (updater: TState | ((prev: TState) => TState)): void => {
    const next =
      typeof updater === "function" ? (updater as (prev: TState) => TState)(state) : updater;
    if (Object.is(next, state)) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const subscribe = (listener: ExternalStoreListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getSnapshot,
    getServerSnapshot,
    setSnapshot,
    subscribe,
  };
}
