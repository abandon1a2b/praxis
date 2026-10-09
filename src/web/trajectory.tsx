import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { request, time } from "./api";

type Trace = {
  id: string;
  type: string;
  time: string | number | null;
  title: string;
  state: string;
  callId?: string;
  input?: string;
  output?: string;
};
export function Trajectory({ url, active }: { url: string; active: boolean }) {
  const { data, error } = useSWR<{ events: Trace[]; limited: boolean }>(
    url,
    request,
    { refreshInterval: active ? 1500 : 0 },
  );
  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>轨迹读取失败</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  if (!data) return <Skeleton className="h-40 w-full" />;
  if (!data.events.length)
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
          {data.events.length} 条事件{data.limited ? " · 仅最近 200 条" : ""}
        </span>
        <span>{active ? "实时更新" : "历史记录"}</span>
      </div>
      <ol>
        {data.events.map((event) => (
          <li key={event.id}>
            <details>
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
                      } as Record<string, string>
                    )[event.state] ?? event.state}
                  </Badge>
                </span>
                <time>
                  {event.time
                    ? time(new Date(event.time).toISOString())
                    : "时间未记录"}
                </time>
              </summary>
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
        ))}
      </ol>
    </div>
  );
}
