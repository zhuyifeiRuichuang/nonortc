// nonortc content script — 主世界（MAIN world，document_start）
// 职责：对当前页面覆盖 时区 / 语言 / 地理定位，使其匹配代理出口，
// 阻止网站获取宿主机的真实时区、语言环境与物理位置。
// 覆盖函数只安装一次，实际值通过闭包变量实时切换，支持运行时开关而不重复包装。
//
// 重要（Chrome 官方约束）：注入到主世界的内容脚本与宿主网页共享同一 JS 执行环境，
// 因此**没有**扩展 API（chrome.storage / chrome.runtime 均不可用）。
// 配置由隔离世界脚本 content-bridge.js 读取后经 window.postMessage 下发
// （官方文档：内容脚本与网页跨世界通信必须通过共享 DOM / window.postMessage）。
//
// ⚠ 安全边界（必须知悉，勿再假设 token 不可窃取）：
// Chrome 官方在 content_scripts 文档中明确警告——「使用 "MAIN" 环境存在风险。
// 托管页面可以访问和干扰注入的脚本。」（https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts）
// 实测（Chrome 154）已证实两件事：
//   1. 本脚本用 postMessage(token) 广播握手，而 postMessage 是异步任务派发，
//      页面在 <head> 里的内联脚本仍能在该任务被派发前注册监听并截获 token，
//      随后自行 postMessage({active:false}) 即可让本扩展的防护整体降级。
//   2. Web Worker / SharedWorker / Worklet / 页面 Service Worker 属于独立 realm，
//      内容脚本不会注入，其中的时区与语言是宿主机真实值。
// 因此：本扩展防护的是「不做对抗的常规站点」，不能对抗主动绕过的站点。
// token 机制的价值仅在于防止网页**误触**，不构成安全边界。

