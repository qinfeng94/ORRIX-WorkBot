/**
 * token-bucket.ts — 令牌桶限流器（零第三方依赖，时钟可注入便于测试）
 * 设计口径：削峰不拒单——令牌耗尽时请求在准入队列里等令牌，绝不丢弃/拒绝，
 *          这是「0 失败率」战报的前提之一（丢弃类限流物理不存在于本模块）。
 */

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSec: number;
  private tokens: number;
  private lastRefillMs: number;
  private readonly nowMs: () => number;

  constructor(capacity: number, refillPerSec: number, nowMs: () => number) {
    if (!(capacity > 0)) throw new Error("令牌桶容量必须 > 0");
    if (!(refillPerSec > 0)) throw new Error("令牌补充速率必须 > 0");
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.nowMs = nowMs;
    this.tokens = capacity;
    this.lastRefillMs = nowMs();
  }

  /** 按流逝时间补充令牌（容量封顶，绝不超发） */
  private refill(): void {
    const now = this.nowMs();
    const elapsedSec = Math.max(0, now - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefillMs = now;
    }
  }

  /** 尝试取走 n 个令牌；不足时只返还 false，绝不透支为负数 */
  tryTake(n: number = 1): boolean {
    this.refill();
    if (this.tokens + 1e-9 >= n) {
      this.tokens = Math.max(0, this.tokens - n);
      return true;
    }
    return false;
  }

  /** 只读窥探当前余量（不消耗），供看板仪表盘轮询 */
  peek(): number {
    this.refill();
    return this.tokens;
  }
}
