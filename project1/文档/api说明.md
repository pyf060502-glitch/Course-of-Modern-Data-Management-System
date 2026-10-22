# API 说明

## 1. 通用约定

| HTTP状态 | 适用含义                      |
| ------ | ------------------------- |
| 400    | 格式、字段、ID、配置、分页或规则不合法      |
| 401    | 未登录或登录凭据错误                |
| 403    | 缺失/无效/跨会话CSRF token       |
| 404    | 不存在、非作者，或公开访问草稿           |
| 409    | 用户名/重复提交冲突，或不允许的状态变更      |
| 410    | 提交时问卷已关闭或过期               |
| 413    | JSON请求正文超过100kb           |
| 415    | 不支持的字符集或内容编码              |
| 422    | 答案类型、必答、选项、范围或服务端重放路径校验失败 |
| 500    | 内部错误，不泄露内部信息              |
| 503    | 数据库不可用，健康检查明确使用此状态        |

```json
{"error":{"code":"INVALID_CREDENTIALS","message":"Invalid username or password"}}
```

各端点错误JSON见第8节。公共错误还包括400 INVALID\_JSON、413 PAYLOAD\_TOO\_LARGE、415 UNSUPPORTED\_ENCODING、500 INTERNAL\_ERROR。仅health明确将连接失败映射503 DATABASE\_UNAVAILABLE，其他未包装驱动异常返回500。全局正文校验先于CSRF；正常格式的未登录写请求缺CSRF先403，有合法会话token才进入401认证检查。认证csrf/me拒绝未知查询参数，register/login/logout没有查询白名单；不要将其描述为所有端点均拒绝未知查询字段。

## 2. 字段与结构

### 问卷基础字段

| 字段                     | 请求约束                                              |
| ---------------------- | ------------------------------------------------- |
| title                  | 创建必填、非空字符串，最多200 Unicode code point               |
| description            | 可选字符串，最多5000 code point                           |
| allowAnonymous         | 可选boolean，默认false                                 |
| allowMultipleResponses | 可选boolean，默认true；false时必须登录，即使allowAnonymous=true |
| deadline               | 可选日期/null；发布必须在未来；不得用TTL删除问卷                      |

管理问卷返回持久化status（draft/published/closed）及effectiveStatus（含expired）。published且deadline<=now派生expired，不覆盖closed。服务端管理id、ownerId、时间、状态等字段，不属于基础创建请求。

`surveyData`展开持久化文档，JSON同时包含相同的\_id/id字符串、ownerId、全部时间字段和publicUrl，seed问卷还可能有seedTag。管理列表items也为完整问卷，不是标题摘要。以下为完整结构；第4节示例仅省略字段展示变化，不代表实际响应只含那些字段：

```json
{"data":{"_id":"507f1f77bcf86cd799439012","id":"507f1f77bcf86cd799439012","ownerId":"507f1f77bcf86cd799439011","title":"校园调查","description":"了解校园生活","allowAnonymous":false,"allowMultipleResponses":true,"deadline":null,"status":"draft","effectiveStatus":"draft","questions":[],"jumpRules":[],"createdAt":"2026-10-19T08:00:00.000Z","updatedAt":"2026-10-19T08:00:00.000Z","publishedAt":null,"closedAt":null,"publicUrl":"/survey/507f1f77bcf86cd799439012"}}
```

### 题目字段

每问卷最多100题。新增必填title/type，required默认false、validation默认{}，选择题必需options。修改允许type变更，省略字段保留；validation提交后整体替换，不合并，变更type且省略validation则重置{}。转为非选择题清空持久化options，但请求禁止传options（包括\[]）；非选择题转选择题须提供options。

