// dsh-cc-agent-loop：用 Claude Code 作为 dsh 的 agent loop。
// 默认导出的就是循环本体（stock dsh-agent-loop 的 vendored 副本，只在 step() 处留了一个分流点），
// profile 里把 stock `agent-loop` 行 disable 掉、换成这一行即可。
import { AgentLoop, setClaudeStep } from "../vendor/agent-loop.js";
import { claudeStep } from "./claude-step.js";

setClaudeStep(claudeStep);

export default AgentLoop;
export { AgentLoop };
