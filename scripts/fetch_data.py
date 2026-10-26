#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线数据包生成脚本（单机版专用）

用途：抓取双色球 + 大乐透全量历史开奖数据，输出 lottery-data.json，
      供网页版 / APK 初始导入使用。无需后端服务器。

用法：
    python3.11 fetch_data.py                  # 全量抓取（约 3 分钟）
    python3.11 fetch_data.py --dlt-pages 2 --ssq-pages 1   # 快速验证
    python3.11 fetch_data.py --no-500com      # 跳过双色球 2003-2012 补全段

输出：./lottery-data.json
"""

import argparse
import json
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# 注意：体彩接口缺少 Referer 会返回风控 HTML 页面而非 JSON
REF_DLT = "https://www.lottery.gov.cn/kj/kjlb.html?dlt"
REF_SSQ = "https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/"

DLT_API = "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry"
SSQ_API = "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"
SSQ_500 = "https://datachart.500.com/ssq/history/newinc/history.php"

GAP = 1.5  # 请求间隔（秒），抓取纪律：不要压垮官方接口


def http_get(url, referer, timeout=25, retries=3):
    """带退避重试的 GET，返回 bytes"""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Referer": referer,
                "Accept": "application/json, text/plain, */*",
            })
            return urllib.request.urlopen(req, timeout=timeout).read()
        except Exception as e:                       # noqa: BLE001
            last = e
            time.sleep(GAP * (2 ** i))
    raise RuntimeError(f"请求失败 {url} -> {last}")


def decode(raw, prefer="utf-8"):
    for enc in (prefer, "gbk", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


# ---------------- 大乐透 ----------------
def fetch_dlt(max_pages=30, page_size=100):
    """大乐透：前区 5 + 后区 2，gameNo=85"""
    out, total = [], None
    for page in range(1, max_pages + 1):
        url = (f"{DLT_API}?gameNo=85&provinceId=0"
               f"&pageSize={page_size}&pageNo={page}&isVerify=1")
        data = json.loads(decode(http_get(url, REF_DLT)))
        value = data.get("value", {}) or {}
        if total is None:
            total = value.get("total")
            print(f"  大乐透总期数: {total}")
        rows = value.get("list") or []
        if not rows:
            break
        for r in rows:
            nums = (r.get("lotteryDrawResult") or "").split()
            if len(nums) < 7:
                continue
            out.append({
                "lottery": "dlt",
                "issue": r.get("lotteryDrawNum"),
                "date": (r.get("lotteryDrawTime") or "")[:10],
                "front": [int(x) for x in nums[:5]],
                "back": [int(x) for x in nums[5:7]],
                "pool": (r.get("poolBalanceAfterdraw") or "").replace(",", ""),
                "sales": r.get("totalSaleAmount"),
                "source": "official",
            })
        print(f"    第 {page} 页 +{len(rows)} 条")
        if len(rows) < page_size:
            break
        time.sleep(GAP)
    return out


# ---------------- 双色球（官方，2013 至今） ----------------
def fetch_ssq(max_pages=5, page_size=500):
    out = []
    for page in range(1, max_pages + 1):
        url = (f"{SSQ_API}?name=ssq&pageNo={page}"
               f"&pageSize={page_size}&systemType=PC")
        data = json.loads(decode(http_get(url, REF_SSQ)))
        if page == 1:
            print(f"  双色球总期数: {data.get('total')}")
        rows = data.get("result") or []
        if not rows:
            break
        for r in rows:
            red = [int(x) for x in (r.get("red") or "").split(",") if x]
            blue = [int(x) for x in (r.get("blue") or "").split(",") if x]
            if len(red) < 6 or len(blue) < 1:
                continue
            prizes = {str(p.get("type")): p.get("typemoney")
                      for p in (r.get("prizegrades") or []) if p.get("type")}
            out.append({
                "lottery": "ssq",
                "issue": r.get("code"),
                "date": (r.get("date") or "")[:10],
                "front": red,
                "back": blue,
                "pool": r.get("poolmoney"),
                "sales": r.get("sales"),
                "prizes": prizes,
                "source": "official",
            })
        print(f"    第 {page} 页 +{len(rows)} 条")
        if len(rows) < page_size:
            break
        time.sleep(GAP)
    return out


# ---------------- 双色球早期补全（2003-2012，500.com） ----------------
def fetch_ssq_early(years=range(2003, 2013)):
    """官方接口最远只到 2013001，早期段需第三方补全（GBK HTML 解析）"""
    out = []
    for year in years:
        yy = str(year)[2:]
        url = f"{SSQ_500}?start={yy}001&end={yy}999"
        try:
            html = decode(http_get(url, "https://datachart.500.com/ssq/", retries=2), prefer="gbk")
        except Exception as e:                        # noqa: BLE001
            print(f"    {year} 年补全失败: {e}")
            continue
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
        n = 0
        for row in rows:
            cells = [re.sub(r"<[^>]+>", "", c).strip()
                     for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
            cells = [c for c in cells if c]
            # 期望列：序号, 期号, 红1..红6, 蓝
            if len(cells) < 9 or not re.fullmatch(r"\d{5}", cells[1]):
                continue
            try:
                nums = [int(c) for c in cells[2:9]]
            except ValueError:
                continue
            if len(nums) != 7:
                continue
            out.append({
                "lottery": "ssq",
                "issue": f"{year}{cells[1][2:]}",   # 03015 -> 2003015
                "date": "",
                "front": sorted(nums[:6]),
                "back": [nums[6]],
                "pool": None,
                "sales": None,
                "prizes": {},
                "source": "500com",   # 早期段无奖池与奖级，降级处理
            })
            n += 1
        print(f"    {year} 年 +{n} 条")
        time.sleep(GAP)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dlt-pages", type=int, default=30)
    ap.add_argument("--ssq-pages", type=int, default=5)
    ap.add_argument("--no-500com", action="store_true", help="跳过早期补全段")
    ap.add_argument("--out", default="lottery-data.json")
    args = ap.parse_args()

    t0 = time.time()
    print("开始抓取…")

    print("[1/3] 大乐透")
    dlt = fetch_dlt(args.dlt_pages)

    print("[2/3] 双色球（官方段）")
    ssq = fetch_ssq(args.ssq_pages)

    print("[3/3] 双色球（2003-2012 补全段）")
    early = [] if args.no_500com else fetch_ssq_early()

    # 合并去重：期号冲突时以官方数据为准
    merged = {}
    for rec in early + ssq:
        merged[("ssq", rec["issue"])] = rec
    for rec in dlt:
        merged[("dlt", rec["issue"])] = rec

    draws = sorted(merged.values(), key=lambda r: (r["lottery"], r["issue"]))
    dlt_n = sum(1 for r in draws if r["lottery"] == "dlt")
    ssq_n = sum(1 for r in draws if r["lottery"] == "ssq")

    packet = {
        "version": 1,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "counts": {"dlt": dlt_n, "ssq": ssq_n, "total": len(draws)},
        "draws": draws,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(packet, f, ensure_ascii=False, separators=(",", ":"))

    import os
    size = os.path.getsize(args.out) / 1024
    print(f"\n完成：{args.out}")
    print(f"  大乐透 {dlt_n} 期 · 双色球 {ssq_n} 期 · 合计 {len(draws)} 期")
    print(f"  文件大小 {size:.0f} KB · 耗时 {time.time()-t0:.0f} 秒")


if __name__ == "__main__":
    sys.exit(main())
