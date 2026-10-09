# 原生 Agent 接入边界

## 问题与失败经验

最初的检查关闭所有工具、压缩和重试，每批新建会话。长行虽可分片修复，但跨文件关系和正常 Agent 探索能力被削弱。切换原生会话是默认方向，控制层保留目标及运行管理。

Pi SDK 的 customTools 注册并不自动启用工具。第一次比较时保留 tools=[]，导致零工具调用和空报告；必须明确启用 read/grep/find/ls，并检查运行事件是否真的调用工具。只检查工具工厂或模型连接不够。

第一次跨程序比较中，两边模型均可能在文件 id 前添加测试目录名，正确发现缺陷但报告验证失败。任务应明确文件 id 相对于快照根目录，并给出有限样例；结果校验仍以完整清单为准，不静默接受越界路径。输出契约失败应与缺陷识别能力分别报告。

## 当前方案

固定范围的文本快照 + Pi 原生读取/搜索工具 + 单次持久会话。工具验证 canonical path，快照不包含符号链接；访问结果记录截断情况，不推断全量语义覆盖。上下文压缩与有限重试开启，父进程负责取消和总时限，IPC 断开时子进程退出。

## 重构注意事项

工具执行不能暴露配置存储或凭据。当前非 OS 沙箱，开放 shell/写入前需强化隔离。大型快照依然会消耗本机内存和磁盘；全量覆盖、自动续接及实际费用预算尚未完成。原生 read 对超长行可能截断；任务应继续调查或如实记录限制，不能把截断当语法错误或全量检查成功。

验证入口：`tests/native-review.test.js`、`npm run compare:harnesses`。比较应保持模型、推理、样例和时限一致；不能从小样本结论推导大型项目或修复任务已与其他 Harness 等价。

## 原生开发任务接入

通用任务改用 Pi DefaultResourceLoader、默认系统提示词与原生 coding tools，避免把只读检查提示词沿用到开发任务。resources 开关同时管理项目资源信任、skills、扩展与 MCP 内置 extension factories。SDK 本身不自动装载 CLI 的 MCP/codemode/tool_search，需要按官方 SDK 示例显式挂载、启用并 bindExtensions。项目指令、skill、扩展和 MCP 都需要实际触发验证，不能仅凭资源配置存在判断已接入。

`npm run verify:pi` 创建临时 fixture，要求原生编辑修复、bash 测试、资源标记、MCP 调用及 steer 标记，再打开同一会话续接。开发模式无 OS 沙箱，不能沿用只读模式“无法修改控制层文件”的保证。当前没有自动续接策略，也未验证实际触发长上下文压缩；这些边界仍需单独验收。

验证还发现 DefaultResourceLoader.reload 会重载设置，过早 applyOverrides 的 defaultTools 未保留。现在资源加载后再次应用原生工具列表，验收明确检查 read/bash/edit/write/grep/find/ls/codemode/tool_search 全部可用。2026-10-09 的完整实测通过，证据目录为 `/var/folders/ym/rd5r62yn3zsbzm1pbpj9087h0000gn/T/praxis-full-pi-NeFpUI`；其中 result.json 含资源、工具事件、回复及同一会话续接结果。
