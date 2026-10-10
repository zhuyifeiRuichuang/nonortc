# nonortc

面向「主机使用网络代理」场景的 Chrome 隐私防护扩展。阻止网站获取宿主机的真实 IP、DNS 解析路径、真实时区、真实语言环境与物理位置；允许网站获取代理 IP，禁止其获取代理背后的真实信息。

| 仓库 | 地址 | 说明 |
| --- | --- | --- |
| GitHub | https://github.com/zhuyifeiRuichuang/nonortc | 主仓库，源码与安装包发布地 |
| CNB | https://cnb.cool/zhuzhupower/nonortc | 中国地区可直接访问的镜像仓库 |

## 简介

### 功能

| 功能 | 实现机制 | 作用范围 |
| --- | --- | --- |
| WebRTC 泄漏防护 | `chrome.privacy.network.webRTCIPHandlingPolicy` 设为 `disable_non_proxied_udp` | 全局强制 |
| 真实 IP 防护 | 同上，代理场景下强制 UDP 走代理通道 | 全局强制 |
| DNS 探测收敛 | 关闭 `chrome.privacy.network.networkPredictionEnabled`，消除预解析泄漏面 | 全局强制 |
| 时区防护 | 覆盖 `Date.prototype.getTimezoneOffset`、`Intl.DateTimeFormat`、`toLocale*` 系列与 `Temporal.Now.timeZoneId`，使时区名、偏移、GMT 串、区域缩写四者自洽 | 全局与按站点 |
| 语言环境防护 | 覆盖 `navigator.language`、`navigator.languages` 与 `Intl` 各构造器的默认区域，并用 `declarativeNetRequest` 改写 `Accept-Language` 请求头 | 全局与按站点 |
| 地理定位防护 | 覆盖 `navigator.geolocation`，返回与代理时区地区一致的坐标或直接拒绝 | 全局与按站点 |

开关模型：

- **全局开关**独占控制真实 IP、WebRTC、DNS。这三项依赖 `chrome.privacy`，该 API 只能全局生效，无按站点能力。
- **按站点开关**为三态，仅作用于时区、语言、地理定位：跟随全局、仅本站防护、仅本站放行。
- 全局关闭时把某站点单独开启，该站点仍获得时区与语言保护；全局开启时把某站点单独关闭，该站点放行时区与语言。两种情况下真实 IP 与 DNS 始终由全局开关决定。

### 适用浏览器

| 项 | 要求 |
| --- | --- |
| 内核 | Chromium 系，Chrome 与 Edge 等 |
| 最低版本 | Chrome 121，对应清单字段 `minimum_chrome_version` |
| 清单版本 | Manifest V3 |
| 运行时依赖 | 无第三方库、无后台服务 |

最低版本定为 121 的原因：内容脚本使用 `match_origin_as_fallback` 覆盖由匹配来源创建的 `about:`、`data:`、`blob:`、`filesystem:` 帧，该能力自 Chrome 121 起提供；更早的 119 与 120 已停止安全更新。

### 特性

- **时区伪装自洽**：同时对齐时区名、UTC 偏移、`Date.toString` 的 GMT 串与区域缩写，避免留下自相矛盾的伪造指纹。
- **语言伪装完整**：`navigator.language`、`Intl` 默认区域与 `Accept-Language` 请求头三者一致。
- **代理时区自动匹配**：按当前代理出口 IP 确定时区，或在多个 geo-IP 数据源之间自动回退。
- **内置泄漏自检页**：在浏览器内直接验证各项防护是否落地，结果按通过、警告、失败分级并给出处置指引。
- **零第三方依赖**：扩展运行时不引入任何库；geo-IP 探测仅在手动触发或定时校正时发起。
- **权限最小化**：仅申请运行必需的六项权限，不声明 `geolocation`、不使用 `debugger`、不读取或上传浏览数据。
- **可复现打包**：同一份源码配同一把密钥，在 Windows 与 Linux 上构建出的压缩包与 CRX 包字节一致。

### 工作原理

Chrome 规定注入**主世界**的内容脚本与宿主网页共享同一 JS 执行环境，**不能访问任何扩展 API**；默认所在的**隔离世界**才能访问 `chrome.storage` 等受限接口。因此本项目拆成两支内容脚本协作：

