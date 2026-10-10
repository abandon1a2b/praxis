import { useState } from "react";
import { Download, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { time, statusLabels } from "./api";
import type { Run } from "./types";
import { Trajectory } from "./trajectory";

export function ReportView({ run, cancel }: { run: Run; cancel: () => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const report = run.report;
  const findings = (report?.findings ?? []).filter(
    (f) =>
      (filter === "all" || f.severity === filter) &&
      `${f.title} ${f.file}`.toLowerCase().includes(query.toLowerCase()),
  );
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run.businessId}-${run.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="report-view">
      <div className="section-heading">
        <div>
          <h2>检查报告</h2>
          <p>
            {time(run.createdAt)} · 配置 v{run.version} ·{" "}
            {statusLabels[run.status]}
          </p>
        </div>
        <div className="actions">
          {run.status === "running" ? (
            <Button variant="outline" onClick={cancel}>
              <Square data-icon="inline-start" />
              取消运行
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            aria-label="下载报告"
            title="下载报告"
            onClick={download}
          >
            <Download />
          </Button>
        </div>
      </div>
      {run.error ? (
        <Alert variant="destructive">
          <AlertTitle>运行未完成</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="run-facts">
        <span>
          {report?.engine === "pi-native"
            ? `工具调用 ${report.toolCalls ?? 0}`
            : `批次 ${report?.completed.length ?? 0} / ${report?.totalBatches ?? "—"}`}
        </span>
        <span>
          {report?.findings.length ?? 0} 个候选问题 ·{" "}
          {report?.findings.filter(
            (f) => !f.verification || f.verification.status === "pending",
          ).length ?? 0}{" "}
          个待复核
        </span>
        <span>
          {run.config.model.id} · {run.config.model.thinking}
        </span>
      </div>
      <Progress
        value={
          report?.totalBatches
            ? (report.completed.length / report.totalBatches) * 100
            : 0
        }
        aria-label="检查进度"
      />
      <Tabs defaultValue="findings">
        <TabsList>
          <TabsTrigger value="findings">问题</TabsTrigger>
          <TabsTrigger value="coverage">覆盖范围</TabsTrigger>
          <TabsTrigger value="goal">运行目标</TabsTrigger>
          <TabsTrigger value="trajectory">执行轨迹</TabsTrigger>
        </TabsList>
        <TabsContent value="findings">
          <div className="report-filters">
            <Input
              aria-label="搜索问题"
              placeholder="搜索问题或文件"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger aria-label="问题等级">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部等级</SelectItem>
                  <SelectItem value="high">高</SelectItem>
                  <SelectItem value="medium">中</SelectItem>
                  <SelectItem value="low">低</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {findings.length ? (
            <div className="findings">
              {findings.map((f, i) => (
                <article key={`${f.file}:${f.line}:${i}`} className="finding">
                  <div className="finding-title">
                    <Badge
                      variant={
                        f.severity === "high" ? "destructive" : "secondary"
                      }
                    >
                      {
                        (
                          { high: "高", medium: "中", low: "低" } as Record<
                            string,
                            string
                          >
                        )[f.severity]
                      }
                    </Badge>
                    <h3>{f.title}</h3>
                    <Badge variant="outline">
                      {
                        (
                          {
                            pending: "待复核",
                            confirmed: "静态复核支持",
                            rejected: "复核不支持",
                            "needs-context": "需补充上下文",
                          } as Record<string, string>
                        )[f.verification?.status ?? "pending"]
                      }
                    </Badge>
                  </div>
                  <code>
                    {f.file}:{f.line}
                  </code>
                  <p>{f.explanation}</p>
                  <dl>
                    <dt>触发条件</dt>
                    <dd>{f.trigger}</dd>
                  </dl>
                  <pre>{f.evidence}</pre>
                  {f.verification?.reason ? (
                    <p>{f.verification.reason}</p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {run.status === "running"
                    ? "检查进行中"
                    : report?.findings.length
                      ? "没有匹配的问题"
                      : "暂无问题记录"}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="coverage">
          <div className="coverage">
            {report?.plan ? (
              <>
                <h3>检查计划</h3>
                <p>
                  阶段：
                  {(
                    {
                      structure: "结构理解",
                      module: "模块检查",
                      "cross-module": "跨模块检查",
                      verification: "问题复核",
                      completed: "完成",
                    } as Record<string, string>
                  )[report.phase ?? ""] ?? report.phase}{" "}
                  · {report.completed.length} / {report.plan.length} 批次 ·{" "}
                  {report.resumed ? "已接续历史进度" : "新快照"}
                </p>
                {report.structure ? <p>{report.structure}</p> : null}
                {report.plan.map((unit) => (
                  <details key={unit.id}>
                    <summary>
                      {unit.module} ·{" "}
                      {
                        (
                          {
                            pending: "待检查",
                            running: "检查中",
                            completed: "批次已完成",
                            failed: "检查失败",
                          } as Record<string, string>
                        )[unit.status]
                      }{" "}
                      · {unit.ranges.length} 个范围
                    </summary>
                    {unit.ranges.map((range, i) => (
                      <p key={i}>
                        <code>
                          {range.file}:{range.start}–{range.end}
                        </code>
                      </p>
                    ))}
                    {unit.error ? <p>{unit.error}</p> : null}
                  </details>
                ))}
              </>
            ) : null}
            <h3>代码版本</h3>
            {Object.entries(report?.revisions ?? {}).map(([name, revision]) => (
              <p key={name}>
                <strong>{name}</strong> <code>{revision.head}</code>{" "}
                {revision.dirty ? "工作区有改动" : "工作区干净"}
              </p>
            ))}
            {report?.coverage ? (
              <>
                <h3>读取记录</h3>
                <p>
                  范围内 {report.coverage.totalFiles} 个文件 · 读取{" "}
                  {new Set(report.coverage.reads.map((r) => r.file)).size}{" "}
                  个文件 · 全量覆盖未验证
                </p>
                {report.coverage.reads.map((r, i) => (
                  <p key={i}>
                    <code>
                      {r.file}:{r.offset}
                    </code>
                    <span>{r.truncated ? "输出有截断" : "读取成功"}</span>
                  </p>
                ))}
              </>
            ) : (
              <h3>已检查范围</h3>
            )}
            {report?.completed
              .flatMap((batch) => batch.ranges)
              .map((range, i) => (
                <p key={i}>
                  <code>
                    {range.file}:{range.start}
                    {range.startColumn !== undefined
                      ? `:${range.startColumn}–${range.endColumn} 列`
                      : `–${range.end}`}
                  </code>
                </p>
              ))}
            <h3>跳过文件</h3>
            {report?.skipped.map((f) => (
              <p key={f.file}>
                <code>{f.file}</code>
                <span>{f.reason}</span>
              </p>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="goal">
          <div className="coverage">
            <h3>检查目标</h3>
            <p>{run.config.focus}</p>
            <h3>仓库</h3>
            {run.config.repositories.map((r) => (
              <p key={r.name}>
                <strong>{r.name}</strong>
                <code>{r.path}</code>
              </p>
            ))}
            <h3>运行标识</h3>
            <code>{run.id}</code>
          </div>
        </TabsContent>
        <TabsContent value="trajectory">
          <Trajectory
            url={`/api/runs/${run.id}/trajectory`}
            active={run.status === "running"}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
