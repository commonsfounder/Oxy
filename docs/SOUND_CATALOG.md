# Apple's 303 sound labels: what each one is for

Bucket = a judgement about a home assistant. AUC = measured on FSD50K clips (1.0 perfect, 0.5 guessing; blank = no matching test data). Readiness: strong >= 0.90, okay 0.80-0.90, weak < 0.80.

| bucket | labels |
|---|---|
| in the app | 5 |
| alert candidate | 41 |
| routine signal | 96 |
| background context | 79 |
| ignore (not a home sound) | 82 |
| total | 303 |


## in the app (5)

| label | AUC | clips | readiness | note |
|---|---|---|---|---|
| baby_crying | 0.90 | 66 | built, own model + Apple |  |
| door_bell | 0.71 | 123 | built, own model + Apple |  |
| smoke_detector | 0.67 | 377 | built, own model + Apple |  |
| glass_breaking | 0.53 | 459 | built, own model + Apple |  |
| knock | 0.52 | 335 | built, own model + Apple |  |

## alert candidate (41)

| label | AUC | clips | readiness | note |
|---|---|---|---|---|
| bathtub_filling_washing | 1.00 | 19 | strong | left running, sustained |
| siren | 1.00 | 16 | strong | outside |
| toilet_flush | 1.00 | 17 | strong | a toilet that keeps running, sustained |
| sink_filling_washing | 0.95 | 35 | strong | left running, sustained |
| water_tap_faucet | 0.94 | 68 | strong | left running, sustained |
| fire_crackle | 0.93 | 26 | strong |  |
| crying_sobbing | 0.90 | 66 | strong |  |
| fire | 0.79 | 35 | weak |  |
| dog_bark | 0.78 | 37 | weak | if it goes on while you are out |
| liquid_dripping | 0.75 | 20 | weak | possible leak, sustained |
| telephone | 0.73 | 104 | weak |  |
| microwave_oven | 0.70 | 32 | weak | finished beep |
| door_slam | 0.66 | 75 | weak |  |
| ringtone | 0.65 | 27 | weak |  |
| glass_clink | 0.63 | 89 | weak |  |
| car_horn | 0.62 | 19 | weak | outside |
| fireworks | 0.62 | 36 | weak | outside |
| breathing | 0.61 | 34 | weak | overnight trend, no medical claims |
| screaming | 0.60 | 22 | weak |  |
| gunshot_gunfire | 0.58 | 36 | weak |  |
| cough | 0.57 | 19 | weak | as a trend, not each cough |
| air_horn |  |  | no test data |  |
| alarm_clock |  |  | no test data |  |
| ambulance_siren |  |  | no test data | outside |
| baby_laughter |  |  | no test data |  |
| beep |  |  | no test data | appliance finished, needs per-house learning |
| boiling |  | 4 | too few clips to score | kettle or pan boiled; untested |
| civil_defense_siren |  |  | no test data | outside |
| dog_howl |  |  | no test data |  |
| dog_whimper |  |  | no test data |  |
| electric_shaver |  |  | no test data |  |
| emergency_vehicle |  |  | no test data | outside |
| eruption |  |  | no test data |  |
| fire_engine_siren |  |  | no test data | outside |
| firecracker |  |  | no test data |  |
| gasp |  | 5 | too few clips to score |  |
| police_siren |  |  | no test data | outside |
| reverse_beeps |  |  | no test data |  |
| snoring |  |  | no test data | overnight trend |
| telephone_bell_ringing |  |  | no test data |  |
| water_pump |  |  | no test data |  |

## routine signal (96)

