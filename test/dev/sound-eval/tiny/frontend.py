"""The audio -> spectrogram step in front of EfficientAT, in two forms.

FRONTEND=32k (default): upsample our 16 kHz audio to 32 kHz and use the settings the AudioSet weights were trained with.
FRONTEND=16k: compute the spectrogram straight from 16 kHz audio (window 400, hop 160, FFT 512), which is what a
BOX-3 microphone delivers and the only form that is cheap to compute on a chip. Both give 128 x 201 for 2 s of audio.
"""
import os

import torch
import torchaudio


def make():
    from models.preprocess import AugmentMelSTFT
    if os.environ.get("FRONTEND", "32k") == "16k":
        mel = AugmentMelSTFT(n_mels=128, sr=16000, win_length=400, hopsize=160, n_fft=512).eval()
        return lambda x: mel(x)
    mel = AugmentMelSTFT(n_mels=128, sr=32000, win_length=800, hopsize=320).eval()
    return lambda x: mel(torchaudio.functional.resample(x, 16000, 32000))
