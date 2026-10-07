"""Detect the main face over a time range and print a smoothed track as JSON.

usage: face_track.py VIDEO START DURATION MODEL [FPS]
output: {"width": W, "height": H, "points": [{"t": sec, "cx": 0-1, "cy": 0-1, "found": bool}]}
"""
import json
import sys

import cv2

video, start, duration, model = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
fps = float(sys.argv[5]) if len(sys.argv) > 5 else 4.0

cap = cv2.VideoCapture(video)
width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
scale = min(1.0, 640.0 / width)
detector = cv2.FaceDetectorYN.create(model, "", (int(width * scale), int(height * scale)), 0.6, 0.3, 5000)

raw = []
steps = int(duration * fps)
for i in range(steps + 1):
    t = i / fps
    cap.set(cv2.CAP_PROP_POS_MSEC, (start + t) * 1000)
    ok, frame = cap.read()
    if not ok:
        break
    if scale != 1.0:
        frame = cv2.resize(frame, (int(width * scale), int(height * scale)))
    _, faces = detector.detect(frame)
    best = None
    frontal = 0.0
    count = 0
    if faces is not None and len(faces):
        count = len(faces)
        face = max(faces, key=lambda f: f[2] * f[3])
        best = (float((face[0] + face[2] / 2) / frame.shape[1]), float((face[1] + face[3] / 2) / frame.shape[0]))
        eye_distance = abs(face[6] - face[4]) + 1e-6
        offset = abs(face[8] - (face[4] + face[6]) / 2) / eye_distance
        frontal = float(max(0.0, 1.0 - offset / 0.5))
    raw.append((t, best, frontal, count))
cap.release()

# Fill gaps with the nearest known position, then smooth with a dead zone so the crop does not jitter.
known = [p for _, p, _, _ in raw if p]
fallback = (sum(p[0] for p in known) / len(known), sum(p[1] for p in known) / len(known)) if known else (0.5, 0.5)
points = []
current = None
last = None
for t, p, frontal, count in raw:
    if p:
        last = p
    target = p or last or fallback
    if current is None:
        current = target
    else:
        dx, dy = target[0] - current[0], target[1] - current[1]
        if abs(dx) > 0.025 or abs(dy) > 0.04:
            current = (current[0] + dx * 0.35, current[1] + dy * 0.35)
    points.append({"t": round(t, 2), "cx": round(current[0], 4), "cy": round(current[1], 4), "found": p is not None, "frontal": round(frontal, 2), "faces": count})

print(json.dumps({"width": width, "height": height, "points": points}))