| label | AUC | clips | readiness | note |
|---|---|---|---|---|
| applause | 1.00 | 18 | strong |  |
| stream_burbling | 1.00 | 18 | strong |  |
| liquid_filling_container | 0.99 | 13 | strong |  |
| wind_chime | 0.99 | 11 | strong |  |
| chatter | 0.95 | 31 | strong |  |
| cat_purr | 0.94 | 14 | strong |  |
| chime | 0.93 | 25 | strong |  |
| typing_computer_keyboard | 0.92 | 31 | strong |  |
| person_running | 0.91 | 26 | strong |  |
| cheering | 0.90 | 16 | strong |  |
| liquid_pouring | 0.90 | 22 | strong |  |
| liquid_trickle_dribble | 0.90 | 21 | strong |  |
| clock | 0.88 | 21 | okay |  |
| water | 0.88 | 112 | okay |  |
| door_sliding | 0.87 | 51 | okay |  |
| writing | 0.87 | 31 | okay |  |
| gurgling | 0.85 | 18 | okay |  |
| printer | 0.83 | 10 | okay |  |
| singing | 0.83 | 31 | okay |  |
| chewing | 0.81 | 13 | okay |  |
| person_walking | 0.80 | 79 | okay |  |
| tick_tock | 0.80 | 8 | okay |  |
| crumpling_crinkling | 0.78 | 37 | weak |  |
| scissors | 0.76 | 10 | weak |  |
| dog | 0.75 | 81 | weak |  |
| whispering | 0.72 | 18 | weak |  |
| camera | 0.71 | 22 | weak |  |
| squeak | 0.71 | 72 | weak |  |
| yell | 0.71 | 24 | weak |  |
| drill | 0.70 | 8 | weak |  |
| shout | 0.69 | 33 | weak |  |
| zipper | 0.69 | 26 | weak |  |
| bell | 0.68 | 186 | weak |  |
| laughter | 0.65 | 159 | weak |  |
| bicycle_bell | 0.63 | 20 | weak |  |
| cat_meow | 0.63 | 32 | weak |  |
| hammer | 0.62 | 34 | weak |  |
| keys_jangling | 0.61 | 19 | weak |  |
| door | 0.60 | 601 | weak |  |
| drawer_open_close | 0.57 | 30 | weak |  |
| liquid_splashing | 0.57 | 29 | weak |  |
| typewriter | 0.57 | 11 | weak |  |
| ratchet_and_pawl | 0.55 | 9 | weak |  |
| speech | 0.55 | 305 | weak |  |
| coin_dropping | 0.54 | 45 | weak |  |
| crushing | 0.54 | 67 | weak |  |
| tearing | 0.53 | 21 | weak |  |
| giggling | 0.52 | 27 | weak |  |
| tap | 0.52 | 57 | weak |  |
| thump_thud | 0.51 | 56 | weak |  |
| clapping | 0.48 | 66 | weak |  |
| cutlery_silverware | 0.46 | 51 | weak |  |
| burp | 0.42 | 15 | weak |  |
| dishes_pots_pans | 0.42 | 60 | weak |  |
| air_conditioner |  |  | no test data |  |
| belly_laugh |  |  | no test data |  |
| bicycle |  |  | no test data |  |
| biting |  |  | no test data |  |
| blender |  |  | no test data |  |
| booing |  |  | no test data |  |
| cat |  |  | no test data |  |
| chicken |  |  | no test data |  |
| children_shouting |  |  | no test data |  |
| chopping_food |  |  | no test data |  |
| chopping_wood |  |  | no test data |  |
| chuckle_chortle |  |  | no test data |  |
| click |  |  | no test data |  |
| finger_snapping |  |  | no test data |  |
| frying_food |  | 6 | too few clips to score |  |
| gargling |  |  | no test data |  |
| hair_dryer |  |  | no test data |  |
| hiccup |  |  | no test data |  |
| humming |  |  | no test data |  |
| liquid_sloshing |  |  | no test data |  |
| liquid_spraying |  |  | no test data |  |
| liquid_squishing |  |  | no test data |  |
| mechanical_fan |  | 4 | too few clips to score |  |
| nose_blowing |  |  | no test data |  |
| person_shuffling |  |  | no test data |  |
| power_tool |  |  | no test data |  |
| power_windows |  |  | no test data |  |
| rapping |  |  | no test data |  |
| saw |  | 7 | too few clips to score |  |
| sewing_machine |  |  | no test data |  |
| sigh |  | 7 | too few clips to score |  |
| slap_smack |  |  | no test data |  |
| slurp |  |  | no test data |  |
| sneeze |  | 2 | too few clips to score |  |
| snicker |  |  | no test data |  |
| tick |  | 6 | too few clips to score |  |
| toothbrush |  |  | no test data |  |
| typing |  |  | no test data |  |
| vacuum_cleaner |  |  | no test data |  |
| whistling |  |  | no test data |  |
| wood_cracking |  |  | no test data |  |
| yodeling |  |  | no test data |  |

## background context (79)

