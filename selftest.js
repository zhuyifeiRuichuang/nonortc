// nonortc 泄漏自检页逻辑（扩展内部页面，可实读 chrome.privacy 与 DNR 规则）
'use strict';

// 与 manifest.json 的 version 保持一致；selftest.html 用 ?v= 引用本文件以避免缓存旧版
const SELFTEST_VERSION = '1.1.1';

/* ============ 0. 兜底：任何未捕获异常都必须可见，绝不留在「检测中」 ============ */

const STATE = {
  pending: new Set(['policyTable', 'dnrTable', 'spoofTable', 'webrtcRealTable', 'webrtcTable']),
  banner: null,
  ranAt: Date.now()
};

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 版本戳：页头可见，用于识别浏览器是否仍在执行被缓存的旧脚本
(function stampVersion() {
  const el = document.getElementById('ver');
  if (el) el.textContent = `（自检脚本 v${SELFTEST_VERSION}）`;
})();

function banner(msg) {
  if (!STATE.banner) {
    STATE.banner = document.createElement('div');
    STATE.banner.className = 'card err-card';
    STATE.banner.id = 'nonortcErrBanner';
    const sub = document.querySelector('.sub');
    if (sub && sub.parentNode) sub.parentNode.insertBefore(STATE.banner, sub.nextSibling);
    else document.body.insertBefore(STATE.banner, document.body.firstChild);
  }
  STATE.banner.insertAdjacentHTML('beforeend', `<div class="note"><b>运行期异常</b>：${esc(msg)}</div>`);
}

