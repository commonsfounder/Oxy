#!/usr/bin/env python3
"""Bounded USB microphone/speaker bridge to Adam's existing local runtime."""
import argparse
import json
import math
import pathlib
import struct
import subprocess
import tempfile
import time
import wave

import serial
from serial.tools import list_ports

ROOT = pathlib.Path(__file__).resolve().parents[2]
MAX_FRAME = 16000 * 2 * 30


def find_port():
    ports = [p.device for p in list_ports.comports() if p.vid == 0x303A and p.serial_number]
    if len(ports) != 1:
        raise RuntimeError(f'Expected exactly one BOX-3 on USB, found {len(ports)}')
    return ports[0]


class Box:
    def __init__(self, port):
        matches = [p for p in list_ports.comports() if p.device == port]
        if not matches or matches[0].vid != 0x303A or not matches[0].serial_number:
            raise RuntimeError('Selected port is not an identified Espressif USB device')
        self.device_id = 'box3-' + matches[0].serial_number.replace(':', '').lower()
        self.pending_audio = []
        self.serial = serial.Serial(port, 115200, timeout=0.2, write_timeout=15)
        try:
            time.sleep(3)
            self.serial.reset_input_buffer()
            self.send('H')
            deadline = time.monotonic() + 40
            while True:
                kind, payload = self.receive(max(1, deadline - time.monotonic()))
                if kind == 'H' and payload == b'adam-box3-usb-v1':
                    break
                if kind == 'A':
                    self.pending_audio.append(payload)
                elif kind != 'K':
                    raise RuntimeError(f'Unexpected handshake frame: {kind!r}, {payload[:60]!r}')
                if time.monotonic() >= deadline:
                    raise TimeoutError('Adam BOX-3 handshake timed out')
        except BaseException:
            self.serial.close()
            raise

    def send(self, kind, payload=b''):
        if len(payload) > MAX_FRAME:
            raise RuntimeError('Audio exceeds 30-second transport limit')
        data = b'ADAM' + kind.encode() + struct.pack('<I', len(payload)) + payload
        view = memoryview(data)
        while view:
            count = self.serial.write(view[:4096])
            if not count:
                raise RuntimeError('USB write stalled')
            view = view[count:]
        self.serial.flush()

    def read_exact(self, size, deadline):
        data = bytearray()
        while len(data) < size and time.monotonic() < deadline:
            data.extend(self.serial.read(size - len(data)))
        if len(data) != size:
            raise TimeoutError('BOX-3 frame timed out')
        return bytes(data)

    def receive(self, timeout=40):
        deadline = time.monotonic() + timeout
        prefix = bytearray()
        while bytes(prefix) != b'ADAM':
            prefix.extend(self.read_exact(1, deadline))
            prefix = prefix[-4:]
        kind = self.read_exact(1, deadline).decode()
        size = struct.unpack('<I', self.read_exact(4, deadline))[0]
        if size > MAX_FRAME:
            raise RuntimeError('Invalid incoming frame length')
        payload = self.read_exact(size, deadline)
        if kind in ('D', 'B'):  # startup checkpoints and alarm reports are not replies; keep waiting for one
            if kind == 'B':
                print(json.dumps({'alarm_heard': payload.decode(errors='replace')}), flush=True)
            return self.receive(max(1, deadline - time.monotonic()))
        if kind == 'E':
            raise RuntimeError('BOX-3: ' + payload.decode(errors='replace'))
        return kind, payload

    def speak(self, wav_path):
        with wave.open(str(wav_path), 'rb') as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
                raise RuntimeError('Playback must be mono 16kHz PCM16')
            payload = wav.readframes(wav.getnframes())
        self.send('S', payload)
        kind, _ = self.receive(50)
        if kind != 'K':
            raise RuntimeError('Speaker acknowledgement missing')
        print(json.dumps({'speaker_acknowledged': True, 'bytes': len(payload)}), flush=True)


