#!/usr/bin/env python3
"""How well does Apple's classifier hear each of its ~300 sounds? Scored on FSD50K clips (peaks_dir.swift output).

  python3 all_labels.py <fsd50k folder> <esc-peaks.json> <shard json> [shard json ...]

For every Apple label with a matching FSD50K class (table below) it reports how many clips of that sound we have
and AUC: the chance a real example scores higher than a clip of something else (1.0 perfect, 0.5 guessing).
Labels with fewer than MIN clips of the sound are marked "not enough data" instead of getting a number.
FSD50K labels are for the whole clip and often mixed ("Dog" clips also hold speech), so AUC here is
a little pessimistic. ESC-50 numbers (clean, one sound per clip) are shown beside it where they exist.
"""
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

MIN = 8
# Apple label -> FSD50K class(es). "~" marks a loose match (the classes are not the same thing).
MAP = {
    "applause": "Applause", "baby_crying": "~Crying_and_sobbing", "bathtub_filling_washing": "Bathtub_(filling_or_washing)",
    "bell": "Bell", "bicycle_bell": "Bicycle_bell", "bird": "Bird", "bird_chirp_tweet": "Chirp_and_tweet",
    "boiling": "Boiling", "boom": "Boom", "breathing": "Breathing", "burp": "Burping_and_eructation", "bus": "Bus",
    "camera": "Camera", "car_horn": "Vehicle_horn_and_car_horn_and_honking", "car_passing_by": "Car_passing_by",
    "cat_meow": "Meow", "cat_purr": "Purr", "chatter": "Chatter", "cheering": "Cheering",
    "chewing": "Chewing_and_mastication", "chicken_cluck": "~Chicken_and_rooster", "chime": "Chime",
    "church_bell": "Church_bell", "clapping": "Clapping", "clock": "Clock", "coin_dropping": "Coin_(dropping)",
    "cough": "Cough", "cowbell": "Cowbell", "cricket_chirp": "Cricket", "crowd": "Crowd",
    "crumpling_crinkling": "Crumpling_and_crinkling", "crushing": "Crushing", "crying_sobbing": "Crying_and_sobbing",
    "cutlery_silverware": "Cutlery_and_silverware", "cymbal": "Cymbal", "dishes_pots_pans": "Dishes_and_pots_and_pans",
    "dog": "Dog", "dog_bark": "Bark", "dog_growl": "Growling", "door": "Door", "door_bell": "Doorbell",
    "door_sliding": "Sliding_door", "door_slam": "Slam", "drawer_open_close": "Drawer_open_or_close", "drill": "Drill",
    "drum": "Drum", "drum_kit": "Drum_kit", "electric_guitar": "Electric_guitar", "engine": "Engine",
    "engine_starting": "Engine_starting", "engine_idling": "Idling", "fire": "Fire", "fire_crackle": "~Crackle",
    "fireworks": "Fireworks", "fly_buzz": "~Buzz", "frog": "Frog", "frying_food": "Frying_(food)", "gasp": "Gasp",
    "giggling": "Giggle", "glass_breaking": "Shatter", "glass_clink": "Chink_and_clink", "glockenspiel": "Glockenspiel",
    "gong": "Gong", "gunshot_gunfire": "Gunshot_and_gunfire", "gurgling": "Gurgling", "hammer": "Hammer",
    "harmonica": "Harmonica", "harp": "Harp", "hi_hat": "Hi-hat", "insect": "Insect", "keys_jangling": "Keys_jangling",
    "knock": "Knock", "laughter": "Laughter", "liquid_dripping": "Drip", "liquid_filling_container": "Fill_(with_liquid)",
    "liquid_pouring": "Pour", "liquid_trickle_dribble": "Trickle_and_dribble", "liquid_splashing": "Splash_and_splatter",
    "mechanical_fan": "Mechanical_fan", "microwave_oven": "Microwave_oven", "motorcycle": "Motorcycle", "music": "Music",
    "ocean": "Ocean", "organ": "Organ", "person_running": "Run", "person_walking": "Walk_and_footsteps",
    "piano": "Piano", "printer": "Printer", "rain": "Rain", "raindrop": "Raindrop", "ratchet_and_pawl": "Ratchet_and_pawl",
    "rattle_instrument": "Rattle_(instrument)", "ringtone": "Ringtone", "rooster_crow": "~Chicken_and_rooster",
    "saw": "Sawing", "scissors": "Scissors", "screaming": "Screaming", "shout": "Shout", "sigh": "Sigh", "singing": "Singing",
    "sink_filling_washing": "Sink_(filling_or_washing)", "siren": "Siren", "skateboard": "Skateboard",
    "smoke_detector": "~Alarm", "sneeze": "Sneeze", "snare_drum": "Snare_drum", "speech": "Speech", "squeak": "Squeak",
    "stream_burbling": "Stream", "subway_metro": "Subway_and_metro_and_underground", "tabla": "Tabla",
    "tambourine": "Tambourine", "tap": "Tap", "tearing": "Tearing", "telephone": "Telephone", "thump_thud": "Thump_and_thud",
    "thunder": "Thunder", "thunderstorm": "Thunderstorm", "tick": "Tick", "tick_tock": "Tick-tock",
    "toilet_flush": "Toilet_flush", "train": "Train", "trumpet": "Trumpet", "truck": "Truck", "typewriter": "Typewriter",
    "typing_computer_keyboard": "Computer_keyboard", "water": "Water", "water_tap_faucet": "Water_tap_and_faucet",
    "whispering": "Whispering", "whoosh_swoosh_swish": "Whoosh_and_swoosh_and_swish", "wind": "Wind",
    "wind_chime": "Wind_chime", "writing": "Writing", "yell": "Yell", "zipper": "Zipper_(clothing)",
}
ESC = {"baby_crying": "crying_baby", "bird_chirp_tweet": "chirping_birds", "clapping": "clapping", "cough": "coughing",
       "dog_bark": "dog", "door_bell": None, "fire_crackle": "crackling_fire", "glass_breaking": "glass_breaking",
       "knock": "door_wood_knock", "laughter": "laughing", "rain": "rain", "siren": "siren", "sneeze": "sneezing",
       "toilet_flush": "toilet_flush", "typing_computer_keyboard": "keyboard_typing", "wind": "wind",
       "person_walking": "footsteps", "cat_meow": "cat", "church_bell": "church_bells", "thunderstorm": "thunderstorm",
       "fireworks": "fireworks", "engine": "engine", "mechanical_fan": None, "snoring": "snoring", "breathing": "breathing",
       "liquid_dripping": "water_drops", "sink_filling_washing": None, "liquid_pouring": "pouring_water"}