| label | AUC | clips | readiness | note |
|---|---|---|---|---|
| thunder | 1.00 | 25 | strong |  |
| thunderstorm | 1.00 | 25 | strong |  |
| cricket_chirp | 0.99 | 11 | strong |  |
| engine_idling | 0.99 | 8 | strong |  |
| church_bell | 0.97 | 24 | strong |  |
| train | 0.96 | 31 | strong |  |
| insect | 0.95 | 28 | strong |  |
| ocean | 0.95 | 20 | strong |  |
| wind | 0.95 | 29 | strong |  |
| bus | 0.94 | 15 | strong |  |
| motorcycle | 0.91 | 18 | strong |  |
| rain | 0.91 | 29 | strong |  |
| car_passing_by | 0.90 | 13 | strong |  |
| crowd | 0.90 | 41 | strong |  |
| fly_buzz | 0.90 | 9 | strong |  |
| engine | 0.89 | 88 | okay |  |
| truck | 0.87 | 10 | okay |  |
| subway_metro | 0.86 | 19 | okay |  |
| engine_starting | 0.85 | 11 | okay |  |
| boom | 0.81 | 13 | okay |  |
| bird | 0.77 | 110 | weak |  |
| bird_chirp_tweet | 0.77 | 35 | weak |  |
| music | 0.69 | 2378 | weak |  |
| dog_growl | 0.60 | 8 | weak |  |
| whoosh_swoosh_swish | 0.37 | 29 | weak |  |
| aircraft |  |  | no test data |  |
| airplane |  |  | no test data |  |
| babble |  |  | no test data |  |
| basketball_bounce |  |  | no test data |  |
| bee_buzz |  |  | no test data |  |
| bird_flapping |  |  | no test data |  |
| bird_squawk |  |  | no test data |  |
| bird_vocalization |  |  | no test data |  |
| boat_water_vehicle |  |  | no test data |  |
| bowling_impact |  |  | no test data |  |
| chainsaw |  |  | no test data |  |
| chicken_cluck |  | 7 | too few clips to score |  |
| cow_moo |  |  | no test data |  |
| crow_caw |  |  | no test data |  |
| dog_bow_wow |  |  | no test data |  |
| duck_quack |  |  | no test data |  |
| engine_accelerating_revving |  |  | no test data |  |
| engine_knocking |  |  | no test data |  |
| foghorn |  |  | no test data |  |
| fowl |  |  | no test data |  |
| frog |  | 5 | too few clips to score |  |
| frog_croak |  |  | no test data |  |
| goose_honk |  |  | no test data |  |
| hedge_trimmer |  |  | no test data |  |
| helicopter |  |  | no test data |  |
| horse_clip_clop |  |  | no test data |  |
| lawn_mower |  |  | no test data |  |
| mosquito_buzz |  |  | no test data |  |
| motorboat_speedboat |  |  | no test data |  |
| owl_hoot |  |  | no test data |  |
| pig_oink |  |  | no test data |  |
| pigeon_dove_coo |  |  | no test data |  |
| race_car |  |  | no test data |  |
| rail_transport |  |  | no test data |  |
| railroad_car |  |  | no test data |  |
| raindrop |  | 6 | too few clips to score |  |
| rooster_crow |  | 7 | too few clips to score |  |
| rowboat_canoe_kayak |  |  | no test data |  |
| sailing |  |  | no test data |  |
| scuba_diving |  |  | no test data |  |
| sea_waves |  |  | no test data |  |
| sheep_bleat |  |  | no test data |  |
| silence |  |  | no test data |  |
| skateboard |  | 6 | too few clips to score |  |
| traffic_noise |  |  | no test data |  |
| train_horn |  |  | no test data |  |
| train_wheels_squealing |  |  | no test data |  |
| train_whistle |  |  | no test data |  |
| turkey_gobble |  |  | no test data |  |
| underwater_bubbling |  |  | no test data |  |
| vehicle_skidding |  |  | no test data |  |
| waterfall |  |  | no test data |  |
| wind_noise_microphone |  |  | no test data |  |
| wind_rustling_leaves |  |  | no test data |  |

## ignore (not a home sound) (82)

accordion, acoustic_guitar, artillery_fire, bagpipes, banjo, bass_drum, bass_guitar, bassoon, battle_cry, bowed_string_instrument, brass_instrument, cello, choir_singing, clarinet, cowbell, coyote_howl, cymbal, didgeridoo, disc_scratching, double_bass, drum, drum_kit, electric_guitar, electric_piano, electronic_organ, elk_bugle, flute, french_horn, glockenspiel, gong, guitar, guitar_strum, guitar_tapping, hammond_organ, harmonica, harp, harpsichord, hi_hat, horse_neigh, keyboard_musical, lion_roar, mallet_percussion, mandolin, marimba_xylophone, oboe, orchestra, organ, percussion, piano, playing_badminton, playing_hockey, playing_squash, playing_table_tennis, playing_tennis, playing_volleyball, plucked_string_instrument, rattle_instrument, rope_skipping, saxophone, shofar, singing_bowl, sitar, skiing, snake_hiss, snake_rattle, snare_drum, steel_guitar_slide_guitar, steelpan, synthesizer, tabla, tambourine, theremin, timpani, trombone, trumpet, tuning_fork, ukulele, vibraphone, violin_fiddle, whale_vocalization, wind_instrument, zither

