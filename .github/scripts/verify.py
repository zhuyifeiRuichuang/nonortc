#!/usr/bin/env python3
"""nonortc 扩展清单与文件引用校验。

仅使用 Python 标准库，可在本地直接运行，也可由 CI（CNB / GitHub Actions）调用：

    python3 .github/scripts/verify.py

退出码 0 表示全部通过，1 表示存在校验失败项。

校验范围
    1. manifest.json 是否为合法 JSON，manifest_version 是否为 3
    2. name / version / description 是否齐备，version 是否符合 Chrome 版本号规则
    3. manifest 内引用的全部本地文件是否存在（含通配资源）
    4. HTML 页面内引用的本地脚本、样式、图片是否存在
    5. 仓库中是否混入了不应入库的签名私钥与产物文件
    6. permissions / host_permissions 是否重复
"""

import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ERRORS = []
WARNINGS = []
CHECKED = 0


def rel(path):
    return os.path.relpath(path, ROOT).replace("\\", "/")


def fail(msg):
    ERRORS.append(msg)


def warn(msg):
    WARNINGS.append(msg)


def exists(rel_path):
    return os.path.isfile(os.path.join(ROOT, rel_path))


def check_file(rel_path, origin):
    """校验单个被引用文件存在。未声明的字段（None）视为通过。"""
    global CHECKED
    if rel_path is None:
        return True
    if not isinstance(rel_path, str) or not rel_path.strip():
        fail("%s：引用了空路径" % origin)
        return False
    if rel_path.startswith(("http://", "https://", "//", "data:", "chrome-extension://")):
        return True
    CHECKED += 1
    if "*" in rel_path or "?" in rel_path:
        hits = glob.glob(os.path.join(ROOT, rel_path))
        if not hits:
            fail("%s：通配路径未匹配到任何文件 —— %s" % (origin, rel_path))
            return False
        return True
    if not exists(rel_path):
        fail("%s：引用的文件不存在 —— %s" % (origin, rel_path))
        return False
    return True


def check_icon_map(value, origin):
    if isinstance(value, dict):
        for size, path in value.items():
            check_file(path, "%s[%s]" % (origin, size))
    elif isinstance(value, str):
        check_file(value, origin)


VERSION_RE = re.compile(r"^\d{1,5}(\.\d{1,5}){0,3}$")


def check_manifest():
    manifest_path = os.path.join(ROOT, "manifest.json")
    if not os.path.isfile(manifest_path):
        fail("仓库根目录缺少 manifest.json")
        return None

    with open(manifest_path, encoding="utf-8") as fh:
        try:
            mf = json.load(fh)
        except ValueError as exc:
            fail("manifest.json 不是合法 JSON：%s" % exc)
            return None

    if mf.get("manifest_version") != 3:
        fail("manifest_version 必须为 3，实际为 %r" % mf.get("manifest_version"))

    for key in ("name", "version", "description"):
        if not mf.get(key):
            fail("manifest.json 缺少必填字段：%s" % key)

    version = str(mf.get("version", ""))
    if version and not VERSION_RE.match(version):
        fail("version 不符合 Chrome 版本号规则（1~4 段数字）：%s" % version)

    min_chrome = mf.get("minimum_chrome_version")
    if not min_chrome:
        warn("manifest.json 未声明 minimum_chrome_version")
    elif not re.match(r"^\d+$", str(min_chrome)):
        warn("minimum_chrome_version 建议使用纯数字主版本号：%s" % min_chrome)

    check_icon_map(mf.get("icons"), "icons")

    action = mf.get("action") or {}
    check_file(action.get("default_popup"), "action.default_popup")
    check_icon_map(action.get("default_icon"), "action.default_icon")

    check_file(mf.get("options_page"), "options_page")

    options_ui = mf.get("options_ui") or {}
    check_file(options_ui.get("page"), "options_ui.page")

    side_panel = mf.get("side_panel") or {}
    check_file(side_panel.get("default_path"), "side_panel.default_path")

    for key, path in (mf.get("chrome_url_overrides") or {}).items():
        check_file(path, "chrome_url_overrides.%s" % key)

    background = mf.get("background") or {}
    check_file(background.get("service_worker"), "background.service_worker")
    for i, path in enumerate(background.get("scripts") or []):
        check_file(path, "background.scripts[%d]" % i)

    for i, cs in enumerate(mf.get("content_scripts") or []):
        origin = "content_scripts[%d]" % i
        for path in cs.get("js") or []:
            check_file(path, "%s.js" % origin)
        for path in cs.get("css") or []:
            check_file(path, "%s.css" % origin)
        if not cs.get("matches") and not cs.get("include_globs"):
            fail("%s：既没有 matches 也没有 include_globs" % origin)

    for i, war in enumerate(mf.get("web_accessible_resources") or []):
        origin = "web_accessible_resources[%d]" % i
        for path in war.get("resources") or []:
            check_file(path, "%s.resources" % origin)
        if not war.get("matches"):
            fail("%s：缺少 matches" % origin)

    dnr = mf.get("declarative_net_request") or {}
    for i, rule in enumerate(dnr.get("rule_resources") or []):
        check_file(rule.get("path"), "declarative_net_request.rule_resources[%d]" % i)

    for key in ("permissions", "host_permissions", "optional_permissions"):
        items = mf.get(key) or []
        dupes = {x for x in items if items.count(x) > 1}
        if dupes:
            fail("%s 存在重复项：%s" % (key, ", ".join(sorted(dupes))))

    return mf


