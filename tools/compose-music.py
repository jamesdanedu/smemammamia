# Regenerate: python3 tools/compose-music.py out.wav && ffmpeg -i out.wav -c:a libmp3lame -b:a 96k audio/aegean-breeze.mp3
# then copy the printed loopStart/loopEnd into CONFIG.photoMusic in config.js.
"""Original Greek-style instrumental, synthesised from scratch.

Bouzouki-like plucked melody (Karplus-Strong, doubled courses, tremolo on long
notes) over a hasapiko-style boom-chick guitar and bass, D minor / F major.
Writes a WAV that is periodic: [last bar][32-bar loop][first bar], so a player
can loop between LOOP_START and LOOP_END with no seam even if the decoder
shifts the audio by the encoder's priming samples.
"""
import json, sys
import numpy as np
from scipy.signal import lfilter, fftconvolve, butter, sosfilt

FS = 44100
BPM = 104
E8 = round(60 / BPM / 2 * 44100) / 44100   # one eighth note, snapped to whole samples
BAR = 8 * E8
rng = np.random.default_rng(7)

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def ks(freq, dur, bright=0.7, decay=0.996, pos=0.18):
    """Karplus-Strong pluck."""
    n = int(dur * FS)
    N = max(2, int(round(FS / freq - 0.5)))
    exc = rng.uniform(-1, 1, N)
    # brightness: one-pole low-pass on the excitation
    exc = lfilter([bright], [1, -(1 - bright)], exc)
    # pluck position comb
    d = max(1, int(N * pos))
    exc = exc - np.concatenate([np.zeros(d), exc[:-d]])
    x = np.zeros(n); x[:N] = exc
    a = np.zeros(N + 2); a[0] = 1; a[N] = -decay / 2; a[N + 1] = -decay / 2
    y = lfilter([1.0], a, x)
    return y / (np.max(np.abs(y)) + 1e-9)

def bouzouki(m, dur, amp=1.0):
    ring = dur + 0.9
    y = ks(hz(m), ring, bright=0.85, decay=0.9975, pos=0.12)
    y += 0.45 * ks(hz(m + 12) * 1.0015, ring, bright=0.9, decay=0.997, pos=0.1)   # octave course
    y += 0.30 * ks(hz(m) * 0.998, ring, bright=0.8, decay=0.997, pos=0.15)        # paired string
    env = np.ones_like(y)
    stop = int(dur * FS)
    rel = np.exp(-np.arange(len(y) - stop) / (0.08 * FS))                        # damp at note end
    env[stop:] = rel
    return amp * y * env

def guitar(m, dur, amp=1.0):
    y = ks(hz(m), dur + 0.4, bright=0.35, decay=0.994, pos=0.25)
    env = np.ones_like(y); stop = int(dur * FS)
    env[stop:] = np.exp(-np.arange(len(y) - stop) / (0.05 * FS))
    return amp * y * env

def bass(m, dur, amp=1.0):
    y = ks(hz(m), dur + 0.3, bright=0.2, decay=0.995, pos=0.3)
    t = np.arange(len(y)) / FS
    y = 0.6 * y + 0.4 * np.sin(2 * np.pi * hz(m) * t) * np.exp(-t * 3)
    env = np.ones_like(y); stop = int(dur * FS)
    env[stop:] = np.exp(-np.arange(len(y) - stop) / (0.04 * FS))
    return amp * y * env

# ---------------------------------------------------------------- the tune
# (midi, eighths, tremolo?)  D4=62 E4=64 F4=65 G4=67 A4=69 Bb4=70 C5=72 C#5=73 D5=74 E5=76 F5=77 G5=79
A = [
    [(69,2),(74,1),(76,1),(77,2),(76,1),(74,1)],
    [(76,1),(77,1),(76,1),(74,1),(73,2),(74,2)],
    [(70,2),(74,1),(70,1),(67,2),(69,1),(70,1)],
    [(69,4,'t'),(67,1),(65,1),(64,2)],
    [(62,1),(64,1),(65,1),(67,1),(69,2),(74,2)],
    [(72,1),(74,1),(76,1),(72,1),(67,4,'t')],
    [(70,1),(69,1),(67,1),(65,1),(64,1),(65,1),(67,1),(64,1)],
    [(62,6,'t'),(57,2)],
]
A2 = A[:7] + [[(62,8,'t')]]
B = [
    [(77,2),(76,1),(74,1),(72,2),(69,2)],
    [(67,1),(69,1),(70,1),(72,1),(74,2),(72,2)],
    [(74,1),(72,1),(70,1),(69,1),(70,2),(74,2)],
    [(72,4,'t'),(69,2),(65,2)],
    [(67,1),(69,1),(70,1),(74,1),(79,2),(77,2)],
    [(76,1),(77,1),(76,1),(74,1),(69,4,'t')],
    [(70,1),(69,1),(67,1),(65,1),(64,2),(73,2)],
    [(74,6,'t'),(69,2)],
]
B2 = B[:7] + [[(74,4,'t'),(73,1),(74,1),(76,1),(73,1)]]   # turnaround back to the top
MELODY = A + A2 + B + B2

