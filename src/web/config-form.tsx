import { useState, type FormEvent } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { request } from "./api";
import type { Business, BusinessConfig, Model, Repository } from "./types";

const defaults: BusinessConfig = {
  id: "",
  name: "",
  enabled: false,
  repositories: [{ name: "main", path: "", include: [], exclude: [] }],
  model: { provider: "local-gpt", id: "gpt-6.1-sol", thinking: "low" },
  intervalSeconds: 86400,
  batchCharacters: 40000,
  timeoutSeconds: 180,
  focus: "检查可复现的正确性、安全性和可靠性缺陷，给出触发条件与代码证据。",
};
const split = (text: string) =>
  text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function ConfigForm({
  business,
  models,
  onSaved,
}: {
  business?: Business;
  models: Model[];
  onSaved: (business: Business) => void;
}) {
  const [draft, setDraft] = useState<BusinessConfig>(() =>
    business
      ? {
          id: business.id,
          name: business.name,
          enabled: business.enabled,
          repositories: structuredClone(business.repositories),
          model: { ...business.model },
          intervalSeconds: business.intervalSeconds,
          batchCharacters: business.batchCharacters,
          timeoutSeconds: business.timeoutSeconds,
          focus: business.focus,
          phaseTimeoutSeconds: business.phaseTimeoutSeconds,
          topics: structuredClone(business.topics ?? []),
        }
      : structuredClone(defaults),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [patterns, setPatterns] = useState(() =>
    draft.repositories.map((r) => ({
      include: r.include.join(", "),
      exclude: r.exclude.join(", "),
    })),
  );
  const update = <K extends keyof BusinessConfig>(
    key: K,
    value: BusinessConfig[K],
  ) => setDraft((d) => ({ ...d, [key]: value }));
  const repoUpdate = (
    index: number,
    key: keyof Repository,
    value: string | string[],
  ) =>
    setDraft((d) => ({
      ...d,
      repositories: d.repositories.map((r, i) =>
        i === index ? { ...r, [key]: value } : r,
      ),
    }));
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      onSaved(
        await request<Business>("/api/businesses", {
          config: {
            ...draft,
            repositories: draft.repositories.map((r, i) => ({
              ...r,
              include: split(patterns[i].include),
              exclude: split(patterns[i].exclude),
            })),
          },
          expectedVersion: business?.version ?? 0,
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const selectedModel = `${draft.model.provider}/${draft.model.id}`;
  const options = models.some((m) => `${m.provider}/${m.id}` === selectedModel)
    ? models
    : [{ ...draft.model, name: draft.model.id }, ...models];
  return (
    <form onSubmit={save} className="config-form">
      <FieldGroup>
        <div className="form-columns">
          <Field>
            <FieldLabel htmlFor="business-name">业务名称</FieldLabel>
            <Input
              id="business-name"
              required
              maxLength={120}
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="business-id">业务标识</FieldLabel>
            <Input
              id="business-id"
              required
              pattern={"[a-zA-Z0-9_\\-]{1,80}"}
              disabled={Boolean(business)}
              value={draft.id}
              onChange={(e) => update("id", e.target.value)}
            />
          </Field>
        </div>
        <FieldSet>
          <FieldLegend>代码范围</FieldLegend>
          {draft.repositories.map((repo, index) => (
            <FieldGroup key={index} className="repo-fields">
              <div className="repo-heading">
                <span>仓库 {index + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`移除仓库 ${index + 1}`}
                  title="移除仓库"
                  disabled={draft.repositories.length === 1}
                  onClick={() => {
                    update(
                      "repositories",
                      draft.repositories.filter((_, i) => i !== index),
                    );
                    setPatterns((p) => p.filter((_, i) => i !== index));
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="form-columns">
                <Field>
                  <FieldLabel htmlFor={`repo-name-${index}`}>
                    仓库名称
                  </FieldLabel>
                  <Input
                    id={`repo-name-${index}`}
                    required
                    pattern={"[a-zA-Z0-9_\\-]{1,80}"}
                    value={repo.name}
                    onChange={(e) => repoUpdate(index, "name", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`repo-path-${index}`}>
                    本地绝对路径
                  </FieldLabel>
                  <Input
                    id={`repo-path-${index}`}
                    required
                    value={repo.path}
                    onChange={(e) => repoUpdate(index, "path", e.target.value)}
                    placeholder="/Users/name/workspace/business"
                  />
                </Field>
              </div>
              <div className="form-columns">
                <Field>
                  <FieldLabel htmlFor={`repo-include-${index}`}>
                    包含规则
                  </FieldLabel>
                  <Input
                    id={`repo-include-${index}`}
                    value={patterns[index].include}
                    onChange={(e) =>
                      setPatterns((p) =>
                        p.map((v, i) =>
                          i === index ? { ...v, include: e.target.value } : v,
                        ),
                      )
                    }
                    placeholder="src/**, tests/**"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`repo-exclude-${index}`}>
                    排除规则
                  </FieldLabel>
                  <Input
                    id={`repo-exclude-${index}`}
                    value={patterns[index].exclude}
                    onChange={(e) =>
                      setPatterns((p) =>
                        p.map((v, i) =>
                          i === index ? { ...v, exclude: e.target.value } : v,
                        ),
                      )
                    }
                    placeholder="**/generated/**, **/fixtures/**"
                  />
                </Field>
              </div>
            </FieldGroup>
          ))}
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              update("repositories", [
                ...draft.repositories,
                {
                  name: `repo${draft.repositories.length + 1}`,
                  path: "",
                  include: [],
                  exclude: [],
                },
              ]);
              setPatterns((p) => [...p, { include: "", exclude: "" }]);
            }}
          >
            <Plus data-icon="inline-start" />
            添加仓库
          </Button>
        </FieldSet>
        <Field>
          <FieldLabel htmlFor="focus">检查目标</FieldLabel>
          <Textarea
            id="focus"
            required
            maxLength={4000}
            value={draft.focus}
            onChange={(e) => update("focus", e.target.value)}
            rows={3}
          />
        </Field>
        <div className="form-columns">
          <Field>
            <FieldLabel htmlFor="model">模型</FieldLabel>
            <Select
              value={selectedModel}
              onValueChange={(value) => {
                const model = options.find(
                  (m) => `${m.provider}/${m.id}` === value,
                )!;
                update("model", {
                  ...draft.model,
                  provider: model.provider,
                  id: model.id,
                });
              }}
            >
              <SelectTrigger id="model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((m) => (
                    <SelectItem
                      key={`${m.provider}/${m.id}`}
                      value={`${m.provider}/${m.id}`}
                    >
                      {m.provider} / {m.id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="thinking">推理等级</FieldLabel>
            <Select
              value={draft.model.thinking}
              onValueChange={(value) =>
                update("model", { ...draft.model, thinking: value })
              }
            >
              <SelectTrigger id="thinking" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {["low", "medium", "high", "xhigh", "max"].map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <FieldSet>
          <FieldLegend>调度与运行约束</FieldLegend>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="enabled">启用定时检查</FieldLabel>
              <Switch
                id="enabled"
                checked={draft.enabled}
                onCheckedChange={(value) => update("enabled", value)}
              />
            </Field>
            <div className="form-columns three">
              <Field>
                <FieldLabel htmlFor="interval">检查间隔（秒）</FieldLabel>
                <Input
                  id="interval"
                  type="number"
                  required
                  min={60}
                  max={2147483}
                  value={draft.intervalSeconds}
                  onChange={(e) =>
                    update("intervalSeconds", e.target.valueAsNumber)
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timeout">检查总时限（秒）</FieldLabel>
                <Input
                  id="timeout"
                  type="number"
                  required
                  min={1}
                  max={3600}
                  value={draft.timeoutSeconds}
                  onChange={(e) =>
                    update("timeoutSeconds", e.target.valueAsNumber)
                  }
                />
              </Field>
            </div>
          </FieldGroup>
        </FieldSet>
        {error ? (
          <Field data-invalid>
            <FieldError>{error}</FieldError>
          </Field>
        ) : null}
        <div className="form-footer">
          <span>{business ? `当前版本 v${business.version}` : "新业务"}</span>
          <Button type="submit" disabled={saving}>
            <Save data-icon="inline-start" />
            {saving ? "保存中…" : "保存配置"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