def run_turn(box, audio, directory):
    samples = struct.unpack('<' + 'h' * (len(audio) // 2), audio)
    rms = math.sqrt(sum(n * n for n in samples) / max(len(samples), 1))
    print(json.dumps({'microphone_bytes': len(audio), 'rms': round(rms, 2), 'peak': max(map(abs, samples), default=0)}), flush=True)
    if rms < 20:
        raise RuntimeError('Microphone capture is silent')
    source = directory / 'capture.wav'
    with wave.open(str(source), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(audio)
    output, result = directory / 'reply.wav', directory / 'result.json'
    box.send('P')
    kind, payload = box.receive(10)
    if kind != 'P':
        raise RuntimeError('Expected fresh sensor snapshot before voice turn')
    sensor_input = directory / 'sensors.json'
    sensor_input.write_bytes(payload)
    box.send('T', b'Thinking')
    try:
        subprocess.run(['node', 'api/physical/box3-voice.js', '--input', str(source), '--output', str(output), '--result', str(result), '--device', box.device_id, '--sensor-input', str(sensor_input)], cwd=ROOT, check=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        box.send('T', b'Voice connection error')
        raise
    print(result.read_text(), flush=True)
    box.speak(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', default=None, help='USB port; found automatically when exactly one BOX-3 is plugged in')
    parser.add_argument('--speak', type=pathlib.Path)
    parser.add_argument('--ask')
    parser.add_argument('--record', action='store_true')
    parser.add_argument('--sensors', action='store_true')
    parser.add_argument('--seconds', type=int, default=20)
    parser.add_argument('--turns', type=int, default=1)
    parser.add_argument('--wait', type=int, default=90)
    args = parser.parse_args()
    box = Box(args.port or find_port())
    try:
        print(json.dumps({'connected': box.device_id, 'firmware': 'adam-box3-usb-v1'}), flush=True)
        if args.sensors:
            box.send('D')
            snapshots = []
            deadline = time.monotonic() + args.seconds
            while time.monotonic() < deadline:
                box.send('P')
                kind, payload = box.receive(10)
                if kind != 'P':
                    raise RuntimeError('Expected sensor snapshot')
                snapshot = json.loads(payload)
                snapshots.append(snapshot)
                print(json.dumps(snapshot), flush=True)
                time.sleep(1)
            destination = ROOT / 'data/box3/sensor-readings.json'
            destination.write_text(json.dumps({'deviceId': box.device_id, 'snapshots': snapshots}, indent=2))
            destination.chmod(0o600)
            return
        if args.speak:
            box.speak(args.speak)
            return
        if args.ask:
            with tempfile.TemporaryDirectory(prefix='adam-box3-') as temporary:
                directory = pathlib.Path(temporary)
                box.send('P')
                kind, payload = box.receive(10)
                if kind != 'P':
                    raise RuntimeError('Expected fresh sensor snapshot')
                source = directory / 'sensors.json'
                source.write_bytes(payload)
                output, result = directory / 'reply.wav', directory / 'result.json'
                box.send('T', b'Thinking')
                subprocess.run(['node', 'api/physical/box3-voice.js', '--text', args.ask, '--sensor-input', str(source), '--output', str(output), '--result', str(result), '--device', box.device_id], cwd=ROOT, check=True, timeout=120)
                print(result.read_text(), flush=True)
                box.speak(output)
            return
        with tempfile.TemporaryDirectory(prefix='adam-box3-') as temporary:
            directory = pathlib.Path(temporary)
            for _ in range(args.turns):
                if args.record:
                    box.send('R')
                else:
                    print('Ready for Talk on BOX-3', flush=True)
                if box.pending_audio:
                    kind, audio = 'A', box.pending_audio.pop(0)
                else:
                    kind, audio = box.receive(args.wait)
                if kind != 'A':
                    raise RuntimeError('Expected microphone audio')
                run_turn(box, audio, directory)
    finally:
        try:
            box.send('D')
        except (OSError, serial.SerialException):
            pass
        finally:
            box.serial.close()


if __name__ == '__main__':
    main()
