#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *audio;      // mono 16 kHz PCM16 reply (caller frees), or NULL
    size_t audio_bytes;
    char heard[256];     // what Adam understood
    char reply[384];     // what Adam said
    int http_status;
} adam_reply_t;

// Starts Wi-Fi when the box has been provisioned. Safe to call when it has not.
void adam_net_init(void);
bool adam_net_configured(void);
bool adam_net_online(void);
// Saves {"ssid","pass","url","id","token"} to flash. The box restarts afterwards to use it.
bool adam_net_store_config(const char *json);
// Sends one recording and receives the spoken answer. Returns false when no HTTP answer was received at all.
bool adam_net_voice(const int16_t *pcm, size_t bytes, adam_reply_t *reply);
bool adam_net_post_json(const char *path, const char *json);
