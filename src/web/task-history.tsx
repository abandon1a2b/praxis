import { useState } from "react";
import useSWR from "swr";
import { request, time, statusLabels } from "./api";
import { Trajectory } from "./trajectory";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from "@/components/ui/table";
type Session = {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  status: string;
  turnCount: number;
  latestTaskId: string;
};
type Task = {
  input: { prompt: string };
  result: { text?: string } | null;
  error: string | null;
};
export function TaskHistory() {
  const { data: sessions = [], error } = useSWR<Session[]>(
    "/api/sessions",
    request,
    { refreshInterval: 2000 },
  );
  const [selected, setSelected] = useState<string | null>(null);
  const session = sessions.find((s) => s.id === selected) ?? sessions[0];
  const { data: task } = useSWR<Task>(
    session ? `/api/tasks/${session.latestTaskId}` : null,
    request,
    { refreshInterval: session?.status === "running" ? 2000 : 0 },
  );
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>会话轨迹</h1>
          <p>通用 Pi 会话</p>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>读取失败</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {sessions.length ? (
        <section className="runs-section">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>创建时间</TableHead>
                <TableHead>会话</TableHead>
                <TableHead>运行数</TableHead>
                <TableHead>状态</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow
                  key={s.id}
                  data-state={session?.id === s.id ? "selected" : undefined}
                >
                  <TableCell>{time(s.createdAt)}</TableCell>
                  <TableCell>
                    <span className="task-prompt">{s.title}</span>
                  </TableCell>
                  <TableCell>{s.turnCount}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === "failed" ? "destructive" : "secondary"
                      }
                    >
                      {s.status === "completed"
                        ? "已完成"
                        : statusLabels[s.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(s.id)}
                    >
                      查看
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无会话</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {session ? (
        <section className="report-view">
          <div className="section-heading">
            <div>
              <h2>会话记录</h2>
              <p>{session.cwd}</p>
              <code className="trace-id">{session.id}</code>
            </div>
          </div>
          {task?.error ? (
            <Alert variant="destructive">
              <AlertTitle>最近运行未完成</AlertTitle>
              <AlertDescription>{task.error}</AlertDescription>
            </Alert>
          ) : null}
          <Tabs defaultValue="trace" key={session.id}>
            <TabsList>
              <TabsTrigger value="trace">执行轨迹</TabsTrigger>
              <TabsTrigger value="result">最近回复</TabsTrigger>
              <TabsTrigger value="input">最近目标</TabsTrigger>
            </TabsList>
            <TabsContent value="trace">
              <Trajectory
                key={session.id}
                url={`/api/sessions/${session.id}/trajectory`}
                active={session.status === "running"}
              />
            </TabsContent>
            <TabsContent value="result">
              <pre className="task-text">
                {task?.result?.text ?? "暂无回复"}
              </pre>
            </TabsContent>
            <TabsContent value="input">
              <pre className="task-text">
                {task?.input.prompt ?? session.title}
              </pre>
            </TabsContent>
          </Tabs>
        </section>
      ) : null}
    </>
  );
}
