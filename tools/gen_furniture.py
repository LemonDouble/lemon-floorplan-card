#!/usr/bin/env python3
"""
평면도용 가구 에셋을 gpt-image-2 로 생성한다.

  uv run --with openai gen_furniture.py [--quality low|medium|high] [항목...]

- 항목을 안 주면 ITEMS 전체를 병렬로 생성한다.
- 흰 배경으로 뽑고, 누끼는 스킬의 cutout.py 로 따로 딴다
  (gpt-image-2 는 background="transparent" 를 지원하지 않는다).
"""
import argparse, base64, os, pathlib, re, sys
from concurrent.futures import ThreadPoolExecutor

from openai import OpenAI

OUT = pathlib.Path(__file__).resolve().parent.parent / "assets" / "raw"

# slug: (한글 이름, 프롬프트에 넣을 영어 묘사)
ITEMS = {
    "sofa":        "a three-seat fabric sofa",
    "tv-stand":    "a low TV console cabinet with a flat-screen television on top",
    "bed":         "a queen size bed with pillows and a duvet",
    # 아래 4개는 "문 달린 큰 상자"라 그냥 두면 모델이 정면도를 그린다.
    # 윗면만 보인다고 못박아야 다른 항목과 시점이 맞는다.
    "wardrobe":    "the TOP SURFACE of a tall wardrobe closet, viewed from the ceiling looking "
                   "straight down - only the flat rectangular top panel is visible with a thin "
                   "seam line down the middle. The doors and handles are NOT visible from this angle",
    "sink-counter":"a kitchen counter with a sink and a cooktop",
    "fridge":      "the TOP SURFACE of a stainless steel refrigerator, viewed from the ceiling "
                   "looking straight down - a rectangle showing the flat top panel, with a thin "
                   "seam line across the front edge where the two doors meet and a subtle rounded "
                   "front edge so it reads as a fridge. The door fronts are NOT visible",
    "dining-table":"a small square dining table with two chairs",
    "desk":        "a rectangular study desk with a chair",
    "vacuum-dock": "a robot vacuum cleaner sitting on its charging dock",
    "toilet":      "a toilet bowl with a cistern",
    "washbasin":   "a bathroom washbasin with a mirror cabinet",
    "shoe-rack":   "a narrow shoe cabinet",
    "washer":      "the TOP SURFACE of a front-loading washing machine, viewed from the ceiling "
                   "looking straight down - only the flat rectangular top panel with a small "
                   "detergent drawer and a control strip along one edge is visible. The round "
                   "door is NOT visible from this angle",
    "dryer":       "the TOP SURFACE of a front-loading clothes dryer, viewed from the ceiling "
                   "looking straight down - only the flat rectangular top panel with a control "
                   "strip along one edge is visible. The round door is NOT visible from this angle",
    "plants":      "a cluster of three potted green plants of different sizes",
}

STYLE = (
    "Top-down orthographic view seen from directly above, "
    "architectural floor-plan furniture symbol, flat simple vector-like illustration, "
    "soft muted neutral colours, thin clean outlines, minimal detail, "
    "no perspective, no isometric angle, no 3D, no cast shadow. "
    "ISOLATED subject only on a SOLID FLAT PURE WHITE BACKGROUND (#FFFFFF) - "
    "no scenery, no floor, no room, no other objects, no gradient. "
    "The white background must be uniform and clean for chroma keying. "
    "No text, no labels, no dimensions, no watermark."
)


def api_key() -> str:
    raw = pathlib.Path.home().joinpath(".claude/secrets/.openai.secrets").read_text()
    m = re.search(r"(sk-[A-Za-z0-9_\-]+)", raw)
    if not m:
        sys.exit("openai secrets 파일에서 sk- 로 시작하는 키를 못 찾았습니다")
    return m.group(1)


def gen(client: OpenAI, slug: str, desc: str, quality: str) -> tuple[str, str]:
    try:
        r = client.images.generate(
            model="gpt-image-2",
            prompt=f"{desc}. {STYLE}",
            size="1024x1024",
            quality=quality,
            n=1,
            background="opaque",
            output_format="png",
        )
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{slug}.png").write_bytes(base64.b64decode(r.data[0].b64_json))
        u = r.usage
        cost = (u.input_tokens * 5 + u.output_tokens_details.image_tokens * 30) / 1_000_000
        return slug, f"ok  ${cost:.4f}"
    except Exception as e:                                   # noqa: BLE001
        return slug, f"FAIL  {type(e).__name__}: {e}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", default="low", choices=["low", "medium", "high"])
    ap.add_argument("items", nargs="*", help="비우면 전체")
    a = ap.parse_args()

    todo = {k: ITEMS[k] for k in (a.items or ITEMS)} if not a.items else \
           {k: ITEMS[k] for k in a.items if k in ITEMS}
    if not todo:
        sys.exit(f"알 수 없는 항목입니다. 가능: {', '.join(ITEMS)}")

    client = OpenAI(api_key=api_key())
    print(f"{len(todo)}개 생성 (quality={a.quality}) → {OUT}")
    with ThreadPoolExecutor(max_workers=6) as ex:
        for slug, msg in ex.map(lambda kv: gen(client, kv[0], kv[1], a.quality), todo.items()):
            print(f"  {slug:14s} {msg}")


if __name__ == "__main__":
    main()
