#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nonortc — DNS 泄漏自检工具

用意
    Chrome 扩展无法控制系统/网卡的 DNS 解析（Chrome 未向扩展开放任何 DNS、路由、
    网卡控制 API，chrome.privacy 也只有 WebRTC 与网络预测两项）。因此 DNS 泄漏
    必须在「代理侧/系统侧」修复，并用本机工具闭环验证是否真的修好。本工具即用于
    验证环节：它不看第三方检测站的截图，而是从权威 DNS 侧反查「究竟是谁在替你做
    递归查询」。

零依赖
    仅用 Python 3 标准库（subprocess / urllib / ipaddress / json），无需 pip install。

跨平台
    Windows 10/11、Linux、macOS。

检测项
    1. 网卡级配置的 DNS 服务器清单
    2. 权威 DNS 侧实际观测到的递归解析器 IP（Akamai whoami 工具）
    3. 该解析器是否向权威 DNS 泄露了 EDNS Client Subnet（RFC 7871）
    4. 解析器归属（国家/ISP）与本机网络出口是否分离 -> 判定泄漏

用法
    python dns-leak-check.py                       # 常规自检
    python dns-leak-check.py --expect-country US   # 预期代理出口在美国
    python dns-leak-check.py --json                # 机读输出

判定口径（业界通用，非按国家字面比对）
    泄漏 ≠ DNS 和出口 IP 国家不一致。真正的泄漏是：你的 DNS 查询被发给了「你不打算
    让其知晓你访问了什么」的那台解析器 —— 典型即本地 ISP 解析器。它清楚你的家宽/专线
    线路在哪里，而你可能正在刻意用代理出口伪装位置；二者一旦分离，即为泄漏。
    因此本工具把「出口 IP 归属」与「递归解析器归属」对照起来判定，而非看国家是否相同。
"""

import argparse
import ipaddress
import json
import os
import platform
import re
import socket
import subprocess
import sys
import urllib.request

# ---------------------------------------------------------------- 基础工具

IS_WIN = platform.system() == "Windows"

OK = "[ OK ]"
WARN = "[WARN ]"
FAIL = "[FAIL ]"
INFO = "[INFO]"


def _ensure_utf8_stdout():
    """Windows 控制台默认 GBK，直接输出中文会炸。尽力切成 UTF-8。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def sh(args, timeout=8):
    """执行命令并取回文本输出。nslookup 在 Windows 上输出为本地代码页。"""
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout)
    except Exception as e:
        return "", "%s: %s" % (type(e).__name__, e)
    out = p.stdout + b"\n" + p.stderr
    for enc in ("utf-8", "mbcs", "cp936", "latin-1"):
        try:
            out = out.decode(enc)
            break
        except Exception:
            continue
    else:
        out = out.decode("utf-8", errors="replace")
    return out, None


