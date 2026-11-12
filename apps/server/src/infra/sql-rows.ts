/**
 * @module server/infra/sql-rows
 * @description Drizzle `db.execute(sql\`...\`)` 双驱动（`PGlite` / `node-postgres`）返回结果行的零 `any` 类型收窄辅助函数。
 *
 * 架构职责与关键不变量（Invariants）：
 * 联合驱动类型 `OpenHuddleDb` 上的 `execute()` 返回 `unknown`，统一通过运行时结构守卫提取 `rows` 数组后再做强类型映射。
 */

/**
 * 从 `db.execute(...)` 返回值中安全提取行数组。
 *
 * @param result - Drizzle `execute` 原始返回对象
 * @returns 行记录只读数组（若无 `rows` 字段则返回空数组）
 */
export function extractSqlRows<TRow>(result: unknown): readonly TRow[] {
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { readonly rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows as readonly TRow[];
    }
  }
  return [];
}
