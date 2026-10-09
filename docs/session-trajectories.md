# 会话与轨迹

参考 DeepSeek Harness 的[轨迹模块](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-trajectory/README.zh.md)和[会话模块](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/README.zh.md)，将界面组织为会话、用户轮次、模型步骤与配对工具记录。复用 Pi 会话和日志，不引入 DSH 的执行引擎或 Cordis 依赖。

## 数据归属

- `sessionId` 是 Praxis 稳定会话标识，新任务以根任务 id 建立会话，resume 继承它。Pi 原生会话 id 和文件引用随执行结果记录。
- 一个任务记录对应一次触发或续接，保留原始输入、状态、结果和 parentId；一次运行可以包含追加指令产生的多个用户轮次。
- 会话轨迹以 Pi 的持久日志为依据聚合各次运行；用户消息划分轮次，原生 turn_start 划分模型步骤。旧日志没有步骤事件时不补造步骤号。
- 缺失原生日志的运行仅展示已保存的用户目标。旧运行共用同一日志目录时不重复投影同一文件；不能据此恢复缺失的逐次执行边界。
- 工具记录按 callId 配对输入与结果，保持开始事件的稳定 id。只有两端时间都存在时计算耗时。已结束运行中没有结果的调用标记为中断，不伪造结果。
- 原始会话、工具结果和压缩日志保留。页面隐藏内部推理，详情超过 20,000 字符时明确标示截断，不修改源日志。

## 查询与展示

`GET /api/sessions` 查询会话列表；`GET /api/sessions/{sessionId}/trajectory` 聚合续接历史。单任务和单业务运行也保留 trajectory 接口。

首次默认返回最新 50 条投影记录。使用 nextBefore 作为 before 参数加载更早历史，limit 在 1–200 之间；页面去重合并并保留稳定记录键。用户可继续加载全部历史，之前的 200 条永久窗口限制已移除。运行期间重查已加载页面，不自动把用户滚回底部。

数据库启动时迁移旧任务，沿 parentId 回填 sessionId，不删除原始记录。测试覆盖迁移后重启、续接聚合、244 条跨轮次分页、调用配对及中断状态。

## 当前边界

这是会话轨迹基础，并非 DSH 完整轨迹组件的移植。服务端目前扫描日志构建投影，尚无事件偏移索引；浏览器按需分页但未采用虚拟列表。超长会话的读取性能、分支/fork、嵌套工具图、压缩上下文检查器和实时尾部跟随仍需逐步完善。

轨迹不等于长期记忆。后续巡检记忆应保存可验证的观察、异常历史和结论，并关联来源事件；不把整份会话无限塞入上下文，也不把压缩摘要等同于已验证事实。