| 脚本 | 所属世界 | 职责 |
| --- | --- | --- |
| `content-main.js` | MAIN，`document_start` | 覆盖 `Date`、`Intl`、`navigator.language`、`navigator.geolocation`、`Temporal`。不调用任何 `chrome.*` API，只接收配置 |
| `content-bridge.js` | ISOLATED，`document_start` | 读取 `chrome.storage`，解析出当前站点的生效配置，经 `window.postMessage` 下发 |
| `geoip.js` | 共享模块 | 多源回退的出口 IP 时区与坐标探测，设置页与后台共用 |

两项关键设计：

1. **一次性握手 token**。主世界脚本在 `document_start` 生成随机 token 并广播，桥接脚本回发配置时必须携带同一 token 才会被应用。
2. **代理时区决定成败**。检测类站点会比对浏览器时区与出口 IP 归属城市，两者不一致即判定异常。因此代理时区必须取自代理出口 IP 所在城市，而非任意选择。设置页提供手动输入、按需探测、定时自动匹配三种方式。

### 目录构成

| 路径 | 用途 |
| --- | --- |
| `manifest.json` | MV3 清单：权限声明、双内容脚本注册、图标声明 |
| `background.js` | 后台 Service Worker：应用隐私策略、下发请求头改写规则、时区自动校正定时器 |
| `content-main.js` | 主世界内容脚本：时区、语言、地理定位、`Temporal` 覆盖 |
| `content-bridge.js` | 隔离世界内容脚本：读取配置、解析站点策略、下发 token 握手 |
| `geoip.js` | 多源 geo-IP 探测模块 |
| `popup.html` / `popup.js` | 工具栏弹窗：全局开关与当前站点开关 |
| `options.html` / `options.js` | 高级设置页：代理时区、WebRTC 策略、定位模式、语言、例外站点 |
| `selftest.html` / `selftest.js` | 内置泄漏自检页 |
| `icons/` | 扩展图标，四档尺寸，圆角透明底 |
| `tools/dns-leak-check.py` | 本机 DNS 泄漏闭环验证工具，零第三方依赖，不打包进安装包 |
| `.github/` | GitHub 打包发布流水线、打包脚本与清单校验脚本 |
| `.cnb/` | CNB 流水线定义与手动触发按钮，与 GitHub 版共用同一套脚本 |
| `.gitignore` | 排除构建产物与签名私钥，防止私钥误提交 |

## 使用方法

### 安装

**方式一：加载解压目录**

1. 在 `chrome://extensions` 开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 `nonortc` 目录。
3. 点击工具栏拼图图标，把 nonortc 固定到工具栏。

**方式二：使用发布包**

从 Release 下载 `nonortc-<版本>.zip` 并解压，再按方式一加载解压出的目录。

关于 CRX 包：Chrome 已禁止通过双击安装本地 `.crx`，本地安装统一走「加载已解压的扩展程序」。`.crx` 仅用于应用商店上架或企业策略分发。

**迁移注意**：`manifest.json` 中已写入 `key` 字段（固定的签名公钥），因此扩展 ID 不再随安装目录路径变化，解压安装与 CRX3 安装落在同一个扩展 ID 上：更换目录名、或从 zip 安装与从 crx 安装之间互相覆盖，扩展 ID 都保持不变，本地配置可正常继承。

**两个渠道的产物差异**：zip 不含签名，两个渠道内容完全一致；CRX3 需要签名私钥，仅在 GitHub Release 提供（原因见「签名密钥」章节）。

### 配置

入口为工具栏弹窗的「高级设置」，或右键扩展选择「选项」。修改后立即生效，无需重启浏览器。

| 配置项 | 取值 | 作用 |
| --- | --- | --- |
| 全局防护开关 | 开 / 关 | 控制 WebRTC、真实 IP、DNS 防护，并作为各站点时区与语言的默认策略 |
| 代理时区 | IANA 名称，如 `America/New_York` | 网站读到的时区，必须与代理出口 IP 所在城市一致 |
| WebRTC IP 策略 | `disable_non_proxied_udp` / `default_public_interface_only` | 真实 IP 防护强度 |
| 地理定位模式 | `spoof` 伪造坐标 / `deny` 拒绝 | 站点获取到的定位信息 |
| 语言环境 | `en-US` / `en-GB` / `en` | 网站读到的语言标识与语言请求头 |
| 按站点例外 | 三态 | 仅作用于时区、语言、地理定位，不影响 WebRTC 与 DNS |