(function () {
  // ---- 运行时状态（由配置更新）----
  let ACTIVE = false;          // 当前站点是否启用防护
  let CURRENT_TZ = 'UTC';
  let CURRENT_LANG = 'en-US';
  let GEO_MODE = 'spoof';
  let GEO_COORDS = null;

  // ---- 捕获真实实现，用于未启用防护时透传 ----
  const REAL_TZ_OFFSET = Date.prototype.getTimezoneOffset;
  const REAL_DTF = Intl.DateTimeFormat;
  const REAL_LANG_DESC = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');
  const REAL_LANGS_DESC = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
  const REAL_GEO = navigator.geolocation;

  function realLanguage() {
    try {
      if (REAL_LANG_DESC && REAL_LANG_DESC.get) return REAL_LANG_DESC.get.call(navigator);
    } catch (e) {}
    return 'en-US';
  }
  function realLanguages() {
    try {
      if (REAL_LANGS_DESC && REAL_LANGS_DESC.get) return REAL_LANGS_DESC.get.call(navigator);
    } catch (e) {}
    return ['en-US', 'en'];
  }

  // 调用方未显式指定 locales 时，统一回落到代理语言。
  // 依据：navigator.language 只是 JS 属性；Intl.* 与 *toLocale* 的「默认区域」
  // 取自浏览器/操作系统区域设置，不随 navigator.language 改变。
  function intlLocales(locales) {
    return (locales === undefined || locales === null) ? CURRENT_LANG : locales;
  }

  // 复制静态方法（如 supportedLocalesOf），保持包装后的 Intl 构造器行为完整
  function copyStatics(Orig, Wrapped) {
    try {
      for (const k of Object.getOwnPropertyNames(Orig)) {
        if (k === 'length' || k === 'name' || k === 'prototype') continue;
        Object.defineProperty(Wrapped, k, Object.getOwnPropertyDescriptor(Orig, k));
      }
    } catch (e) {}
  }

  // 计算某 IANA 时区相对 UTC 的偏移分钟数（与 Date.getTimezoneOffset 同语义：UTC - 本地）
  function tzOffsetMinutes(date, tz) {
    const dtf = new REAL_DTF('en-US', {
      timeZone: tz, hour12: false, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  }

  function defaultCoords(tz) {
    const map = {
      'America': { lat: 40.7128, lng: -74.0060 },
      'Europe': { lat: 48.8566, lng: 2.3522 },
      'Asia': { lat: 35.6895, lng: 139.6917 },
      'Africa': { lat: 6.5244, lng: 3.3792 },
      'Australia': { lat: -33.8688, lng: 151.2093 }
    };
    const region = (tz.split('/')[0] || 'America');
    return map[region] || { lat: 40.7128, lng: -74.0060 };
  }

  // ---- 安装覆盖（仅一次）----
  function install() {
    try {
      Date.prototype.getTimezoneOffset = function () {
        if (!ACTIVE) return REAL_TZ_OFFSET.call(this);
        return -tzOffsetMinutes(this, CURRENT_TZ);
      };
    } catch (e) {}

    // ---- Intl 默认区域（locale）伪装 ----
    // 实测（Chrome 154，防护开启）：Intl.DateTimeFormat().resolvedOptions().locale
    // 仍返回宿主机区域（如 zh-CN），日期也按 zh-CN 排版（"2026年10月9日星期五"），
    // 与已伪装的 navigator.language=en-US 自相矛盾 —— 属真实语言环境泄漏。
    // 故：调用方未传 locales 时注入 CURRENT_LANG；DateTimeFormat 额外补 timeZone。
    try {
      const WrappedDTF = function (locales, options) {
        if (!ACTIVE) return new REAL_DTF(locales, options);
        if (options == null) options = { timeZone: CURRENT_TZ };
        else if (!('timeZone' in options)) options = Object.assign({}, options, { timeZone: CURRENT_TZ });
        return new REAL_DTF(intlLocales(locales), options);
      };
      WrappedDTF.prototype = REAL_DTF.prototype;
      copyStatics(REAL_DTF, WrappedDTF);
      // 保留原生函数名：包装函数默认 name 为 "WrappedDTF"，
      // Intl.DateTimeFormat.name 一旦暴露，站点即可据此判定"装了伪造扩展"。
      try { Object.defineProperty(WrappedDTF, 'name', { value: 'DateTimeFormat', configurable: true }); } catch (e) {}
      Intl.DateTimeFormat = WrappedDTF;

      // 其余 Intl 构造器：仅注入默认区域（本扩展不涉及它们的时区语义）
      const INTL_CTORS = ['NumberFormat', 'Collator', 'RelativeTimeFormat',
        'ListFormat', 'DisplayNames', 'Segmenter', 'PluralRules'];
      for (const name of INTL_CTORS) {
        const Orig = Intl[name];
        if (typeof Orig !== 'function') continue;
        const Wrapped = function (locales, options) {
          if (!ACTIVE) return new Orig(locales, options);
          return new Orig(intlLocales(locales), options);
        };
        Wrapped.prototype = Orig.prototype;
        copyStatics(Orig, Wrapped);
        try { Object.defineProperty(Wrapped, 'name', { value: name, configurable: true }); } catch (e) {}
        Intl[name] = Wrapped;
      }
    } catch (e) {}

    try {
      // 调用方已显式指定 timeZone 时予以尊重：此时不涉及宿主机时区，不会泄漏真实值，
      // 且能避免破坏「按指定时区展示」的正常业务（如航班/会议站点）。
      const withTZ = (o) => (o && typeof o === 'object' && 'timeZone' in o)
        ? o : Object.assign({}, o, { timeZone: CURRENT_TZ });

      const _toLocaleString = Date.prototype.toLocaleString;
      Date.prototype.toLocaleString = function (l, o) {
        if (!ACTIVE) return _toLocaleString.call(this, l, o);
        return _toLocaleString.call(this, intlLocales(l), withTZ(o));
      };
      const _toLocaleDateString = Date.prototype.toLocaleDateString;
      Date.prototype.toLocaleDateString = function (l, o) {
        if (!ACTIVE) return _toLocaleDateString.call(this, l, o);
        return _toLocaleDateString.call(this, intlLocales(l), withTZ(o));
      };
      const _toLocaleTimeString = Date.prototype.toLocaleTimeString;
      Date.prototype.toLocaleTimeString = function (l, o) {
        if (!ACTIVE) return _toLocaleTimeString.call(this, l, o);
        return _toLocaleTimeString.call(this, intlLocales(l), withTZ(o));
      };
    } catch (e) {}

    // 数字 / 数组 / 字符串比较 / Temporal 的默认区域同样取自 OS 区域设置，一并注入代理语言，
    // 避免与 navigator.language 出现「en-US 却按 zh-CN 排版」的矛盾指纹。
    try {
      const _numToLocale = Number.prototype.toLocaleString;
      Number.prototype.toLocaleString = function (l, o) {
        if (!ACTIVE) return _numToLocale.call(this, l, o);
        return _numToLocale.call(this, intlLocales(l), o);
      };
      if (typeof BigInt !== 'undefined' && BigInt.prototype && typeof BigInt.prototype.toLocaleString === 'function') {
        const _bigToLocale = BigInt.prototype.toLocaleString;
        BigInt.prototype.toLocaleString = function (l, o) {
          if (!ACTIVE) return _bigToLocale.call(this, l, o);
          return _bigToLocale.call(this, intlLocales(l), o);
        };
      }
      const _arrToLocale = Array.prototype.toLocaleString;
      Array.prototype.toLocaleString = function (l, o) {
        if (!ACTIVE) return _arrToLocale.call(this, l, o);
        return _arrToLocale.call(this, intlLocales(l), o);
      };
      const _localeCompare = String.prototype.localeCompare;
      String.prototype.localeCompare = function (that, l, o) {
        if (!ACTIVE) return _localeCompare.call(this, that, l, o);
        return _localeCompare.call(this, that, intlLocales(l), o);
      };
      if (typeof Temporal !== 'undefined') {
        const TPROTO = ['PlainDate', 'PlainTime', 'PlainDateTime', 'ZonedDateTime',
          'Instant', 'PlainYearMonth', 'PlainMonthDay', 'Duration'];
        for (const name of TPROTO) {
          const C = Temporal[name];
          if (!C || !C.prototype || typeof C.prototype.toLocaleString !== 'function') continue;
          const orig = C.prototype.toLocaleString;
          Object.defineProperty(C.prototype, 'toLocaleString', {
            configurable: true, writable: true,
            value: function (l, o) {
              if (!ACTIVE) return orig.call(this, l, o);
              return orig.call(this, intlLocales(l), o);
            }
          });
        }
      }
    } catch (e) {}

    // Date 字符串系列：原生 toString/toTimeString 会原样泄露宿主机的
    // GMT 偏移与区域缩写（如 "GMT+0800 (China Standard Time)"），是经典的
    // 时区泄漏向量。需与 getTimezoneOffset / Intl 保持一致地重写为代理时区。
    try {
      const REAL_TO_STRING = Date.prototype.toString;
      const REAL_TO_TIME_STRING = Date.prototype.toTimeString;
      const REAL_TO_DATE_STRING = Date.prototype.toDateString;

      function zoneAbbr(date) {
        try {
          const dtf = new REAL_DTF('en-US', { timeZone: CURRENT_TZ, timeZoneName: 'short' });
          const part = dtf.formatToParts(date).find((p) => p.type === 'timeZoneName');
          return part ? part.value : '';
        } catch (e) { return ''; }
      }
      function tzParts(date) {
        const dtf = new REAL_DTF('en-US', {
          timeZone: CURRENT_TZ, hour12: false, hourCycle: 'h23',
          weekday: 'short', year: 'numeric', month: 'short',
          day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const parts = {};
        for (const part of dtf.formatToParts(date)) parts[part.type] = part.value;
        const offMin = -tzOffsetMinutes(date, CURRENT_TZ); // 与 getTimezoneOffset 同值
        const gmtOff = -offMin; // GMT 串符号与其相反：getTZOffset=+300 ↔ GMT-0500
        const sign = gmtOff >= 0 ? '+' : '-';
        const abs = Math.abs(gmtOff);
        const gmt = `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
        return {
          wd: parts.weekday, mon: parts.month, day: parts.day, yr: parts.year,
          h: parts.hour, m: parts.minute, s: parts.second, gmt, abbr: zoneAbbr(date)
        };
      }

      Date.prototype.toString = function () {
        if (!ACTIVE) return REAL_TO_STRING.call(this);
        const p = tzParts(this);
        return `${p.wd} ${p.mon} ${p.day} ${p.yr} ${p.h}:${p.m}:${p.s} ${p.gmt} (${p.abbr})`;
      };
      Date.prototype.toTimeString = function () {
        if (!ACTIVE) return REAL_TO_TIME_STRING.call(this);
        const p = tzParts(this);
        return `${p.h}:${p.m}:${p.s} ${p.gmt} (${p.abbr})`;
      };
      Date.prototype.toDateString = function () {
        if (!ACTIVE) return REAL_TO_DATE_STRING.call(this);
        const p = tzParts(this);
        return `${p.wd} ${p.mon} ${p.day} ${p.yr}`;
      };
    } catch (e) {}

    try {
      Object.defineProperty(Navigator.prototype, 'language', {
        configurable: true,
        get() { return ACTIVE ? CURRENT_LANG : realLanguage(); }
      });
      Object.defineProperty(Navigator.prototype, 'languages', {
        configurable: true,
        get() { return ACTIVE ? [CURRENT_LANG, CURRENT_LANG.split('-')[0] || 'en'] : realLanguages(); }
      });
    } catch (e) {}

    try {
      if (REAL_GEO) {
        // 必须先保存原生实现：未启用防护时要原样透传，否则站点的定位请求会
        // 「既不成功也不失败」地永久挂起（实测确认：success/error 均不触发）。
        const REAL_GEO_GET = REAL_GEO.getCurrentPosition;
        const REAL_GEO_WATCH = REAL_GEO.watchPosition;
        const successObj = () => {
          const c = (GEO_COORDS && typeof GEO_COORDS.lat === 'number')
            ? GEO_COORDS : defaultCoords(CURRENT_TZ);
          return {
            coords: {
              latitude: c.lat, longitude: c.lng,
              accuracy: 100, altitude: null, altitudeAccuracy: null,
              heading: null, speed: null
            },
            timestamp: Date.now()
          };
        };
        const denyObj = { code: 1, PERMISSION_DENIED: 1, message: 'User denied Geolocation' };

        REAL_GEO.getCurrentPosition = function (success, error, options) {
          if (!ACTIVE) return REAL_GEO_GET.call(this, success, error, options);
          if (GEO_MODE === 'spoof') { if (success) success(successObj()); }
          else if (error) error(denyObj);
        };
        REAL_GEO.watchPosition = function (success, error, options) {
          if (!ACTIVE) return REAL_GEO_WATCH.call(this, success, error, options);
          if (GEO_MODE === 'spoof') { if (success) success(successObj()); return 0; }
          if (error) error(denyObj);
          return 0;
        };
      }
    } catch (e) {}

    // Temporal API 覆盖。
    // 注意接口已随规范收敛：最终版规范用 Temporal.Now.timeZoneId()（返回 IANA 名字符串），
    // 早期草案为 Temporal.Now.timeZone()（返回 Temporal.TimeZone 对象）。
    // 实测 Chrome 154：timeZone 已被移除、timeZoneId() 存在且返回宿主机真实时区，
    // 故两种接口都要处理，并让 zonedDateTimeISO/plainDateTimeISO 等在无参时注入代理时区。
    try {
      if (typeof Temporal !== 'undefined' && Temporal.Now) {
        const NOW = Temporal.Now;

        if (typeof NOW.timeZoneId === 'function') {
          const ORIG_TZID = NOW.timeZoneId;
          Object.defineProperty(NOW, 'timeZoneId', {
            configurable: true, writable: true,
            value: function () { return ACTIVE ? CURRENT_TZ : ORIG_TZID.call(NOW); }
          });
        }
        if (typeof NOW.timeZone === 'function') {
          const ORIG_TZ = NOW.timeZone;
          Object.defineProperty(NOW, 'timeZone', {
            configurable: true, writable: true,
            value: function () {
              if (!ACTIVE) return ORIG_TZ.call(NOW);
              try {
                return (typeof Temporal.TimeZone === 'function')
                  ? new Temporal.TimeZone(CURRENT_TZ) : undefined;
              } catch (e) { return undefined; }
            }
          });
        }

        const injectTZ = (orig) => function (...args) {
          if (!ACTIVE) return orig.apply(NOW, args);
          if (args.length === 0) return orig.call(NOW, CURRENT_TZ); // 默认时区参数注入代理时区
          return orig.apply(NOW, args);
        };
        for (const name of ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO']) {
          const orig = NOW[name];
          if (typeof orig !== 'function') continue;
          Object.defineProperty(NOW, name, { configurable: true, writable: true, value: injectTZ(orig) });
        }
      }
    } catch (e) {}
  }

  // ---- 与隔离世界桥接脚本（content-bridge.js）通信 ----
  // 主世界无扩展 API，配置必须由隔离世界经 window.postMessage 下发。
  // 随机一次性 token 用于校验下发来源，防止网页脚本伪造「关闭防护」指令。
  const TOKEN = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2);

  let configured = false;

  function applyPayload(p) {
    ACTIVE = !!p.active;
    CURRENT_TZ = p.tz || 'UTC';
    CURRENT_LANG = p.lang || 'en-US';
    GEO_MODE = p.geoMode === 'deny' ? 'deny' : 'spoof';
    GEO_COORDS = (p.coords && typeof p.coords.lat === 'number' && typeof p.coords.lng === 'number')
      ? { lat: p.coords.lat, lng: p.coords.lng }
      : null;
    configured = true;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.token !== TOKEN) return; // 非本扩展下发，忽略
    if (d.__nonortc === 'config' && d.payload) applyPayload(d.payload);
  });

  function handshake() {
    try { window.postMessage({ __nonortc: 'nonortc-whoami', token: TOKEN }, '*'); } catch (e) {}
  }

  install();
  handshake();

  // 桥接脚本与主世界脚本同属 document_start 阶段注入，但两世界注入顺序无官方保证。
  // 若首发握手未被收到，做少量短延时重试；一旦拿到配置即停止（storage 变更由桥接脚本推送）。
  const RETRY_MS = [10, 30, 80, 200, 500];
  let retry = 0;
  (function schedule() {
    if (configured || retry >= RETRY_MS.length) return;
    setTimeout(() => {
      if (configured) return;
      handshake();
      retry++;
      schedule();
    }, RETRY_MS[retry]);
  })();
})();
