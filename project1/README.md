# MongoDB 在线问卷系统

## 环境与安装

需要 Node.js 20 或以上、npm、MongoDB。若当前机器已安装 MongoDB 8.3.11 和 mongosh，则无需重复安装数据库；确保数据库进程或服务正在运行。

在项目根目录下的 `code/` 目录打开 PowerShell 并执行以下命令。本文所有 npm、启动、测试和 seed 命令都在 `code/` 中运行：

```powershell
node --version
npm --version
Get-Service -Name '*mongo*'
mongosh "mongodb://127.0.0.1:27017" --quiet --eval "db.adminCommand({ping:1})"
npm ci
```

如果已经注册了名为 `MongoDB` 的服务但未运行，可在管理员 PowerShell 执行 `Start-Service MongoDB`；若没有匹配的服务，使用已有的 mongod 启动配置，不要随意创建新数据目录或重装。ping 的 `ok: 1` 才表示数据库可用。

## PowerShell 配置

以下变量仅设置在当前终端，启动、开发和 seed 应在同一终端执行。也可依据 [code/.env.example](code/.env.example) 在 `code/` 中配置本地 `.env`；不要提交实际密码或密钥。

```powershell
function New-RandomSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes)
    } finally {
        $rng.Dispose()
    }
}

$env:PORT = "3000"
$env:NODE_ENV = "development"
$env:MONGODB_URI = "mongodb://127.0.0.1:27017"
$env:MONGODB_DB = "survey_system"
$env:SESSION_SECRET = New-RandomSecret
```

`MONGODB_URI`、`MONGODB_DB`、`SESSION_SECRET`必填，库名显式指定，不依赖URI默认库。SESSION\_SECRET至少32字符、不可占位；正式使用通过安全渠道保存并复用，重生成使原会话失效。生产模式会开启Secure Cookie，但当前源码是HTTP监听且未设置trust proxy；HTTPS反向代理不会自动获得信任，部署须另行审慎配置TLS与代理信任，不把当前开发启动当生产HTTPS验收。

## 运行与测试

```powershell
npm start
```

开发时使用下面的命令代替 start，Node watch 会在源码修改时重启：

```powershell
npm run dev
```

默认健康检查地址为 `http://localhost:3000/api/health`。成功响应中 `data.status` 为 `ok`，数据库不可用返回 503；缺少配置、连接或索引初始化失败时启动失败，不切换其他存储。

自动化测试在另一个位于 `code/` 的 PowerShell 终端执行，必须有真实 MongoDB：

```powershell
$env:TEST_MONGODB_URI = "mongodb://127.0.0.1:27017"
$env:TEST_MONGODB_DB = "survey_test_integration"
npm test
```

测试支持模块只接受 `survey_test_` 专用前缀，追加随机后缀创建独立库，结束时仅清理该次创建的测试库。不要把测试前缀设成业务库名，也不要在 TEST\_MONGODB\_URI 中指定业务库；数据库不可用时测试失败，不跳过。

## 示例数据

先按上述方式配置数据库和 SESSION\_SECRET，再生成演示密码：

```powershell
$env:SEED_PASSWORD = New-RandomSecret
npm run seed
npm run seed
```

演示账号为固定用户名 `survey_demo`，密码来源是第一次插入时的 `SEED_PASSWORD`，不是默认密码。通过本地安全渠道管理该值，脚本不会打印密码或哈希，也不会创建凭据文件。密码不 trim，至少 8 个 Unicode 字符、UTF-8 最多 72 字节；缺失或超限时失败退出。再次运行应复用同一密码，换一个环境变量值不会重置已存在账号的密码。

固定标识与字段：

| 项目                                | 值或来源                                               |
| --------------------------------- | -------------------------------------------------- |
| 用户 `_id`                          | ObjectId `000000000000000000000010`                |
| `username` / `usernameNormalized` | `survey_demo`                                      |
| `passwordHash`                    | 对环境密码使用 bcrypt，cost=12                             |
| 问卷 `_id`                          | ObjectId `000000000000000000000020`                |
| `ownerId`                         | 固定演示用户 ObjectId                                    |
| 用户和问卷 `seedTag`                   | 固定字符串 `survey-demo-v1`                             |
| 题目、选项、规则 ID                       | normalizeQuestion / validateRules 生成的 UUID，插入后保持稳定 |
| 时间字段                              | 首次插入的当前时间，后续不覆盖                                    |

