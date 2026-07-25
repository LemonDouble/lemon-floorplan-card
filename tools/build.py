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

    missing, inlined = [], 0

    def sub(m: re.Match) -> str:
        nonlocal inlined
        rel = m.group(2)
        f = ROOT / rel
        if not f.is_file():
            missing.append(rel)
            return m.group(0)
        mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        b64 = base64.b64encode(f.read_bytes()).decode()
        inlined += 1
        return f'{m.group(1)}="data:{mime};base64,{b64}"'

    # 상대경로만 인라인한다. <use href="#p-geosil"> 같은 fragment 참조와
    # 이미 절대/data 인 것은 건드리지 않는다.
    svg = re.sub(r'\b(href)="((?!data:|https?:|#|/)[^"]+)"', sub, svg)

    if missing:
        sys.exit("참조된 파일이 없습니다:\n  " + "\n  ".join(missing))

    # SVG 를 JS 문자열 리터럴로. json.dumps 가 따옴표·개행·백슬래시를 안전하게 이스케이프한다.
    js = (ROOT / SRC).read_text()
    marker = 'const EMBEDDED_SVG = ""; /*__FLOORPLAN__*/'
    if marker not in js:
        sys.exit(f"{SRC} 에서 주입 지점을 못 찾았습니다: {marker}")
    js = js.replace(marker, f"const EMBEDDED_SVG = {json.dumps(svg)};")

    DIST.mkdir(exist_ok=True)
    for stale in DIST.glob("*"):
        if stale.name != CARD:
            stale.unlink()
    (DIST / CARD).write_text(js)

    print(f"평면도       {len(svg.encode())/1024:8.1f} KB  (이미지 {inlined}개 인라인)")
    print(f"dist/{CARD}  {(DIST/CARD).stat().st_size/1024:8.1f} KB  ← HACS 배포본 (이 파일 하나면 끝)")


if __name__ == "__main__":
    main()