| 字段         | 约束                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| title      | trim后1～200 Unicode code point                                                                                     |
| type       | single / multiple / text / number                                                                                 |
| required   | boolean；新增默认false，修改省略则保留                                                                                         |
| options    | 选择题1～50项，label trim后1～200 code point；新增项必须省略id，修改原项用本题已有id，新项仍省略id；拒绝外来/重复id。数组整体替换，未列原项被删除                       |
| validation | single为{}；multiple为minSelections/maxSelections/exactSelections可选项；text为minLength/maxLength；number为min/max/integer |
| id / order | 服务端管理；题目ID稳定，order从1连续，排序用专门端点                                                                                    |

数量与长度配置为非负安全整数，长度最多10000、选择数量不超过选项数；min<=max，exact须在min/max内，必答多选max>=1且exact不能0，必答文本max不能0；整数数字范围至少容纳一个整数。缺省{}：多选0～选项数，文本0～10000，数字答案无显式范围但仍拒绝非有限数/不安全整数。非选择题请求禁止options，持久化及完整响应含options:\[]。

### 规则字段

每问卷最多500条。rules完整替换，id省略则生成，提交则只要求合法UUID及本次数组唯一，不要求已存在；其余五字段必填。来源和非END目标必须属本问卷，目标严格在来源之后；priority非负安全整数、同来源唯一、越小越优先。

| 来源类型     | operator                                                                       | value          |
| -------- | ------------------------------------------------------------------------------ | -------------- |
| single   | equals、not\_equals                                                             | 合法选项ID         |
| multiple | contains、not\_contains                                                         | 单个合法选项ID       |
| multiple | contains\_any、contains\_all                                                    | 非空、无重复合法选项ID数组 |
| number   | equals、not\_equals、greater\_than、greater\_or\_equal、less\_than、less\_or\_equal | 有限JSON number  |
| text     | 首版不支持                                                                          | 不接受文本跳转规则      |

targetQuestionId为后续题目UUID或`END`。空可选答案不匹配规则，无匹配顺序继续；多规则匹配取最小priority，末题自动结束。

### 答案字段

提交只接受answers数组，项为`{questionId,value}`；不提交path。single值为合法选项ID，multiple为无重复合法ID数组，text为字符串（trim后最多10000 code point），number为JSON number（有限且整数值安全）。缺失/null、多选空数组、文本trim后空串可作为可选空答案；required题不允许为空。数字0有效。

后端从首题重放路径，拒绝未知/重复questionId、路径外答案及非法选项；只校验访问到的题，跳过的必答题无需提交。多选非空才应用min/exact，数字/文本依题目配置校验。

## 3. 健康与认证（结构已核对）

示例用户ID和注册时间仅演示，不是真实用户；示例token是说明字符串，不是可用凭证。

实际csrfToken为64位小写十六进制字符串，GET csrf与登录返回的说明文本不可作为实际请求头值。GET health/csrf/me请求均无业务正文，例如 `GET /api/auth/me`；客户端使用服务端返回值，不在日志保存Cookie/token。

### GET /api/health

无认证、无参数。数据库健康200，连接失败503；未知参数400。

```json
{"data":{"status":"ok","database":"connected"}}
```

### GET /api/auth/csrf

无认证、无参数；创建或使用当前会话，200。未知参数400。

```json
{"data":{"csrfToken":"example-token-not-a-real-secret"}}
```

之后同会话写请求发送请求头：

```http
X-CSRF-Token: example-token-not-a-real-secret
Content-Type: application/json
```

### POST /api/auth/register

CSRF必需。username trim后3～32字符，仅ASCII字母、数字、下划线、连字符，按小写规范化唯一；password不trim，至少8字符且UTF-8不超过72字节。201，不自动登录。错误400/403/409（USERNAME\_TAKEN）/413。

```json
{"username":"example_author","password":"example-only-password"}
```

```json
{"data":{"user":{"id":"507f1f77bcf86cd799439011","username":"example_author","createdAt":"2026-10-19T08:00:00.000Z"}}}
```

### POST /api/auth/login

CSRF必需。字段和格式校验同register；成功200，重建并保存会话；返回新csrfToken，必须替换旧值。错误400/401（INVALID\_CREDENTIALS）/403/413。