window.addEventListener('error', (e) => {
  banner(`${e.message}（${e.filename ? e.filename.split('/').pop() : '?'}:${e.lineno}）`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  banner(`Promise 未处理拒绝：${r && r.message ? r.message : r}`);
});

/* ============ 1. 渲染基元 ============ */

function setCell(tableId, html) {
  const tb = document.querySelector(`#${tableId} tbody`);
  if (tb) tb.innerHTML = html;
}

function row(name, status, detail) {
  const cls = { pass: 'pass', fail: 'fail', warn: 'warn', info: 'info' }[status] || 'info';
  return `<tr><td style="width:34%">${esc(name)}</td>`
    + `<td style="width:12%"><span class="badge ${cls}">${esc(String(status).toUpperCase())}</span></td>`
    + `<td class="mono">${esc(detail)}</td></tr>`;
}

function noteRow(text) {
  return `<tr><td colspan="3" class="note">${esc(text)}</td></tr>`;
}

function errorRow(msg, e) {
  const stack = e && e.stack ? `<br><span class="mono">${esc(String(e.stack).split('\n').slice(0, 4).join(' / '))}</span>` : '';
  return `<tr><td style="width:34%"><span class="badge fail">ERROR</span></td>`
    + `<td style="width:12%"></td>`
    + `<td>${esc(msg)}${stack}</td></tr>`;
}

// 统一执行器：任何状态下都会把卡片从「检测中」改写为结果或错误，并附耗时
async function runSection(tableId, label, fn) {
  const t0 = performance.now();
  let html;
  try {
    html = await fn();
    if (!html) html = noteRow('本项无输出。');
  } catch (e) {
    html = errorRow(`本项执行失败：${e && e.message ? e.message : e}`, e);
    banner(`${label} 执行失败：${e && e.message ? e.message : e}`);
  }
  const ms = Math.round(performance.now() - t0);
  setCell(tableId, html + noteRow(`— ${label} 用时 ${ms} ms —`));
  STATE.pending.delete(tableId);
}

// 看门狗：10 秒后任何仍未落地的卡片都要给出明确交代，而不是继续「检测中」
setTimeout(() => {
  for (const id of Array.from(STATE.pending)) {
    setCell(id, errorRow('超时：本项 10 秒内未返回结果，等待已中止（页面不再卡在「检测中」）。请按 F12 打开控制台查看报错，或对该页执行硬性刷新（Ctrl+Shift+R）后重试。'));
    STATE.pending.delete(id);
  }
}, 10000);

/* ============ 2. 时区 / 语言覆盖复刻（与 content-main.js 同款语义） ============ */

function pad2(n) { return String(n).padStart(2, '0'); }

function isValidTZ(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// getTZOffset 语义：UTC - 本地（与 Date#getTimezoneOffset 相反）
// 无效日期须返回 NaN：原生 getTimezoneOffset 对 Invalid Date 即返回 NaN，
// 若继续走 Intl 会抛 RangeError（与 content-main.js 保持同一语义）。
function tzOffsetMinutes(date, tz) {
  if (!Number.isFinite(date.getTime())) return NaN;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000);
}

function gmtString(off) { // getTZOffset 值 -> GMT±hhmm（符号相反）
  const gmtOff = -off;
  const sign = gmtOff >= 0 ? '+' : '-';
  const abs = Math.abs(gmtOff);
  return `GMT${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

function zoneAbbr(date, tz) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName');
    return part ? part.value : '';
  } catch (e) { return ''; }
}

// 在测试页内复刻 content-main.js 的覆盖效果，返回观测值
function applySpoofAndRead(tz, lang) {
  const REAL_DTF = Intl.DateTimeFormat;
  const localesOf = (l) => (l === undefined || l === null) ? lang : l;
  Date.prototype.getTimezoneOffset = function () { return -tzOffsetMinutes(this, tz); };

  const _toLocaleString = Date.prototype.toLocaleString;
  const _toLocaleDateString = Date.prototype.toLocaleDateString;
  const _toLocaleTimeString = Date.prototype.toLocaleTimeString;
  Date.prototype.toLocaleString = function (l, o) {
    return _toLocaleString.call(this, localesOf(l), Object.assign({}, o, { timeZone: tz }));
  };
  Date.prototype.toLocaleDateString = function (l, o) {
    return _toLocaleDateString.call(this, localesOf(l), Object.assign({}, o, { timeZone: tz }));
  };
  Date.prototype.toLocaleTimeString = function (l, o) {
    return _toLocaleTimeString.call(this, localesOf(l), Object.assign({}, o, { timeZone: tz }));
  };
  const _toString = Date.prototype.toString;
  Date.prototype.toString = function () {
    if (!Number.isFinite(this.getTime())) return _toString.call(this); // 无效日期原样透传
    const dtf = new REAL_DTF('en-US', {
      timeZone: tz, hour12: false, hourCycle: 'h23',
      weekday: 'short', year: 'numeric', month: 'short',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    for (const part of dtf.formatToParts(this)) p[part.type] = part.value;
    const offMin = -tzOffsetMinutes(this, tz);
    const gmtOff = -offMin;                       // 与 getTimezoneOffset 符号相反
    const abs = Math.abs(gmtOff);
    const gmt = `GMT${gmtOff >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
    return `${p.weekday} ${p.month} ${p.day} ${p.year} ${p.hour}:${p.minute}:${p.second} ${gmt} (${zoneAbbr(this, tz)})`;
  };

  Intl.DateTimeFormat = function (locales, options) {
    if (options == null) options = { timeZone: tz };
    else if (!('timeZone' in options)) options = Object.assign({}, options, { timeZone: tz });
    return new REAL_DTF(localesOf(locales), options);
  };
  Object.defineProperty(Navigator.prototype, 'language', { configurable: true, get() { return lang; } });
  Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get() { return [lang, lang.split('-')[0] || 'en']; } });

  // 复刻 Temporal 覆盖（现行规范 timeZoneId + 早期草案 timeZone）
  try {
    if (typeof Temporal !== 'undefined' && Temporal.Now) {
      const NOW = Temporal.Now;
      if (typeof NOW.timeZoneId === 'function') {
        Object.defineProperty(NOW, 'timeZoneId', {
          configurable: true, writable: true,
          value: function () { return tz; }
        });
      }
      if (typeof NOW.timeZone === 'function') {
        const OTZ = NOW.timeZone;
        Object.defineProperty(NOW, 'timeZone', {
          configurable: true, writable: true,
          value: function () { try { return new Temporal.TimeZone(tz); } catch (e) { return OTZ ? OTZ.call(NOW) : undefined; } }
        });
      }
      const inj = (orig) => function (...a) { return a.length === 0 ? orig.call(NOW, tz) : orig.apply(NOW, a); };
      for (const m of ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO']) {
        if (typeof NOW[m] === 'function') Object.defineProperty(NOW, m, { configurable: true, writable: true, value: inj(NOW[m]) });
      }
    }
  } catch (e) { /* Temporal 不可用或属性不可重定义时保持原样，不影响其余向量 */ }

  // 无效日期（Invalid Date）行为回归：原生 toString 返回 "Invalid Date"、
  // getTimezoneOffset 返回 NaN，均不抛错。覆盖后必须保持，否则站点会收到
  // "Uncaught RangeError: Invalid time value"（Chrome 实测，content-main.js 曾因此报错）。
  let invalidThrew = false, invalidStr = '', invalidOff = '';
  try {
    const bad = new Date(NaN);
    invalidStr = bad.toString();
    invalidOff = String(bad.getTimezoneOffset());
  } catch (e) { invalidThrew = true; invalidStr = e.name + ': ' + e.message; }

  const now = new Date();
  const off = now.getTimezoneOffset();
  let temporalId = '（浏览器不支持 Temporal）';
  if (typeof Temporal !== 'undefined' && Temporal.Now) {
    try {
      if (typeof Temporal.Now.timeZoneId === 'function') temporalId = Temporal.Now.timeZoneId();
      else if (typeof Temporal.Now.timeZone === 'function') temporalId = Temporal.Now.timeZone().id;
    } catch (e) { temporalId = 'ERR ' + e.message; }
  }
  return {
    tzName: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    localeStr: now.toLocaleString(),
    off, gmt: gmtString(off),
    str: now.toString(),
    temporalId,
    lang: navigator.language,
    langs: navigator.languages.join(', '),
    abbr: zoneAbbr(now, tz),
    invalidThrew, invalidStr, invalidOff
  };
}

