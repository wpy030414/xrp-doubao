# Spec — OpenAI Chat Completions 桥接

> 状态：已实现；离线 E2E 覆盖流式 / 非流式 / thinking / 附件上传 / 回退 / 错误。
> 实现：`src/messages.ts`、`src/doubaoUpload.ts`、`src/doubaoClient.ts`、`src/openai.ts`

## 1. 端点

- 对外：`POST /v1/chat/completions`
- 上游主端点：`POST {baseUrl}/chat/completion?<web params>`
- 上游回退：`POST {baseUrl}/samantha/chat/completion?<desktop params>`

## 2. 请求映射

### 2.1 消息压平

输入是 OpenAI `messages` 数组。豆包一次只接收一条用户消息，因此：

1. `system` / `developer` 提取为系统指令
2. `user` / `assistant` 按顺序保留，带角色标签
3. `tool` / `function` 转为“工具结果”文本
4. 最后一条 `user` 消息中的图片 / 文件提取为附件；音频 → 400（`UnsupportedMessageError`）；历史附件以 `[图片]` / `[文件：…]` 占位
5. 单条用户消息 → 原样发送；单条 system + user → `system\n\nuser`；只有附件时 prompt 可以为空
6. 多轮 → 
   ```
   系统指令：
   <system>

   以下是对话记录：
   用户：…
   助手：…
   用户：…

   请针对最后一条用户消息作答。
   ```
7. 最后一条是 assistant → “请基于以上对话继续上一条助手回复。”
8. 最后一条是工具结果 → “请根据以上工具结果继续完成用户的任务。”

### 2.2 模型映射

客户端 `model` → `resolveModelPreset()` → `DoubaoModelPreset`：

| 字段 | 用途 |
|---|---|
| `modelItemKey` | `option.model_config.model_item_key` / `conversation_init_ext` / `aggregate_params` |
| `menuType` | `option.need_deep_think` / `ext.use_deep_think`（0/3/9/5/10001） |
| `agentMode` | `option.agent_mode` / `ext.agent_mode`（2 聊天，1 工作任务） |
| `modeId` | `conversation_init_ext.mode_id` / `option.conversation_mode`（1 对话，3 工作任务） |
| `reasoningEffort` | 默认思考强度 3/4/5 |
| `deepThink` | 旧版 `/samantha` 的 `use_deep_think` 布尔值 |
| `modelExtraParams` | `option.model_config.model_extra_params`（任务类模型的窗口参数） |

客户端 `reasoning_effort`（`low` / `medium` / `high` / 数字）覆盖默认值，映射到 3/4/5。
未知模型回退 `doubao-fast`。

### 2.3 请求体

- `/chat/completion`：`client_meta` + `messages[]`（附件消息 `content_block[10052]` + 文本消息 `content_block[10000]`）+ `option` + `ext`
- 附件流程：`prepare_upload → ApplyImageUpload(SigV4) → TOS → CommitImageUpload(SigV4) → pre_handle`，详见 `src/doubaoUpload.ts`
- `/samantha/chat/completion`：`messages[{content_type:2001, content:'{"text":...}'}]` + `completion_option`
- 设备参数 / 请求头见 `docs/DOUBAO_REVERSE.md` 第 3 节
- 不生成 `a_bogus`

## 3. 响应映射

### 3.1 流式

每个上游增量 → 一个 OpenAI `chat.completion.chunk`：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "created": 1792900000,
  "model": "doubao-fast",
  "choices": [{
    "index": 0,
    "delta": {"role": "assistant", "content": "…", "reasoning_content": "…"},
    "logprobs": null,
    "finish_reason": null
  }]
}
```

- 首个带内容的 chunk 带 `role:"assistant"`
- thinking → `delta.reasoning_content`；正文 → `delta.content`
- 非结束 chunk `finish_reason: null`
- 结束 chunk `delta: {}` + `finish_reason:"stop"`
- `stream_options.include_usage` 时，结束 chunk 之后追加 `choices: []` + `usage`
- 最后 `data: [DONE]`
- 不输出空 `tool_calls: []`

### 3.2 非流式

聚合全部增量：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1792900000,
  "model": "doubao-fast",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "…", "reasoning_content": "…"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}
}
```

- `usage` 仅在上游给出时返回；插件不伪造 token 数

## 4. 上游事件解析

### 4.1 `/chat/completion`

