// Pure, deterministic S2 telemetry interpretation. No child process or provider calls.
export type StopReason = "NO_ACTIVITY" | "NO_MEANINGFUL_PROGRESS";

export interface ProgressObservation {
  activity: boolean;
  meaningful: boolean;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

const TEST_COMMAND = /(?:^|[\s;&|])(?:node(?:\.exe)?\s+--test|npm(?:\.cmd)?\s+(?:run\s+)?(?:test|typecheck|check|build|lint)|pnpm(?:\.cmd)?\s+(?:run\s+)?(?:test|typecheck|check|build|lint))\b/i;

export function parseProgressEvent(line: string): ProgressObservation {
  const none: ProgressObservation = { activity: false, meaningful: false, usage: null };
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return none; }
  if (!parsed || typeof parsed !== "object") return none;
  const event = parsed as Record<string, unknown>;
  const activity = typeof event.type === "string" && /^(thread\.started|turn\.started|item\.(started|updated|completed))$/.test(event.type);
  let meaningful = false;
  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    meaningful = item.type === "file_change" && item.status !== "failed";
    if (item.type === "command_execution" && item.status === "completed" && typeof item.command === "string") {
      meaningful = TEST_COMMAND.test(item.command);
    }
  }
  let usage: ProgressObservation["usage"] = null;
  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const data = event.usage as Record<string, unknown>;
    if (Number.isSafeInteger(data.input_tokens) && Number.isSafeInteger(data.output_tokens)
      && (data.input_tokens as number) >= 0 && (data.output_tokens as number) >= 0) {
      usage = {
        inputTokens: data.input_tokens as number,
        outputTokens: data.output_tokens as number,
        cachedInputTokens: Number.isSafeInteger(data.cached_input_tokens) ? data.cached_input_tokens as number : 0
      };
    }
  }
  return { activity, meaningful, usage };
}

// Fail closed only before the first verified edit/test. Never call PASS on telemetry alone.
export function evaluateProgressGate(
  elapsedMs: number,
  inactiveMs: number,
  meaningfulObserved: boolean
): StopReason | null {
  if (meaningfulObserved) return null;
  if (elapsedMs >= 150_000) return "NO_MEANINGFUL_PROGRESS";
  if (inactiveMs >= 60_000) return "NO_ACTIVITY";
  return null;
}
