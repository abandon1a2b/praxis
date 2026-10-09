import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { Plus, Play, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
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
import { request, time } from "./api";

type Config = {
  id: string;
  name: string;
  scope: string;
  kind: "http" | "git";
  target: string;
  expectedStatus: number;
  enabled: boolean;
  intervalSeconds: number;
  timeoutSeconds: number;
};
type Check = Config & { version: number; nextAt: string | null };
type Observation = {
  id: string;
  checkId: string;
  checkVersion: number;
  scope: string;
  observedAt: string;
  status: string;
  change: string;
  summary: string;
  evidence: unknown;
  evidencePreviewTruncated?: boolean;
};
type Incident = {
  id: string;
  check_id: string;
  status: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  resolved_at: string | null;
  observation_id: string;
};
const labels: Record<string, string> = {
  normal: "正常",
  abnormal: "异常",
  failed: "检查失败",
  new_anomaly: "首次异常",
  ongoing_anomaly: "持续异常",
  recovered: "已恢复",
  unchanged: "无变化",
  check_failed: "检查失败",
  active: "仍异常",
  resolved: "已恢复",
  superseded: "配置已变更",
};
const initial: Config = {
  id: "",
  name: "",
  scope: "default",
  kind: "http",
  target: "",
  expectedStatus: 200,
  enabled: false,
  intervalSeconds: 3600,
  timeoutSeconds: 10,
};

function CheckForm({
  check,
  onSaved,
}: {
  check?: Check;
  onSaved: (value: Check) => void;
}) {
  const [draft, setDraft] = useState<Config>(() =>
    check
      ? {
          id: check.id,
          name: check.name,
          scope: check.scope,
          kind: check.kind,
          target: check.target,
          expectedStatus: check.expectedStatus,
          enabled: check.enabled,
          intervalSeconds: check.intervalSeconds,
          timeoutSeconds: check.timeoutSeconds,
        }
      : { ...initial },
  );
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  function update<K extends keyof Config>(key: K, value: Config[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      onSaved(
        await request<Check>("/api/inspections", {
          config: draft,
          expectedVersion: check?.version ?? 0,
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="config-form" onSubmit={submit}>
      <FieldGroup>
        <div className="form-columns">
          <Field>
            <FieldLabel htmlFor="check-name">检查名称</FieldLabel>
            <Input
              id="check-name"
              required
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="check-id">检查标识</FieldLabel>
            <Input
              id="check-id"
              required
              disabled={Boolean(check)}
              pattern={"[a-zA-Z0-9_\\-]{1,80}"}
              value={draft.id}
              onChange={(e) => update("id", e.target.value)}
            />
          </Field>
        </div>
        <div className="form-columns">
          <Field>
            <FieldLabel htmlFor="check-scope">记忆范围</FieldLabel>
            <Input
              id="check-scope"
              required
              pattern={"[a-zA-Z0-9_\\-]{1,80}"}
              value={draft.scope}
              onChange={(e) => update("scope", e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="check-kind">检查类型</FieldLabel>
            <Select
              value={draft.kind}
              onValueChange={(value) => update("kind", value as Config["kind"])}
            >
              <SelectTrigger id="check-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="http">HTTP 状态</SelectItem>
                  <SelectItem value="git">Git 工作区</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="check-target">
            {draft.kind === "http" ? "请求地址" : "仓库绝对路径"}
          </FieldLabel>
          <Input
            id="check-target"
            required
            value={draft.target}
            onChange={(e) => update("target", e.target.value)}
            placeholder={
              draft.kind === "http"
                ? "http://127.0.0.1:4310/api/docs"
                : "/Users/name/workspace/project"
            }
          />
        </Field>
        <div className="form-columns three">
          <Field data-disabled={draft.kind === "git"}>
            <FieldLabel htmlFor="expected-status">期望状态码</FieldLabel>
            <Input
              id="expected-status"
              type="number"
              min={100}
              max={599}
              disabled={draft.kind === "git"}
              required
              value={draft.expectedStatus}
              onChange={(e) => update("expectedStatus", e.target.valueAsNumber)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="check-interval">巡检间隔（秒）</FieldLabel>
            <Input
              id="check-interval"
              type="number"
              min={60}
              max={2147483}
              required
              value={draft.intervalSeconds}
              onChange={(e) =>
                update("intervalSeconds", e.target.valueAsNumber)
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="check-timeout">超时（秒）</FieldLabel>
            <Input
              id="check-timeout"
              type="number"
              min={1}
              max={60}
              required
              value={draft.timeoutSeconds}
              onChange={(e) => update("timeoutSeconds", e.target.valueAsNumber)}
            />
          </Field>
        </div>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="check-enabled">启用定时巡检</FieldLabel>
          <Switch
            id="check-enabled"
            checked={draft.enabled}
            onCheckedChange={(value) => update("enabled", value)}
          />
        </Field>
        {error ? (
          <Field data-invalid>
            <FieldError>{error}</FieldError>
          </Field>
        ) : null}
        <div className="form-footer">
          <span>{check ? `配置 v${check.version}` : "新检查项"}</span>
          <Button disabled={saving} type="submit">
            <Save data-icon="inline-start" />
            {saving ? "保存中…" : "保存检查项"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

export function Inspections() {
  const {
    data: checks = [],
    error: checksError,
    mutate: reload,
  } = useSWR<Check[]>("/api/inspections", request, { refreshInterval: 5000 });
  const [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [tab, setTab] = useState("memory"),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const check = creating
    ? undefined
    : selected === null
      ? checks[0]
      : checks.find((c) => c.id === selected);
  const scope = check?.scope;
  const {
    data: observations = [],
    error: memoryError,
    mutate: refreshMemory,
  } = useSWR<Observation[]>(
    `/api/memory?q=${encodeURIComponent(query)}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`,
    request,
    { refreshInterval: 5000 },
  );
  const { data: incidents = [], mutate: refreshIncidents } = useSWR<Incident[]>(
    `/api/incidents${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`,
    request,
    { refreshInterval: 5000 },
  );
  async function run() {
    if (!check) return;
    setBusy(true);
    setError("");
    try {
      await request(`/api/inspections/${check.id}/run`, {});
      await Promise.all([reload(), refreshMemory(), refreshIncidents()]);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>巡检与记忆</h1>
          <p>{check ? `${check.scope} · 配置 v${check.version}` : "检查项"}</p>
        </div>
        <div className="actions">
          <Button
            variant="outline"
            onClick={() => {
              setCreating(true);
              setTab("config");
            }}
          >
            <Plus data-icon="inline-start" />
            新检查项
          </Button>
          <Button disabled={!check || busy} onClick={() => void run()}>
            <Play data-icon="inline-start" />
            {busy ? "巡检中…" : "立即巡检"}
          </Button>
        </div>
      </div>
      {error || checksError || memoryError ? (
        <Alert variant="destructive">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>
            {error || (checksError ?? memoryError)?.message}
          </AlertDescription>
        </Alert>
      ) : null}
      {checks.length ? (
        <Select
          value={check?.id ?? ""}
          onValueChange={(id) => {
            setSelected(id);
            setCreating(false);
            setQuery("");
          }}
        >
          <SelectTrigger aria-label="选择检查项" className="w-full">
            <SelectValue placeholder="选择检查项" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {checks.map((c) => (
                <SelectItem value={c.id} key={c.id}>
                  {c.name} · {c.scope}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}
      {check ? (
        <div className="business-summary">
          <div>
            <span>定时巡检</span>
            <strong>{check.enabled ? "已启用" : "未启用"}</strong>
          </div>
          <div>
            <span>下一次运行</span>
            <strong>{time(check.nextAt)}</strong>
          </div>
          <div>
            <span>目标</span>
            <strong>{check.target}</strong>
          </div>
        </div>
      ) : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="memory">观察记忆</TabsTrigger>
          <TabsTrigger value="incidents">异常历史</TabsTrigger>
          <TabsTrigger value="config">检查配置</TabsTrigger>
        </TabsList>
        <TabsContent value="config">
          <CheckForm
            key={check ? `${check.id}:${check.version}` : "new"}
            check={check}
            onSaved={(value) => {
              setSelected(value.id);
              setCreating(false);
              setTab("memory");
              void reload(
                (previous) =>
                  [
                    ...(previous ?? []).filter((item) => item.id !== value.id),
                    value,
                  ].sort((a, b) => a.id.localeCompare(b.id)),
                { revalidate: true },
              );
            }}
          />
        </TabsContent>
        <TabsContent value="memory">
          <div className="report-filters">
            <Input
              aria-label="检索观察记忆"
              placeholder="检索关键词"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {observations.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>观察时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>变化</TableHead>
                  <TableHead>事实与证据</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {observations.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{time(o.observedAt)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          o.status === "normal" ? "secondary" : "destructive"
                        }
                      >
                        {labels[o.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>{labels[o.change]}</TableCell>
                    <TableCell>
                      <details className="memory-evidence">
                        <summary>{o.summary}</summary>
                        <p>
                          <code>{o.id}</code> · {o.checkId} v{o.checkVersion}
                        </p>
                        {o.evidencePreviewTruncated ? (
                          <p>证据预览已截断</p>
                        ) : null}
                        <a
                          href={`/api/observations/${o.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline"
                        >
                          完整证据
                        </a>
                        <pre>{JSON.stringify(o.evidence, null, 2)}</pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无观察记忆</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="incidents">
          {incidents.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>检查项</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>首次出现</TableHead>
                  <TableHead>最近出现</TableHead>
                  <TableHead>次数</TableHead>
                  <TableHead>恢复时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidents.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.check_id}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          i.status === "active" ? "destructive" : "secondary"
                        }
                      >
                        {labels[i.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>{time(i.first_seen)}</TableCell>
                    <TableCell>{time(i.last_seen)}</TableCell>
                    <TableCell>{i.occurrences}</TableCell>
                    <TableCell>{time(i.resolved_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无异常记录</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