```json
{"username":"example_author","password":"example-only-password"}
```

```json
{"data":{"user":{"id":"507f1f77bcf86cd799439011","username":"example_author","createdAt":"2026-10-19T08:00:00.000Z"},"csrfToken":"example-new-token-not-a-real-secret"}}
```

### POST /api/auth/logout

无正文或空对象；CSRF必需，幂等销毁会话和清Cookie，200。幂等不免除CSRF要求；退出后继续写请求重新取token。错误400/403/413。

```json
{}
```

```json
{"data":{"loggedOut":true}}
```

### GET /api/auth/me

可选登录，无参数，200；无登录不返回401，而返回user=null。未知参数400。

```json
{"data":{"user":{"id":"507f1f77bcf86cd799439011","username":"example_author","createdAt":"2026-10-19T08:00:00.000Z"}}}
```

```json
{"data":{"user":null}}
```

## 4. 问卷管理

响应使用第2节完整管理结构；本节示例只展示关键字段。所有管理端点拒绝未知查询字段，mine仅接受page/pageSize；无业务正文端点可省略正文或传{}，不得传其他字段。各端点请求和错误示例分别见本节与第8节。

### POST /api/surveys

登录+CSRF；基础字段见第2节，201草稿。错误400/401/403/413。

```json
{"title":"校园调查","description":"了解校园生活","allowAnonymous":false,"allowMultipleResponses":true,"deadline":null}
```

```json
{"data":{"id":"507f1f77bcf86cd799439012","title":"校园调查","status":"draft","effectiveStatus":"draft","questions":[],"jumpRules":[]}}
```

### GET /api/surveys/mine

登录；page默认1，pageSize默认20、最大100，均为不带前导零的正整数字符串；page最大floor(MAX\_SAFE\_INTEGER/pageSize)。按createdAt降序、\_id降序分页，items为完整管理问卷。错误400/401。

```http
GET /api/surveys/mine?page=1&pageSize=20
```

```json
{"data":{"items":[{"id":"507f1f77bcf86cd799439012","title":"校园调查","status":"draft","effectiveStatus":"draft"}],"page":1,"pageSize":20,"total":1,"totalPages":1}}
```

### GET /api/surveys/:surveyId

作者；合法surveyId，无业务查询参数；200完整管理问卷，字段见第2节。错误400/401/404。

```http
GET /api/surveys/507f1f77bcf86cd799439012
```

```json
{"data":{"id":"507f1f77bcf86cd799439012","title":"校园调查","description":"了解校园生活","allowAnonymous":false,"allowMultipleResponses":true,"deadline":null,"status":"draft","effectiveStatus":"draft","questions":[],"jumpRules":[]}}
```

### PATCH /api/surveys/:surveyId

作者+CSRF；至少提交一个基础字段。草稿可改参与设置，published锁定参与设置但可改标题/说明/未来截止或null；closed/expired不可改，409。返回完整问卷。错误400/401/403/404/409/413。

```json
{"title":"校园调查修订","description":"修订说明","deadline":null}
```

```json
{"data":{"id":"507f1f77bcf86cd799439012","title":"校园调查修订","description":"修订说明","status":"draft","effectiveStatus":"draft","deadline":null}}
```

### DELETE /api/surveys/:surveyId

作者+CSRF，无正文；先关闭，再删除关联回答和问卷，200删除结果。错误400/401/403/404/413。正常流程无残留，不承诺与在途提交跨集合原子性。

```http
DELETE /api/surveys/507f1f77bcf86cd799439012
```

```json
{"data":{"deleted":true,"deletedResponses":2}}
```

### POST /api/surveys/:surveyId/publish

作者+CSRF，无正文；草稿至少一题、完整合法配置、截止在未来或null。200直接返回完整问卷含publicUrl，不嵌套survey。有效published直接幂等返回，保留publishedAt；closed/expired不可重开。错误400/401/403/404/409/413。