代理时区的三种确定方式：

- **手动输入**：输入框提供完整 IANA 时区联想，约四百余项，可按关键字过滤。
- **自动探测**：按需触发一次，依次尝试多个 geo-IP 数据源，取首个可用结果。
- **自动匹配**：开启后随浏览器启动探测一次，此后每小时按当前出口 IP 校正，切换代理节点后自动跟上。

### 验证

入口为设置页的「打开泄漏自检页」，或直接访问 `chrome-extension://<扩展ID>/selftest.html`。

| 检查项 | 内容 | 数据来源 |
| --- | --- | --- |
| 一、全局策略落地 | 隐私策略是否按配置生效 | 扩展内实测 `chrome.privacy` |
| 二、语言请求头改写 | 是否存在改写 `Accept-Language` 的规则 | 请求头改写规则 |
| 三、覆盖效果复刻 | 时区、语言、地理定位的观测值是否与配置一致 | 扩展页内复刻验证 |
| 四、真实网页候选实测 | 真实网页中枚举到的 ICE 候选 | 普通网页，唯一有证据力的判定轨 |
| 五、扩展页候选对照 | 扩展页自身枚举结果 | 特权来源，仅供参考 |
| 六、外部站点复核 | 跳转第三方检测站点 | 外部站点 |

第四项需先打开至少一个 `http` 或 `https` 网页，例如 `https://browserleaks.com/webrtc`，再回到自检页取样。

结果分级与处置：

| 级别 | 含义 | 处置 |
| --- | --- | --- |
| 通过 | 符合预期 | 无需处理 |
| 警告 | 存在风险或已知盲区 | 按该行说明处理 |
| 失败 | 检测到真实信息泄漏或配置未生效 | 重新加载扩展后复测 |
| 信息 | 参考性数据，不参与判定 | 无需处理 |

四条常见误读：

- 扩展页对照出现明文内网地址，不代表防护失效。该来源属特权来源，不受主机候选策略约束。
- Worker 盲区告警不代表检测失败，它的作用是把已知盲区显式暴露出来。
- 候选数为零不代表功能损坏，而是 `disable_non_proxied_udp` 抑制非代理 UDP 的正常结果，代价是无代理环境下视频会议类站点可能无法建连。
- 仅出现 `.local` 候选不等于真实 IP 泄漏，那是浏览器默认的主机名遮蔽。

### 已知边界

以下内容在现有浏览器能力下无法由扩展解决，请勿据此判定扩展失效。

| 边界 | 说明 |
| --- | --- |
| 主动对抗的页面 | 页面可把检测逻辑移入 Worker 或 SharedWorker 等独立执行环境，内容脚本不注入这些环境，其中读到的是宿主机真实值 |
| 握手 token 可被窃取 | 页面在文档头部注册消息监听即可截获 token 并主动关闭本站防护。同一执行环境内不存在页面不可观测的传输通道，属 JS 覆盖方案的固有上限 |
| 脚本被沙箱禁用的框架 | `sandbox` 未授予 `allow-scripts` 的 iframe 不执行任何脚本，内容脚本无法注入；普通 `about:blank`、`srcdoc`、`blob:` 框架均已覆盖 |
| 操作系统与代理侧网络层 | DNS 递归查询走哪家解析器、是否存在分流直连、IPv6 与 QUIC 是否绕过代理，取决于代理客户端与系统配置，浏览器未向扩展开放对应接口 |

前两项的共同结论：本扩展能防护常规站点的检测脚本，但无法对抗主动绕过的站点。若需彻底解决，唯一路径是浏览器级覆盖，代价是被覆盖的标签页常驻调试提示条，与「不干扰浏览器正常使用」的约束冲突，因此默认不采用。

第四项的治理位置在代理侧，建议按以下对照处理：

