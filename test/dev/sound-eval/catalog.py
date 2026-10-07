#!/usr/bin/env python3
"""Gives each of Apple's sound labels a decision: alert, routine signal, background context, or ignore.

  python3 catalog.py <labels.txt (comma separated)> <all-labels result txt> <out folder>

The buckets are a judgement about a home assistant, not a measurement; the AUC column is measured
(all_labels.py, FSD50K clips). Writes SOUND_CATALOG.md and sound-catalog.json.
"""
import json
import re
import sys
from pathlib import Path

labels = sorted(x.strip() for x in Path(sys.argv[1]).read_text().split(",") if x.strip())
auc, clips = {}, {}
for line in Path(sys.argv[2]).read_text().splitlines():
    m = re.match(r"^(\S+)\s+~?\S+\s+(\d+)\s+(\d\.\d\d|n/a)", line)
    if m:
        clips[m.group(1)] = int(m.group(2))
        auc[m.group(1)] = None if m.group(3) == "n/a" else float(m.group(3))

IN_APP = {"glass_breaking", "knock", "door_bell", "baby_crying", "smoke_detector"}
# Worth telling someone about. "sustained" ones only matter after a while (a tap running 10 minutes).
ALERT = {
    "screaming": "", "gunshot_gunfire": "", "door_slam": "", "dog_bark": "if it goes on while you are out",
    "dog_howl": "", "dog_whimper": "", "crying_sobbing": "", "cough": "as a trend, not each cough", "gasp": "",
    "alarm_clock": "", "telephone_bell_ringing": "", "ringtone": "", "telephone": "", "siren": "outside", "police_siren": "outside",
    "ambulance_siren": "outside", "fire_engine_siren": "outside", "emergency_vehicle": "outside", "civil_defense_siren": "outside",
    "liquid_dripping": "possible leak, sustained", "water_tap_faucet": "left running, sustained", "sink_filling_washing": "left running, sustained",
    "bathtub_filling_washing": "left running, sustained", "toilet_flush": "a toilet that keeps running, sustained", "water_pump": "",
    "boiling": "kettle or pan boiled; untested", "microwave_oven": "finished beep", "fire": "", "fire_crackle": "",
    "air_horn": "", "car_horn": "outside", "glass_clink": "", "explosion": "", "eruption": "", "firecracker": "", "fireworks": "outside",
    "snoring": "overnight trend", "breathing": "overnight trend, no medical claims", "baby_laughter": "", "reverse_beeps": "",
    "beep": "appliance finished, needs per-house learning", "timer": "", "electric_shaver": "",
}
# Evidence someone is home and what they are doing; log it, do not interrupt.
ROUTINE = {
    "person_walking", "person_running", "person_shuffling", "keys_jangling", "door", "door_sliding", "drawer_open_close",
    "hair_dryer", "toothbrush", "vacuum_cleaner", "blender", "dishes_pots_pans", "cutlery_silverware", "chopping_food",
    "frying_food", "typing", "typing_computer_keyboard", "printer", "speech", "chatter", "laughter", "giggling", "singing",
    "humming", "whispering", "sneeze", "burp", "sigh", "hiccup", "chewing", "slurp", "clock", "tick_tock", "tick", "tap",
    "mechanical_fan", "air_conditioner", "power_windows", "scissors", "zipper", "writing", "camera", "click", "coin_dropping",
    "crumpling_crinkling", "tearing", "thump_thud", "squeak", "cat_meow", "cat_purr", "cat", "dog", "chuckle_chortle",
    "belly_laugh", "snicker", "gargling", "nose_blowing", "biting", "crushing", "whistling", "finger_snapping", "clapping",
    "applause", "cheering", "booing", "shout", "yell", "water", "liquid_pouring", "liquid_filling_container", "liquid_splashing",
    "liquid_sloshing", "liquid_squishing", "liquid_trickle_dribble", "liquid_spraying", "gurgling", "stream_burbling",
    "wind_chime", "bell", "chime", "bicycle", "bicycle_bell", "slap_smack", "typewriter", "chopping_wood", "ratchet_and_pawl", "hammer", "drill", "saw", "power_tool", "sewing_machine",
    "wood_cracking", "yodeling", "rapping", "children_shouting", "crying", "chicken", "television",
}
# Setting, not event: useful to know and to suppress false alarms, never an alert.
CONTEXT = {
    "boom", "church_bell", "motorboat_speedboat", "whoosh_swoosh_swish",
    "rain", "raindrop", "thunder", "thunderstorm", "wind", "wind_noise_microphone", "wind_rustling_leaves", "ocean", "sea_waves",
    "waterfall", "traffic_noise", "car_passing_by", "engine", "engine_idling", "engine_accelerating_revving", "engine_starting",
    "engine_knocking", "bus", "truck", "motorcycle", "train", "train_horn", "train_wheels_squealing", "train_whistle", "rail_transport",
    "railroad_car", "subway_metro", "aircraft", "airplane", "helicopter", "music", "babble", "crowd", "silence", "bird",
    "bird_chirp_tweet", "bird_vocalization", "bird_squawk", "bird_flapping", "insect", "cricket_chirp", "fly_buzz",
    "mosquito_buzz", "bee_buzz", "frog", "frog_croak", "lawn_mower", "hedge_trimmer", "chainsaw", "motorboat_speedbo", "boat_water_vehicle",
    "race_car", "vehicle_skidding", "skateboard", "foghorn", "dog_bow_wow", "dog_growl", "horse_clip_clop", "chicken_cluck", "rooster_crow",
    "crow_caw", "owl_hoot", "pigeon_dove_coo", "goose_honk", "duck_quack", "turkey_gobble", "fowl", "cow_moo", "sheep_bleat", "pig_oink",
    "underwater_bubbling", "scuba_diving", "sailing", "rowboat_canoe_kayak", "ocean", "basketball_bounce", "bowling_impact",
}
INSTRUMENT = re.compile(
    r"(accordion|guitar|banjo|bass_drum|bass_guitar|bassoon|bagpipes|bowed_string|brass|cello|clarinet|cymbal|didgeridoo|double_bass|"
    r"drum|electric_piano|electronic_organ|flute|french_horn|glockenspiel|gong|hammond|harmonica|harp|harpsichord|hi_hat|keyboard_musical|"
    r"mallet|mandolin|marimba|oboe|orchestra|organ|percussion|piano|plucked|saxophone|singing_bowl|sitar|snare|steel|steelpan|synthesizer|"
    r"tabla|tambourine|theremin|timpani|trombone|trumpet|tuning_fork|ukulele|vibraphone|violin|wind_instrument|zither|shofar|rattle_instrument|"
    r"cowbell|choir|bell_instrument|disc_scratching|battle_cry)")