def auc(positive, negative):
    ranked = sorted([(score, 1) for score in positive] + [(score, 0) for score in negative])
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        rank_sum += (i + j + 1) / 2 * sum(flag for _, flag in ranked[i:j])
        i = j
    n_pos, n_neg = len(positive), len(negative)
    return (rank_sum - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


fsd = Path(sys.argv[1])
classes = {}
for name in ("dev", "eval"):
    for row in csv.DictReader(open(fsd / "FSD50K.ground_truth" / f"{name}.csv")):
        classes[row["fname"]] = set(row["labels"].split(","))
clips = []
for shard in sys.argv[3:]:
    clips += json.load(open(shard))
clips = [c for c in clips if c["file"] in classes]
print(f"{len(clips)} clips scored")

esc = defaultdict(list)
for clip in json.load(open(sys.argv[2])):
    esc[clip["category"]].append(clip)
esc_total = sum(len(v) for v in esc.values())

rows = []
for apple, target in sorted(MAP.items()):
    loose = target.startswith("~")
    wanted = target.lstrip("~")
    positive = [c["peak1"].get(apple, 0) for c in clips if wanted in classes[c["file"]]]
    negative = [c["peak1"].get(apple, 0) for c in clips if wanted not in classes[c["file"]]]
    value = auc(positive, negative) if len(positive) >= MIN else None
    esc_value = None
    category = ESC.get(apple)
    if category and category in esc:
        pos = [c["peak1"].get(apple, 0) for c in esc[category]]
        neg = [c["peak1"].get(apple, 0) for v in esc.values() for c in v if c["category"] != category]
        esc_value = auc(pos, neg)
    rows.append((value, apple, wanted, loose, len(positive), esc_value))

print(f"\n{'Apple label':28} {'FSD50K class':36} {'clips':>5} {'AUC':>5} {'ESC-50 AUC':>10}")
for value, apple, wanted, loose, count, esc_value in sorted(rows, key=lambda r: (r[0] is None, -(r[0] or 0))):
    shown = "n/a" if value is None else f"{value:.2f}"
    flag = "~" if loose else " "
    e = "" if esc_value is None else f"{esc_value:.2f}"
    note = "" if value is not None else "  not enough data"
    print(f"{apple:28} {flag}{wanted:35} {count:5} {shown:>5} {e:>10}{note}")

scored = [r for r in rows if r[0] is not None]
print(f"\n{len(MAP)} Apple labels matched to an FSD50K class; {len(scored)} have at least {MIN} clips.")
print(f"  strong (AUC >= 0.90): {sum(r[0] >= 0.90 for r in scored)}   okay (0.80-0.90): {sum(0.80 <= r[0] < 0.90 for r in scored)}   weak (< 0.80): {sum(r[0] < 0.80 for r in scored)}")
print(f"  no FSD50K class to compare against: {len(MAP) and 303 - len(MAP)} of Apple's 303 labels")
