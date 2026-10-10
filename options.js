// nonortc options page logic

// 回退时区清单（当浏览器不支持 Intl.supportedValuesOf('timeZone') 时使用）
const FALLBACK_TZ = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver',
  'America/Sao_Paulo', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Madrid', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Rome', 'Europe/Zurich',
  'Europe/Vienna', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki',
  'Europe/Warsaw', 'Europe/Prague', 'Europe/Athens', 'Europe/Moscow', 'Europe/Istanbul',
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
  'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Manila', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Jerusalem',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland',
  'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi'
];

const $ = (id) => document.getElementById(id);

// 优先用浏览器内置的完整 IANA 时区列表（Chrome 99+）
function allTimezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const list = Intl.supportedValuesOf('timeZone');
      if (Array.isArray(list) && list.length) return list.slice();
    }
  } catch (e) {}
  return FALLBACK_TZ.slice();
}

function fillTzDatalist() {
  const dl = $('tzList');
  if (!dl) return;
  const frag = document.createDocumentFragment();
  for (const tz of allTimezones()) {
    const o = document.createElement('option');
    o.value = tz;
    frag.appendChild(o);
  }
  dl.appendChild(frag);
}

function setHint(text, warn) {
  const el = $('detectHint');
  el.textContent = text;
  el.className = warn ? 'hint warn' : 'hint';
}

// 探测当前出口 IP 的时区与坐标（多源回退）；silent=true 时不显示"探测中"
async function detect(opts) {
  const silent = !!(opts && opts.silent);
  if (!silent) setHint('探测中（依次尝试 ' + NonortcGeo.providerNames.join(' → ') + '）…');
  try {
    const info = await NonortcGeo.detect();
    $('tz').value = info.timezone;
    if (info.lat != null) $('geoLat').value = info.lat;
    if (info.lng != null) $('geoLng').value = info.lng;
    const where = [info.city, info.country].filter(Boolean).join(', ');
    let msg = `探测成功（来源 ${info.provider}）：时区 = ${info.timezone}` +
      (info.ip ? `，出口 IP = ${info.ip}` : '') + (where ? `（${where}）` : '') + '。可点「保存设置」生效。';
    if (info.isChina) {
      msg += ' ⚠ 出口显示为中国大陆，可能命中了直连分流，请确认该探测请求确实经代理发出。';
      setHint(msg, true);
    } else {
      setHint(msg, false);
    }
    return info;
  } catch (e) {
    const detail = (e && e.details && e.details.length) ? '（' + e.details.slice(0, 3).join('；') + '）' : '';
    setHint('自动探测失败：' + e.message + detail + ' 请手动输入 IANA 时区，如 America/Los_Angeles。', true);
    return null;
  }
}

async function load() {
  fillTzDatalist();

  const s = await chrome.storage.local.get([
    'proxyTimezone', 'webrtcPolicy', 'geoMode', 'geoCoords', 'language', 'siteSettings', 'autoDetectTimezone'
  ]);

  $('tz').value = s.proxyTimezone || 'America/New_York';
  $('webrtcPolicy').value = s.webrtcPolicy || 'disable_non_proxied_udp';
  $('geoMode').value = s.geoMode || 'spoof';
  if (s.geoCoords) {
    $('geoLat').value = s.geoCoords.lat ?? '';
    $('geoLng').value = s.geoCoords.lng ?? '';
  }
  $('language').value = s.language || 'en-US';
  $('autoDetectTz').checked = !!s.autoDetectTimezone;
  renderSites(s.siteSettings || {});

  // 已开启自动匹配但尚未确定时区时，进入设置页即自动跑一次
  if (s.autoDetectTimezone && !s.proxyTimezone) await detect({ silent: true });
}

function renderSites(siteSettings) {
  const body = $('siteBody');
  body.innerHTML = '';
  const entries = Object.entries(siteSettings).filter(([, v]) => v === false || v === true);
  if (entries.length === 0) {
    body.innerHTML = '<tr><td colspan="3" style="color:#888;">暂无例外站点（全部跟随全局默认）</td></tr>';
    return;
  }
  for (const [host, v] of entries) {
    // 用 DOM API 构造而非 innerHTML 拼接：host 来自 URL 解析结果，
    // 直接插值进 innerHTML 等于在扩展页（chrome-extension:// 特权上下文）里开一个 XSS 汇点。
    const tr = document.createElement('tr');
    const tdHost = document.createElement('td');
    tdHost.textContent = host;
    const tdState = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = v === false ? 'pill off' : 'pill on';
    pill.textContent = v === false ? '已放行' : '仅本站防护';
    tdState.appendChild(pill);
    const tdOp = document.createElement('td');
    const btn = document.createElement('button');
    btn.textContent = '清除例外';
    btn.dataset.host = host;
    tdOp.appendChild(btn);
    tr.append(tdHost, tdState, tdOp);
    body.appendChild(tr);
  }
  body.querySelectorAll('button[data-host]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const map = (await chrome.storage.local.get('siteSettings')).siteSettings || {};
      delete map[btn.dataset.host];
      await chrome.storage.local.set({ siteSettings: map });
      const s = await chrome.storage.local.get('siteSettings');
      renderSites(s.siteSettings || {});
    });
  });
}

async function save() {
  const tz = ($('tz').value || '').trim();
  if (!NonortcGeo.isValidTimezone(tz)) {
    setHint('时区无效：' + (tz || '(空)') + '，请输入合法的 IANA 名称（如 America/Los_Angeles）。', true);
    return;
  }
  const lat = parseFloat($('geoLat').value);
  const lng = parseFloat($('geoLng').value);
  const geoCoords = (isNaN(lat) || isNaN(lng)) ? null : { lat, lng };

  await chrome.storage.local.set({
    proxyTimezone: tz,
    webrtcPolicy: $('webrtcPolicy').value,
    geoMode: $('geoMode').value,
    geoCoords,
    language: $('language').value,
    autoDetectTimezone: $('autoDetectTz').checked
  });
  $('saveStatus').textContent = '已保存 ✓';
  setTimeout(() => { $('saveStatus').textContent = ''; }, 2000);
}

$('saveBtn').addEventListener('click', save);
$('detectBtn').addEventListener('click', () => detect());
$('selftestBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('selftest.html') });
});
load();