def http_json(url, timeout=8):
    req = urllib.request.Request(
        url, headers={"User-Agent": "curl/8", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def is_private(ip):
    """私有 / 环回 / 链路本地 / CGNAT(100.64/10) 均视为本地转发解析器。"""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if a.version == 4:
        nets = [
            "127.0.0.0/8", "10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12",
            "169.254.0.0/16", "100.64.0.0/10", "0.0.0.0/8",
        ]
    else:
        nets = ["::1/128", "fc00::/7", "fe80::/10"]
    return any(a in ipaddress.ip_network(n) for n in nets)


# ---------------------------------------------------------------- 步骤 1：本机出口 IP

EGRESS_PROVIDERS = [
    ("https://ipwho.is/", None),
    ("https://api.ip.sb/geoip", None),
    ("https://ipinfo.io/json", None),
    ("http://ip-api.com/json/", None),
]


def get_egress_ip():
    """
    经 HTTP 探测出口 IP。注意：Python 会继承环境变量里的代理配置，
    因此这里取到的是「HTTP 代理出口」的 IP，而非拨号 IP —— 这正是我们要拿来
    与 DNS 解析器做对照的那个值（网站视角看到的你）。
    """
    for url, _ in EGRESS_PROVIDERS:
        try:
            d = http_json(url)
            ip = d.get("ip") or d.get("query")
            if ip:
                return {
                    "ip": ip,
                    "country": d.get("country_code") or d.get("countryCode")
                    or d.get("country"),
                    "region": d.get("region") or d.get("regionName"),
                    "isp": (d.get("connection") or {}).get("isp")
                    or d.get("isp") or d.get("org"),
                    "source": url,
                }
        except Exception:
            continue
    return None


# ---------------------------------------------------------------- 步骤 2：网卡 DNS 配置

def get_nic_dns():
    """返回 [(接口, [dns,...]), ...]"""
    res = []
    if IS_WIN:
        out, err = sh(["powershell", "-NoProfile", "-Command",
                       "Get-DnsClientServerAddress -AddressFamily IPv4 | "
                       "ForEach-Object { $_.InterfaceAlias + '|' + "
                       "($_.ServerAddresses -join ',') }"], timeout=15)
        for line in out.splitlines():
            line = line.strip()
            if "|" in line:
                name, _, servers = line.partition("|")
                servers = [s.strip() for s in servers.split(",") if s.strip()]
                if servers:
                    res.append((name.strip(), servers))
        if not res:  # powershell 不可用时回退 ipconfig
            out, _ = sh(["ipconfig", "/all"], timeout=15)
            cur = None
            for line in out.splitlines():
                if line and not line.startswith(" "):
                    cur = line.strip().rstrip(":")
                m = re.search(r"(?:DNS Servers|DNS 服务器)\s*[\. ]*:\s*(.+)", line)
                if m:
                    res.append((cur or "?", [m.group(1).strip()]))
    else:
        try:
            with open("/etc/resolv.conf") as f:
                servers = [
                    l.split()[1] for l in f
                    if l.strip().startswith("nameserver") and len(l.split()) > 1
                ]
            if servers:
                res.append(("resolv.conf", servers))
        except OSError:
            pass
        # macOS
        out, _ = sh(["scutil", "--dns"], timeout=8)
        if out:
            for m in re.finditer(r"nameserver\[\d+\]\s*:\s*(\S+)", out):
                res.append(("scutil", [m.group(1)]))
    return res


# ---------------------------------------------------------------- 步骤 3：Akamai whoami

WHOAMI_HOSTS = {
    "dual": "whoami.ds.akahelp.net",
    "ipv4": "whoami.ipv4.akahelp.net",
    "ipv6": "whoami.ipv6.akahelp.net",
}


def query_txt(name, timeout=8):
    """
    查询 TXT 记录并返回引号内字段列表。
    Akamai 权威 DNS 会返回：ns(递归解析器单播地址) / ecs(ECS 客户端子网) / ip(其
    从 ECS 子网随机选出的代表地址)。参考 Akamai 官方 Blog「Introducing New WhoAmI
    Tool DNS Resolver Information」。
    """
    if IS_WIN:
        args = ["nslookup", "-type=TXT", name]
    else:
        args = ["dig", "+short", "TXT", name] if _has("dig") else \
            ["nslookup", "-type=TXT", name]
    out, err = sh(args, timeout=timeout + 2)
    if err:
        return None, err
    fields = re.findall(r'"([^"]+)"', out)
    if not fields:
        return None, out.strip()[:200] or "无 TXT 响应"
    return fields, None


def _has(cmd):
    for p in os.environ.get("PATH", "").split(os.pathsep):
        if p and os.path.exists(os.path.join(p, cmd)):
            return True
    return False


def parse_whoami(fields):
    """把 [ns, ip, ecs, cidr, ...] 解析成结构。"""
    info = {"nameserver": [], "ecs": [], "representative": []}
    i = 0
    while i < len(fields):
        cur = fields[i].strip().lower()
        nxt = fields[i + 1].strip() if i + 1 < len(fields) else ""
        if cur == "ns" and nxt:
            info["nameserver"].append(nxt)
        elif cur == "ecs" and nxt:
            info["ecs"].append(nxt)
        elif cur == "ip" and nxt:
            info["representative"].append(nxt)
        i += 1
    return info


# ---------------------------------------------------------------- 步骤 4：解析器归属

GEO_PROVIDERS = [
    {
        "url": "https://ipwho.is/{ip}",
        "pick": lambda d: (
            d.get("country_code"),
            (d.get("connection") or {}).get("isp") or (d.get("connection") or {}).get("org"),
        ),
    },
    {
        "url": "http://ip-api.com/json/{ip}",
        "pick": lambda d: (d.get("countryCode"), d.get("isp") or d.get("org")),
    },
    {
        "url": "https://ipinfo.io/{ip}/json",
        "pick": lambda d: (d.get("country"), d.get("org")),
    },
]


def geo_lookup(ip):
    if is_private(ip):
        return {"ip": ip, "country": None, "isp": "私有/本地网络（转发解析器）",
                "private": True}
    for p in GEO_PROVIDERS:
        try:
            d = http_json(p["url"].format(ip=ip))
            cc, org = p["pick"](d)
            if cc or org:
                return {"ip": ip, "country": cc, "isp": org, "private": False}
        except Exception:
            continue
    return {"ip": ip, "country": None, "isp": None, "private": False}


# ---------------------------------------------------------------- 判定

def build_verdict(ns_list, egress, nic_dns, expect_country, has_ecs):
    """
    判定口径：DNS 泄漏不是「DNS 与出口 IP 国家不同」，而是「DNS 查询被发给了你不
    打算让其知情的解析器」。因此核心是看递归解析器是否走了本机直连链路。
    """
    v = []
    expect = (expect_country or "").upper()
    nic_servers = [s for _, sv in nic_dns for s in sv]
    hijacked = bool(nic_servers) and all(is_private(s) for s in nic_servers)

    if not ns_list:
        v.append((FAIL, "本机 DNS 递归查询未能完成 —— 这不是「泄漏」，而是解析链路中断或被拦截。"
                        "请先恢复本地 DNS 转发，否则关于 DNS 泄漏的一切结论都无从谈起。"))
        if hijacked:
            v.append((INFO, "网卡 DNS 已全部指向本机/私有地址（本地劫持生效中），但转发没有返回结果 —— "
                            "请检查接管 53 端口的程序是否已正常联网。"))
        return v

    priv_ns = [g for g in ns_list if g["private"]]
    public_ns = [g for g in ns_list if not g["private"]]

    if priv_ns:
        v.append((INFO, "存在私有地址的递归解析器（%s）：本机有 DNS 转发器，权威 DNS 看到的是转发器出口，"
                        "其真实上游本工具无法直接观测。"
                 % ", ".join(g["ip"] for g in priv_ns)))

    if not public_ns:
        v.append((INFO, "未在权威 DNS 侧观测到公网递归解析器，无法完成归属维度比对。"))
        return v

    eg_country = (egress or {}).get("country")
    eg_isp = (egress or {}).get("isp")

    if expect:
        bad = [(g["ip"], (g.get("country") or "").upper(), g.get("isp") or "?")
               for g in public_ns
               if (g.get("country") or "").upper() and
               (g.get("country") or "").upper() != expect]
        if bad:
            for ip, cc, isp in bad:
                v.append((FAIL, "解析器 %s 归属 %s / %s，与预期代理出口 %s 不一致 —— DNS 查询未进入代理隧道，"
                                "权威 DNS 仍可看到你本机的网络位置。" % (ip, cc, isp, expect)))
        else:
            v.append((OK, "全部 %d 个递归解析器的归属均与预期出口 %s 一致，"
                          "未发现 DNS 查询脱离隧道的迹象。" % (len(public_ns), expect)))
    else:
        same_src = bool(egress) and all(
            (g.get("country") or "").upper() == str(eg_country or "").upper()
            for g in public_ns
        )
        if same_src:
            v.append((WARN, "递归解析器与网络出口同属 %s / %s —— 表明 DNS 查询走的是本机直连链路，"
                            "并未被代理隧道接管。若你此刻依赖代理隐藏真实网络位置，这就是 DNS 泄漏；"
                            "若未使用代理则属正常。" % (eg_country, eg_isp)))
        else:
            v.append((WARN, "递归解析器归属与网络出口不一致（%s）。请核对这些解析器是否属于你预期的链路 —— "
                            "若它们来自本机 ISP 而 HTTP 已走代理，即构成 DNS 泄漏。"
                     % ", ".join("%s / %s" % (g.get("country") or "?", g.get("isp") or "?")
                                 for g in public_ns)))
        v.append((INFO, "未指定 --expect-country 时只能给出提示。加该参数可得确定性判定，"
                        "如：--expect-country US"))

    if hijacked:
        v.append((INFO, "网卡 DNS 已被劫持到本机/私有地址，但权威 DNS 侧看到的仍是公网解析器 —— "
                        "本地转发器把查询转发给了上游（多半未被代理接管），因此需要继续管理局端的 DNS 走向。"))

    if has_ecs:
        v.append((FAIL, "检测到 EDNS Client Subnet 披露：解析器已把你的真实子网交给权威 DNS，"
                        "即使 IP 隐藏也可能被定位到所在地区。"))

    return v


# ---------------------------------------------------------------- 主流程

def main():
    _ensure_utf8_stdout()
    ap = argparse.ArgumentParser(description="nonortc DNS 泄漏自检工具")
    ap.add_argument("--expect-country", metavar="XX",
                    help="预期的代理出口国家/地区码（如 US/JP/SG），用于判定解析器归属是否越界")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--timeout", type=int, default=8, help="单次网络超时秒数（默认 8）")
    args = ap.parse_args()

    report = {}
    lines = []

    def emit(s):
        lines.append(s)
        if not args.json:
            print(s)

    if not args.json:
        sys.stderr.write("%s 正在检测，请稍候...\n" % INFO)
        sys.stderr.flush()

    # 1) 出口 IP
    egress = get_egress_ip()
    report["egress"] = egress

    # 2) 网卡 DNS
    nic_dns = get_nic_dns()
    report["nic_dns"] = [{"interface": n, "servers": s} for n, s in nic_dns]

    # 3) whoami 三连查
    whoami = {}
    for key, host in WHOAMI_HOSTS.items():
        fields, err = query_txt(host, timeout=args.timeout)
        whoami[key] = parse_whoami(fields) if fields else {"error": err}
    report["whoami"] = whoami

    # 4) 解析器归属
    seen, ns_list = set(), []
    for key in ("dual", "ipv4", "ipv6"):
        for ip in whoami.get(key, {}).get("nameserver", []):
            if ip not in seen:
                seen.add(ip)
                ns_list.append(geo_lookup(ip))
    report["resolvers"] = ns_list

    report["ecs_values"] = sorted({e for k in whoami if isinstance(whoami[k], dict)
                                   for e in whoami[k].get("ecs", [])})

    # ---------- 判定 ----------
    verdicts = build_verdict(ns_list, egress, nic_dns,
                             args.expect_country, bool(report["ecs_values"]))
    report["verdicts"] = [{"level": t.strip("[] "), "message": m} for t, m in verdicts]
    report["leak_suspected"] = any(
        (t.strip("[] ") in ("FAIL", "WARN")) for t, _ in verdicts)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    # ---------- 输出报告 ----------
    emit("")
    emit("=" * 66)
    emit(" nonortc DNS 泄漏自检报告")
    emit("=" * 66)

    emit("")
    emit("【1】网络出口（HTTP 视角，即网站看到的你）")
    if egress:
        emit("   出口 IP : %s" % egress["ip"])
        emit("   归属    : %s / %s / %s" % (egress.get("country"), egress.get("region"),
                                            egress.get("isp")))
    else:
        emit("   %s 无法探测（全部数据源不可达）" % WARN)

    emit("")
    emit("【2】网卡配置的 DNS 服务器")
    if nic_dns:
        for name, servers in nic_dns:
            tag = "localhost-forward" if any(is_private(s) for s in servers) else ""
            emit("   %-28s %s %s" % (name[:28], ", ".join(servers), tag))
        localhost_only = all(is_private(s) for _, sv in nic_dns for s in sv)
        if localhost_only:
            emit("   %s 所有网卡 DNS 均指向本机/私有地址 -> 存在本地 DNS 劫持（代理软件或企业 VPN 客户端）"
                 % INFO)
    else:
        emit("   %s 未能读取" % WARN)

    emit("")
    emit("【3】权威 DNS 侧实际观测到的递归解析器")
    if ns_list:
        for g in ns_list:
            loc = "私有/本地网络" if g["private"] else "%s / %s" % (
                g.get("country") or "?", g.get("isp") or "?")
            emit("   %-40s %s" % (g["ip"], loc))
    else:
        emit("   %s 未取到解析器 —— 通常意味着本机 DNS 查询根本没成功出去（见下方诊断）"
             % FAIL)
        for key in ("dual", "ipv4", "ipv6"):
            r = whoami.get(key, {})
            if isinstance(r, dict) and r.get("error"):
                emit("       %s -> %s" % (WHOAMI_HOSTS[key], r["error"]))
    emit("")
    emit("【4】EDNS Client Subnet（RFC 7871）")
    ecs_values = report["ecs_values"]
    if ecs_values:
        for e in ecs_values:
            emit("   %s 解析器向权威 DNS 披露了客户端子网: %s" % (FAIL, e))
        emit("   权威 DNS 可据此定位到你的真实网络所在地区。")
    elif ns_list:
        emit("   %s 未检测到 ECS 信息披露" % OK)
    else:
        emit("   %s 无解析器数据，无法判定" % WARN)

    emit("")
    emit("【5】判定")
    for tag, msg in verdicts:
        emit("   %s %s" % (tag, msg))

    emit("")
    emit("=" * 66)
    emit(" 修复方向（均在代理侧/系统侧，Chrome 扩展无法介入）")
    emit("=" * 66)
    for line in [
        "· 代理客户端（Clash/Mihomo）：dns.enable=true + enhanced-mode: fake-ip",
        "  + 加密上游 DoH/DoT + TUN + dns-hijack any:53；勿用 redir-host。",
        "· 命令行工具用 socks5h:// 而非 socks5://（后者在本机解析域名，必然泄漏）。",
        "· IPv6：代理未接管则在网卡关闭 IPv6，否则它绕过一切 IPv4 规则。",
        "· QUIC：chrome://flags/#enable-quic 置 Disabled，或换支持 UDP 的代理。",
        "· 详细步骤见 nonortc/README.md「网络层泄漏」一节。",
    ]:
        emit("   " + line)
    emit("")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已中断")
        sys.exit(130)