```http
POST /api/surveys/507f1f77bcf86cd799439012/publish
```

```json
{"data":{"id":"507f1f77bcf86cd799439012","status":"published","effectiveStatus":"published","publishedAt":"2026-10-19T08:01:00.000Z","publicUrl":"/survey/507f1f77bcf86cd799439012"}}
```

### POST /api/surveys/:surveyId/close

作者+CSRF，无正文；200完整问卷。关闭幂等且保留第一次closedAt，草稿409；status=published的过期问卷允许关闭，之后status/effectiveStatus均closed，不能重开。错误400/401/403/404/409/413。

```http
POST /api/surveys/507f1f77bcf86cd799439012/close
```

```json
{"data":{"id":"507f1f77bcf86cd799439012","status":"closed","effectiveStatus":"closed"}}
```

## 5. 题目及规则管理

以下均作者权限；写操作需CSRF且只能编辑草稿，非草稿结构修改409。共同错误400/401/403/404/409/413。UUID示例按执行时返回值替换，响应示意不表示已实测。

### POST /api/surveys/:surveyId/questions

必需question对象，不将题目字段平铺到请求顶层；字段及配置见第2节。新增201题目。以下四个JSON是四次独立新增示例。

```json
{"question":{"title":"请选择年级","type":"single","required":true,"options":[{"label":"大一"},{"label":"大二"}],"validation":{}}}
```

```json
{"question":{"title":"请选择水果","type":"multiple","required":true,"options":[{"label":"苹果"},{"label":"香蕉"},{"label":"西瓜"}],"validation":{"minSelections":2,"maxSelections":3}}}
```

```json
{"question":{"title":"建议","type":"text","required":false,"validation":{"minLength":2,"maxLength":100}}}
```

```json
{"question":{"title":"年龄","type":"number","required":true,"validation":{"min":0,"max":120,"integer":true}}}
```

```json
{"data":{"question":{"id":"11111111-1111-4111-8111-111111111111","order":1,"title":"请选择年级","type":"single","required":true,"options":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","label":"大一"},{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","label":"大二"}],"validation":{}}}}
```

### PATCH /api/surveys/:surveyId/questions/:questionId

必需question对象，questionId为本问卷稳定UUID，字段同新增。空question保留原题并保存。200返回question与removedRuleIds；变更题型清理以本题为来源的规则，移除选项清理依赖该选项的来源规则，目标规则不删除。完整结构仍需通过合法性校验。

```json
{"question":{"title":"请选择当前年级","required":true}}
```

```json
{"data":{"question":{"id":"11111111-1111-4111-8111-111111111111","order":1,"title":"请选择当前年级","type":"single","required":true,"options":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","label":"大一"},{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","label":"大二"}],"validation":{}},"removedRuleIds":[]}}
```

保留原项、删除未列原项并添加新项：

```json
{"question":{"options":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","label":"大一（改名）"},{"label":"新增年级"}]}}
```

### DELETE /api/surveys/:surveyId/questions/:questionId

无正文，200删除结果及移除规则ID；同时清理以该题为来源或目标的规则，剩余题顺序连续。

```http
DELETE /api/surveys/507f1f77bcf86cd799439012/questions/11111111-1111-4111-8111-111111111111
```

```json
{"data":{"deleted":true,"questionId":"11111111-1111-4111-8111-111111111111","removedRuleIds":["99999999-9999-4999-8999-999999999999"]}}
```

### PUT /api/surveys/:surveyId/questions/order

questionIds为本问卷全部题目ID的完整无重复排列，不能漏项/增项；若造成已有规则向前跳转则400且不保存。200完整题目数组（下例省略title/type/required/options/validation）。静态order不能被questionId动态路由误匹配。

```json
{"questionIds":["22222222-2222-4222-8222-222222222222","11111111-1111-4111-8111-111111111111"]}
```

```json
{"data":{"questions":[{"id":"22222222-2222-4222-8222-222222222222","order":1},{"id":"11111111-1111-4111-8111-111111111111","order":2}]}}
```

