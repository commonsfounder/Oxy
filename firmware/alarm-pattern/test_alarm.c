// Host test for the C port. Same cases, same expectations as test/dev/sound-eval/alarm/main.swift.
//   make test SMOKE=<folder with 0800.wav 0925.wav 1153.wav> ESC50=<ESC-50 folder>
#include "alarm_pattern.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { float *samples; size_t count; int rate; } clip_t;

static int load_wav(const char *path, clip_t *clip) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END); long size = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *bytes = malloc((size_t)size);
    if (fread(bytes, 1, (size_t)size, f) != (size_t)size) { fclose(f); free(bytes); return 0; }
    fclose(f);
    int channels = 1, bits = 16; clip->rate = 16000;
    long at = 12; const int16_t *pcm = NULL; size_t data_bytes = 0;
    while (at + 8 <= size) {
        unsigned chunk = bytes[at + 4] | bytes[at + 5] << 8 | bytes[at + 6] << 16 | (unsigned)bytes[at + 7] << 24;
        if (!memcmp(bytes + at, "fmt ", 4)) {
            if (bytes[at + 8] != 1) { free(bytes); return 0; }
            channels = bytes[at + 10]; clip->rate = bytes[at + 12] | bytes[at + 13] << 8 | bytes[at + 14] << 16;
            bits = bytes[at + 22];
        } else if (!memcmp(bytes + at, "data", 4)) {
            pcm = (const int16_t *)(bytes + at + 8); data_bytes = chunk; break;
        }
        at += 8 + chunk + (chunk & 1);
    }
    if (!pcm || bits != 16) { free(bytes); return 0; }
    clip->count = data_bytes / 2 / (size_t)channels;
    clip->samples = malloc(clip->count * sizeof(float));
    for (size_t i = 0; i < clip->count; i++) clip->samples[i] = (float)pcm[i * (size_t)channels] / 32768.f;
    free(bytes);
    return 1;
}

static unsigned long long rng = 88172645463325252ULL;
static float noise(float amount) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return amount * ((float)(rng % 20001) / 10000.f - 1.f); }

// Runs the detector over `seconds` of audio looped from `source[from..to)`; returns a bitmask of kinds reported.
static int detect(const float *source, size_t from, size_t to, int rate, double seconds) {
    alarm_pattern_t *d = malloc(sizeof *d);
    alarm_pattern_init(d, rate);
    size_t target = (size_t)(rate * seconds), at = from, chunk = (size_t)(rate / 10);
    int found = 0;
    for (size_t done = 0; done < target;) {
        size_t n = chunk < target - done ? chunk : target - done;
        if (at + n > to) n = to - at;
        alarm_kind_t kind = alarm_pattern_process_f32(d, source + at, n);
        if (kind) found |= 1 << kind;
        at += n; done += n;
        if (at >= to) at = from;
    }
    free(d);
    return found;
}

static float *synthetic(double frequency, const double (*pattern)[2], int steps, double seconds, float noise_amount, int square, size_t *count) {
    int rate = 16000;
    size_t capacity = (size_t)(rate * (seconds + 8)), n = 0;
    float *out = malloc(capacity * sizeof(float));
    double phase = 0;
    while (n < (size_t)(seconds * rate)) {
        for (int s = 0; s < steps; s++) {
            for (int i = 0; i < (int)(pattern[s][0] * rate); i++, n++) {
                double v = sin(phase);
                out[n] = (float)(square ? (v >= 0 ? 0.5 : -0.5) : 0.5 * v) + noise(noise_amount);
                phase += 2 * M_PI * frequency / rate;
            }
            for (int i = 0; i < (int)(pattern[s][1] * rate); i++, n++) out[n] = noise(noise_amount);
        }
    }
    *count = n;
    return out;
}

