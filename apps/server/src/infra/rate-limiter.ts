/**
 * @module server/infra/rate-limiter
 * @description 面向认证接口的内存有界滑动窗口限流器与代理安全客户端 IP 提取工具。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 有界内存（2C4G 友好）：通过 `maxKeys` 上限与周期性过期桶回收，防止恶意随机 IP 洪泛撑爆 Node.js 堆内存。
 * 2. 确定性时间戳注入：核心方法接受可选 `nowMs` 参数，确保单元测试可秒级精确验证窗口过期与重试倒计时。
 * 3. 失败计数与常规频控解耦：支持「先判定再累加（登录防爆破）」与「单步检查并扣减（接口请求限流）」两种模式。
 */
import type { Context } from "hono";

/**
 * 限流判定结果快照。
 */
export interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSec: number;
}

/**
 * 有界内存滑动窗口限流器（适用于单进程及进程级防爆破前哨；邮箱重发冷却由 PostgreSQL 持久层额外兜底）。
 */
export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxKeys: number;

  /**
   * @param options - 可选最大键数上限（默认 `10_000`）
   */
  public constructor(options?: { readonly maxKeys?: number }) {
    this.maxKeys = options?.maxKeys ?? 10_000;
  }

  private pruneBucket(key: string, windowMs: number, nowMs: number): number[] {
    const existing = this.buckets.get(key);
    if (!existing) {
      return [];
    }
    const cutoff = nowMs - windowMs;
    const fresh = existing.filter((ts) => ts > cutoff);
    if (fresh.length === 0) {
      this.buckets.delete(key);
    } else if (fresh.length !== existing.length) {
      this.buckets.set(key, fresh);
    }
    return fresh;
  }

  private evictIfNeeded(nowMs: number, windowMs: number): void {
    if (this.buckets.size < this.maxKeys) {
      return;
    }
    // 先清理明显过期的空桶；若仍满则按 Map 插入序淘汰最老键（FIFO 近似 LRU）
    const cutoff = nowMs - windowMs;
    for (const [k, timestamps] of this.buckets) {
      const latest = timestamps[timestamps.length - 1];
      if (latest === undefined || latest <= cutoff) {
        this.buckets.delete(k);
      }
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
      }
    }
  }

  /**
   * 仅检查当前键是否已触及窗口上限，不写入新记录（适用于密码登录前的失败次数熔断检查）。
   *
   * @param key - 限流维度键（如 `login-fail:<ip>:<email>`）
   * @param limit - 窗口内允许的最大次数
   * @param windowMs - 滑动窗口时长（毫秒）
   * @param nowMs - 当前毫秒时间戳（默认 `Date.now()`）
   * @returns 限流判定结果与建议重试等待秒数
   */
  public checkOnly(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number = Date.now(),
  ): RateLimitCheckResult {
    const hits = this.pruneBucket(key, windowMs, nowMs);
    if (hits.length >= limit) {
      const oldestHit = hits[0] ?? nowMs;
      const retryAfterSec = Math.max(1, Math.ceil((oldestHit + windowMs - nowMs) / 1_000));
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec,
      };
    }
    return {
      allowed: true,
      remaining: Math.max(0, limit - hits.length),
      retryAfterSec: 0,
    };
  }

  /**
   * 向指定键追加一条命中时间戳（例如密码校验失败时记录失败计数）。
   *
   * @param key - 限流维度键
   * @param windowMs - 滑动窗口时长（毫秒）
   * @param nowMs - 当前毫秒时间戳（默认 `Date.now()`）
   */
  public recordHit(key: string, windowMs: number, nowMs: number = Date.now()): void {
    const hits = this.pruneBucket(key, windowMs, nowMs);
    if (hits.length === 0) {
      this.evictIfNeeded(nowMs, windowMs);
    }
    hits.push(nowMs);
    this.buckets.set(key, hits);
  }

  /**
   * 原子检查并在允许时记入一次命中（适用于接口请求频控）。
   *
   * @param key - 限流维度键
   * @param limit - 窗口内允许的最大次数
   * @param windowMs - 滑动窗口时长（毫秒）
   * @param nowMs - 当前毫秒时间戳（默认 `Date.now()`）
   * @returns 限流判定结果
   */
  public checkAndConsume(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number = Date.now(),
  ): RateLimitCheckResult {
    const check = this.checkOnly(key, limit, windowMs, nowMs);
    if (!check.allowed) {
      return check;
    }
    this.recordHit(key, windowMs, nowMs);
    return {
      allowed: true,
      remaining: Math.max(0, check.remaining - 1),
      retryAfterSec: 0,
    };
  }

  /**
   * 清空指定键的计数桶（例如用户密码登录成功后重置失败计数）。
   *
   * @param key - 待清理的限流维度键
   */
  public reset(key: string): void {
    this.buckets.delete(key);
  }
}

/**
 * 从 Hono 请求头中提取客户端源 IP（兼容 Caddy / Nginx 单层反向代理注入头）。
 *
 * @remarks
 * 在标准反向代理拓扑下，代理会将真实对端 IP 追加在 `X-Forwarded-For` 末尾；
 * 若读取首跳（`[0]`），客户端可伪造随机 `X-Forwarded-For` 请求头绕过登录与验证码频控。
 * 因此优先读取代理覆写的单值 `X-Real-IP`，否则取 `X-Forwarded-For` 最右跳。
 *
 * @param c - Hono 请求上下文
 * @returns 规范化后的客户端 IP 标识字符串
 */
export function extractClientIp(c: Context): string {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp && realIp.length > 0) {
    return realIp.slice(0, 64);
  }
  const forwarded = c.req.header("x-forwarded-for")?.trim();
  if (forwarded && forwarded.length > 0) {
    const hops = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const rightmostHop = hops[hops.length - 1];
    if (rightmostHop !== undefined) {
      return rightmostHop.slice(0, 64);
    }
  }
  return "local";
}
