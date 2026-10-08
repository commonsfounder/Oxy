# Sensor fusion and the house simulator

A sound on its own is a weak reason to interrupt someone (glass breaking alone fires about 6 times an hour on our dense test stream). `api/services/sensor-fusion.js` combines sounds with other sensors over a short window and raises one alert per situation. Wording is fixed in the code; no sensor can supply its own text.

**Rule that does not bend:** combining only ever *adds* to what is raised. A smoke or CO alarm heard on its own is still raised at once by the box's `/sound` route; a smoke or CO *sensor* alone also alerts.

## The 13 sensors
door contact, window contact, door lock, someone home/away (phone), motion, camera person, smoke particles, CO level, rapid temperature rise, water leak, impact/vibration, appliance power (running/finished), doorbell press. Sounds accepted: smoke_alarm, carbon_monoxide_alarm, sustained_beeping, glass_breaking, knock, door_slam, doorbell, baby_crying, scream, water_running, microwave.

## Rules (windows are short; each fires at most once per 10 minutes)
- Possible break-in: glass or an impact or a broken window, plus a window or door opening within a minute, while nobody is confirmed home (at home it is only a quiet check).
- Someone may be inside: a way in, then movement indoors, while away.
- Opened while you are out: a window opens (at once), or a door opens or unlocks and nobody says "home" within 90 seconds. Only openings *after* the house became empty count.
- Fire likely / CO confirmed: an alarm sound plus a second sensor. Smoke detected / CO detected: the sensor alone.
- Water leak (sensor); tap left running (water sound over 10 minutes, nobody near); visitor at the door (bell, press or knock plus a person); a baby crying (alerts on the sound alone, since no other sensor can confirm a cry; "no one has gone in" is added as an urgent follow-up); appliance finished; glass heard twice in two minutes.
- A more specific alert replaces the plainer ones it covers (and keeps them quiet for the cooldown).

Because a door waits 90 seconds, a house must be re-checked now and then: `registerBoxRoutes` sweeps every 15 seconds. State is kept in memory per server process, so a restart forgets the last 30 minutes (fine for a stand-in; a multi-machine deploy would need shared state).

## Try it
```sh
node test/dev/sensor-sim.js list
node test/dev/sensor-sim.js break_in            # what the house would raise (no server)
ADAM_DISPLAY_ID=... ADAM_DISPLAY_TOKEN=... node test/dev/sensor-sim.js break_in --send --url http://localhost:3000 --speed 10
node test/dev/fusion-eval.js 60 1               # sound-alone vs combined, simulated days (second argument scales false sound rates)
```
Sensors are posted to `POST /display/:id/signal` (`{kind:'sensor'|'sound', name, value, room}`), limited to 30 a minute per display.

## What the comparison shows, and does not
`fusion-eval.js` is a **simulation under stated assumptions**, not a measurement in a home. Sound rates come from our own tests (e.g. glass 16 of 36 found at 6 false alarms an hour; the beep detector found 3 of 12 real alarm recordings); sensors are imagined at 97% reliable; the phone is sometimes slow to say "home".
Over 60 simulated quiet days with false sound rates as dense as our test stream, sound alone raises about 300 alerts a day and the combined rules about 100; at a tenth of that rate, about 26 against 11. Real events caught: break-in 44% -> 97%, forced door with no sound 0% -> 97%, kitchen fire 23% -> 98%, visitor 22% -> 98%, baby crying unchanged at 96%.
**What fusion cannot fix:** most of the remaining false alerts are baby-crying detections from the sound model itself (a second sensor cannot tell a real cry from a false one), so the baby model's false alarms are still the biggest source of noise. The sound-alone baseline alerts on every detection, which is deliberately naive.
Found by running this: leaving by the door looked like an alert a minute later; a door opening just before the phone said "home" gave a false alarm about once a day; a plainer alert followed a confirmed fire. All three are fixed and tested.