| 泄漏向量 | 责任方 | 建议措施 |
| --- | --- | --- |
| DNS 递归查询走本地运营商 | 代理客户端 | 启用 fake-ip 模式的 DNS 并接管 53 端口，使用加密上游 |
| 分流规则命中直连 | 代理客户端规则 | 需要匿名的场景改用全局模式，或为目标域名显式强制代理 |
| IPv6 绕过仅 IPv4 的代理 | 系统网卡 | 在网卡关闭 IPv6，或在代理侧启用 IPv6 接管 |
| QUIC 基于 UDP 绕过代理 | 浏览器与代理客户端 | 关闭浏览器 QUIC 开关，或使用支持 UDP 转发的代理 |
| WebRTC 暴露主机候选 | 浏览器 | 已由本扩展覆盖 |
| DNS 预解析探测 | 浏览器 | 已由本扩展覆盖 |

代理侧改完后，用仓库内的工具做闭环验证，而不是只看第三方站点截图：

```bash
python tools/dns-leak-check.py                      # 常规自检
python tools/dns-leak-check.py --expect-country US  # 严格判定：预期出口在美国
python tools/dns-leak-check.py --json               # 机读输出
```

该工具仅用 Python 标准库，跨平台且无需安装依赖。它通过查询 Akamai 权威 DNS 的 `whoami` 记录反查究竟是谁在替你做递归查询，这比第三方检测站的结论更接近证据链：DNS 查询天然不会被 HTTP 代理转发，本地解析一旦发生就会在权威侧留下记录。通过标准是权威 DNS 侧看到的递归解析器不再是本地运营商，且与预期出口地区一致。

## 参与开发

### 定制开发流程

本仓库保留公开读取，供有同类需求的开发者 fork 后自行定制。流程如下：

1. 在 GitHub 仓库页点击 Fork，创建属于自己的副本。
2. 克隆到本地：`git clone https://github.com/<你的账号>/nonortc.git`
3. 修改后在 `chrome://extensions` 通过「加载已解压的扩展程序」选择该目录，改完点击「重新加载」即刻生效。

常见定制入口：

| 定制目标 | 修改位置 |
| --- | --- |
| 默认语言、定位模式、WebRTC 策略 | 设置页脚本中的默认配置 |
| geo-IP 数据源与回退顺序 | `geoip.js` |
| 权限清单与脚本注入范围 | `manifest.json` |
| 自检项与判定口径 | `selftest.js` |
| 打包时的排除规则 | 打包脚本中的排除名单 |

定制时请注意：主世界脚本不得调用任何 `chrome.*` API，配置只能由隔离世界脚本经 `postMessage` 下发；向主世界下发配置必须沿用握手 token 校验，否则页面可伪造关闭指令。

### 不接受合并请求

本仓库为个人自用项目，**不接受任何 Pull Request，也不处理外部 Issue**。所有代码决策以满足个人使用场景为唯一依据，不承诺兼容性、不提供维护支持。若需变更，请自行 fork 后修改。

由此衍生两点：

- 仓库内不设贡献者名单、行为准则与议题模板。
- 若 fork 后出现兼容问题，请自行排查；本仓库不会同步上游修复。

### 打包与发布

两条流水线共用同一个打包脚本。发布必须显式触发，推送代码不会自动发版。

| 平台 | 配置文件 | 触发方式 | 发布产物 |
| --- | --- | --- | --- |
| GitHub Actions | `.github/workflows/release.yml` | Actions 页选择工作流，点击运行 | zip、CRX3、SHA-256 校验文件、构建信息 |
| 腾讯 CNB | `.cnb.yml` 引入 `.cnb/pipeline.yml` | 分支推送自动校验；分支详情页按钮或开放接口执行发布 | zip、SHA-256 校验文件、构建信息 |

两条流水线的 zip 由同一脚本产出，内容逐字节一致；CRX3 需要签名私钥，仅在 GitHub 侧发布。

#### 推送校验

腾讯 CNB 在任意分支收到推送时自动执行静态校验，不产出发布物、不改动仓库：先由 `.github/scripts/verify.py` 校验清单字段与全部文件引用，再用 `node --check` 校验全部 JavaScript 语法。该脚本可在提交前本地执行：

```bash
python3 .github/scripts/verify.py
```

#### 发布流水线

腾讯 CNB 提供两种发布触发途径，二者共用同一份流水线定义。

