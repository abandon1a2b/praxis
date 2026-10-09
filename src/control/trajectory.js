import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const clip = (value) => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > 20000
    ? `${text.slice(0, 20000)}\n[显示内容已截断，原始日志保留]`
    : text;
};
const textContent = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === "text")
          .map((c) => c.text ?? "")
          .join("\n")
      : "";
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
      output: clip(textContent(event.result?.content) || event.result),
    };
  if (event.type === "message_end") {
    const message = event.message;
    if (message?.role === "user")
      return {
        ...base,
        title: "用户消息",
        state: "user",
        input: clip(textContent(message.content)),
      };
    if (message?.role !== "assistant") return null;
    const text = textContent(message.content);
    if (!text && !message.errorMessage) return null;
    return {
      ...base,
      title: "模型回复",
      state:
        message.stopReason === "error"
          ? "error"
          : message.stopReason === "aborted"
            ? "interrupted"
            : "completed",
      output: clip(text || message.errorMessage),
      usage: message.usage,
    };
  }
  if (event.type === "user_message")
    return {
      ...base,
      title: event.initial ? "用户目标" : "追加指令",
      state: event.mode,
      input: clip(event.text),
    };
  if (event.type === "memory_context")
    return {
      ...base,
      title: "巡检记忆",
      state: "context",
      input: clip({ scope: event.scope, observationIds: event.observationIds }),
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
export function pairEvents(events, status = "running") {
  const result = [],
    calls = new Map();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.callId) {
      calls.set(event.callId, event);
      result.push({ ...event });
      calls.set(event.callId, result.at(-1));
    } else if (event.type === "tool_execution_end" && calls.has(event.callId)) {
      const start = calls.get(event.callId);
      start.state = event.state;
      start.output = event.output;
      start.endTime = event.time;
      if (start.time && event.time) {
        const duration =
          Number(new Date(event.time)) - Number(new Date(start.time));
        if (duration >= 0) start.durationMs = duration;
      }
      calls.delete(event.callId);
    } else result.push({ ...event });
  }
  if (status !== "running")
    for (const pending of calls.values()) pending.state = "interrupted";
  return result;
}
export function trajectoryPage(events, { before, limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid trajectory limit");
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
    throw new Error("Invalid trajectory cursor");
  const end = Math.min(before ?? events.length, events.length),
    start = Math.max(0, end - limit);
  return {
    events: events.slice(start, end),
    total: events.length,
    nextBefore: start > 0 ? start : null,
    limited: start > 0,
  };
}
export async function readTrajectory(file, extra = [], options = {}) {
  const events = [];
  let index = 0,
    limited = false;
  let step = 0;
  let localTurn = 0;
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
        if (raw.type === "message_end" && raw.message?.role === "user") {
          localTurn++;
          step = 0;
        }
        if (raw.type === "turn_start") step++;
        const event = traceEvent(raw, index++);
        if (event) {
          event.step = step || null;
          event.localTurn = localTurn || 1;
          events.push(event);
          if (!options.all && events.length > 200) {
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
    if (
      raw.type === "user_message" &&
      events.some((event) => event.state === "user" && event.input === raw.text)
    )
      continue;
    const event = traceEvent(raw, index++);
    if (event) {
      event.localTurn = localTurn || 1;
      events.push(event);
    }
  }
  if (events.every((event) => event.time !== null))
    events.sort(
      (a, b) => Number(new Date(a.time ?? 0)) - Number(new Date(b.time ?? 0)),
    );
  return {
    events: options.all
      ? pairEvents(events, options.status)
      : events.slice(-200),
    limited: limited || events.length > 200,
  };
}
export async function sessionTrajectory(store, id, options = {}) {
  const tasks = store.sessionTasks(id);
  if (!tasks.length) return null;
  const parts = [];
  let turnOffset = 0;
  const journalDirs = new Set();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i],
      dir =
        task.result?.sessionDir ??
        (task.result?.sessionFile
          ? path.dirname(task.result.sessionFile)
          : null);
    const file =
      dir && !journalDirs.has(dir) ? path.join(dir, "events.jsonl") : null;
    const meta = await store.trajectoryIndex.update(file, task.status);
    if (dir) journalDirs.add(dir);
    const goal = traceEvent(
      {
        type: "user_message",
        initial: true,
        text: task.input.prompt,
        mode: "user",
        time: task.createdAt,
      },
      "goal",
    );
    if (!meta.hasUser)
      parts.push({ events: [goal], count: 1, taskId: task.id, turnOffset });
    const context = store
      .taskContextEvents(task.id)
      .filter((raw) => raw.type === "memory_context")
      .map((raw) => ({
        ...traceEvent(raw, `context:${raw.seq}`),
        localTurn: 1,
      }));
    if (context.length)
      parts.push({
        events: context,
        count: context.length,
        taskId: task.id,
        turnOffset,
      });
    if (meta.count)
      parts.push({
        file,
        count: meta.count,
        taskId: task.id,
        turnOffset,
        status: task.status,
      });
    const extra = store.userTaskEvents(task.id).map((raw) => ({
      ...traceEvent(raw, `accepted:${raw.seq}`),
      title: "追加指令已接受",
      localTurn: meta.turns,
    }));
    if (extra.length)
      parts.push({
        events: extra,
        count: extra.length,
        taskId: task.id,
        turnOffset,
      });
    turnOffset += meta.turns;
  }
  return {
    ...indexedPage(store, parts, options),
    sessionId: id,
    turnCount: turnOffset,
  };
}

function indexedPage(store, parts, options) {
  trajectoryPage([], options);
  const total = parts.reduce((sum, part) => sum + part.count, 0),
    end = Math.min(options.before ?? total, total),
    start = Math.max(0, end - (options.limit ?? 50));
  const events = [];
  let position = 0;
  for (const part of parts) {
    const from = Math.max(0, start - position),
      to = Math.min(part.count, end - position);
    if (from < to) {
      const records = part.events
        ? part.events.slice(from, to)
        : store.trajectoryIndex.page(part.file, from, to - from, part.status);
      for (const event of records)
        events.push({
          ...event,
          id: part.taskId ? `${part.taskId}:${event.id}` : event.id,
          taskId: part.taskId,
          turn: (part.turnOffset ?? 0) + (event.localTurn ?? 1),
        });
    }
    position += part.count;
  }
  return {
    events,
    total,
    nextBefore: start > 0 ? start : null,
    limited: start > 0,
  };
}
export async function indexedTrajectory(
  store,
  file,
  status,
  extra = [],
  options = {},
) {
  const meta = await store.trajectoryIndex.update(file, status),
    parts = [];
  const context = extra.filter((raw) => raw.type === "memory_context");
  if (context.length)
    parts.push({
      events: context.map((raw) => ({
        ...traceEvent(raw, `context:${raw.seq}`),
        localTurn: 1,
      })),
      count: context.length,
    });
  if (meta.count) parts.push({ file, count: meta.count, status });
  extra = extra.filter((raw) => raw.type !== "memory_context");
  if (extra.length)
    parts.push({
      events: extra.map((raw) => ({
        ...traceEvent(raw, `accepted:${raw.seq}`),
        localTurn: meta.turns,
      })),
      count: extra.length,
    });
  return indexedPage(store, parts, options);
}