/* ============ 3. 地理定位（复刻覆盖语义，不调用真实 API） ============ */
//
// 本扩展刻意不声明 "geolocation" 权限：该权限会在安装时向用户展示「检测你的位置」，
// 与一个隐私防护扩展的定位直接冲突。由此产生两个必须记录在案的事实：
//
//   1) 官方文档（Chrome for Developers / Extensions / Use geolocation）明确：
//      popup / 侧边栏 / 扩展页这类扩展文档若要使用 navigator.geolocation，
//      必须在 manifest 的 "permissions" 里声明 "geolocation"；未声明时 API 依然存在，
//      但「任何尝试使用都会立即产生错误，就像用户拒绝了请求一样」。
//      https://developer.chrome.com/docs/extensions/how-to/web-platform/geolocation
//
//   2) 调用发生的瞬间，Chrome 会向该扩展记一条**警告**（级别 warning，非 error）：
//      Is the 'geolocation' permission appropriate? See <manifest.html#permissions>
//      实测 Chrome 154.0.8037.58：随调用发生（与页面加载时机、是否用户手势均无关），
//      并显示在 chrome://extensions 的「错误」页。
//
// 结论：在扩展页调用真实 geolocation，既注定只有一个结果（code 1）、又会留下告警，
// 属零诊断价值的取样方式（与 ④-b 同类问题）。故此处改为**复刻** content-main.js 的覆盖
// 语义：在内存里驱动一遍回调，验证「按当前配置应当返回什么」，不触碰真实 API、不产生告警。

// 与 content-main.js 的 defaultCoords() 保持一致；改动其一必须同步另一处
const GEO_DEFAULT_MAP = {
  America: { lat: 40.7128, lng: -74.0060 },
  Europe: { lat: 48.8566, lng: 2.3522 },
  Asia: { lat: 35.6895, lng: 139.6917 },
  Africa: { lat: 6.5244, lng: 3.3792 },
  Australia: { lat: -33.8688, lng: 151.2093 }
};

// 同步驱动一次伪装的 getCurrentPosition，返回「谁被回调、回调了什么」
function geoReplicaCheck(mode, tz, coords) {
  const region = String(tz || '').split('/')[0];
  const expected = (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number')
    ? { lat: coords.lat, lng: coords.lng }
    : (GEO_DEFAULT_MAP[region] || GEO_DEFAULT_MAP.America);
  const calls = { success: 0, error: 0 };
  let got = null, gotErr = null;
  const denyObj = { code: 1, PERMISSION_DENIED: 1, message: 'User denied Geolocation' };

  // 复刻 content-main.js：spoof → 同步回调伪造坐标；deny → 同步回调 code 1
  const getCurrentPosition = function (success, error) {
    if (mode === 'spoof') {
      calls.success++;
      got = {
        coords: {
          latitude: expected.lat, longitude: expected.lng,
          accuracy: 100, altitude: null, altitudeAccuracy: null, heading: null, speed: null
        },
        timestamp: Date.now()
      };
      if (success) success(got);
    } else {
      calls.error++;
      gotErr = denyObj;
      if (error) error(denyObj);
    }
  };
  getCurrentPosition((p) => p, (e) => e);
  return { mode, expected, calls, got, gotErr };
}

/* ============ 3b. Worker realm（内容脚本盲区，必须显式暴露） ============ */

// Web Worker / SharedWorker / Worklet / 页面 Service Worker 是独立 JS realm，
// 内容脚本不会注入其中，因此里面的时区与语言是宿主机真实值。
// 这一项不是为了"通过"，而是为了让盲区可见 —— 站点把检测逻辑搬进 Worker 即可绕过。
function testWorkerRealm() {
  return new Promise((resolve) => {
    if (typeof Worker !== 'function') { resolve({ status: 'info', msg: '浏览器无 Worker' }); return; }
    const src = 'self.onmessage=function(){self.postMessage({' +
      'tzOffset:new Date().getTimezoneOffset(),' +
      'intlTz:Intl.DateTimeFormat().resolvedOptions().timeZone,' +
      'intlLocale:Intl.DateTimeFormat().resolvedOptions().locale,' +
      'lang:navigator.language,langs:navigator.languages.join(","),' +
      'dateStr:new Date().toString()});};';
    let url;
    try {
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch (e) { resolve({ status: 'info', msg: '无法构造 Worker: ' + e.message }); return; }
    let w;
    try {
      w = new Worker(url);
    } catch (e) { resolve({ status: 'info', msg: 'Worker 创建失败: ' + e.message }); return; }
    const timer = setTimeout(() => resolve({ status: 'info', msg: 'Worker 无响应' }), 4000);
    w.onmessage = (e) => {
      clearTimeout(timer);
      w.terminate();
      URL.revokeObjectURL(url);
      const d = e.data || {};
      const main = { tzOffset: new Date().getTimezoneOffset(), lang: navigator.language };
      const leaked = (d.tzOffset !== main.tzOffset) || (d.lang !== main.lang);
      resolve({
        status: leaked ? 'warn' : 'pass',
        msg: leaked
          ? `Worker 内为宿主机真实值：时区 ${d.intlTz}（偏移 ${d.tzOffset}）、语言 ${d.lang} / ${d.langs}、${d.dateStr}。`
            + '内容脚本不注入 Worker，这是本扩展的已知盲区：站点把检测逻辑放进 Worker 即可读到真实值。'
          : `Worker 内与主 realm 一致：${d.intlTz} / ${d.lang}`
      });
    };
    w.onerror = (e) => { clearTimeout(timer); resolve({ status: 'info', msg: 'Worker 报错: ' + e.message }); };
    w.postMessage(1);
  });
}

/* ============ 4. WebRTC ICE 候选 ============ */
//
// 本卡片分两轨，判定口径完全不同：
//   轨 1「真实网页实测」—— 由 content-bridge.js 在**普通网页**的隔离世界里取样，
//        取样环境与页面同源、同权限、同网络栈，是唯一有证据力的结果，参与判定。
//   轨 2「扩展页对照」  —— 在自检页自身（chrome-extension:// 特权来源）枚举。
//        实测（Chrome 154，有头 / 无头一致）该来源既不施加 mDNS 主机名遮蔽，也不施加
//        webRTCIPHandlingPolicy，故恒能拿到明文内网地址 —— 属浏览器行为，不参与判定。

// RFC 8839 / draft-ietf-mmusic-ice-sip-sdp：候选行格式
//   candidate:<foundation> <component-id> <transport> <priority> <connection-address> <port> typ <type> [...]
// 解析必须按字段顺序取值，否则 type 永远取不到（历史实现即因此把泄漏候选误判为 PASS）。
const PRIVATE_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd][0-9a-f]{2}:|fe80:)/i;