当前 MongoDB 集合没有禁止附加字段的 collection validator，持久化 schema 允许用户和问卷顶层额外的固定 `seedTag` 标记。这个标记只用于 seed 身份识别，不是权限或用户可提交的 API 字段；题目与规则仍严格遵守现有白名单，不附加标记。

脚本复用 `loadConfig`、`connectDatabase`、`normalizeQuestion`、`validateRules`。只以固定身份过滤器执行 `$setOnInsert` / upsert，绝不清库、删除记录或覆盖现有字段，也不插入回答或会话。真实同名账户、固定用户 ID 或问卷 ID 被其他数据占用时失败，不将真实账户认领为演示用户；不要移除冲突记录来强行运行。没有跨集合事务，插入中断可能留下演示用户，排除故障后重跑即可补入问卷。

问卷首次插入即为 `published`，`deadline=null`，允许匿名和重复填写。四题按单选、多选、数字、文本排序，多选限制 1～2 项，数字限制 0～100 的整数，文本限制 2～200 字符，均为必答。示例内容采用英文标签：

仅验证 seed 时，使用随机专用库，不在业务库试跑：

```powershell
$env:MONGODB_DB = "survey_test_seed_" + [Guid]::NewGuid().ToString("N")
$env:SEED_PASSWORD = New-RandomSecret
npm run seed
npm run seed
```

该配置会改变当前终端目标库；恢复业务环境请显式重新设置 MONGODB\_DB。seed 本身不会清理测试库，也不会自动改用测试库，始终写入显式配置的目标库。

## 浏览器路由

默认使用 `http://localhost:3000`，以下页面文件和路由均已实现：

| 地址                              | 用途         |
| ------------------------------- | ---------- |
| `/register`、`/login`            | 注册、登录      |
| `/surveys`                      | 我的问卷       |
| `/surveys/:surveyId/edit`       | 作者编辑、发布、关闭 |
| `/survey/:surveyId`             | 公开填写       |
| `/survey/:surveyId/complete`    | 通用完成提示     |
| `/surveys/:surveyId/statistics` | 作者统计       |

演示链接为 `http://localhost:3000/survey/000000000000000000000020`。默认应用已接入业务API及上述页面，注册不自动登录，登录后再进入作者管理。浏览器已实测注册至发布、匿名/登录填写、返回清不可达答案、END、完成页、统计、作者隔离及关闭拒绝提交，主流程9/9和补充4/4通过；不是仅凭seed或页面HTTP200判定交互通过。备用脚本使用项目外TEMP中的Playwright-core及本机Chrome，不是项目依赖或默认npm test的一部分。

## 约定与边界

## PowerShell API 会话示例

以下用户名是说明值；密码由当前终端动态生成，示例不含真实凭据。使用同一个WebSession保留Cookie，匿名写请求也必须先取CSRF。返回token是真实64位小写十六进制字符串，不要把API文档的说明token文本直接发给服务器，也不要打印或提交它。

```powershell
$base = "http://localhost:3000"
$csrf = Invoke-RestMethod "$base/api/auth/csrf" -SessionVariable web
$headers = @{ "X-CSRF-Token" = $csrf.data.csrfToken }
$credentials = @{
    username = "example_" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    password = New-RandomSecret
} | ConvertTo-Json
Invoke-RestMethod "$base/api/auth/register" -Method Post -WebSession $web `
    -Headers $headers -ContentType "application/json" -Body $credentials
$login = Invoke-RestMethod "$base/api/auth/login" -Method Post -WebSession $web `
    -Headers $headers -ContentType "application/json" -Body $credentials
$headers["X-CSRF-Token"] = $login.data.csrfToken
$survey = Invoke-RestMethod "$base/api/surveys" -Method Post -WebSession $web `
    -Headers $headers -ContentType "application/json" -Body '{"title":"API 示例草稿"}'
