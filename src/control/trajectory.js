import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const clip = (value) =>
  typeof value === "string"
    ? value.slice(0, 20000)
    : JSON.stringify(value ?? null).slice(0, 20000);
export function traceEvent(event, index) {
  const base = {
    id: String(index),
    type: event.type,
    time: event.time ?? event.message?.timestamp ?? null,
  };
  if (event.type === "tool_execution_start")
    return {
      ...base,
      title: event.toolName,
      callId: event.toolCallId,
      state: "started",
      input: clip(event.args),
    };
  if (event.type === "tool_execution_end")
    return {
      ...base,
      title: event.toolName,
      callId: event.toolCallId,
      state: event.isError ? "error" : "completed",
      output: clip(
        event.result?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? event.result,
      ),
    };
  if (event.type === "message_end") {
    const message = event.message;
    if (message?.role !== "assistant") return null;
    const text = message.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!text && !message.errorMessage) return null;
    return {
      ...base,
      title: "模型回复",
      state: message.stopReason === "error" ? "error" : "completed",
      output: clip(text || message.errorMessage),
      usage: message.usage,
    };
  }
  if (event.type === "user_message")
    return {
      ...base,
      title: "追加指令",
      state: event.mode,
      input: clip(event.text),
    };
  if (
    event.type === "auto_compaction_start" ||
    event.type === "auto_compaction_end"
  )
    return {
      ...base,
      title: "上下文压缩",
      state: event.type.endsWith("start") ? "started" : "completed",
    };
  return null;
}
export async function readTrajectory(file, extra = []) {
  const events = [];
  let index = 0,
    limited = false;
  if (file) {
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const event = traceEvent(raw, index++);
        if (event) {
          events.push(event);
          if (events.length > 200) {
            events.shift();
            limited = true;
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  for (const raw of extra) {
    const event = traceEvent(raw, index++);
    if (event) events.push(event);
  }
  if (events.every((event) => event.time !== null))
    events.sort(
      (a, b) => Number(new Date(a.time ?? 0)) - Number(new Date(b.time ?? 0)),
    );
  return {
    events: events.slice(-200),
    limited: limited || events.length > 200,
  };
}