const CAND_RE = /^candidate:\S+ \d+ (\w+) (\d+) (\S+) (\d+) typ (\w+)/;

function parseCandidates(lines) {
  return (lines || []).map((line) => {
    const m = String(line).match(CAND_RE);
    if (!m) return { transport: '?', addr: '', port: '', type: '?', mdns: false, priv: false, raw: String(line) };
    const addr = m[3];
    return {
      transport: m[1], priority: m[2], addr, port: m[4], type: m[5],
      mdns: /\.local$/i.test(addr), priv: PRIVATE_RE.test(addr), raw: String(line)
    };
  });
}

// 网段来源提示（仅作提示，不参与判定；同一网段可能对应真实网卡，见 172.17/16 说明）
function addrHint(addr) {
  if (!addr) return '';
  if (/\.local$/i.test(addr)) return 'mDNS 遮蔽主机名（Chrome 默认隐私保护，不含可路由的本机地址）';
  if (/^169\.254\./.test(addr)) return '链路本地地址（APIPA，通常不可路由）';
  if (/^127\./.test(addr)) return '回环地址';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return 'CGNAT 段 100.64/10，常见于 Tailscale 等覆盖网络';
  if (/^172\.17\./.test(addr)) return '172.17/16 与 Docker 默认网桥同段，但本机实测该段也可能就是真实以太网 —— 不可仅凭网段判定为虚拟网卡';
  if (/^192\.168\.\d+\.1$/.test(addr) || /^10\.\d+\.\d+\.1$/.test(addr)) return '形如 x.x.x.1 的网段网关地址，常见于 VMware / VirtualBox / Hyper-V 主机虚拟网卡';
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return 'IPv6 ULA（fc00::/7）';
  if (/^fe80:/i.test(addr)) return 'IPv6 链路本地地址';
  if (PRIVATE_RE.test(addr)) return 'RFC1918 私网地址';
  return '';
}

