// nonortc geo-IP 探测模块（多源回退，options 页与 background service worker 共用）
// 职责：探测「当前出口 IP」的 IANA 时区与坐标。请求由浏览器网络栈发出，
// 因此走的是当前代理配置的出口 —— 探测到的即代理出口的时区。
// 单一数据源易因限流/风控返回 403（如 ipapi.co），故按顺序多源回退。

(function (root) {
  'use strict';

  const TIMEOUT_MS = 5000;
  const CHINA = /^(CN|CHN|China|中国|中国大陆)$/i;

  // 各数据源：url + 把响应规整为统一结构
  const PROVIDERS = [
    {
      name: 'ipwho.is',
      url: 'https://ipwho.is/',
      pick: (d) => (d && d.success !== false && d.timezone && d.timezone.id) ? {
        timezone: d.timezone.id, lat: d.latitude, lng: d.longitude,
        ip: d.ip, city: d.city, country: d.country
      } : null
    },
    {
      name: 'ipapi.co',
      url: 'https://ipapi.co/json/',
      pick: (d) => (d && !d.error && d.timezone) ? {
        timezone: d.timezone, lat: d.latitude, lng: d.longitude,
        ip: d.ip, city: d.city, country: d.country_name
      } : null
    },
    {
      name: 'ipinfo.io',
      url: 'https://ipinfo.io/json',
      pick: (d) => {
        if (!d || !d.timezone) return null;
        const loc = String(d.loc || '').split(',');
        return {
          timezone: d.timezone,
          lat: loc[0] ? parseFloat(loc[0]) : undefined,
          lng: loc[1] ? parseFloat(loc[1]) : undefined,
          ip: d.ip, city: d.city, country: d.country
        };
      }
    },
    {
      name: 'api.ip.sb',
      url: 'https://api.ip.sb/geoip',
      pick: (d) => (d && d.timezone) ? {
        timezone: d.timezone, lat: d.latitude, lng: d.longitude,
        ip: d.ip, city: d.city, country: d.country
      } : null
    },
    {
      name: 'worldtimeapi.org',
      url: 'https://worldtimeapi.org/api/ip',
      pick: (d) => (d && d.timezone) ? { timezone: d.timezone } : null
    }
  ];

  // 校验是否为合法 IANA 时区名
  function isValidTimezone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
    catch (e) { return false; }
  }

  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
    try {
      const resp = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // 依次尝试各数据源，返回首个成功且时区合法的结果
  async function detect(options) {
    const opts = options || {};
    const errors = [];
    for (const p of PROVIDERS) {
      try {
        const data = await fetchJson(p.url, opts.timeoutMs);
        const info = p.pick(data);
        if (info && isValidTimezone(info.timezone)) {
          info.provider = p.name;
          // 外部数据源不可信：坐标除有限性外还需校验取值范围，
          // 否则越界值会直接写入 chrome.storage 并作为伪造坐标返回给站点。
          const okLat = (v) => typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90;
          const okLng = (v) => typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180;
          info.lat = okLat(info.lat) ? info.lat : null;
          info.lng = okLng(info.lng) ? info.lng : null;
          info.isChina = CHINA.test(String(info.country || '').trim());
          return info;
        }
        errors.push(p.name + ': 响应中无有效时区');
      } catch (e) {
        errors.push(p.name + ': ' + (e && e.message ? e.message : String(e)));
      }
    }
    const err = new Error('全部 geo-IP 数据源均失败');
    err.details = errors;
    throw err;
  }

  root.NonortcGeo = {
    detect: detect,
    isValidTimezone: isValidTimezone,
    providerNames: PROVIDERS.map((p) => p.name)
  };
})(typeof self !== 'undefined' ? self : this);
