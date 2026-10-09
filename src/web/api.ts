export async function request<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
export const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "medium",
      }).format(new Date(value))
    : "—";
export const statusLabels: Record<string, string> = {
  running: "运行中",
  completed: "检查完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