// 把一组候选折算为「严重度 + 原因」。判定优先级：
//   明文私网 host > 有 mDNS 遮蔽 host（策略未落地）> 公网 host / srflx > relay > 空集合
function judgeCandidates(list, glob) {
  const privHost = list.filter((c) => c.type === 'host' && c.priv && !c.mdns);
  const mdnsHost = list.filter((c) => c.type === 'host' && c.mdns);
  const pubHost = list.filter((c) => c.type === 'host' && !c.priv && !c.mdns);
  const srflx = list.filter((c) => c.type === 'srflx' || c.type === 'prflx');
  const relay = list.filter((c) => c.type === 'relay');

  if (privHost.length) {
    return { status: 'fail', reason: `出现 ${privHost.length} 条明文私网 host 候选，本机内网地址对该页面可见` };
  }
  if (!list.length) {
    return {
      status: glob ? 'pass' : 'info',
      reason: glob
        ? '0 条候选：disable_non_proxied_udp 已抑制全部非代理 UDP，页面拿不到任何本机地址（代价是此环境下 WebRTC 不可用）'
        : '0 条候选（全局开关关闭状态下的观测值）'
    };
  }
  if (mdnsHost.length) {
    return {
      status: glob ? 'warn' : 'info',
      reason: glob
        ? `仍有 ${mdnsHost.length} 条 mDNS 遮蔽的 host 候选 —— webRTCIPHandlingPolicy 未按预期抑制非代理 UDP`
        : `${mdnsHost.length} 条 host 候选已被 Chrome 默认的 mDNS 遮蔽（随机 .local 主机名，不含可路由的本机地址）`
    };
  }
  if (pubHost.length || srflx.length) {
    return { status: 'warn', reason: `出现公网类候选（host ${pubHost.length} 条 / srflx·prflx ${srflx.length} 条），公网出口对该页面可见` };
  }
  if (relay.length) {
    return { status: 'pass', reason: `仅 ${relay.length} 条 relay（中继）候选，本机地址未暴露` };
  }
  return { status: 'info', reason: `候选 ${list.length} 条，均为非 host 类型` };
}

// 轨 1：向所有已打开的 http/https 网页索取真实取样
async function probeOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); }
  catch (e) { return { error: '读取标签页失败：' + (e && e.message ? e.message : e) }; }
  const targets = tabs.filter((t) => /^https?:/i.test(t.url || '')).slice(0, 12);
  const results = [];
  for (const t of targets) {
    let data;
    try { data = await chrome.tabs.sendMessage(t.id, { __nonortc: 'iceProbe' }); }
    catch (e) { data = { error: '未取到内容脚本（页面尚未加载完成，或该页面不接受注入）' }; }
    results.push({ tab: t, data: data || {} });
  }
  return { tabs: targets, results };
}

function tabHost(url) {
  try { return new URL(url).host; } catch (e) { return url || '?'; }
}

// 轨 1 渲染
async function realWebrtcSection(glob) {
  const p = await probeOpenTabs();
  let h = '';
  if (p.error) return row('取样', 'info', p.error);
  if (!p.tabs.length) {
    return row('取样对象', 'info',
      '当前没有已打开的 http/https 网页可供取样。请先打开任意一个网页'
      + '（推荐 https://browserleaks.com/webrtc，或任意常用网站），回到本页后点上方「重新取样」。');
  }
  h += row('取样对象', 'info',
    `在 ${p.tabs.length} 个已打开网页上注入隔离世界探针取样（与页面同源同权限同网络栈，且原型链独立，页面脚本无法篡改）`);

  let leakTabs = 0, mdnsTabs = 0, emptyTabs = 0;
  for (const { tab, data } of p.results) {
    const host = tabHost(tab.url);
    if (data.error) { h += row(`网页 · ${host}`, 'info', data.error); continue; }
    const list = parseCandidates(data.cands);
    const j = judgeCandidates(list, glob);
    if (j.status === 'fail') leakTabs++;
    if (list.some((c) => c.type === 'host' && c.mdns)) mdnsTabs++;
    if (!list.length) emptyTabs++;
    h += row(`网页 · ${host}`, j.status, `${j.reason}（候选 ${list.length} 条）`);
    for (const c of list.filter((x) => x.type === 'host' && x.priv && !x.mdns)) {
      const hint = addrHint(c.addr);
      h += row('　└ 泄漏地址', 'fail', `${c.addr}:${c.port} [${c.transport}]${hint ? ' — ' + hint : ''}`);
    }
  }

  if (leakTabs) {
    h += row('泄漏判定（真实网页）', 'fail', `共 ${leakTabs} 个取样网页枚举到明文内网地址 —— 这些页面上本机地址可见`);
  } else {
    h += row('泄漏判定（真实网页）', 'pass',
      `在 ${p.tabs.length} 个取样网页上均未出现明文内网地址（其中 ${emptyTabs} 个为 0 候选）`);
  }
  if (glob && mdnsTabs) {
    h += row('策略落地核对', 'warn',
      `全局开关已开启，但仍有 ${mdnsTabs} 个网页拿到 mDNS 遮蔽的 host 候选，说明 webRTCIPHandlingPolicy 未被网络栈按预期执行。`
      + '请到 chrome://extensions 重新加载本扩展后，再点「重新取样」复测。');
  }
  if (!glob && mdnsTabs) {
    h += row('防护状态提示', 'info',
      '全局开关当前关闭：这些网页上的 host 候选只被 Chrome 自身的 mDNS 遮蔽（随机 .local 主机名）挡住真机地址。'
      + '该遮蔽由浏览器策略决定、并非本扩展提供，且不保证在所有来源状态下都生效；'
      + '若要确定性抑制，请开启全局开关（由 webRTCIPHandlingPolicy 接管）。');
  }
  if (glob && !leakTabs && emptyTabs) {
    h += row('可用性提示', 'info',
      `disable_non_proxied_udp 会在「无代理」环境下让 WebRTC 完全不可用（${emptyTabs} 个网页 0 候选）。`
      + '依赖 WebRTC 的站点（视频会议、网页实时通信）可能因此无法建连；如需两者兼顾，请在代理侧提供 UDP 转发后再选用该策略。');
  }
  return h;
}

