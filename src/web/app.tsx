import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Activity,
  FolderGit2,
  Plus,
  Play,
  RefreshCw,
  Settings2,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { ConfigForm } from "./config-form";
import { ReportView } from "./report";
import { request, time, statusLabels } from "./api";
import type { Business, Model, Run, RunSummary } from "./types";
import { TaskHistory } from "./task-history";

export function App() {
  const { mutate } = useSWRConfig();
  const {
    data: businesses,
    error: loadError,
    mutate: reloadBusinesses,
  } = useSWR<Business[]>("/api/businesses", request, { refreshInterval: 5000 });
  const { data: models = [] } = useSWR<Model[]>("/api/models", request);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState("runs");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tasksView, setTasksView] = useState(false);
  const business =
    businesses?.find((b) => b.id === selected) ??
    (selected === null ? businesses?.[0] : undefined);
  const {
    data: runs = [],
    error: runsError,
    mutate: reloadRuns,
  } = useSWR<RunSummary[]>(
    !creating && business ? `/api/businesses/${business.id}/runs` : null,
    request,
    { refreshInterval: 2000 },
  );
  const currentRunId = runId ?? runs[0]?.id;
  const {
    data: run,
    error: reportError,
    mutate: reloadReport,
  } = useSWR<Run>(
    !creating && currentRunId ? `/api/runs/${currentRunId}` : null,
    request,
    { refreshInterval: (data) => (data?.status === "running" ? 2000 : 0) },
  );
  const visibleRuns = runs.map((summary) =>
    run?.id === summary.id
      ? {
          ...summary,
          status: run.status,
          report: run.report
            ? {
                completedBatches: run.report.completed.length,
                totalBatches: run.report.totalBatches,
                findingCount: run.report.findings.length,
              }
            : summary.report,
        }
      : summary,
  );
  async function action(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
      await Promise.all([reloadBusinesses(), reloadRuns(), reloadReport()]);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/">
          <Activity />
          <span>Praxis</span>
        </a>
        <Button
          variant={tasksView ? "secondary" : "ghost"}
          onClick={() => setTasksView(true)}
        >
          <Activity data-icon="inline-start" />
          会话轨迹
        </Button>
        <div className="sidebar-label">业务</div>
        <nav aria-label="业务列表">
          {businesses?.map((b) => (
            <button
              key={b.id}
              className={cn(
                "business-nav",
                !tasksView && !creating && business?.id === b.id && "selected",
              )}
              onClick={() => {
                setTasksView(false);
                setSelected(b.id);
                setCreating(false);
                setRunId(null);
                setTab("runs");
                setError("");
              }}
            >
              <FolderGit2 />
              <span>{b.name}</span>
              <i className={cn("schedule-dot", b.enabled && "enabled")} />
            </button>
          ))}
        </nav>
        <Button
          variant="outline"
          onClick={() => {
            setTasksView(false);
            setCreating(true);
            setRunId(null);
            setError("");
          }}
        >
          <Plus data-icon="inline-start" />
          新建业务
        </Button>
        <div className="sidebar-bottom">
          <span className="connection-dot" />
          本地控制台
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>{tasksView ? "执行记录" : "代码检查"}</span>
          <Badge variant="outline">{tasksView ? "任务" : "只读"}</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新"
            aria-label="刷新"
            onClick={() =>
              void action(async () => {
                if (tasksView)
                  await mutate(
                    (key) =>
                      typeof key === "string" &&
                      (key.startsWith("/api/tasks") ||
                        key.startsWith("/api/sessions")),
                  );
              })
            }
          >
            <RefreshCw />
          </Button>
        </header>
        <div className="main-content">
          {error || loadError || runsError || reportError ? (
            <Alert variant="destructive">
              <AlertTitle>操作失败</AlertTitle>
              <AlertDescription>
                {error || (loadError ?? runsError ?? reportError)?.message}
              </AlertDescription>
            </Alert>
          ) : null}
          {tasksView ? (
            <TaskHistory />
          ) : !businesses && !loadError ? (
            <>
              <Skeleton className="h-10 w-48" />
              <Skeleton className="h-64 w-full" />
            </>
          ) : creating || !business ? (
            <>
              <div className="section-heading">
                <div>
                  <h1>新建业务</h1>
                  <p>代码检查</p>
                </div>
              </div>
              <ConfigForm
                key="new"
                models={models}
                onSaved={(b) => {
                  setCreating(false);
                  setSelected(b.id);
                  setTab("runs");
                  void reloadBusinesses();
                }}
              />
            </>
          ) : (
            <>
              <div className="section-heading">
                <div>
                  <h1>{business.name}</h1>
                  <p>
                    {business.repositories.length} 个仓库 · 配置 v
                    {business.version}
                  </p>
                </div>
                <Button
                  disabled={
                    busy || visibleRuns.some((r) => r.status === "running")
                  }
                  onClick={() =>
                    void action(async () => {
                      const next = await request<Run>(
                        `/api/businesses/${business.id}/runs`,
                        {},
                      );
                      setRunId(next.id);
                      setTab("runs");
                    })
                  }
                >
                  <Play data-icon="inline-start" />
                  立即检查
                </Button>
              </div>
              <div className="business-summary">
                <div>
                  <span>定时检查</span>
                  <strong>{business.enabled ? "已启用" : "未启用"}</strong>
                </div>
                <div>
                  <span>下一次运行</span>
                  <strong>{time(business.nextAt)}</strong>
                </div>
                <div>
                  <span>模型</span>
                  <strong>
                    {business.model.id} · {business.model.thinking}
                  </strong>
                </div>
              </div>
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="runs">
                    <ListChecks />
                    运行记录
                  </TabsTrigger>
                  <TabsTrigger value="config">
                    <Settings2 />
                    业务配置
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="config">
                  <ConfigForm
                    key={`${business.id}:${business.version}`}
                    business={business}
                    models={models}
                    onSaved={() => {
                      setTab("runs");
                      void reloadBusinesses();
                    }}
                  />
                </TabsContent>
                <TabsContent value="runs">
                  <section className="runs-section">
                    {visibleRuns.length ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>触发时间</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>来源</TableHead>
                            <TableHead>版本</TableHead>
                            <TableHead>批次</TableHead>
                            <TableHead>问题</TableHead>
                            <TableHead>
                              <span className="sr-only">报告</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleRuns.map((r) => (
                            <TableRow
                              key={r.id}
                              data-state={
                                currentRunId === r.id ? "selected" : undefined
                              }
                            >
                              <TableCell>{time(r.createdAt)}</TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    r.status === "failed"
                                      ? "destructive"
                                      : "secondary"
                                  }
                                >
                                  {statusLabels[r.status]}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {r.trigger === "manual" ? "手动" : "定时"}
                              </TableCell>
                              <TableCell>v{r.version}</TableCell>
                              <TableCell>
                                {r.report
                                  ? `${r.report.completedBatches}/${r.report.totalBatches}`
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                {r.report?.findingCount ?? "—"}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`查看运行 ${r.id}`}
                                  onClick={() => setRunId(r.id)}
                                >
                                  查看
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>暂无运行记录</EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </section>
                  {run && run.businessId === business.id ? (
                    <ReportView
                      key={run.id}
                      run={run}
                      cancel={() =>
                        void action(() =>
                          request(`/api/runs/${run.id}/cancel`, {}),
                        )
                      }
                    />
                  ) : null}
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
