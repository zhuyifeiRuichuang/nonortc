// nonortc config bridge — 隔离世界（ISOLATED world，document_start）
// 职责：主世界脚本 content-main.js 与宿主网页共享执行环境、**无法访问扩展 API**，
// 因此本脚本在隔离世界读取 chrome.storage 配置，按当前站点解析出「生效配置」，
// 再经 window.postMessage 下发给主世界脚本应用。
// 依据 Chrome 官方文档：主世界与隔离世界共享 DOM，跨世界通信必须通过
// 共享 DOM（window.postMessage）。
//
// ⚠ 安全边界（已实测推翻原设计假设）：
// 原注释称「网页脚本无法在 document_start 之前注册 message 监听，故无法窃取 token」——
// 该假设不成立。postMessage 是**异步任务派发**：内容脚本在 document_start 同步调用
// postMessage 后，任务的派发晚于当前同步执行；页面 <head> 中的内联脚本仍会在该任务
// 被派发前完成监听注册，从而截获 token。实测（Chrome 154）已成功截获。
// 另：Web Worker 等独立 realm 不注入内容脚本，防护对其完全无效。
// 结论见 content-main.js 顶部说明：此处仅防止网页**误触**，不构成安全边界。

(function () {
  const KEYS = [
    'globalEnabled', 'siteSettings', 'proxyTimezone',
    'geoMode', 'geoCoords', 'language'
  ];

  // 收集主世界广播的 token（用集合而非单值：网页伪造的 whoami 无法挤掉真实 token）
  const TOKENS = new Set();
  let resolved = null;

  function siteHost() {
    if (location.hostname) return location.hostname;
    // about:blank / srcdoc 等无主机名的框架：回退到创建者来源，保证按站点开关一致
    try {
      if (location.ancestorOrigins && location.ancestorOrigins.length) {
        return new URL(location.ancestorOrigins[0]).hostname;
      }
    } catch (e) {}
    try {
      if (document.referrer) return new URL(document.referrer).hostname;
    } catch (e) {}
    return '';
  }

  // 三态判定（与弹窗一致）：
  //   true -> 仅本站强制开启；false -> 仅本站放行；未设置 -> 跟随全局默认。
  // 此判定只作用于「时区 / 语言 / 地理定位」；WebRTC / DNS 由全局开关独占控制。
  function resolve(settings) {
    const s = settings || {};
    const map = s.siteSettings || {};
    const v = map[siteHost()];
    let active;
    if (v === true) active = true;
    else if (v === false) active = false;
    else active = !!s.globalEnabled;

    const c = s.geoCoords;
    return {
      active: active,
      tz: s.proxyTimezone || 'UTC',
      lang: s.language || 'en-US',
      geoMode: s.geoMode || 'spoof',
      coords: (c && typeof c.lat === 'number' && typeof c.lng === 'number')
        ? { lat: c.lat, lng: c.lng }
        : null
    };
  }

  function push() {
    if (!resolved || TOKENS.size === 0) return;
    for (const token of TOKENS) {
      try {
        window.postMessage({ __nonortc: 'config', token, payload: resolved }, '*');
      } catch (e) {}
    }
  }

  function load() {
    chrome.storage.local.get(KEYS, (s) => {
      if (chrome.runtime.lastError) return;
      resolved = resolve(s);
      push();
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__nonortc === 'nonortc-whoami' && typeof d.token === 'string') {
      if (TOKENS.size < 16) TOKENS.add(d.token);
      push();                        // 已有配置则立即回发，否则等 storage 回调
    }
  });

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') load();
  });

  // ---- 自检取证通道：在「真实网页」的隔离世界里枚举 ICE 候选 ----
  //
  // 为什么必须放在网页里取样：自检页自身运行在 chrome-extension:// 特权来源上，
  // 实测（Chrome 154，有头 / 无头一致）该来源既不施加 mDNS 主机名遮蔽，也不施加
  // webRTCIPHandlingPolicy —— 无论策略怎么设，扩展页恒能枚举到明文内网地址。
  // 因此「在扩展页里枚举候选」对「普通网页会不会泄漏」零证据力，只会恒报 FAIL。
  //
  // 本段代码运行在普通网页的隔离世界：与页面同源、同权限、同网络栈（ICE 候选由
  // 浏览器网络栈产生，与 realm 无关），因此取样结果即页面真实所见；又因隔离世界的
  // 原型链独立，页面脚本无法篡改这段逻辑，比注入主世界更安全。
  // 仅顶层帧应答（ICE 候选按来源聚合，顶层帧足以代表该站点）。
  function collectIce() {
    return new Promise((resolve) => {
      const out = { origin: location.origin, cands: [], error: null };
      if (typeof RTCPeerConnection !== 'function') { out.error = '该页面无 RTCPeerConnection'; resolve(out); return; }
      let pc;
      try { pc = new RTCPeerConnection({ iceServers: [] }); } catch (e) { out.error = e.message; resolve(out); return; }

      let settled = false;
      const timer = setTimeout(done, 3000);
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { pc.close(); } catch (e) {}
        resolve(out);
      }
      pc.onicecandidate = (e) => {
        if (!e.candidate) { done(); return; }
        out.cands.push(e.candidate.candidate);
      };
      try {
        pc.createDataChannel('nonortc-selftest');
        pc.createOffer()
          .then((o) => pc.setLocalDescription(o))
          .catch((e) => { out.error = String((e && e.message) || e); done(); });
      } catch (e) { out.error = String((e && e.message) || e); done(); }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__nonortc !== 'iceProbe') return;
    if (window.top !== window) return;            // 仅顶层帧应答
    collectIce().then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;                                  // 异步回复，保持通道打开
  });

  load();
})();
