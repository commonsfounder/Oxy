#!/usr/bin/env python3
"""Downloads single FSD50K clips without downloading the 30 GB archive: reads the zip's index with HTTP range
requests, then fetches only the bytes of each clip listed (paths like .../FSD50K.dev_audio/123.wav).

  python3 fetch.py <missing.txt>
"""
import json
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RECORD = "https://zenodo.org/api/records/4060432"
FILES = "https://zenodo.org/records/4060432/files/{}?download=1"

wanted = [Path(line) for line in Path(sys.argv[1]).read_text().split() if line]
sizes = {f["key"]: f["size"] for f in json.load(urllib.request.urlopen(RECORD))["files"]}


# Zenodo allows 133 requests a minute; stay under it, and wait when told to.
PER_MINUTE = 120
pace = threading.Lock()
next_slot = [0.0]


def wait_for_slot():
    with pace:
        now = time.monotonic()
        slot = max(now, next_slot[0])
        next_slot[0] = slot + 60 / PER_MINUTE
    time.sleep(max(0, slot - now))


def ranged(name, start, length):
    request = urllib.request.Request(FILES.format(name), headers={"Range": f"bytes={start}-{start + length - 1}"})
    for attempt in range(8):
        wait_for_slot()
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
            if len(data) == length:
                return data
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 7:
                raise
            time.sleep(int(error.headers.get("retry-after", "60")))
        except Exception:
            if attempt == 7:
                raise
    raise IOError(f"short read from {name}")


class Archive:
    """A split zip (name.z01, name.z02, ..., name.zip) read over HTTP."""

    def __init__(self, stem):
        parts = sorted(key for key in sizes if key.startswith(stem + ".z") and key != stem + ".zip")
        self.parts = parts + [stem + ".zip"]
        self.entries = self._index()

    def read(self, disk, offset, length):
        out = b""
        while length > 0:
            part = self.parts[disk]
            take = min(length, sizes[part] - offset)
            out += ranged(part, offset, take)
            length -= take
            disk, offset = disk + 1, 0
        return out

    def remaining(self, disk, offset):
        return sum(sizes[part] for part in self.parts[disk:]) - offset

    def locate(self, disk, offset):
        while offset >= sizes[self.parts[disk]]:
            offset -= sizes[self.parts[disk]]
            disk += 1
        return disk, offset

    def _index(self):
        last = len(self.parts) - 1
        tail_length = min(sizes[self.parts[last]], 1 << 16)
        tail = ranged(self.parts[last], sizes[self.parts[last]] - tail_length, tail_length)
        locator = tail.rfind(b"PK\x06\x07")
        _, _, end64_disk_offset, _ = struct.unpack("<IIQI", tail[locator:locator + 20])
        end64 = tail[tail.rfind(b"PK\x06\x06"):]
        cd_disk, = struct.unpack("<I", end64[20:24])
        cd_size, cd_offset = struct.unpack("<QQ", end64[40:56])
        directory = self.read(cd_disk, cd_offset, cd_size)
        entries, at = {}, 0
        while at < len(directory) and directory[at:at + 4] == b"PK\x01\x02":
            (method, compressed, uncompressed, name_length, extra_length, comment_length, disk,
             offset) = struct.unpack("<10xH8xIIHHHH6xI", directory[at:at + 46])
            name = directory[at + 46:at + 46 + name_length].decode()
            extra = directory[at + 46 + name_length:at + 46 + name_length + extra_length]
            # Zip64: whichever fields were 0xFFFFFFFF / 0xFFFF are listed in order in the 0x0001 extra field.
            pointer = 0
            while pointer < len(extra):
                tag, size = struct.unpack("<HH", extra[pointer:pointer + 4])
                if tag == 1:
                    values, field = extra[pointer + 4:pointer + 4 + size], 0
                    if uncompressed == 0xFFFFFFFF:
                        uncompressed, = struct.unpack("<Q", values[field:field + 8]); field += 8
                    if compressed == 0xFFFFFFFF:
                        compressed, = struct.unpack("<Q", values[field:field + 8]); field += 8
                    if offset == 0xFFFFFFFF:
                        offset, = struct.unpack("<Q", values[field:field + 8]); field += 8
                    if disk == 0xFFFF:
                        disk, = struct.unpack("<I", values[field:field + 4])
                pointer += 4 + size
            entries[name.split("/")[-1]] = (method, compressed, disk, offset, name_length)
            at += 46 + name_length + extra_length + comment_length
        return entries

    def extract(self, file_name, destination):
        method, compressed, disk, offset, name_length = self.entries[file_name]
        # One request for header and data: the local header's extra field is unknown until read, so take some slack.
        slack = 30 + name_length + 256
        chunk = self.read(disk, offset, min(slack + compressed, self.remaining(disk, offset)))
        local_name, extra_length = struct.unpack("<HH", chunk[26:30])
        begin = 30 + local_name + extra_length
        data = chunk[begin:begin + compressed]
        if len(data) < compressed:
            data += self.read(*self.locate(disk, offset + len(chunk)), compressed - len(data))
        if method == 8:
            data = zlib.decompress(data, -15)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.with_suffix(".part").write_bytes(data)
        destination.with_suffix(".part").rename(destination)


archives = {}
for stem in sorted({path.parent.name for path in wanted}):
    archives[stem] = Archive(stem)
    print(f"{stem}: {len(archives[stem].entries)} clips in the archive")

done = 0


def fetch(path):
    global done
    if not path.exists():
        archives[path.parent.name].extract(path.name, path)
    done += 1
    if done % 250 == 0:
        print(f"{done}/{len(wanted)}", flush=True)


with ThreadPoolExecutor(8) as pool:
    list(pool.map(fetch, wanted))
print(f"fetched {len(wanted)} clips")