### PUT /api/surveys/:surveyId/jump-rules

rules数组完整替换，空数组清空。规则字段及运算符见第2节；提交合法且无重复id则保留，不要求已有，省略则生成。200规则数组。

```json
{"rules":[{"sourceQuestionId":"11111111-1111-4111-8111-111111111111","operator":"equals","value":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","targetQuestionId":"END","priority":0}]}
```

```json
{"data":{"rules":[{"id":"99999999-9999-4999-8999-999999999999","sourceQuestionId":"11111111-1111-4111-8111-111111111111","operator":"equals","value":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","targetQuestionId":"END","priority":0}]}}
```

## 6. 公开填写

### GET /api/public/surveys/:surveyId

可选登录，无业务参数；200返回填写必需的标题、题目、规则、有效状态及登录提示，草稿404。关闭/过期读取仍200，canSubmit=false、submissionBlockedReason为closed/expired；需要登录且未登录时为login\_required。错误400/404；未知查询字段400。

```http
GET /api/public/surveys/507f1f77bcf86cd799439012
```

```json
{"data":{"id":"507f1f77bcf86cd799439012","title":"校园调查","description":"了解校园生活","status":"published","effectiveStatus":"published","deadline":null,"allowAnonymous":false,"allowMultipleResponses":true,"requiresLogin":true,"canSubmit":false,"submissionBlockedReason":"login_required","questions":[{"id":"11111111-1111-4111-8111-111111111111","order":1,"title":"建议","type":"text","required":false,"options":[],"validation":{"maxLength":100}}],"jumpRules":[]}}
```

本示例使用另一个仅含文本题的问卷结构，不能与前面的单选规则示例拼成同一请求数据。不得返回作者内部数据、统计、哈希或其他人的提交。

### POST /api/public/surveys/:surveyId/responses

CSRF必需，是否需登录按实际设置判定；answers及value见第2节。成功201返回id、submittedAt、completionUrl，不提供公开回答读取端点。错误400/401（AUTH\_REQUIRED）/403/404（NOT\_FOUND）/409（ALREADY\_SUBMITTED）/410（SURVEY\_UNAVAILABLE）/413/422。410的details含effectiveStatus，草稿和不存在404；不接受查询字段。

```json
{"answers":[{"questionId":"11111111-1111-4111-8111-111111111111","value":"支持更多活动"}]}
```

```json
{"data":{"id":"507f1f77bcf86cd799439013","submittedAt":"2026-10-19T08:05:00.000Z","completionUrl":"/survey/507f1f77bcf86cd799439012/complete"}}
```

该请求对应上面的文本题示例。客户端不发送path、respondentId、anonymous、submittedAt或singleResponseKey。服务端在保存前重查状态、参与配置及路径；多次允许提交独立插入。禁止重复的登录提交由partial unique索引保障，并发重复409。

## 7. 作者统计

### GET /api/surveys/:surveyId/statistics

作者，无业务参数；200全问卷摘要及各题MongoDB聚合统计，不内嵌全部文本/数字内容。错误400/401/404。下例结构已与statistics.js核对，数值仍是说明数据，不是实测。

```http
GET /api/surveys/507f1f77bcf86cd799439012/statistics
```

```json
{"data":{"surveyId":"507f1f77bcf86cd799439012","totalResponses":3,"uniqueRegisteredRespondents":1,"anonymousResponses":1,"questions":[{"questionId":"11111111-1111-4111-8111-111111111111","title":"请选择年级","type":"single","visitedCount":3,"answeredCount":2,"ratioUnit":"fraction","ratioDenominator":"answeredCount","options":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","label":"大一","count":2,"ratio":1},{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","label":"大二","count":0,"ratio":0}]}]}}
```

