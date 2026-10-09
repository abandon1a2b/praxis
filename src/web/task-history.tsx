import { useState } from "react";
import useSWR from "swr";
import { request, time, statusLabels } from "./api";
import { Trajectory } from "./trajectory";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from "@/components/ui/table";
type Task = {
  id: string;
  status: string;
  createdAt: string;
  input: { prompt: string; cwd: string };
  result: { text?: string } | null;
  error: string | null;
};
export function TaskHistory() {
  const { data: tasks = [], error } = useSWR<Task[]>("/api/tasks", request, {
    refreshInterval: 2000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const task = tasks.find((t) => t.id === selected) ?? tasks[0];
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>任务轨迹</h1>
          <p>通用 Pi 任务</p>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>读取失败</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {tasks.length ? (
        <section className="runs-section">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>任务</TableHead>
                <TableHead>状态</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow
                  key={t.id}
                  data-state={task?.id === t.id ? "selected" : undefined}
                >
                  <TableCell>{time(t.createdAt)}</TableCell>
                  <TableCell>
                    <span className="task-prompt">{t.input.prompt}</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        t.status === "failed" ? "destructive" : "secondary"
                      }
                    >
                      {t.status === "completed"
                        ? "已完成"
                        : statusLabels[t.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(t.id)}
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
            <EmptyTitle>暂无通用任务</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {task ? (
        <section className="report-view">
          <div className="section-heading">
            <div>
              <h2>执行记录</h2>
              <p>{task.input.cwd}</p>
            </div>
          </div>
          {task.error ? (
            <Alert variant="destructive">
              <AlertTitle>任务未完成</AlertTitle>
              <AlertDescription>{task.error}</AlertDescription>
            </Alert>
          ) : null}
          <Tabs defaultValue="trace" key={task.id}>
            <TabsList>
              <TabsTrigger value="trace">执行轨迹</TabsTrigger>
              <TabsTrigger value="result">回复</TabsTrigger>
              <TabsTrigger value="input">目标</TabsTrigger>
            </TabsList>
            <TabsContent value="trace">
              <Trajectory
                url={`/api/tasks/${task.id}/trajectory`}
                active={task.status === "running"}
              />
            </TabsContent>
            <TabsContent value="result">
              <pre className="task-text">{task.result?.text ?? "暂无回复"}</pre>
            </TabsContent>
            <TabsContent value="input">
              <pre className="task-text">{task.input.prompt}</pre>
            </TabsContent>
          </Tabs>
        </section>
      ) : null}
    </>
  );
}
