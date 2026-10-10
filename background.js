// nonortc background service worker (Manifest V3)
// 职责：
// 1. 通过 chrome.privacy 全局强制 WebRTC / 网络预测 防护（真实IP / DNS 泄漏防护）
// 2. 通过 chrome.declarativeNetRequest 动态规则改写 Accept-Language（语言环境防护）
// 3. 监听配置变化并实时应用
// 4. 可选的「自动匹配代理时区」：按当前出口 IP 探测时区并定时校正

importScripts('geoip.js');

const DEFAULTS = {
  globalEnabled: false,
  siteSettings: {},          // host -> false 表示对该站点关闭防护（其余默认开启）
  proxyTimezone: 'America/New_York',
  webrtcPolicy: 'disable_non_proxied_udp',
  geoMode: 'spoof',          // spoof | deny
  geoCoords: null,           // {lat, lng} 可选，留空则按代理时区地区取默认坐标
  language: 'en-US',
  autoDetectTimezone: false  // 开启后按出口 IP 自动匹配时区（联网探测，默认关闭）
};

const KEYS = Object.keys(DEFAULTS);

const ACCEPT_LANG = {
  'en-US': 'en-US,en;q=0.9',
  'en-GB': 'en-GB,en;q=0.9',
  'en': 'en,en-US;q=0.9'
};

// 站点例外键来自 location.hostname（用户可控、且可能来自 URL 解析），
// 送入 DNR 的 requestDomains / excludedRequestDomains 前必须校验：
// 非法域名会让整次 updateDynamicRules 失败，导致语言防护全部失效。
function validDomain(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 253
    && /^[a-z0-9.\-_]+$/i.test(h);
}

// geo-IP 数据源是外部不可信服务，坐标必须做取值范围校验
function validCoords(c) {
  return !!c && typeof c.lat === 'number' && isFinite(c.lat) && Math.abs(c.lat) <= 90
    && typeof c.lng === 'number' && isFinite(c.lng) && Math.abs(c.lng) <= 180;
}

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
  'websocket', 'webtransport', 'other'
];

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(KEYS);
  const merged = Object.assign({}, DEFAULTS, stored);
  await chrome.storage.local.set(merged);
  await applyAll(merged);
  if (merged.autoDetectTimezone) autoMatchTimezone();
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await chrome.storage.local.get(KEYS);
  const merged = Object.assign({}, DEFAULTS, settings);
  await applyAll(merged);
  if (merged.autoDetectTimezone) autoMatchTimezone();
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(KEYS).then(applyAll).catch(() => {});
});

async function applyAll(settings) {
  await applyPrivacy(settings);
  await applyDNR(settings);
  await manageTimezoneAlarm(settings);
}

// ---- 自动匹配代理时区（可选，联网探测出口 IP 的时区/坐标）----
const TZ_ALARM = 'nonortc-tz-match';

async function manageTimezoneAlarm(settings) {
  try {
    if (settings.autoDetectTimezone) {
      // 每小时按当前出口 IP 校正一次（切换代理节点后自动跟上）
      await chrome.alarms.create(TZ_ALARM, { periodInMinutes: 60, delayInMinutes: 1 });
    } else {
      await chrome.alarms.clear(TZ_ALARM);
    }
  } catch (e) {
    console.error('[nonortc] alarm manage failed:', e);
  }
}

async function autoMatchTimezone() {
  try {
    const info = await self.NonortcGeo.detect();
    if (!info || !info.timezone) return null;
    const cur = await chrome.storage.local.get(['proxyTimezone', 'geoCoords']);
    const patch = {};
    if (cur.proxyTimezone !== info.timezone) patch.proxyTimezone = info.timezone;
    // 用户未手动指定坐标时，同步出口坐标，使地理定位与出口地区一致
    const c = { lat: info.lat, lng: info.lng };
    if (!cur.geoCoords && validCoords(c)) {
      patch.geoCoords = { lat: c.lat, lng: c.lng };
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    console.log('[nonortc] 自动匹配代理时区:', info.timezone, '| 来源', info.provider, '| 出口', info.ip || '?');
    return info;
  } catch (e) {
    console.warn('[nonortc] 自动匹配代理时区失败:', e && e.message, e && e.details ? e.details : '');
    return null;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TZ_ALARM) return;
  chrome.storage.local.get(KEYS).then((s) => {
    if (s.autoDetectTimezone) autoMatchTimezone();
  }).catch(() => {});
});

// ---- WebRTC / 网络预测（真实IP + DNS 泄漏防护，全局强制）----
async function applyPrivacy(settings) {
  const enabled = !!settings.globalEnabled;
  const webrtc = enabled ? (settings.webrtcPolicy || 'disable_non_proxied_udp') : 'default';
  const prediction = !enabled; // 开启防护时关闭网络预测（消除预解析 DNS 探测）
  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: webrtc });
    await chrome.privacy.network.networkPredictionEnabled.set({ value: prediction });
  } catch (e) {
    console.error('[nonortc] privacy set failed:', e);
  }
}

// ---- Accept-Language 改写（语言环境防护，支持按站点开关）----
async function applyDNR(settings) {
  const globalOn = !!settings.globalEnabled;
  const lang = settings.language || 'en-US';
  const value = ACCEPT_LANG[lang] || (lang + ',en;q=0.9');
  const map = settings.siteSettings || {};
  const rules = [];
  let id = 1;

  if (globalOn) {
    // 全局开关打开：对所有请求改写 Accept-Language。
    //
    // 「仅本站放行」的站点不再用 priority=2 的 allow 规则排除，原因有二：
    //   1. allow 规则优先级高于其他扩展的低优先级规则，会连带放行（破坏）用户
    //      其它扩展（如广告拦截）对该站点的拦截规则 —— 属越权干扰。
    //   2. 例外站点越多，动态规则条数越多；直接写在主规则的 excludedRequestDomains
    //      里只需 1 条规则，规避动态规则数量上限。
    const disabledHosts = Object.entries(map)
      .filter(([, v]) => v === false)
      .map(([h]) => h)
      .filter(validDomain);
    const condition = { resourceTypes: ALL_RESOURCE_TYPES };
    if (disabledHosts.length) condition.excludedRequestDomains = disabledHosts;
    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'accept-language', operation: 'set', value }]
      },
      condition
    });
  } else {
    // 全局开关关闭：仅对「仅本站强制开启」的站点（显式 true）单独改写
    const enabledHosts = Object.entries(map)
      .filter(([, v]) => v === true)
      .map(([h]) => h)
      .filter(validDomain);
    for (const host of enabledHosts) {
      rules.push({
        id: id++,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'accept-language', operation: 'set', value }]
        },
        condition: { requestDomains: [host], resourceTypes: ALL_RESOURCE_TYPES }
      });
    }
  }

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: rules
    });
  } catch (e) {
    console.error('[nonortc] DNR update failed:', e);
  }
}