totalResponses是提交次数；uniqueRegisteredRespondents去重登录用户，anonymousResponses是次数不是匿名人数。选择题ratio为fraction（0～1），分母answeredCount；多选每条回答每个选项最多计一次，合计可超过回答数，比例和可超过1；未选选项也返回。number题含numeric:{count,average,min,max}，text仅含基本逐题计数，内容另行分页。

### GET /api/surveys/:surveyId/statistics/questions/:questionId

作者；page可选正整数字符串（默认1，最大floor(MAX\_SAFE\_INTEGER/pageSize)），pageSize可选正整数字符串（默认20、最大100），不接受前导零或其他查询字段。200直接在data中返回surveyId和逐题统计字段，text/number另含contents。按submittedAt降序、\_id降序稳定分页。错误400/401/404，题目不存在NOT\_FOUND。

```http
GET /api/surveys/507f1f77bcf86cd799439012/statistics/questions/11111111-1111-4111-8111-111111111111?page=1&pageSize=20
```

```json
{"data":{"surveyId":"507f1f77bcf86cd799439012","questionId":"11111111-1111-4111-8111-111111111111","title":"年龄","type":"number","visitedCount":3,"answeredCount":3,"numeric":{"count":3,"average":10,"min":0,"max":20},"contents":{"items":[{"responseId":"507f1f77bcf86cd799439015","value":20,"submittedAt":"2026-10-19T08:07:00.000Z"},{"responseId":"507f1f77bcf86cd799439014","value":10,"submittedAt":"2026-10-19T08:06:00.000Z"},{"responseId":"507f1f77bcf86cd799439013","value":0,"submittedAt":"2026-10-19T08:05:00.000Z"}],"page":1,"pageSize":20,"totalItems":3,"totalPages":1}}}
```

此为另一个数字题的说明数据，不是前一文本/单选问卷的真实返回。contents.items每项为responseId/submittedAt/value，totalItems=answeredCount，totalPages=ceil(totalItems/pageSize)，零内容时0；空页items=\[]。text内容同样分页；选择题不返回contents。无数字回答时numeric.count=0、average/min/max=null；单选零回答比例0。

## 8. 每端点错误 JSON

每行给出一个可触发的典型错误，并非穷举；各节列明的状态及公共错误同样适用。message保留源码英文，避免中文解释冒充实际返回。

