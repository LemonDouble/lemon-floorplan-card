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
    "desk":        "a rectangular computer desk with a chair, a monitor on a stand and a keyboard "
                   "laid on the desktop, all seen from directly above",

    # ── HA 에 등록된 기기들 ────────────────────────────────────────────────
    "curtain":     "a pair of window curtains seen from directly above: a straight curtain rail "
                   "with two gathered fabric bundles at each end and a soft wavy fabric line "
                   "running between them, drawn as a long thin horizontal element",
    "speaker":     "a small round smart speaker seen from directly above - a fabric-covered "
                   "circular puck with a subtle ring on top",
    # 주의: "circular grille" 같은 말을 넣으면 실외기(condenser)가 나온다.
    # 실내 스탠드형은 위에서 보면 팬이 없는 좁고 긴 둥근 사각형이다.
    "ac-stand":    "the TOP SURFACE of a tall indoor floor-standing tower air conditioner, viewed "
                   "from the ceiling looking straight down. Its footprint is ROUGHLY SQUARE - "
                   "about as wide as it is deep (a real unit is ~36cm x 36cm) - drawn as a "
                   "rounded square with softly rounded front corners, a plain flat top panel and "
                   "one thin seam line near the front edge. Absolutely NO fan, NO circular "
                   "grille, NO vents on top - a big round fan would make it an outdoor condenser "
                   "unit, which this is NOT. Do not draw it as a long narrow slab",
    "ac-wall":     "the TOP SURFACE of a wall-mounted split air conditioner indoor unit, viewed "
                   "from the ceiling looking straight down - a long thin rounded rectangle with "
                   "a slim grille line along one long edge. The front panel is NOT visible",
    "air-purifier":"the TOP SURFACE of a cylindrical air purifier, viewed from the ceiling "
                   "looking straight down - a circle with a round mesh outlet grille and a small "
                   "control dial on top",
    "dehumidifier":"the TOP SURFACE of a boxy dehumidifier, viewed from the ceiling looking "
                   "straight down - a rounded rectangle with a slotted air outlet and a small "
                   "control panel on top",
    "humidifier":  "the TOP SURFACE of a cylindrical ultrasonic humidifier, viewed from the "
                   "ceiling looking straight down - a circle with a round mist nozzle opening "
                   "in the centre",
    "projector":   "the TOP SURFACE of a small home projector, viewed from the ceiling looking "
                   "straight down - a rounded rectangle with a focus ring and a couple of "
                   "buttons on top",
    "floor-lamp":  "a floor lamp seen from directly above - a round fabric lampshade circle with "
                   "a small round base visible at its centre",
    "led-strip":   "an LED light strip seen from directly above - a very long thin straight bar "
                   "with a soft even glow along its length",
    # 본체를 흰색으로 두면 누끼 3단계(순수 배경색 제거)가 피사체에 구멍을 낸다.
    # 흰 배경과 겹치지 않게 회색 본체로 못박는다.
    "air-monitor": "a small square air quality monitor seen from directly above - a rounded "
                   "square puck with a WARM MID-GREY body (clearly darker than white, never "
                   "white) and a slim dark display bezel on top",
    "scale":       "a square bathroom weighing scale seen from directly above - a flat glass "
                   "square with a small display strip near one edge",

    # ── 천장/벽 부착물. 평면도에서는 방 안 해당 위치에 심볼로 얹는다 ──────────
    "ceiling-light":"a round flush-mount ceiling light fixture seen straight on - a circle with "
                    "a soft warm glowing diffuser panel and a thin slim rim around it, "
                    "flat and simple",
    "exhaust-fan": "a square ceiling exhaust fan vent seen straight on - a square grille with "
                   "evenly spaced parallel slats and a small round hub in the middle",
    "table-lamp":  "a small bedside table lamp seen from directly above - a SQUARE fabric "
                   "lampshade with a small round finial dot at its centre (square shade, not "
                   "round, so it reads differently from a floor lamp)",
    "door-lock":   "a smart door lock keypad module seen from directly above - a small vertical "
                   "rounded rectangle with a subtle keypad grid and a thin handle bar beside it",
    "contact-sensor":"a door and window contact sensor seen from directly above - one slim small "
                     "rounded rectangle body with a smaller thin magnet block right next to it, "
                     "a narrow gap between the two",

    # ── 장식용. HA 엔티티와 연결하지 않는다 ──────────────────────────────
    # 흰 가구는 반드시 "순백 아님" 을 못박는다. 순수 흰색이면 누끼 3단계가
    # 배경으로 오인해 본체에 구멍을 낸다 (air-monitor 에서 실제로 겪음).
    "shelf-unit":  "the TOP SURFACE of a tall standing bookshelf unit viewed from directly above "
                   "- a long narrow light-wood top board with three thin vertical divider seams "
                   "showing the compartments below",
    "ac-outdoor":  "the TOP SURFACE of an outdoor air conditioner condenser unit viewed from "
                   "directly above - a rectangular metal box with a large circular fan guard "
                   "grille with radial bars on top",
    "plant-shelf": "a low plant stand shelf seen from directly above - a wooden rectangular "
                   "shelf board with three small potted green plants of different sizes "
                   "arranged on it",
    "wardrobe-white":"the TOP SURFACE of a tall two-door wardrobe closet, viewed from the ceiling "
                     "looking straight down - a rectangle showing the flat top panel with a thin "
                     "seam line down the middle. The body is a SOFT OFF-WHITE / very light warm "
                     "grey - clearly NOT pure white - with a visible thin darker outline. "
                     "The doors and handles are NOT visible from this angle",
    "table-white": "a plain rectangular table seen from directly above - a simple long rectangle "
                   "with slightly rounded corners and four thin legs just visible at the corners. "
                   "The top is SOFT OFF-WHITE / very light warm grey, clearly NOT pure white, "
                   "with a visible thin darker outline",
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