// 轨 2：扩展页自身枚举（仅作对照，不参与判定）
function extIceProbe() {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection !== 'function') { resolve({ cands: [], error: '浏览器无 RTCPeerConnection' }); return; }
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [] }); }
    catch (e) { resolve({ cands: [], error: 'RTCPeerConnection 创建失败: ' + e.message }); return; }
    const cands = [];
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      try { pc.close(); } catch (e) {}
      resolve({ cands, error: error || null });
    };
    pc.onicecandidate = (e) => { if (!e.candidate) { finish(); return; } cands.push(e.candidate.candidate); };
    try {
      pc.createDataChannel('');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => finish('offer 失败: ' + e.message));
    } catch (e) { finish(e.message); }
    setTimeout(() => finish(cands.length ? null : ''), 3500);
  });
}

async function extWebrtcSection() {
  const r = await extIceProbe();
  let h = '';
  h += noteRow('以下候选取自本扩展页自身（chrome-extension:// 特权来源）。实测（Chrome 154，有头 / 无头一致）：'
    + '该来源既不施加 mDNS 主机名遮蔽，也不施加 webRTCIPHandlingPolicy，因此无论策略如何设置，扩展页恒能枚举到明文内网地址。'
    + '这是浏览器对该来源的行为，既不代表防护失效，也不代表普通网页会泄漏 —— 本段仅作对照，不参与判定。');
  if (r.error) h += row('扩展页枚举', 'info', r.error);
  const list = parseCandidates(r.cands);
  if (!list.length && !r.error) {
    h += row('扩展页候选', 'info', '未枚举到候选（在特权来源上较为少见，通常意味着浏览器策略在该来源上也被应用）');
  }
  for (const c of list) {
    const hint = addrHint(c.addr);
    h += row('ICE 候选（扩展页）', 'info',
      `${c.type} | ${c.addr}:${c.port} | transport=${c.transport}` + (hint ? ` — ${hint}` : ''));
  }
  const netIds = new Set();
  for (const raw of r.cands) { const m = String(raw).match(/network-id (\d+)/); if (m) netIds.add(m[1]); }
  if (netIds.size) {
    h += row('参与 ICE 的网卡数', 'info',
      `${netIds.size} 张（network-id: ${[...netIds].join(', ')}）—— 含虚拟网卡；该字段只对特权来源可见，普通网页拿不到`);
  }
  return h;
}

/* ============ 5. 外部复核站点 ============ */

const EXTERNAL_SITES = {
  openTzLang: 'https://browserleaks.com/javascript',
  openIpTz: 'https://browserleaks.com/ip',
  openDnsLeak: 'https://dnsleaktest.com/',
  openBlDns: 'https://browserleaks.com/dns',
  openClaudeIp: 'https://ip.net.coffee/claude/',
  openWebrtc: 'https://browserleaks.com/webrtc',
  openWebrtc2: 'https://browserleaks.com/webrtc'
};

function bindOpen(id, url) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', () => {
    try {
      const p = chrome.tabs.create({ url });
      if (p && typeof p.catch === 'function') p.catch(() => window.open(url, '_blank'));
    } catch (e) { window.open(url, '_blank'); }
  });
}

/* ============ 6. 主流程 ============ */

let STORE = {};

