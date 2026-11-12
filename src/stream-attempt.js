// 实时 assistant 流的帧协议：start → chunk* → end，帧形状即 dsh 的 AssistantStreamFrame wire 形状，
// 客户端按 revision 连续性校验（断号直接废掉流），end 帧的 outcome 必须和 durable append 对齐。
// stock 的 AssistantStreamAttempt 没有导出，这里用 dsh-llm 的公开原语自己实现。
import { AssistantStreamAccumulator, BlockAssembler, LlmAttemptId } from "@deepseek-ai/dsh-llm";
import { appendFileSync } from "node:fs";

export class EngineStreamAttempt {
  #emit;
  #nextRevision;
  #accumulator = new AssistantStreamAccumulator();
  #assembler = new BlockAssembler();
  #index = 0;
  #ended = false;

  /**
   * @param {{ sessionId: string, attempt: number, turn: number, step: number, nextRevision: () => number, emit: (frame: object) => void }} options
   */
  constructor({ sessionId, attempt, turn, step, nextRevision, emit }) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`);
    this.turn = turn;
    this.step = step;
    this.#nextRevision = nextRevision;
    // 诊断通道：DSH_FH_DEBUG 时把发出的帧（rev/index/turn/step）按序落盘。
    this.#emit = process.env.DSH_FH_DEBUG
      ? (frame) => {
          try { appendFileSync(process.env.DSH_FH_DEBUG, JSON.stringify({ frame: frame.type, rev: frame.revision, idx: frame.index, turn: frame.turn, step: frame.step, chunkType: frame.chunk?.type }) + "\n"); } catch {}
          emit(frame);
        }
      : emit;
  }

  get ended() { return this.#ended; }
  /** 持久 compact 流（与 assistant/message 的 stream 字段同源）。 */
  get stream() { return this.#accumulator.snapshot(); }
  get usage() { return this.#assembler.usage; }
  get finish() { return this.#assembler.finish; }
  /** @returns {object[]} 正常完成的内容块 */
  blocks() { return this.#assembler.blocks(); }
  /** @returns {object[]} 中断时安全可见的前缀块 */
  interruptedBlocks() { return this.#assembler.interruptedBlocks(); }

  start() {
    this.#emit({ type: "start", attemptId: this.attemptId, revision: this.#nextRevision(), turn: this.turn, step: this.step });
  }

  /** @param {import("@deepseek-ai/dsh-llm").StreamChunk} chunk */
  push(chunk) {
    const time = Date.now();
    try {
      this.#accumulator.push({ time, chunk });
    } catch (error) {
      console.error("[fh] bad chunk", JSON.stringify(chunk, (k, v) => (v === undefined ? "__undef__" : v)));
      throw error;
    }
    this.#assembler.push(chunk);
    this.#emit({ type: "chunk", attemptId: this.attemptId, revision: this.#nextRevision(), index: this.#index++, time, chunk });
  }

  /**
   * durable 事件提交后收尾：end 帧携带真实 seq，客户端折叠出的 live entry 才能和日志对上。
   * @param {"assistant/message" | "assistant/attempt"} eventType
   * @param {() => number} append 提交 durable 事件，返回 seq
   */
  settle(eventType, append) {
    let seq;
    try {
      seq = append();
    } catch (error) {
      // durable append 失败时没有可提交的 settlement，和 stock 一样先 abandon（关掉 live 流）再把原错误抛回去。
      this.abandon();
      throw error;
    }
    this.#emit({ type: "end", attemptId: this.attemptId, revision: this.#nextRevision(), index: this.#index++, outcome: { kind: "committed", eventType, seq } });
    this.#ended = true;
  }

  /** 本 attempt 不落任何 durable 事件（比如纯失败重试），只关掉流。 */
  abandon() {
    this.#emit({ type: "end", attemptId: this.attemptId, revision: this.#nextRevision(), index: this.#index++, outcome: { kind: "abandoned" } });
    this.#ended = true;
  }
}
