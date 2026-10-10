#!/usr/bin/env python3
"""nonortc 构建脚本：生成 zip（本地「加载已解压的扩展程序」用）与 CRX3（商店上架 / 企业策略分发用）。

依赖：Python 3 标准库 + openssl 命令行工具（GitHub Actions 的 ubuntu-latest 自带，无需 pip 安装）。

CRX3 格式依据（三处独立来源相互印证）：
  - chromium 源码 components/crx_file/crx3.proto
  - chromium 源码 components/crx_file/crx_verifier.cc（VerifyCrx3）
  - chrome 官方 CRX3 设计文档
文件布局：
  [4 octets] "Cr24"
  [4 octets] version = 3（小端 uint32）
  [4 octets] N = CrxFileHeader 的长度（小端 uint32）
  [N octets] CrxFileHeader（protobuf）
  [M octets] ZIP 归档
签名覆盖范围（顺序不可变）：
  "CRX3 SignedData\\x00" + len(signed_header_data)(小端 uint32) + signed_header_data + archive
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

MAGIC = b"Cr24"
CRX_VERSION = 3
# crx_file.h: "CRX3 SignedData" 含结尾 NUL，共 16 字节
SIG_CONTEXT = b"CRX3 SignedData\x00"
# crx_verifier.cc 明确拒绝 header 中出现 ZIP EOCD / EOCD64 / EOCD64 record token
FORBIDDEN_TOKENS = (b"PK\x05\x06", b"PK\x06\x07", b"PK\x06\x06")

EXCLUDE_DIRS = {
    ".git",
    ".github",
    ".cnb",
    ".workbuddy",
    ".vscode",
    "tools",
    "old",
    "__pycache__",
    "node_modules",
    # 构建产物与签名私钥目录：绝不进包（.build / .cnb-build 内存放签名私钥 key.pem）
    ".build",
    ".cnb-build",
    "build",
    "dist",
    "out",
}
EXCLUDE_SUFFIXES = (".zip", ".crx", ".pem", ".pyc", ".tar", ".gz")
EXCLUDE_FILES = {"logo.png", ".DS_Store", "Thumbs.db", ".gitignore", ".cnb.yml"}
# 可复现构建：固定 ZIP 条目时间戳
ZIP_DATE_TIME = (1980, 1, 1, 0, 0, 0)
# zipfile.ZipInfo 默认按 sys.platform 设定 create_system（Windows=0，Unix=3），
# 会在 ZIP 中央目录写入不同的一字节，导致同一份源码在 Windows 与 Linux 上产出的 zip/crx
# 内容完全相同但容器字节不同。此处固定为 3（Unix）以保证跨平台可复现。
ZIP_CREATE_SYSTEM = 3


def die(msg: str) -> "None":
    sys.stderr.write("ERROR: %s\n" % msg)
    sys.exit(1)


def run(cmd: list) -> bytes:
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        die(
            "命令失败: %s\n%s"
            % (" ".join(cmd), (p.stderr or b"").decode("utf-8", "replace").strip())
        )
    return p.stdout


def openssl() -> str:
    exe = shutil.which("openssl")
    if not exe:
        die("未找到 openssl，请先安装（Debian/Ubuntu: sudo apt-get install -y openssl）")
    return exe


# protobuf（手工编码）


def pb_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pb_bytes(field: int, data: bytes) -> bytes:
    """wire type 2（length-delimited）"""
    return pb_varint((field << 3) | 2) + pb_varint(len(data)) + data


def ext_id_from_pub(pub_der: bytes) -> str:
    """扩展 ID：SHA256(SPKI DER) 前 16 字节，十六进制后 0-f 映射为 a-p。"""
    digest = hashlib.sha256(pub_der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


# openssl 辅助


def load_or_create_key(key_path: str) -> tuple:
    """返回 (是否已存在, 公钥 SPKI DER, 公钥 PEM)。密钥不存在时生成 2048 位 RSA。"""
    ossl = openssl()
    existed = os.path.isfile(key_path)
    if not existed:
        os.makedirs(os.path.dirname(os.path.abspath(key_path)) or ".", exist_ok=True)
        run([ossl, "genrsa", "-out", key_path, "2048"])
    pub_der = run([ossl, "rsa", "-in", key_path, "-pubout", "-outform", "DER"])
    if len(pub_der) < 100:
        die("公钥导出异常（%d 字节），请检查 %s 是否为有效 RSA 私钥" % (len(pub_der), key_path))
    pub_pem = run([ossl, "rsa", "-in", key_path, "-pubout", "-outform", "PEM"])
    return existed, pub_der, pub_pem


def sign_data(key_path: str, data: bytes) -> bytes:
    """RSASSA-PKCS1-v1_5 + SHA-256（与 verifier 的 RSA_PKCS1_SHA256 一致）。"""
    ossl = openssl()
    with tempfile.TemporaryDirectory() as td:
        payload = os.path.join(td, "signed.bin")
        sig = os.path.join(td, "sig.bin")
        with open(payload, "wb") as f:
            f.write(data)
        run([ossl, "dgst", "-sha256", "-sign", key_path, "-out", sig, payload])
        with open(sig, "rb") as f:
            return f.read()


def verify_signature(pub_pem: bytes, data: bytes, signature: bytes) -> bool:
    ossl = openssl()
    with tempfile.TemporaryDirectory() as td:
        payload = os.path.join(td, "signed.bin")
        sig = os.path.join(td, "sig.bin")
        pub = os.path.join(td, "pub.pem")
        with open(payload, "wb") as f:
            f.write(data)
        with open(sig, "wb") as f:
            f.write(signature)
        with open(pub, "wb") as f:
            f.write(pub_pem)
        p = subprocess.run(
            [ossl, "dgst", "-sha256", "-verify", pub, "-signature", sig, payload],
            capture_output=True,
        )
        return p.returncode == 0


# ZIP 构建


def collect_files(src: str) -> list:
    """返回 [(绝对路径, 归档内相对路径)]，已排序以保证可复现。"""
    out = []
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        rel_root = os.path.relpath(root, src).replace("\\", "/")
        for name in sorted(files):
            if rel_root == "." and name in EXCLUDE_FILES:
                continue
            if name.lower().endswith(EXCLUDE_SUFFIXES):
                continue
            rel = name if rel_root == "." else "%s/%s" % (rel_root, name)
            out.append((os.path.join(root, name), rel))
    return sorted(out, key=lambda x: x[1])


def make_zip(src: str, entries: list, out_path: str, prefix: str = "", manifest_patch=None) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for abs_path, rel in entries:
            with open(abs_path, "rb") as fh:
                data = fh.read()
            if manifest_patch and rel == "manifest.json":
                data = manifest_patch(data)
            zi = zipfile.ZipInfo(prefix + rel, date_time=ZIP_DATE_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zi.create_system = ZIP_CREATE_SYSTEM
            z.writestr(zi, data)


def patch_manifest_version(data: bytes, version: str) -> bytes:
    """仅替换 version 字段，保持文件其余内容与格式不变。"""
    text = data.decode("utf-8")
    new_text, n = re.subn(
        r'("version"\s*:\s*)"[^"]*"',
        lambda m: '%s"%s"' % (m.group(1), version),
        text,
        count=1,
    )
    if n != 1:
        die("manifest.json 中未找到 version 字段，无法同步版本号")
    return new_text.encode("utf-8")


# CRX3 打包


def pack_crx(archive: bytes, key_path: str, out_path: str) -> dict:
    _, pub_der, pub_pem = load_or_create_key(key_path)

    # SignedData { bytes crx_id = 1; }  —— 字段号为 1（非 20）
    signed_header_data = pb_bytes(1, hashlib.sha256(pub_der).digest()[:16])

    to_sign = SIG_CONTEXT + struct.pack("<I", len(signed_header_data)) + signed_header_data + archive
    signature = sign_data(key_path, to_sign)

    # AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
    proof = pb_bytes(1, pub_der) + pb_bytes(2, signature)
    # CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
    header = pb_bytes(2, proof) + pb_bytes(10000, signed_header_data)

    for token in FORBIDDEN_TOKENS:
        if token in header:
            die(
                "CRX3 header 中出现被 Chrome 拒绝的 ZIP token %r（概率极低）。"
                "请重新生成签名密钥后重试。" % (token,)
            )

    blob = (
        MAGIC
        + struct.pack("<I", CRX_VERSION)
        + struct.pack("<I", len(header))
        + header
        + archive
    )
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(blob)

    if not verify_signature(pub_pem, to_sign, signature):
        die("CRX3 签名自校验失败")

    return {
        "crx_id": ext_id_from_pub(pub_der),
        "header_size": len(header),
        "public_key_der": len(pub_der),
        "signature": len(signature),
    }


# 主流程


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 nonortc 的 zip 与 CRX3 包")
    ap.add_argument("--src", default=".", help="扩展源码根目录（含 manifest.json）")
    ap.add_argument("--name", default="nonortc", help="产物文件名前缀")
    ap.add_argument("--version", required=True, help="版本号，如 1.4.2（允许带 v 前缀）")
    ap.add_argument("--out-dir", default="dist", help="产物输出目录")
    ap.add_argument("--key", default="", help="CRX 签名私钥（PEM）。不存在时自动生成")
    ap.add_argument(
        "--no-sync-manifest",
        action="store_true",
        help="不把 --version 写入产物内的 manifest.json",
    )
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    manifest_path = os.path.join(src, "manifest.json")
    if not os.path.isfile(manifest_path):
        die("%s 不存在，--src 应为扩展根目录" % manifest_path)

    version = args.version.strip()
    version = version[1:] if version.lower().startswith("v") else version
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?", version):
        die("版本号格式非法：%r（应为 1.4.2 或 v1.4.2）" % args.version)

    out_dir = os.path.abspath(args.out_dir)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)

    repo_version = None
    try:
        repo_version = json.loads(open(manifest_path, encoding="utf-8").read()).get("version")
    except Exception as e:
        die("解析 manifest.json 失败: %s" % e)
    patch = None
    if not args.no_sync_manifest:
        patch = lambda d, v=version: patch_manifest_version(d, v)
        if repo_version != version:
            sys.stderr.write(
                "WARN: 仓库 manifest.json 版本为 %s，与本次发布版本 %s 不一致；"
                "仅产物内 manifest.json 会被同步，仓库文件未改动。\n" % (repo_version, version)
            )

    entries = collect_files(src)
    if not any(rel == "manifest.json" for _, rel in entries):
        die("待打包清单中缺少 manifest.json，请检查排除规则")
    sys.stderr.write("打包 %d 个文件: %s\n" % (len(entries), ", ".join(r for _, r in entries)))

    base = "%s-%s" % (args.name, version)
    zip_path = os.path.join(out_dir, base + ".zip")
    crx_path = os.path.join(out_dir, base + ".crx")
    flat_zip = os.path.join(out_dir, ".flat-archive.zip")

    # 1) 发布用 zip：顶层带 <name>/ 目录，解压后即得扩展目录
    make_zip(src, entries, zip_path, prefix=args.name + "/", manifest_patch=patch)
    # 2) CRX 归档：扁平结构（解压后直接是 manifest.json）
    make_zip(src, entries, flat_zip, prefix="", manifest_patch=patch)

    key_path = os.path.abspath(args.key) if args.key else os.path.join(out_dir, args.name + ".pem")
    key_existed = os.path.isfile(key_path)
    with open(flat_zip, "rb") as f:
        archive = f.read()
    info = pack_crx(archive, key_path, crx_path)
    os.remove(flat_zip)

    if not key_existed:
        sys.stderr.write(
            "WARN: 未指定签名私钥，已新生成 %s。后续版本必须复用同一把密钥，"
            "否则扩展 ID 会变化、Chrome 视为不同扩展无法升级。\n" % key_path
        )

    digest_lines = []
    for p in (zip_path, crx_path):
        digest_lines.append("%s  %s" % (sha256_file(p), os.path.basename(p)))
    sums_path = os.path.join(out_dir, base + "-SHA256SUMS.txt")
    with open(sums_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(digest_lines) + "\n")

    info_path = os.path.join(out_dir, base + "-BUILD-INFO.txt")
    with open(info_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("name: %s\n" % args.name)
        f.write("version: %s\n" % version)
        f.write("manifest_version_in_repo: %s\n" % repo_version)
        f.write("extension_id: %s\n" % info["crx_id"])
        f.write("crx_header_size: %d\n" % info["header_size"])
        f.write("sign_algorithm: RSASSA-PKCS1-v1_5 / SHA-256\n")
        f.write("zip_sha256: %s\n" % sha256_file(zip_path))
        f.write("crx_sha256: %s\n" % sha256_file(crx_path))
        f.write("key_reused: %s\n" % ("yes" if key_existed else "no (newly generated)"))
        f.write("files: %d\n" % len(entries))

    print(json.dumps({
        "version": version,
        "extension_id": info["crx_id"],
        "zip": zip_path,
        "crx": crx_path,
        "sha256sums": sums_path,
        "build_info": info_path,
        "key": key_path,
        "key_reused": bool(key_existed),
        "files": len(entries),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