async function main() {
  // 存储读取失败不应让整页停摆
  try {
    STORE = await chrome.storage.local.get(['globalEnabled', 'proxyTimezone', 'language', 'geoMode', 'geoCoords', 'siteSettings']);
  } catch (e) {
    banner('读取 chrome.storage 失败：' + (e && e.message ? e.message : e));
    STORE = {};
  }
  const expectedTZ = STORE.proxyTimezone || 'UTC';
  const expectedLang = STORE.language || 'en-US';
  const glob = !!STORE.globalEnabled;

  // ① 全局策略
  await runSection('policyTable', '全局策略', async () => {
    let h = '';
    h += row('全局开关', glob ? 'pass' : 'fail', glob ? '已开启' : '已关闭（真实IP/DNS 防护不生效）');
    const policy = await new Promise((res) => {
      chrome.privacy.network.webRTCIPHandlingPolicy.get({}, (d) => res(d ? d.value : null));
    });
    let polStatus = 'info';
    let polMsg = `当前值=${policy === null ? 'N/A' : policy}`;
    if (policy === 'disable_non_proxied_udp') {
      polStatus = glob ? 'pass' : 'info';
      polMsg += '（最强：抑制全部非代理 UDP，页面 0 候选；代价是无代理环境下 WebRTC 不可用）';
    } else if (policy === 'default_public_interface_only') {
      polStatus = glob ? 'pass' : 'info';
      polMsg += '（丢弃私网地址，仅保留公网接口 —— 内网拓扑不泄漏，但公网出口地址对页面可见）';
    } else if (policy === 'default') {
      polStatus = glob ? 'fail' : 'info';
      polMsg += glob
        ? '（全局已开启却回落到 default：本机地址仅靠 Chrome 自身 mDNS 遮蔽，非本扩展提供，不保证在所有来源状态下生效）'
        : '（全局关闭时的预期值）';
    } else {
      polStatus = 'warn';
      polMsg += '（非选项页提供的取值，请在「高级设置」中重新选择）';
    }
    h += row('WebRTC IP 策略', polStatus, polMsg);
    const npe = await new Promise((res) => {
      chrome.privacy.network.networkPredictionEnabled.get({}, (d) => res(d ? d.value : null));
    });
    h += row('网络预测（DNS 探测）', npe === false ? 'pass' : 'fail',
      `当前值=${npe === null ? 'N/A' : npe}（期望 false）`);
    return h;
  });

  // ② DNR 规则
  await runSection('dnrTable', '语言请求头规则', async () => {
    try {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const r1 = rules.find((r) => r.id === 1 && r.action && r.action.type === 'modifyHeaders');
      if (r1) {
        const hdr = (r1.action.requestHeaders || []).find((h) => /accept-language/i.test(h.header));
        return row('改写 Accept-Language', hdr ? 'pass' : 'fail',
          hdr ? `规则#1 已生效，注入值: ${hdr.value}` : '规则存在但未改 accept-language');
      }
      return row('改写 Accept-Language', glob ? 'fail' : 'warn',
        glob ? '规则#1 缺失（语言头未改写）' : '全局关闭，未注入改写规则（符合预期）');
    } catch (e) {
      return row('改写 Accept-Language', 'fail', '读取失败: ' + e.message);
    }
  });

  // ③ 覆盖逻辑
  await runSection('spoofTable', '覆盖逻辑复刻', async () => {
    let h = '';
    if (!isValidTZ(expectedTZ)) {
      h += errorRow(`存储中的「代理时区」不是合法 IANA 时区名：${expectedTZ}。`
        + '覆盖逻辑无法构造 Intl.DateTimeFormat（会抛 RangeError），因此本项无法验证。'
        + '请到「高级设置」重新选择一个合法时区（如 America/New_York）后重跑本页。');
      h += noteRow(`存储快照：globalEnabled=${glob} / proxyTimezone=${expectedTZ} / language=${expectedLang} / geoMode=${STORE.geoMode || 'spoof'}`);
      return h;
    }
    const obs = applySpoofAndRead(expectedTZ, expectedLang);
    const expOff = -tzOffsetMinutes(new Date(), expectedTZ);
    h += row('IANA 时区名', obs.tzName === expectedTZ ? 'pass' : 'fail', `观测=${obs.tzName} / 期望=${expectedTZ}`);
    h += row('getTimezoneOffset', obs.off === expOff ? 'pass' : 'fail', `观测=${obs.off} / 期望=${expOff}`);
    h += row('Date.toString', obs.str.includes(obs.gmt) ? 'pass' : 'fail', `GMT 串=${obs.gmt} | ${obs.str}`);
    h += row('Temporal 时区', /不支持|ERR/.test(obs.temporalId) ? 'info' : (obs.temporalId === expectedTZ ? 'pass' : 'fail'), obs.temporalId);
    h += row('Intl 默认区域', obs.locale === expectedLang ? 'pass' : 'fail', `观测=${obs.locale} / 期望=${expectedLang}（宿主真实区域泄漏点）`);
    h += row('toLocaleString 排版', obs.localeStr ? 'pass' : 'fail', obs.localeStr);
    h += row('navigator.language', obs.lang === expectedLang ? 'pass' : 'fail', `观测=${obs.lang} / 期望=${expectedLang}`);
    h += row('navigator.languages', obs.langs.startsWith(expectedLang) ? 'pass' : 'fail', obs.langs);

    // 回归项：覆盖不得改变 Invalid Date 的原生语义（原生不抛错，返回 "Invalid Date" 与 NaN）。
    // 依据 ECMA-262：Date.prototype.toString 对 NaN 时间值返回 "Invalid Date"；
    // 而 ECMA-402 的 Intl.DateTimeFormat.prototype.formatToParts 对非有限时间值抛 RangeError。
    const okInvalid = !obs.invalidThrew && obs.invalidStr === 'Invalid Date' && obs.invalidOff === 'NaN';
    h += row('无效日期透传', okInvalid ? 'pass' : 'fail',
      okInvalid ? `new Date(NaN).toString()="${obs.invalidStr}"、getTimezoneOffset()=${obs.invalidOff}，与原生一致`
        : `覆盖破坏了原生语义：${obs.invalidThrew ? '抛错 ' + obs.invalidStr
          : `toString="${obs.invalidStr}" / getTimezoneOffset()=${obs.invalidOff}`}`);

    // Geolocation：复刻覆盖语义（不调用真实 API，避免产生 chrome://extensions 告警）
    const gc = geoReplicaCheck(STORE.geoMode || 'spoof', expectedTZ, STORE.geoCoords);
    if (gc.mode === 'spoof') {
      const fromCfg = !!(STORE.geoCoords && typeof STORE.geoCoords.lat === 'number' && typeof STORE.geoCoords.lng === 'number');
      const ok = gc.calls.success === 1 && gc.calls.error === 0 && !!gc.got
        && gc.got.coords.latitude === gc.expected.lat && gc.got.coords.longitude === gc.expected.lng;
      h += row('Geolocation 覆盖复刻', ok ? 'pass' : 'fail',
        ok ? `spoof 模式：同步回调成功，lat=${gc.got.coords.latitude.toFixed(4)}, lng=${gc.got.coords.longitude.toFixed(4)}`
          + `（坐标来源：${fromCfg ? '设置页配置的坐标' : `按代理时区 ${expectedTZ} 取区域默认坐标`}），accuracy=${gc.got.coords.accuracy}`
          : `spoof 模式应同步回调成功坐标，实测 success=${gc.calls.success} / error=${gc.calls.error}`);
    } else {
      const ok = gc.calls.error === 1 && gc.calls.success === 0 && !!gc.gotErr && gc.gotErr.code === 1;
      h += row('Geolocation 覆盖复刻', ok ? 'pass' : 'fail',
        ok ? 'deny 模式：同步回调 code 1（PERMISSION_DENIED），success 未被调用'
          : `deny 模式应回调 code 1，实测 success=${gc.calls.success} / error=${gc.calls.error}`);
    }
    h += noteRow('说明：本行是「复刻覆盖语义」的结果（在内存里驱动一遍回调），不是真实网页上的观测；'
      + '且刻意不调用真实 navigator.geolocation —— 本扩展不声明 geolocation 权限，'
      + '扩展页调用按官方文档只会以 code 1 立即失败，并使 Chrome 记一条 warning 级告警，对判定没有信息量。'
      + '普通网页上的实际坐标请在第⑤项外部站点复核。');

    const wr = await testWorkerRealm();
    h += row('Worker realm（盲区）', wr.status, wr.msg);
    if (typeof Temporal === 'undefined') h += noteRow('当前浏览器未启用 Temporal，相关向量不参与判定。');
    h += noteRow(`存储快照：globalEnabled=${glob} / proxyTimezone=${expectedTZ} / language=${expectedLang} / geoMode=${STORE.geoMode || 'spoof'}`);
    return h;
  });

  // ④a WebRTC —— 真实网页实测（唯一有证据力的判定轨）
  await runSection('webrtcRealTable', '真实网页 ICE 取样', () => realWebrtcSection(glob));

  // ④b WebRTC —— 扩展页对照（特权来源，不参与判定）
  await runSection('webrtcTable', '扩展页 ICE 对照', extWebrtcSection);
}

for (const id of Object.keys(EXTERNAL_SITES)) bindOpen(id, EXTERNAL_SITES[id]);

const rerun = document.getElementById('rerun');
if (rerun) rerun.addEventListener('click', () => location.reload());

// 「重新取样」：只重跑真实网页那一轨，避免整页刷新后仍需等待其余卡片
const reprobe = document.getElementById('probeTabs');
if (reprobe) {
  reprobe.addEventListener('click', async () => {
    const glob = !!STORE.globalEnabled;
    STATE.pending.add('webrtcRealTable');
    setCell('webrtcRealTable', noteRow('正在取样…'));
    await runSection('webrtcRealTable', '真实网页 ICE 取样', () => realWebrtcSection(glob));
  });
}

main().catch((e) => {
  banner('自检主流程异常终止：' + (e && e.message ? e.message : e));
  for (const id of Array.from(STATE.pending)) {
    setCell(id, errorRow('主流程异常终止：' + (e && e.message ? e.message : e)));
    STATE.pending.delete(id);
  }
});
