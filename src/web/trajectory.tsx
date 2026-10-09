import useSWRInfinite from "swr/infinite";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { request, time } from "./api";
import { useRef, useState, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

type Trace = {
  id: string;
  type: string;
  time: string | number | null;
  title: string;
  state: string;
  callId?: string;
  input?: string;
  output?: string;
  turn?: number;
  step?: number;
  durationMs?: number;
};
type Page = {
  events: Trace[];
  limited: boolean;
  total?: number;
  nextBefore?: number | null;
  sessionId?: string;
};
function TraceList({
  events,
  loadEarlier,
  hasEarlier,
  loading,
}: {
  events: Trace[];
  loadEarlier: () => void;
  hasEarlier: boolean;
  loading: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    anchor = useRef<{ id: string; offset: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const virtual = useVirtualizer({
    count: events.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 90,
    overscan: 5,
    getItemKey: (index) => events[index].id,
    useFlushSync: false,
  });
  useLayoutEffect(() => {
    const saved = anchor.current;
    const index = saved
      ? events.findIndex((event) => event.id === saved.id)
      : events.length - 1;
    if (index < 0) return;
    if (saved || follow.current) {
      virtual.scrollToIndex(index, { align: saved ? "start" : "end" });
      const frame = requestAnimationFrame(() => {
        if (saved && parent.current) {
          const row = virtual
            .getVirtualItems()
            .find((item) => item.index === index);
          if (row) parent.current.scrollTop = row.start + saved.offset;
        } else if (follow.current)
          virtual.scrollToIndex(index, { align: "end" });
      });
      anchor.current = null;
      return () => cancelAnimationFrame(frame);
    }
  }, [
    events.length,
    events[0]?.id,
    events.at(-1)?.id,
    events.at(-1)?.state,
    events.at(-1)?.output?.length,
  ]);
  function earlier() {
    const row = virtual
      .getVirtualItems()
      .find((item) => item.end > (parent.current?.scrollTop ?? 0));
    if (row)
      anchor.current = {
        id: events[row.index].id,
        offset: (parent.current?.scrollTop ?? 0) - row.start,
      };
    follow.current = false;
    loadEarlier();
  }
  return (
    <>
      {hasEarlier ? (
        <Button variant="outline" disabled={loading} onClick={earlier}>
          {loading ? "加载中…" : "加载更早历史"}
        </Button>
      ) : null}
      <div
        className="trace-scroll"
        ref={parent}
        onScroll={() => {
          const node = parent.current;
          if (node)
            follow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        }}
      >
        <ol style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const event = events[item.index],
              index = item.index;
            return (
              <li
                key={event.id}
                data-index={index}
                data-record-id={event.id}
                ref={virtual.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "calc(100% - 16px)",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {event.turn !== undefined &&
                event.turn !== events[index - 1]?.turn ? (
                  <h3 className="trace-turn">轮次 {event.turn}</h3>
                ) : null}
                <details
                  open={expanded.has(event.id)}
                  onToggle={(e) => {
                    const open = e.currentTarget.open;
                    setExpanded((previous) => {
                      if (previous.has(event.id) === open) return previous;
                      const next = new Set(previous);
                      open ? next.add(event.id) : next.delete(event.id);
                      return next;
                    });
                  }}
                >
                  <summary>
                    <span className="trace-heading">
                      <strong>{event.title}</strong>
                      <Badge
                        variant={
                          event.state === "error" ? "destructive" : "secondary"
                        }
                      >
                        {(
                          {
                            started: "开始",
                            completed: "完成",
                            error: "错误",
                            steer: "调整",
                            followUp: "后续",
                            interrupted: "中断",
                            user: "用户",
                            context: "上下文",
                          } as Record<string, string>
                        )[event.state] ?? event.state}
                      </Badge>
                    </span>
                    {event.step ? (
                      <span className="text-muted-foreground text-xs">
                        步骤 {event.step}
                      </span>
                    ) : null}
                    <time>
                      {event.time
                        ? time(new Date(event.time).toISOString())
                        : "时间未记录"}
                    </time>
                  </summary>
                  {event.durationMs !== undefined ? (
                    <p className="text-muted-foreground text-xs">
                      耗时 {(event.durationMs / 1000).toFixed(2)} 秒
                    </p>
                  ) : null}
                  {event.callId ? (
                    <code className="trace-id">{event.callId}</code>
                  ) : null}
                  {event.input ? (
                    <>
                      <h4>输入</h4>
                      <pre>{event.input}</pre>
                    </>
                  ) : null}
                  {event.output ? (
                    <>
                      <h4>输出</h4>
                      <pre>{event.output}</pre>
                    </>
                  ) : null}
                </details>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
export function Trajectory({ url, active }: { url: string; active: boolean }) {
  const { data, error, size, setSize, isValidating } = useSWRInfinite<Page>(
    (index, previous) =>
      index === 0
        ? url
        : previous?.nextBefore === null || previous?.nextBefore === undefined
          ? null
          : `${url}?before=${previous.nextBefore}&limit=50`,
    request,
    { refreshInterval: active ? 1500 : 0 },
  );
  const events = [
    ...new Map(
      (data ?? [])
        .slice()
        .reverse()
        .flatMap((page) => page.events)
        .map((event) => [event.id, event]),
    ).values(),
  ];
  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>轨迹读取失败</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  if (!data) return <Skeleton className="h-40 w-full" />;
  if (!events.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{active ? "等待执行事件" : "暂无执行轨迹"}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="trajectory">
      <div className="run-facts">
        <span>
          {events.length} 条记录
          {data[0]?.total !== undefined ? ` / ${data[0].total}` : ""}
        </span>
        <span>{active ? "实时更新" : "历史记录"}</span>
      </div>
      <TraceList
        events={events}
        hasEarlier={
          data.at(-1)?.nextBefore !== null &&
          data.at(-1)?.nextBefore !== undefined
        }
        loading={isValidating}
        loadEarlier={() => void setSize(size + 1)}
      />
    </div>
  );
}