| 端点                                                          | 条件 / 状态                | 错误JSON示例                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /api/health                                             | 连接失败 / 503             | `{"error":{"code":"DATABASE_UNAVAILABLE","message":"Database is unavailable"}}`                                                                             |
| GET /api/auth/csrf                                          | query.extra / 400      | `{"error":{"code":"INVALID_INPUT","message":"Unknown request field","details":{"field":"query.extra"}}}`                                                    |
| POST /api/auth/register                                     | 同名 / 409               | `{"error":{"code":"USERNAME_TAKEN","message":"Username is already registered"}}`                                                                            |
| POST /api/auth/login                                        | 错误密码 / 401             | `{"error":{"code":"INVALID_CREDENTIALS","message":"Invalid username or password"}}`                                                                         |
| POST /api/auth/logout                                       | 无CSRF / 403            | `{"error":{"code":"CSRF_INVALID","message":"A valid session CSRF token is required"}}`                                                                      |
| GET /api/auth/me                                            | query.extra / 400      | `{"error":{"code":"INVALID_INPUT","message":"Unknown request field","details":{"field":"query.extra"}}}`                                                    |
| POST /api/surveys                                           | 有认证及CSRF但正文{} / 400    | `{"error":{"code":"INVALID_INPUT","message":"Title is required","details":{"field":"title"}}}`                                                              |
| GET /api/surveys/mine                                       | 未登录 / 401              | `{"error":{"code":"AUTH_REQUIRED","message":"Login is required"}}`                                                                                          |
| GET /api/surveys/:surveyId                                  | 非作者 / 404              | `{"error":{"code":"NOT_FOUND","message":"Resource not found"}}`                                                                                             |
| PATCH /api/surveys/:surveyId                                | 空更新 / 400              | `{"error":{"code":"INVALID_INPUT","message":"At least one update field is required","details":{"field":"body"}}}`                                           |
| DELETE /api/surveys/:surveyId                               | 不存在 / 404              | `{"error":{"code":"NOT_FOUND","message":"Resource not found"}}`                                                                                             |
| POST /api/surveys/:surveyId/publish                         | 空草稿 / 400              | `{"error":{"code":"INVALID_INPUT","message":"Publishing requires at least one question","details":{"field":"questions"}}}`                                  |
| POST /api/surveys/:surveyId/close                           | 草稿 / 409               | `{"error":{"code":"SURVEY_STATE_CONFLICT","message":"Draft surveys cannot be closed"}}`                                                                     |
| POST /api/surveys/:surveyId/questions                       | text传options:\[] / 400 | `{"error":{"code":"INVALID_INPUT","message":"This question type does not accept options","details":{"field":"question.options"}}}`                          |
| PATCH /api/surveys/:surveyId/questions/:questionId          | 非草稿 / 409              | `{"error":{"code":"SURVEY_STATE_CONFLICT","message":"Published survey structure is locked"}}`                                                               |
| DELETE /api/surveys/:surveyId/questions/:questionId         | 合法UUID但题不存在 / 404      | `{"error":{"code":"NOT_FOUND","message":"Question not found"}}`                                                                                             |
| PUT /api/surveys/:surveyId/questions/order                  | 漏题/重复 / 400            | `{"error":{"code":"INVALID_INPUT","message":"Provide the complete question list without duplicates","details":{"field":"questionIds"}}}`                    |
| PUT /api/surveys/:surveyId/jump-rules                       | 向前目标 / 400             | `{"error":{"code":"INVALID_INPUT","message":"Target must be a later question or END","details":{"field":"rules[0].targetQuestionId"}}}`                     |
| GET /api/public/surveys/:surveyId                           | 草稿 / 404               | `{"error":{"code":"NOT_FOUND","message":"Resource not found"}}`                                                                                             |
| POST /api/public/surveys/:surveyId/responses                | 必答为空 / 422             | `{"error":{"code":"INVALID_ANSWER","message":"This question is required","details":{"questionId":"11111111-1111-4111-8111-111111111111","field":"value"}}}` |
| GET /api/surveys/:surveyId/statistics                       | 非作者 / 404              | `{"error":{"code":"NOT_FOUND","message":"Resource not found"}}`                                                                                             |
| GET /api/surveys/:surveyId/statistics/questions/:questionId | 合法UUID但题不存在 / 404      | `{"error":{"code":"NOT_FOUND","message":"Resource not found"}}`                                                                                             |

提交还可能返回：

```json
{"error":{"code":"AUTH_REQUIRED","message":"Login is required for this survey"}}
```

```json
{"error":{"code":"ALREADY_SUBMITTED","message":"Only one response per registered user is allowed"}}
```

```json
{"error":{"code":"SURVEY_UNAVAILABLE","message":"Survey is closed or expired","details":{"effectiveStatus":"expired"}}}
```

```json
{"error":{"code":"INVALID_SUBMISSION","message":"Answer belongs to an unvisited question","details":{"field":"answers","questionId":"22222222-2222-4222-8222-222222222222"}}}
```

对应401、409、410、422。一般答案值为422 INVALID\_ANSWER，答案结构/路径为422 INVALID\_SUBMISSION；但顶层非法字段、递归危险键由全局先拦截为400 INVALID\_INPUT，不能一律写成422。

统一传输错误示例，适用于经过JSON正文处理的请求：

```json
{"error":{"code":"INVALID_JSON","message":"Request body must be valid JSON"}}
```

```json
{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Request body exceeds the size limit"}}
```

```json
{"error":{"code":"UNSUPPORTED_ENCODING","message":"Request encoding is not supported"}}
```

```json
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}
```

分别400、413、415、500；500/503不返回内部details或堆栈。
