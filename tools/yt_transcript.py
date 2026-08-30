#!/usr/bin/env python3
"""유튜브 링크에서 자막(스크립트)을 시간초와 함께 뽑아내는 스크립트.

사용 예:
    python3 tools/yt_transcript.py "https://youtu.be/VIDEO_ID"
    python3 tools/yt_transcript.py VIDEO_ID --lang ko en --merge 15
    python3 tools/yt_transcript.py URL --format srt --out script.srt

자막을 가져오는 방법은 두 가지를 순서대로 시도한다.
  1) youtube-transcript-api  (pip install youtube-transcript-api)
  2) yt-dlp                  (pip install yt-dlp)
둘 다 없으면 설치 안내를 출력하고 종료한다.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def video_id(raw):
    """URL이든 ID든 11자리 video id로 정규화."""
    raw = raw.strip()
    if ID_RE.match(raw):
        return raw
    m = re.search(r"(?:v=|/shorts/|/embed/|/live/|youtu\.be/)([A-Za-z0-9_-]{11})", raw)
    if m:
        return m.group(1)
    raise SystemExit("유튜브 링크에서 video id를 찾지 못했습니다: %s" % raw)


# ---------------------------------------------------------------- 자막 수집

def via_transcript_api(vid, langs):
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return None

    api = YouTubeTranscriptApi()
    try:
        listing = api.list(vid)
    except AttributeError:  # 구버전 API
        raw = YouTubeTranscriptApi.get_transcript(vid, languages=langs)
        return [(c["start"], c["duration"], c["text"]) for c in raw]

    try:
        tr = listing.find_manually_created_transcript(langs)
    except Exception:
        try:
            tr = listing.find_generated_transcript(langs)
        except Exception:
            tr = next(iter(listing), None)
    if tr is None:
        return None
    return [(c.start, c.duration, c.text) for c in tr.fetch()]


def via_ytdlp(vid, langs):
    if subprocess.call(["which", "yt-dlp"], stdout=subprocess.DEVNULL) != 0:
        return None

    with tempfile.TemporaryDirectory() as tmp:
        cmd = [
            "yt-dlp", "--skip-download",
            "--write-subs", "--write-auto-subs",
            "--sub-langs", ",".join(langs) + ",-live_chat",
            "--sub-format", "json3",
            "-o", os.path.join(tmp, "%(id)s.%(ext)s"),
            "https://www.youtube.com/watch?v=" + vid,
        ]
        if subprocess.call(cmd) != 0:
            return None

        files = sorted(glob.glob(os.path.join(tmp, "*.json3")))
        if not files:
            return None
        # 요청한 언어 순서를 우선한다.
        def rank(path):
            for i, lang in enumerate(langs):
                if ".%s." % lang in os.path.basename(path):
                    return i
            return len(langs)
        with open(sorted(files, key=rank)[0], encoding="utf-8") as fh:
            data = json.load(fh)

    out = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text:
            continue
        out.append((ev.get("tStartMs", 0) / 1000.0,
                    ev.get("dDurationMs", 0) / 1000.0,
                    text))
    return out or None


def fetch(vid, langs):
    for grab in (via_transcript_api, via_ytdlp):
        cues = grab(vid, langs)
        if cues:
            return cues
    raise SystemExit(
        "자막을 가져오지 못했습니다. 아래 중 하나를 설치한 뒤 다시 실행하세요.\n"
        "  pip install youtube-transcript-api\n"
        "  pip install yt-dlp\n"
        "(설치돼 있는데도 실패하면 해당 영상에 자막이 없거나 비공개일 수 있습니다.)"
    )


# ---------------------------------------------------------------- 가공/출력

def merge(cues, window):
    """window초 단위로 문장을 뭉쳐서 읽기 좋게 만든다."""
    if window <= 0:
        return cues
    out = []
    start = end = None
    buf = []
    for s, d, text in cues:
        if start is None:
            start = s
        if buf and text == buf[-1]:   # 자동자막의 반복 줄 제거
            end = s + d
            continue
        buf.append(text)
        end = s + d
        if end - start >= window:
            out.append((start, end - start, " ".join(buf)))
            start, buf = None, []
    if buf:
        out.append((start, (end or start) - start, " ".join(buf)))
    return out


def stamp(sec):
    sec = int(sec)
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


def srt_stamp(sec):
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def render(cues, fmt):
    if fmt == "plain":
        return "\n".join(text for _, _, text in cues)
    if fmt == "json":
        return json.dumps(
            [{"start": round(s, 3), "duration": round(d, 3), "text": t}
             for s, d, t in cues],
            ensure_ascii=False, indent=2)
    if fmt == "srt":
        blocks = []
        for i, (s, d, t) in enumerate(cues, 1):
            blocks.append("%d\n%s --> %s\n%s\n" % (i, srt_stamp(s), srt_stamp(s + d), t))
        return "\n".join(blocks)
    return "\n".join("[%s] %s" % (stamp(s), t) for s, _, t in cues)


def main():
    p = argparse.ArgumentParser(description="유튜브 자막을 시간초와 함께 추출")
    p.add_argument("url", nargs="+", help="유튜브 링크 또는 video id")
    p.add_argument("--lang", nargs="+", default=["ko", "en"],
                   help="선호 자막 언어 순서 (기본: ko en)")
    p.add_argument("--merge", type=float, default=0,
                   help="N초 단위로 문장 묶기 (예: 15). 0이면 원본 그대로")
    p.add_argument("--format", choices=["ts", "plain", "srt", "json"], default="ts",
                   help="출력 형식 (기본: ts = [분:초] 텍스트)")
    p.add_argument("--out", help="파일로 저장 (없으면 화면 출력)")
    args = p.parse_args()

    chunks = []
    for raw in args.url:
        vid = video_id(raw)
        cues = merge(fetch(vid, args.lang), args.merge)
        body = render(cues, args.format)
        chunks.append(body if len(args.url) == 1 else "# %s\n%s" % (vid, body))

    text = "\n\n".join(chunks)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print("저장 완료: %s (%d줄)" % (args.out, text.count("\n") + 1), file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
