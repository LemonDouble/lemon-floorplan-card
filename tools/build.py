#!/usr/bin/env python3
"""
HACS 배포용 dist/ 를 만든다.

  uv run --with pillow python tools/build.py

HACS 는 plugin 을 받을 때 dist/ 를 먼저 본다. "js 가 아닌 파일이 필요하면 카드 파일까지
전부 dist 에 넣어라" 까지는 문서에 있지만, dist 하위 디렉토리를 재귀적으로 받아주는지는
문서에 없다. 그래서 fp/ 를 통째로 SVG 안에 data URI 로 인라인해서
dist 를 평면 2파일(js + svg)로 만든다.

부수 효과로 상대경로 문제도 사라진다 — 카드가 SVG 를 shadow DOM 에 인라인하면
내부 상대경로가 "보고 있는 페이지 URL" 기준으로 풀리는데, data URI 는 그 영향을 안 받는다.
"""
import base64, mimetypes, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
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

    DIST.mkdir(exist_ok=True)
    (DIST / PLAN).write_text(svg)
    (DIST / CARD).write_text((ROOT / CARD).read_text())

    print(f"dist/{PLAN}  {len(svg.encode())/1024:8.1f} KB  (이미지 {inlined}개 인라인)")
    print(f"dist/{CARD}  {(DIST/CARD).stat().st_size/1024:8.1f} KB")


if __name__ == "__main__":
    main()