其一为页面按钮。按钮定义在 `.cnb/web_trigger.yml`，事件名 `web_trigger_release`，显示在仓库「代码 - 分支详情页」。当前仓库仅有 `main` 一个分支，进入该分支详情页即可看到按钮，点击后填入版本号等参数即可启动。仅有仓库写权限的用户可点击该按钮。

其二为开放接口，事件名 `api_trigger_release`。

```bash
curl -X POST https://api.cnb.cool/zhuzhupower/nonortc/-/build/start \
  -H "Authorization: Bearer $CNB_TOKEN" \
  -H "Accept: application/vnd.cnb.api+json" \
  -H "Content-Type: application/json" \
  -d '{"branch":"main","event":"api_trigger_release",
       "env":{"VERSION":"<版本号>","SYNC_MANIFEST":"true"}}'
```

页面表单填写的输入项，改用接口触发时必须在 `env` 中显式给出，否则流水线会在版本校验阶段失败。事件名必须是 `api_trigger` 或以 `api_trigger_` 开头，这是接口的硬性限制。令牌需具备 `repo-cnb-trigger:rw` 权限才能调用该接口，若缺少会返回权限不匹配；流水线内含发布 Release 的步骤，因此还需要 `repo-release:rw`，仅具备代码读写权限的令牌无法完成发布。

发布产物流向：GitHub 侧产出 zip 安装包、CRX3 安装包、SHA-256 校验文件与构建信息文件，同时写入制品仓库与 Release；CNB 侧产出 zip 安装包、SHA-256 校验文件与构建信息文件，写入 Release 附件与提交附件。CNB 侧不产出 CRX3，原因见下一节。

### 签名密钥与扩展 ID

扩展 ID 由签名公钥推导，**更换密钥等于更换扩展 ID**，已安装的扩展将无法原地升级。因此密钥必须在首次发布前确定并长期复用。

```bash
openssl genrsa -out nonortc-signing-key.pem 2048     # 生成后离线保存，切勿提交
openssl rsa -in nonortc-signing-key.pem -pubout -outform DER \
  | openssl dgst -sha256 -binary | head -c 16 | xxd -p | tr '0-9a-f' 'a-p'
```

第二条命令输出的三十二位字符即该密钥对应的扩展 ID，可用于核对密钥配置是否正确。

**私钥存放位置**：GitHub 在 Settings 的 Secrets 中，变量名 `CRX_PRIVATE_KEY`。腾讯 CNB 没有可用的密钥配置入口——仓库「设置」下没有「变量与密钥」，开放接口也没有任何密钥写入端点——因此 CNB 侧不产出 CRX3。

**两端的产物策略差异**：

- GitHub 侧用私钥签名产出 CRX3，构建脚本会校验 `manifest.json` 的 `key` 字段与签名公钥一致，不一致时直接失败（不一致的包会被 Chrome 以 `Invalid key` 拒绝安装）。
- CNB 侧只产出 zip。zip 不含签名，扩展 ID 改由 `manifest.json` 的 `key` 字段推导，因此两个渠道安装得到的扩展 ID 完全相同，可以互相覆盖升级。CRX3 统一从 GitHub Release 获取。

`manifest.json` 的 `key` 字段来自同一个签名公钥，生成方式：

```bash
openssl rsa -in nonortc-signing-key.pem -pubout -outform DER | base64 -w0
```

把输出整行填入 `manifest.json` 的 `key` 字段即可。该字段是公钥，可以公开，也不影响 CRX3 的签名校验。

`.gitignore` 已排除 `*.pem`、`*.crx`、`*.zip` 与构建目录，私钥不会随提交入库。

## 开源协议

本项目采用 **MIT 协议**，全文见仓库根目录的 `LICENSE` 文件。

- 个人与企业均可自由使用、复制、修改、合并、发布、再许可和销售副本。
- 须在软件副本中包含版权声明与协议声明。
- 软件按「原样」提供，不含任何明示或默示担保，作者不对使用过程中产生的任何损害负责。
- 协议不限制你在 fork 后选择其他协议重新发布自己的派生版本，前提是保留上述版权与协议声明。

本仓库不接受合并请求，但 MIT 协议允许你在自己的副本上自由开发，无需向本仓库回馈。