SPORT_WILD = re.compile(r"(playing_|rope_skipping|skiing|artillery|coyote|elk_bugle|lion_roar|whale|snake|horse_neigh|bicycle_bell_x)")


def bucket(label):
    if label in IN_APP:
        return "in the app"
    if label in ALERT:
        return "alert candidate"
    if label in ROUTINE:
        return "routine signal"
    if label in CONTEXT:
        return "background context"
    if INSTRUMENT.search(label) or SPORT_WILD.search(label):
        return "ignore (not a home sound)"
    return "unassigned"


def readiness(label, b):
    a = auc.get(label)
    if b == "in the app":
        return "built, own model + Apple"
    if b.startswith("ignore"):
        return "-"
    if a is None:
        return "no test data" if label not in clips else "too few clips to score"
    return "strong" if a >= 0.90 else "okay" if a >= 0.80 else "weak"


rows = []
for label in labels:
    b = bucket(label)
    rows.append({"label": label, "bucket": b, "auc": auc.get(label), "clips": clips.get(label), "readiness": readiness(label, b),
                 "note": ALERT.get(label, "")})
order = ["in the app", "alert candidate", "routine signal", "background context", "ignore (not a home sound)", "unassigned"]
out = Path(sys.argv[3])
(out / "sound-catalog.json").write_text(json.dumps(rows, indent=1))
md = ["# Apple's 303 sound labels: what each one is for\n",
      "Bucket = a judgement about a home assistant. AUC = measured on FSD50K clips (1.0 perfect, 0.5 guessing; blank = no matching test data). "
      "Readiness: strong >= 0.90, okay 0.80-0.90, weak < 0.80.\n"]
counts = {b: sum(r["bucket"] == b for r in rows) for b in order}
md.append("| bucket | labels |\n|---|---|\n" + "\n".join(f"| {b} | {counts[b]} |" for b in order if counts[b]) + f"\n| total | {len(rows)} |\n")
for b in order:
    group = [r for r in rows if r["bucket"] == b]
    if not group:
        continue
    md.append(f"\n## {b} ({len(group)})\n")
    if b.startswith("ignore") or b == "unassigned":
        md.append(", ".join(r["label"] for r in group) + "\n")
        continue
    md.append("| label | AUC | clips | readiness | note |\n|---|---|---|---|---|")
    for r in sorted(group, key=lambda r: (r["auc"] is None, -(r["auc"] or 0))):
        md.append(f"| {r['label']} | {'' if r['auc'] is None else format(r['auc'], '.2f')} | {r['clips'] or ''} | {r['readiness']} | {r['note']} |")
(out / "SOUND_CATALOG.md").write_text("\n".join(md) + "\n")
print(counts)
print("unassigned:", [r["label"] for r in rows if r["bucket"] == "unassigned"])
