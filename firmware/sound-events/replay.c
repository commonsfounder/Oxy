// Replays a recorded stream of model scores through the real alert logic and prints every event, one per line:
//   <class name> <seconds into the recording> <heard|sustained>
//   replay <scores.bin: float32, windows x (classes + 1), background first> <number of classes incl. background>
// Window k ends 2 s + 0.5 s * k into the recording (2 s model windows, hop 0.5 s). Used to check the C logic against calibrate.py.
#include "sound_events.h"
#include "sound_events_config.h"
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    FILE *f = fopen(argv[1], "rb");
    if (!f) return 1;
    int width = SOUND_EVENT_CLASSES + 1;
    float *row = malloc((size_t)width * sizeof(float));
    se_t s; se_init(&s, SOUND_EVENT_CONFIG, SOUND_EVENT_CLASSES);
    se_event_t ev[SE_MAX_CLASSES];
    for (long k = 0; fread(row, sizeof(float), (size_t)width, f) == (size_t)width; k++) {
        int n = se_update(&s, row, ev, SE_MAX_CLASSES);
        for (int i = 0; i < n; i++)
            printf("%s %.1f %s\n", SOUND_EVENT_CONFIG[ev[i].class_index].name, 2.0 + 0.5 * (double)k, ev[i].kind == SE_SUSTAINED ? "sustained" : "heard");
    }
    return 0;
}