# chords per bar: (bass root, fifth, voicing)
DM = (50, 57, [62, 65, 69]); GM = (43, 50, [62, 67, 70]); A7 = (45, 52, [61, 64, 67])
C  = (48, 55, [60, 64, 67]); F  = (41, 48, [60, 65, 69]); BB = (46, 53, [62, 65, 70])
CH_A = [DM, DM, GM, A7, DM, C, (GM, A7), DM]
CH_B = [F, C, BB, F, GM, DM, A7, DM]
CHORDS = CH_A + CH_A + CH_B + CH_B[:7] + [A7]

LOOP_BARS = len(MELODY)
L = LOOP_BARS * BAR

mixL = mixR = None

def place(sig, t, pan=0.0):
    i = int(round(t * FS))
    gl, gr = np.sqrt(0.5 * (1 - pan)), np.sqrt(0.5 * (1 + pan))
    j = min(len(mixL), i + len(sig))
    mixL[i:j] += gl * sig[:j - i]; mixR[i:j] += gr * sig[:j - i]

def render_loop(offset):
    global rng
    rng = np.random.default_rng(7)          # identical every pass → seamless loop
    t = offset
    for bar in MELODY:
        for note in bar:
            m, d = note[0], note[1] * E8
            if len(note) > 2:                         # tremolo: 16th-note repeated picks
                k = int(round(d / (E8 / 2)))
                for r in range(k):
                    place(bouzouki(m, E8 / 2, 0.55 + 0.1 * (r % 2) - 0.25 * r / k), t + r * E8 / 2, 0.15)
            else:
                place(bouzouki(m, d * 0.95, 0.8 + rng.uniform(-0.05, 0.05)), t, 0.15)
            t += d
    for b, ch in enumerate(CHORDS):
        t0 = offset + b * BAR
        split = isinstance(ch[0], tuple)
        first, second = ch if split else (ch, ch)
        # beat 1: root  · beat 2: chick
        place(bass(first[0], 2 * E8 * 0.9, 0.9), t0, -0.1)
        for s_, v in enumerate(first[2]):
            place(guitar(v, E8 * 0.8, 0.28), t0 + 2 * E8 + s_ * 0.012, -0.35)
        # beat 3: fifth (or new root if the bar changes chord) · beat 4: chick + off-beat chick
        place(bass(second[0] if split else second[1], 2 * E8 * 0.9, 0.75), t0 + 4 * E8, -0.1)
        for s_, v in enumerate(second[2]):
            place(guitar(v, E8 * 0.8, 0.28), t0 + 6 * E8 + s_ * 0.012, -0.35)
            place(guitar(v, E8 * 0.5, 0.18), t0 + 7 * E8 + s_ * 0.010, -0.35)

# Render the loop three times back to back and keep [L - BAR, 2L + BAR]:
# the middle copy then has the real ringing-over from the copy before it.
mixL = np.zeros(int((3 * L + 4) * FS)); mixR = np.zeros_like(mixL)
for k in range(3):
    render_loop(k * L)

# reverb
ir_n = int(1.8 * FS)
ir = rng.standard_normal(ir_n) * np.exp(-np.arange(ir_n) / (0.42 * FS))
ir = sosfilt(butter(2, 4500, fs=FS, output='sos'), ir); ir /= np.sqrt(np.sum(ir ** 2))
ir2 = np.roll(ir, 311)
wetL = fftconvolve(mixL, ir)[:len(mixL)]; wetR = fftconvolve(mixR, ir2)[:len(mixR)]
outL = mixL + 0.22 * wetL; outR = mixR + 0.22 * wetR

s0, s1 = int((L - BAR) * FS), int((2 * L + BAR) * FS)
out = np.stack([outL[s0:s1], outR[s0:s1]], axis=1)
out = sosfilt(butter(1, 60, 'hp', fs=FS, output='sos'), out, axis=0)
out *= 0.5 / np.max(np.abs(out))            # quiet master: peak -6 dBFS
import wave
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(FS)
    w.writeframes((out * 32767).astype('<i2').tobytes())
print(json.dumps({"loopStart": round(BAR, 6), "loopEnd": round(BAR + L, 6), "length": round(len(out) / FS, 3)}))
