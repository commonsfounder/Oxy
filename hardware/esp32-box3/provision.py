#!/usr/bin/env python3
"""Sets up a BOX-3 for Adam over USB: Wi-Fi details plus a pairing made in the Adam app.

  python3 hardware/esp32-box3/provision.py --url http://192.168.1.20:3000

In the app, open Your Home and add a display. It shows a link and a one-time code; paste both when asked.
The Wi-Fi password and the code are typed here, never put on a command line, and the box keeps them in its own flash.
"""
import argparse
import getpass
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

from serial.tools import list_ports

from bridge import Box


def find_port():
    ports = [p.device for p in list_ports.comports() if p.vid == 0x303A and p.serial_number]
    if len(ports) != 1:
        sys.exit(f'Expected exactly one BOX-3 on USB, found {len(ports)}. Plug it in with a data cable.')
    return ports[0]


def lan_url():
    for interface in ('en0', 'en1'):
        out = subprocess.run(['ipconfig', 'getifaddr', interface], capture_output=True, text=True).stdout.strip()
        if out:
            return f'http://{out}:3000'
    return ''


def challenge_id(link):
    link = link.strip()
    match = re.search(r'challenge=([^&\s]+)', link)
    return urllib.parse.unquote(match.group(1)) if match else link


def redeem(base, challenge, code, name):
    body = json.dumps({'challengeId': challenge, 'code': code.strip(), 'displayName': name}).encode()
    request = urllib.request.Request(base + '/display/pair', data=body, headers={'content-type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        message = json.loads(error.read() or b'{}').get('error', f'HTTP {error.code}')
        sys.exit(f'Pairing failed: {message}')
    except OSError as error:
        sys.exit(f'Could not reach {base}: {error}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default=None, help="Adam server the box will talk to, e.g. http://192.168.1.20:3000 or https://...")
    parser.add_argument('--port', default=None)
    parser.add_argument('--name', default='Adam box')
    args = parser.parse_args()

    base = (args.url or input(f'Adam server address [{lan_url()}]: ').strip() or lan_url()).rstrip('/')
    if not re.match(r'^https?://', base):
        sys.exit('The address must start with http:// or https://')
    ssid = input('Wi-Fi name: ').strip()
    password = getpass.getpass('Wi-Fi password (hidden, empty for an open network): ')
    link = input('Pairing link from the Adam app: ').strip()
    code = getpass.getpass('One-time code from the Adam app (hidden): ')

    paired = redeem(base, challenge_id(link), code, args.name)
    config = {'ssid': ssid, 'pass': password, 'url': base, 'id': paired['display']['id'], 'token': paired['token']}

    box = Box(args.port or find_port())
    try:
        box.send('C', json.dumps(config).encode())
        kind, payload = box.receive(15)
        if kind != 'K':
            sys.exit(f'The box did not accept the details: {payload!r}')
    finally:
        box.serial.close()
    print('Done. The box is restarting; in about 20 seconds it should show "Online".')


if __name__ == '__main__':
    main()