- `SSE_HEARTBEAT` / 空 data：忽略
- `SSE_ACK`：记录 `conversation_id`
- `SSE_REPLY_END`：正文结束（`end_type=1`），提前收尾
- 内容块：`content_block` / `content.content_block` / `patch_op[].patch_value.content_block`
- `block_type=10040`：`content.thinking_block.think` → reasoning；`cot_ui_style=summary` 时只有 `finish_title/streaming_title` 步骤标题，按 `DOUBAO_THINKING_SUMMARY` 映射为 reasoning；无 `thinking_block` 的旧空块按分隔符兼容
- `block_type=10000`（及 10001/2001/2003）：正文
- `CHUNK_DELTA`：实测 `{"text":"…"}` → 正文；解析器同时兼容 `{"think":"…"}` → reasoning
- `block_type=2008`：`content.think` → reasoning
- `10024` / `10025` / `10101` / `10052`：忽略
- 紧凑 `{"text":"…"}`：当前事件没有内容块时作为正文
- `STREAM_ERROR` / `error_code`：分类为 auth / risk / upstream
- `[DONE]` / `SSE_REPLY_END` / `STREAM_END`：结束

### 4.2 `/samantha/chat/completion`

- `event_type=2003`：结束
- `event_type=2005`：错误
- `event_type=2002`：记录 conversation_id
- `event_type=2001`：`event_data.message.content_type`
  - 2001 / 10000 / 2003 → 正文
  - 2008 → `content.think` → reasoning；`content.text` → 正文
  - 2002 → 推荐问题，忽略
- `gateway-error`：错误

## 5. 回退

- `DOUBAO_CHAT_MODE=auto`（默认）：
  1. 尝试 `/chat/completion`
  2. 仅 404 / 405 / 410 / 501-504 / 非 SSE / 网络错误 → 尝试 `/samantha/chat/completion`
  3. 风控、鉴权、400/422 参数错误、带附件请求 → 直接返回，不回退
  4. 两者都失败 → 组合错误信息
- 响应头 `X-Doubao-Mode: web|legacy` 标明实际通道；回退时带 `X-Doubao-Fallback: 1` 与 URL 编码的 `X-Doubao-Fallback-Reason`
- `chat` / `samantha` 可固定单通道

### 5.1 会话清理

- SSE 结束后（含客户端断开）异步调用 `/im/conversation/batch_del_user_conv`
- 请求：`cmd:4171`、`conversation_type:3`、`Content-Type: application/json; encoding=utf-8`
- 只对 web 通道生效；旧 `/samantha` 没有 conversation_id
- 712010703 / 网络错误重试一次；统计见 `/health.conversation_cleanup`
- `DOUBAO_AUTO_DELETE_CONVERSATION=0` 可关闭

## 6. 错误映射

| 上游 | HTTP | type | 额外字段 |
|---|---:|---|---|
| 401 / 403 / 710012001 | 401 | `authentication_error` | — |
| 710022004 等风控 | 429 | `rate_limit_error` | `needs_captcha: true` |
| 其他 4xx / 5xx | 502 或上游状态 | `upstream_error` | `code`, `upstream_status` |
| 音频输入 | 400 | `invalid_request_error` | — |
| 附件上传失败 | 401 / 429 / 502 | `authentication_error` / `rate_limit_error` / `upstream_error` | `needs_captcha`, `code` |
| 客户端取消 | 499 | — | — |

首个上游分片在响应头发出前读取，保证这些错误能返回正确 HTTP 状态；流中错误以 SSE error 事件返回。

## 7. 验收

- 流式：正文、thinking、`finish_reason`、usage、`[DONE]` 正确
- 非流式：内容与流式一致
- 模型映射：`doubao-expert` → key 3 / effort 4/5 / `need_deep_think` 3
- thinking：`10040` + `content.thinking_block.think` → reasoning；`cot_ui_style=summary` 时步骤标题 → reasoning；旧 delimiter 兼容
- `CHUNK_DELTA` 的 `{"text":…}` / `{"think":…}` 作为增量
- 会话清理：ACK `conversation_id` → 删除；失败重试一次并计入统计
- 附件：图片 `10052` + `type:1`、文件 `10052` + `type:3`；大小与数量限制生效
- 回退：仅 404 / HTML / 网络错误 → legacy；风控、400、附件请求不回退
- 错误：auth / risk / upstream 分别 401 / 429 / 502
- 健康：`needs_captcha` 可观测、可重置