HTML_REF_RE = re.compile(
    r"""<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE,
)


def check_html_files():
    html_files = sorted(glob.glob(os.path.join(ROOT, "*.html")))
    html_files += sorted(glob.glob(os.path.join(ROOT, "**", "*.html"), recursive=True))
    seen = set()
    for path in html_files:
        path = os.path.abspath(path)
        if path in seen or os.sep + ".git" + os.sep in path:
            continue
        seen.add(path)
        name = rel(path)
        if name.startswith((".build", "dist", ".cnb-build")) or name.startswith("old/"):
            continue
        with open(path, encoding="utf-8", errors="replace") as fh:
            content = fh.read()
        for ref in HTML_REF_RE.findall(content):
            if ref.startswith(("#", "data:", "http://", "https://", "//", "mailto:")):
                continue
            ref = ref.split("?")[0].split("#")[0]
            if not ref:
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(path), ref))
            global CHECKED
            CHECKED += 1
            if not os.path.isfile(target):
                fail("%s：引用的文件不存在 —— %s" % (name, ref))
    return len(seen)


FORBIDDEN_SUFFIX = (".pem", ".key", ".p12", ".pfx", ".crx", ".zip", ".jks")
FORBIDDEN_NAMES = (".env", "id_rsa", "id_ed25519")
SKIP_DIRS = {".git", "node_modules", "old", "dist", ".build", ".cnb-build", ".cache"}


def tracked_files():
    """返回 Git 跟踪的文件列表；不可用时返回 None。"""
    try:
        proc = subprocess.run(
            ["git", "-C", ROOT, "ls-files", "-z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = proc.stdout.decode("utf-8", "replace")
    files = [f for f in out.split("\0") if f]
    return files or None


def check_forbidden_files():
    """检查是否有私钥或构建产物被纳入版本控制。

    优先依据 Git 索引判断（本地生成的私钥与产物已被 .gitignore 排除，
    不算入库），Git 不可用时回退为扫描工作区并跳过构建输出目录。
    """
    tracked = tracked_files()
    if tracked is not None:
        candidates = tracked
        source = "Git 索引"
    else:
        candidates = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                candidates.append(rel(os.path.join(dirpath, name)))
        source = "工作区扫描"

    hits = []
    for name in candidates:
        lower = os.path.basename(name).lower()
        if lower.endswith(FORBIDDEN_SUFFIX) or lower in FORBIDDEN_NAMES:
            hits.append(name)
    for hit in sorted(hits):
        fail("仓库中不应存在私钥或构建产物：%s" % hit)
    return len(hits), "%s（共 %d 个受检文件）" % (source, len(candidates))


def main():
    print("nonortc 校验 —— 仓库根目录：%s" % ROOT)
    print("-" * 68)

    mf = check_manifest()
    html_count = check_html_files()
    forbidden, forbidden_source = check_forbidden_files()

    js_files = sorted(
        rel(p)
        for p in glob.glob(os.path.join(ROOT, "**", "*.js"), recursive=True)
        if os.sep + ".git" + os.sep not in p
    )

    print("manifest.json      : %s" % ("读取成功" if mf else "读取失败"))
    if mf:
        print("扩展名称           : %s" % mf.get("name"))
        print("扩展版本           : %s" % mf.get("version"))
        print("清单版本           : %s" % mf.get("manifest_version"))
        print("最低 Chrome 版本   : %s" % mf.get("minimum_chrome_version"))
        print("权限项             : %d 个" % len(mf.get("permissions") or []))
    print("HTML 页面          : %d 个" % html_count)
    print("JavaScript 文件    : %d 个" % len(js_files))
    print("文件引用校验       : %d 处" % CHECKED)
    print("私钥与产物检查     : %d 处违规（来源：%s）" % (forbidden, forbidden_source))
    print("-" * 68)

    for item in WARNINGS:
        print("[警告] %s" % item)
    for item in ERRORS:
        print("[失败] %s" % item)

    if ERRORS:
        print("\n校验未通过：%d 项失败，%d 项警告" % (len(ERRORS), len(WARNINGS)))
        return 1
    print("\n校验通过：0 项失败，%d 项警告" % len(WARNINGS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
