# dsh-auto-model-switch

**自动模型切换 / Auto Model Switch**

DSH（Cordis）插件：当模型请求因**额度耗尽**（`QUOTA` / `ACCOUNT_QUOTA`）失败时，自动切换到备用角色（provider）并重试当前步骤，让 Agent 任务不中断。

包名：`@lis212-cloud/dsh-auto-model-fallback`

## 能力边界（先看这个）

- ✅ 只处理 `failure.code` 为 `QUOTA`、`ACCOUNT_QUOTA` 的失败（大小写不敏感）。
- ❌ 不处理 429 限流、401 鉴权失败、超时、5xx、模型不存在——代码里没有对应分支。
- ❌ 没有图形化配置面板，只能改 `cordis.patch.yml`。
- ❌ 切换后不自动切回；额度恢复后需要手动把默认模型改回去。

## 一次切换的流程

1. 监听 `agent/request-error`，先 `await next()` 让下游监听器（如 `dsh-llm-retry`）优先处理；
2. 仍为配额类错误才继续（不判断下游是否已修好）；
3. 按 `agent.id:turn:step` 计次，达到 `maxAttempts` 即放弃，防死循环；
4. 选备用模型（用户列表 → 自动发现）；
5. `agentDefaultModel.saveSelection()` 切换会话默认模型（持久切换）；
6. `notify` 为真时注入 developer 消息告知 Agent；
7. 返回 `{ kind: 'retry' }` 重发当前请求。

## 备用模型选择

1. **优先** `fallbackModels` 优先级列表（跳过当前 provider，用 `resolveModelInfo` / `listModels` 验活）；
2. 列表为空或都不可用时**自动发现**：遍历 `llm.listProviders()` 取首个模型，列不出来则用内置默认名。

内置默认名（可能已过时）：`openai→gpt-4o`、`openai-compatible→gpt-4o`、`google→gemini-2.5-pro`、`anthropic→claude-sonnet-4-20250514`、`deepseek→deepseek-chat`、`zhipu→glm-4-plus`、`volcengine→doubao-seed-1-6-flash-250616`。

## 安装

从仓库安装：

```powershell
dsh plugin --profile desktop add github:lis212-cloud/dsh-auto-model-fallback
```

或使用本地目录：

```powershell
dsh plugin --profile desktop add F:\0000\auto-model-fallback
```

安装后完全退出 DSH 再重新启动。若遇到 `unable to verify the first certificate`，先设置 `NODE_OPTIONS=--use-system-ca`（需 Node ≥ 22.15）。

## 配置

编辑 `cordis.patch.yml`：

```yaml
- insert:
    - id: auto-model-fallback
      name: '@lis212-cloud/dsh-auto-model-fallback'
      config:
        fallbackModels:
          - provider: deepseek
            model: deepseek-chat
          - provider: volcengine
            model: doubao-seed-1-6-flash-250616
        quotaCodes:
          - QUOTA
          - ACCOUNT_QUOTA
        notify: true
        maxAttempts: 3
```

| 配置项 | 说明 |
|---|---|
| `fallbackModels` | 备用模型（provider + model）优先级列表；留空则自动发现 |
| `quotaCodes` | 触发切换的错误码集合 |
| `notify` | 切换后是否注入 developer 消息，默认 `true` |
| `maxAttempts` | 单步骤最大切换次数，默认 `3` |

## 目录结构

```
index.js          插件全部逻辑
cordis.patch.yml  注册与默认配置
locale/           中英文标题与说明（zh: 自动模型切换 / en: Auto Model Switch）
icon.svg          设置页图标
LICENSE           MIT
```

## License

[MIT](./LICENSE) © 2026 lis212-cloud