Invoke-RestMethod "$base/api/auth/me" -WebSession $web
Invoke-RestMethod "$base/api/auth/logout" -Method Post -WebSession $web -Headers $headers
```

此示例会向当前显式配置的库新增账号和草稿，不是只读检查，本轮文档工作没有执行它。登录必须更新headers中的token，WebSession自动接收新Cookie；退出后再写应重新GET csrf。先使用隔离验收库，不为运行示例清理现有业务数据。

## 交付

根据课程要求，两个阶段均需提交代码、文档、测试用例和项目完成报告。下面列出当前第一阶段的交付内容；第二阶段收到新要求后，需要同步更新这些内容并提交对应阶段的版本。本次实验重点为 MongoDB 和后端实现。

### 1. 代码

| 提交内容 | 对应位置与说明 |
| --- | --- |
| 后端代码 | [code/src/](code/src/)：包含 HTTP 接口、认证与权限、问卷管理、校验、跳转、提交和统计；配套页面位于 [code/public/](code/public/)，示例数据脚本位于 [code/scripts/](code/scripts/) |
| MongoDB schema | [数据库设计](文档/数据库设计.md)：说明集合、BSON 字段、嵌入与引用、关联关系和索引。项目使用 MongoDB 原生驱动，字段校验与索引约束由后端实现，不另设 Mongoose schema 文件 |
| 配置说明 | 本 README 的“环境与安装”“PowerShell 配置”“运行与测试”章节，以及 [code/.env.example](code/.env.example) |

提交的代码必须可运行。本项目在 `code/` 中按上述步骤安装依赖、配置环境变量并连接真实 MongoDB 后，使用 `npm start` 启动，开发时使用 `npm run dev`；依赖声明和锁定文件分别为 [code/package.json](code/package.json) 与 [code/package-lock.json](code/package-lock.json)。

### 2. 文档

| 提交内容 | 对应文件与说明 |
| --- | --- |
| 系统说明 | [系统说明.md](文档/系统说明.md)：系统目标、架构、MongoDB 存储方案、业务流程、运行配置和当前限制 |
| 数据库设计 | [数据库设计.md](文档/数据库设计.md)：集合与字段结构、嵌入和独立存储的选择、索引与数据约束 |
| API 说明 | [api说明.md](文档/api说明.md)：请求方法、URL、参数、返回数据、认证要求和错误情况 |
| 关键逻辑说明 | [关键逻辑说明.md](文档/关键逻辑说明.md)：权限、状态更新、并发防重复、题型校验、跳转重放、提交保存及 MongoDB 聚合统计 |

### 3. 测试用例

| 提交内容 | 对应位置与说明 |
| --- | --- |
| 测试步骤 | [测试用例.md](测试/测试用例.md)：前置条件和操作步骤 |
| 输入 | [测试用例.md](测试/测试用例.md)：测试数据、请求内容和边界条件 |
| 输出 | [测试用例.md](测试/测试用例.md)中的预期结果及实际回填，以及[测试结果.md](测试/测试结果.md)中的实际响应、数据库断言和命令结果 |
| 结果 | [测试结果.md](测试/测试结果.md)：实际验证结果、失败修复和验证范围；测试用例中的实际回填表也提供逐项判定 |

自动化测试代码位于 [code/tests/](code/tests/)，在 `code/` 中运行 `npm test`，集成测试使用真实 MongoDB。原计划中保留的“待运行”历史栏不代表实际结论，应以实际回填和验证记录为准，未执行的输入或范围不视为已通过。

### 4. 项目完成报告

[项目报告.md](项目报告.md)说明项目目标、架构与工程设计、MongoDB 设计、关键业务逻辑、测试证据、问题与解决方案、AI 使用情况及第二阶段扩展预留。

配套的 [AI使用日志.md](文档/AI使用日志.md)记录使用工具、提示词或注明的摘要、得到的代码或文档、是否修改及具体修改内容。历史记录提及的 `AI使用提示词.txt` 当前未包含在目录中，现有提示词摘要见 AI 使用日志。
