"""Small audio helpers for building hard test and training sets: load, mix at a noise level, add a room echo, crop."""
import wave

import numpy as np

RATE = 16000


def load(path):
    """Mono float32 at 16 kHz, or None if the file can't be read."""
    try:
        with wave.open(str(path), "rb") as handle:
            channels, width, rate, frames = handle.getnchannels(), handle.getsampwidth(), handle.getframerate(), handle.getnframes()
            raw = handle.readframes(frames)
    except Exception:
        return None
    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    elif width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        data = (((b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)) << 8) >> 8).astype(np.float32) / 8388608
    else:
        return None
    if channels > 1:
        data = data[: len(data) // channels * channels].reshape(-1, channels).mean(axis=1)
    if len(data) == 0:
        return None
    return resample(data, rate)


def resample(data, rate):
    if rate == RATE:
        return data
    if rate > RATE:
        taps = 63
        cutoff = 0.45 * RATE / rate
        n = np.arange(taps) - taps // 2
        kernel = np.sinc(2 * cutoff * n) * np.hanning(taps)
        data = np.convolve(data, kernel / kernel.sum(), mode="same")
    positions = np.arange(0, len(data) - 1, rate / RATE)
    return np.interp(positions, np.arange(len(data)), data).astype(np.float32)


def save(path, data):
    data = np.clip(data, -1, 1)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes((data * 32767).astype("<i2").tobytes())


def _moving_sum(values, window):
    total = np.concatenate([[0.0], np.cumsum(values, dtype=np.float64)])
    return total[window:] - total[:-window]


def rms(data):
    return float(np.sqrt(np.mean(np.square(data)) + 1e-12))


def active_rms(data, window=RATE // 2):
    """Loudness of the loudest half second, so silent padding doesn't make a sound look quiet."""
    if len(data) <= window:
        return rms(data)
    return float(np.sqrt(_moving_sum(np.square(data), window).max() / window + 1e-12))


def loudest(data, seconds):
    """The loudest stretch of the given length."""
    size = int(seconds * RATE)
    if len(data) <= size:
        return data
    start = int(_moving_sum(np.square(data), size).argmax())
    return data[start:start + size]


def noise_like(pool, length, rng):
    """A noise bed of the given length, stitched from random clips of the pool."""
    out = np.zeros(0, dtype=np.float32)
    while len(out) < length:
        piece = pool[rng.integers(len(pool))]
        out = np.concatenate([out, piece / max(rms(piece), 1e-4)])
    start = rng.integers(0, max(1, len(out) - length + 1))
    return out[start:start + length]


def mix(signal, noise, snr_db):
    """Signal plus noise scaled so the signal's active level is snr_db above the noise."""
    target = active_rms(signal) / (10 ** (snr_db / 20))
    return signal + noise[:len(signal)] / max(rms(noise[:len(signal)]), 1e-6) * target


def reverb(data, rng, rt60=None):
    rt60 = rt60 or rng.uniform(0.4, 1.0)
    length = int(rt60 * RATE)
    t = np.arange(length) / RATE
    tail = rng.standard_normal(length) * np.exp(-6.9 * t / rt60)
    tail[: int(0.005 * RATE)] = 0
    response = np.zeros(length)
    response[0] = 1.0
    response += 0.35 * tail / np.abs(tail).max()
    size = len(data) + length
    out = np.fft.irfft(np.fft.rfft(data, size) * np.fft.rfft(response, size), size)[:len(data)]
    return (out * rms(data) / max(rms(out), 1e-6)).astype(np.float32)


def normalise(data, peak=0.9):
    top = np.abs(data).max()
    return data if top < 1e-6 else data * (peak / top) if top > peak else data
