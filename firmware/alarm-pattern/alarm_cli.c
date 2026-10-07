// Runs the alarm detector over wav files and says what it hears and when.
//   alarm_cli <loop seconds> file.wav [file.wav ...]      (a recording shorter than the loop time is repeated, as in test_alarm)
#include "alarm_pattern.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static float *load_wav(const char *path, size_t *count, int *rate) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); long size = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *b = malloc((size_t)size);
    if (fread(b, 1, (size_t)size, f) != (size_t)size) { fclose(f); free(b); return NULL; }
    fclose(f);
    int channels = 1, bits = 16; *rate = 16000;
    long at = 12; size_t data = 0; const unsigned char *pcm = NULL;
    while (at + 8 <= size) {
        unsigned chunk = b[at + 4] | b[at + 5] << 8 | b[at + 6] << 16 | (unsigned)b[at + 7] << 24;
        if (!memcmp(b + at, "fmt ", 4)) { channels = b[at + 10]; *rate = b[at + 12] | b[at + 13] << 8 | b[at + 14] << 16; bits = b[at + 22]; }
        else if (!memcmp(b + at, "data", 4)) { pcm = b + at + 8; data = chunk; break; }
        at += 8 + chunk + (chunk & 1);
    }
    if (!pcm || bits != 16) { free(b); return NULL; }
    if (at + 8 + data > (size_t)size) data = (size_t)size - (size_t)at - 8;
    *count = data / 2 / (size_t)channels;
    float *out = malloc(*count * sizeof(float));
    for (size_t i = 0; i < *count; i++) out[i] = (float)((const int16_t *)pcm)[i * (size_t)channels] / 32768.f;
    free(b);
    return out;
}

int main(int argc, char **argv) {
    double loop = atof(argv[1]);
    for (int a = 2; a < argc; a++) {
        size_t n; int rate; float *x = load_wav(argv[a], &n, &rate);
        if (!x || n < 1000) { printf("%s: unreadable\n", argv[a]); continue; }
        alarm_pattern_t *d = malloc(sizeof *d);
        alarm_pattern_init(d, rate);
        size_t total = (size_t)(loop * rate), at = 0, done = 0, chunk = (size_t)rate / 10;
        char found[128] = "";
        while (done < total) {
            size_t m = chunk < total - done ? chunk : total - done;
            if (at + m > n) m = n - at;
            alarm_kind_t k = alarm_pattern_process_f32(d, x + at, m);
            if (k) { char t[48]; snprintf(t, sizeof t, "%s@%.0fs ", alarm_kind_name(k), (double)done / rate); strcat(found, t); }
            at += m; done += m; if (at >= n) at = 0;
        }
        const char *name = strrchr(argv[a], '/'); name = name ? name + 1 : argv[a];
        printf("%-12s %5.1fs  %s\n", name, (double)n / rate, found[0] ? found : "nothing");
        free(d); free(x);
    }
    return 0;
}
