#!/usr/bin/env python3
"""
HACS 배포용 dist/ 를 만든다.

  uv run --with pillow python tools/build.py

HACS 는 plugin 릴리스에서 "레포 이름과 같은 .js" 파일 하나만 가져간다.
dist 에 floorplan.svg 를 같이 넣어봤지만 받아가지 않았다 (/hacsfiles/.../floorplan.svg → 404).
그래서 배포본은 .js 한 개로 자족하게 만든다:

  fp/*.webp  --(data URI)-->  floorplan.svg  --(문자열)-->  dist/lemon-floorplan-card.js

부수 효과로 상대경로 문제도 사라진다 — 카드가 SVG 를 shadow DOM 에 인라인하면
내부 상대경로가 "보고 있는 페이지 URL" 기준으로 풀리는데, data URI 는 그 영향을 안 받는다.
"""
import base64, json, mimetypes, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SRC  = "src/card.js"
CARD = "lemon-floorplan-card.js"
PLAN = "floorplan.svg"


def main() -> None:
    svg = (ROOT / PLAN).read_text()

    # SVG 안의 상대경로를 그대로 두고, 에셋은 따로 모아 JS 맵으로 넘긴다.
    # 예전에는 href 를 만날 때마다 data URI 를 박아 넣었는데, 천장등처럼 같은
    # 파일을 7번 쓰면 7벌이 들어가서 1.2MB 가 됐다. 맵으로 빼면 한 벌만 담긴다.
    used = sorted(set(re.findall(r'href="((?!data:|https?:|#|/)[^"]+)"', svg)))
    missing = [r for r in used if not (ROOT / r).is_file()]
    if missing:
        sys.exit("참조된 파일이 없습니다:\n  " + "\n  ".join(missing))

    assets = {}
    for rel in used:
        f = ROOT / rel
        mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        assets[rel] = f"data:{mime};base64," + base64.b64encode(f.read_bytes()).decode()
    inlined = len(assets)

    # SVG 를 JS 문자열 리터럴로. json.dumps 가 따옴표·개행·백슬래시를 안전하게 이스케이프한다.
    js = (ROOT / SRC).read_text()
    for marker, value in (
        ('const EMBEDDED_SVG = ""; /*__FLOORPLAN__*/', json.dumps(svg)),
        ('const EMBEDDED_ASSETS = {}; /*__ASSETS__*/', json.dumps(assets)),
    ):
        if marker not in js:
            sys.exit(f"{SRC} 에서 주입 지점을 못 찾았습니다: {marker}")
        js = js.replace(marker, marker.split("=")[0] + "= " + value + ";")

    DIST.mkdir(exist_ok=True)
    for stale in DIST.glob("*"):
        if stale.name != CARD:
            stale.unlink()
    (DIST / CARD).write_text(js)

    a = sum(len(v) for v in assets.values()) / 1024
    print(f"평면도       {len(svg.encode())/1024:8.1f} KB")
    print(f"에셋         {a:8.1f} KB  ({inlined}종, 중복 없음)")
    print(f"dist/{CARD}  {(DIST/CARD).stat().st_size/1024:8.1f} KB  ← HACS 배포본 (이 파일 하나면 끝)")


if __name__ == "__main__":
    main()