static const char *names(int mask, char *buffer) {
    buffer[0] = 0;
    for (int k = 1; k <= 3; k++) if (mask & (1 << k)) { if (buffer[0]) strcat(buffer, ","); strcat(buffer, alarm_kind_name((alarm_kind_t)k)); }
    if (!buffer[0]) strcpy(buffer, "-");
    return buffer;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: test_alarm <smoke folder> <ESC-50 folder>\n"); return 2; }
    int failures = 0; char label[96], path[1024];

    printf("Real recordings (looped to 45 s):\n");
    struct { const char *name; alarm_kind_t want; double from, to; } real[] = {
        {"0800", ALARM_SMOKE, 0, 0}, {"0925", ALARM_CARBON_MONOXIDE, 0.06, 2.38}, {"1153", ALARM_SUSTAINED_BEEPING, 0, 0}};
    for (int i = 0; i < 3; i++) {
        clip_t clip; snprintf(path, sizeof path, "%s/%s.wav", argv[1], real[i].name);
        if (!load_wav(path, &clip)) { printf("  %s: missing\n", real[i].name); failures++; continue; }
        size_t from = (size_t)(real[i].from * clip.rate), to = real[i].to > 0 ? (size_t)(real[i].to * clip.rate) : clip.count;
        int got = detect(clip.samples, from, to, clip.rate, 45);
        int ok = got == 1 << real[i].want; failures += !ok;
        printf("  %s: expected %s, got %s  %s\n", real[i].name, alarm_kind_name(real[i].want), names(got, label), ok ? "OK" : "WRONG");
        free(clip.samples);
    }

    printf("\nSynthetic alarms in noise (45 s):\n");
    static const double t3[][2] = {{0.5, 0.5}, {0.5, 0.5}, {0.5, 1.5}};
    static const double t4[][2] = {{0.1, 0.1}, {0.1, 0.1}, {0.1, 0.1}, {0.1, 5.0}};
    static const double rapid[][2] = {{0.12, 0.13}};
    struct { const char *label; double hz; const double (*pattern)[2]; int steps; double seconds; float noise; int square; alarm_kind_t want; } cases[] = {
        {"smoke 3.1 kHz, quiet room", 3100, t3, 3, 45, 0.02f, 0, ALARM_SMOKE},
        {"smoke 3.1 kHz, noisy room", 3100, t3, 3, 45, 0.25f, 0, ALARM_SMOKE},
        {"smoke 3.1 kHz, very noisy", 3100, t3, 3, 45, 0.6f, 0, ALARM_SMOKE},
        {"smoke 520 Hz square", 520, t3, 3, 45, 0.05f, 1, ALARM_SMOKE},
        {"CO 3 kHz", 3000, t4, 4, 45, 0.05f, 0, ALARM_CARBON_MONOXIDE},
        {"alarm clock: 4 beeps a second", 2800, rapid, 1, 45, 0.05f, 0, ALARM_SUSTAINED_BEEPING},
        {"alarm clock, only 20 s", 2800, rapid, 1, 20, 0.05f, 0, ALARM_NONE}};
    for (int i = 0; i < 7; i++) {
        size_t count; float *audio = synthetic(cases[i].hz, cases[i].pattern, cases[i].steps, cases[i].seconds, cases[i].noise, cases[i].square, &count);
        int got = detect(audio, 0, count, 16000, cases[i].seconds);
        int ok = cases[i].want == ALARM_NONE ? got == 0 : got == 1 << cases[i].want; failures += !ok;
        printf("  %s: got %s  %s\n", cases[i].label, names(got, label), ok ? "OK" : "WRONG");
        free(audio);
    }

    printf("\nESC-50 clips as non-alarms (each looped to 45 s):\n");
    snprintf(path, sizeof path, "%s/meta/esc50.csv", argv[2]);
    FILE *csv = fopen(path, "r"); char line[512]; int total = 0, smoke = 0, co = 0, beeping = 0;
    if (csv) {
        fgets(line, sizeof line, csv);
        while (fgets(line, sizeof line, csv)) {
            char *name = strtok(line, ","); clip_t clip;
            snprintf(path, sizeof path, "%s/audio/%s", argv[2], name);
            if (!load_wav(path, &clip)) continue;
            int got = detect(clip.samples, 0, clip.count, clip.rate, 45);
            total++; smoke += !!(got & 1 << ALARM_SMOKE); co += !!(got & 1 << ALARM_CARBON_MONOXIDE); beeping += !!(got & 1 << ALARM_SUSTAINED_BEEPING);
            free(clip.samples);
        }
        fclose(csv);
    }
    printf("  %d clips. Called a smoke alarm: %d, a CO alarm: %d, sustained beeping: %d\n", total, smoke, co, beeping);
    failures += smoke + co;
    printf("\n%s\n", failures ? "FAILED" : "ALL PASS");
    return failures != 0;
}
