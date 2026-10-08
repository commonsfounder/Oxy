#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "adam_net.h"
#include "alarm_pattern.h"
#include "bsp/esp-bsp.h"
#include "driver/usb_serial_jtag.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sensors.h"

#define RATE 16000
#define MAX_AUDIO (RATE * 2 * 30)
#define RECORD_SECONDS 8
static esp_codec_dev_handle_t mic, speaker;
static lv_obj_t *status_label, *reply_label;
static lv_obj_t *talk_button;
static volatile bool capture_requested;
static volatile bool host_connected, voice_busy;
static TickType_t voice_started;

// The microphone task listens all the time for alarm patterns and fills a recording buffer when asked.
static SemaphoreHandle_t recording_done;
static int16_t *volatile recording_buffer;
static volatile uint32_t recording_target, recording_position;
static volatile bool deaf;  // true while the speaker is playing, so Adam's own voice is never analysed
static volatile alarm_kind_t pending_alarm;

static void status(const char *text) {
    if (bsp_display_lock(1000)) {
        lv_label_set_text(status_label, text);
        bsp_display_unlock();
    }
}

static void show_reply(const char *text) {
    if (bsp_display_lock(1000)) {
        lv_label_set_text(reply_label, text);
        bsp_display_unlock();
    }
}

static bool can_talk(void) { return host_connected || adam_net_online(); }

static void update_talk_button(void) {
    static int last = -1;
    int now = can_talk();
    if (now == last) return;
    last = now;
    if (bsp_display_lock(1000)) {
        if (now) lv_obj_remove_state(talk_button, LV_STATE_DISABLED);
        else lv_obj_add_state(talk_button, LV_STATE_DISABLED);
        bsp_display_unlock();
    }
}

static void host_state(bool connected) { host_connected = connected; update_talk_button(); }

static bool send_all(const void *data, size_t size) {
    const uint8_t *p = data;
    while (size) {
        int n = usb_serial_jtag_write_bytes(p, size > 4096 ? 4096 : size, pdMS_TO_TICKS(5000));
        if (n <= 0) return false;
        p += n; size -= n;
    }
    return true;
}

static bool receive_all(void *data, size_t size) {
    uint8_t *p = data;
    while (size) {
        int n = usb_serial_jtag_read_bytes(p, size, pdMS_TO_TICKS(5000));
        if (n <= 0) return false;
        p += n; size -= n;
    }
    return true;
}

static SemaphoreHandle_t usb_lock;

static void frame(char kind, const void *payload, uint32_t size) {
    uint8_t header[9] = {'A','D','A','M',kind};
    memcpy(header + 5, &size, 4);
    xSemaphoreTake(usb_lock, portMAX_DELAY);
    if (send_all(header, sizeof(header)) && size) send_all(payload, size);
    xSemaphoreGive(usb_lock);
}

static void mic_task(void *arg) {
    alarm_pattern_t *detector = calloc(1, sizeof(*detector));
    alarm_pattern_init(detector, RATE);
    int16_t stereo[1024], mono[512];
    bool was_deaf = false;
    while (true) {
        if (esp_codec_dev_read(mic, stereo, sizeof(stereo)) != ESP_CODEC_DEV_OK) { vTaskDelay(pdMS_TO_TICKS(20)); continue; }
        for (int j = 0; j < 512; j++) mono[j] = stereo[j * 2];
        uint32_t target = recording_target;
        if (target && recording_buffer && recording_position < target) {
            uint32_t take = target - recording_position < 512 ? target - recording_position : 512;
            memcpy(recording_buffer + recording_position, mono, take * 2);
            recording_position += take;
            if (recording_position >= target) { recording_target = 0; xSemaphoreGive(recording_done); }
        }
        if (deaf) { was_deaf = true; continue; }
        if (was_deaf) { alarm_pattern_reset(detector); was_deaf = false; }
        alarm_kind_t kind = alarm_pattern_process(detector, mono, 512);
        if (kind != ALARM_NONE) {
            pending_alarm = kind;
            alarm_pattern_reset(detector);  // allow the same alarm to be reported again if it keeps going
        }
    }
}

static int16_t *record(uint32_t seconds) {
    uint32_t samples = RATE * seconds;
    int16_t *pcm = heap_caps_malloc(samples * 2, MALLOC_CAP_SPIRAM);
    if (!pcm) return NULL;
    xSemaphoreTake(recording_done, 0);
    recording_position = 0; recording_buffer = pcm; recording_target = samples;
    bool done = xSemaphoreTake(recording_done, pdMS_TO_TICKS((seconds + 4) * 1000)) == pdTRUE;
    recording_target = 0; recording_buffer = NULL;
    if (!done) { free(pcm); return NULL; }
    return pcm;
}

static void capture(void) {
    voice_busy = true; voice_started = xTaskGetTickCount();
    status("Listening");
    int16_t *pcm = record(RECORD_SECONDS);
    if (!pcm) { frame('E', "Microphone read failed", 22); status("Microphone error"); voice_busy = false; return; }
    status("Thinking");
    frame('A', pcm, RATE * RECORD_SECONDS * 2);
    free(pcm);
}

static void play(const void *pcm, size_t bytes) {
    deaf = true;
    status("Speaking");
    esp_codec_dev_write(speaker, (void *)pcm, bytes);
    deaf = false;
}

static void network_turn(void) {
    voice_busy = true; voice_started = xTaskGetTickCount();
    show_reply("");
    status("Listening");
    int16_t *pcm = record(RECORD_SECONDS);
    if (!pcm) { status("Microphone error"); voice_busy = false; return; }
    status("Thinking");
    adam_reply_t reply;
    bool answered = adam_net_voice(pcm, RATE * RECORD_SECONDS * 2, &reply);
    free(pcm);
    if (answered && reply.http_status == 200 && reply.audio_bytes >= 3200) {
        show_reply(reply.reply);
        play(reply.audio, reply.audio_bytes & ~1u);
    } else if (answered && reply.http_status == 422) show_reply("I didn't catch that.");
    else if (answered && reply.http_status == 429) show_reply("One moment.");
    else if (answered && reply.http_status == 401) show_reply("Not paired. Pair this box again.");
    else show_reply("Adam could not answer just now.");
    free(reply.audio);
    voice_busy = false;
}

static const char *alarm_type(alarm_kind_t kind) {
    switch (kind) {
        case ALARM_SMOKE: return "smoke_alarm";
        case ALARM_CARBON_MONOXIDE: return "carbon_monoxide_alarm";
        case ALARM_SUSTAINED_BEEPING: return "sustained_beeping";
        default: return NULL;
    }
}

static void report_alarm(alarm_kind_t kind) {
    const char *type = alarm_type(kind);
    if (!type) return;
    show_reply(kind == ALARM_SMOKE ? "Smoke alarm heard" : kind == ALARM_CARBON_MONOXIDE ? "Carbon monoxide alarm heard" : "Steady beeping heard");
    if (host_connected) frame('B', type, strlen(type));
    char body[64];
    snprintf(body, sizeof(body), "{\"type\":\"%s\"}", type);
    for (int attempt = 0; attempt < 3 && adam_net_configured(); attempt++) {
        if (adam_net_post_json("sound", body)) break;
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

static void post_sensors(void) {
    char *snapshot = adam_sensors_snapshot();
    if (!snapshot) return;
    adam_net_post_json("sensors", snapshot);
    free(snapshot);
}

static void touch(lv_event_t *event) {
    if (lv_event_get_code(event) == LV_EVENT_CLICKED && can_talk() && !voice_busy) capture_requested = true;
}

static void checkpoint(const char *text);

static void sensors_task(void *arg) {
    adam_sensors_init();
    checkpoint("sensors ready");
    vTaskDelete(NULL);
}

static void checkpoint(const char *text) {
    char line[80];
    snprintf(line, sizeof(line), "%s | internal free %u, largest %u", text, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    frame('D', line, strlen(line));
}

void app_main(void) {
    usb_serial_jtag_driver_config_t usb = {.tx_buffer_size = 8192, .rx_buffer_size = 8192};
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
    usb_lock = xSemaphoreCreateMutex();
    checkpoint("start");
    bsp_display_start();
    bsp_display_backlight_on();
    bsp_display_lock(0);
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xf4f0e8), 0);
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "Adam");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, 0);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 25);
    status_label = lv_label_create(screen);
    lv_label_set_text(status_label, "Starting");
    lv_obj_set_style_text_align(status_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(status_label, LV_ALIGN_TOP_MID, 0, 75);
    reply_label = lv_label_create(screen);
    lv_label_set_text(reply_label, "");
    lv_label_set_long_mode(reply_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(reply_label, 290);
    lv_obj_set_style_text_align(reply_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(reply_label, LV_ALIGN_TOP_MID, 0, 120);
    lv_obj_t *button = lv_button_create(screen);
    talk_button = button;
    lv_obj_add_state(button, LV_STATE_DISABLED);
    lv_obj_set_size(button, 170, 48);
    lv_obj_align(button, LV_ALIGN_BOTTOM_MID, 0, -14);
    lv_obj_add_event_cb(button, touch, LV_EVENT_CLICKED, NULL);
    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, "Talk"); lv_obj_center(label);
    bsp_display_unlock();

    checkpoint("display ok");
    adam_net_init();
    checkpoint("net ok");
    speaker = bsp_audio_codec_speaker_init();
    mic = bsp_audio_codec_microphone_init();
    assert(mic && speaker);
    esp_codec_dev_sample_info_t input = {.sample_rate = RATE, .channel = 2, .bits_per_sample = 16};
    esp_codec_dev_sample_info_t output = {.sample_rate = RATE, .channel = 1, .bits_per_sample = 16};
    ESP_ERROR_CHECK(esp_codec_dev_open(speaker, &output));
    ESP_ERROR_CHECK(esp_codec_dev_open(mic, &input));
    ESP_ERROR_CHECK(esp_codec_dev_set_out_vol(speaker, 65));
    ESP_ERROR_CHECK(esp_codec_dev_set_in_gain(mic, 24));
    checkpoint("codec open");
    xTaskCreate(sensors_task, "sensors", 6144, NULL, 3, NULL);
    recording_done = xSemaphoreCreateBinary();
#ifndef ADAM_NO_MIC_TASK
    xTaskCreatePinnedToCore(mic_task, "mic", 8192, NULL, 5, NULL, 1);
#endif
    checkpoint("loop");
    status("Ready");
    TickType_t last_sensor_display = 0, last_sensor_post = 0;
    while (true) {
        TickType_t now = xTaskGetTickCount();
        update_talk_button();
        if (voice_busy && now - voice_started > pdMS_TO_TICKS(120000)) { voice_busy = false; host_state(false); }
        if (pending_alarm != ALARM_NONE && !voice_busy) { alarm_kind_t kind = pending_alarm; pending_alarm = ALARM_NONE; report_alarm(kind); }
        if (!voice_busy && now - last_sensor_display > pdMS_TO_TICKS(1000)) {
            char *snapshot = adam_sensors_snapshot();
            if (snapshot) {
                free(snapshot);
                char line[160];
                snprintf(line, sizeof(line), "%s\n%s", adam_sensors_display(), adam_net_configured() ? (adam_net_online() ? "Online" : "Connecting to Wi-Fi") : "Not set up");
                status(line);
            }
            last_sensor_display = now;
        }
        if (!voice_busy && adam_net_online() && now - last_sensor_post > pdMS_TO_TICKS(60000)) { last_sensor_post = now; post_sensors(); }
        if (capture_requested) { capture_requested = false; if (host_connected) capture(); else network_turn(); }
        uint8_t byte;
        if (usb_serial_jtag_read_bytes(&byte, 1, pdMS_TO_TICKS(50)) <= 0) continue;
        if (byte != 'A') continue;
        uint8_t rest[8];
        if (!receive_all(rest, sizeof(rest)) || memcmp(rest, "DAM", 3)) continue;
        char kind = rest[3]; uint32_t size;
        memcpy(&size, rest + 4, 4);
        if (size > MAX_AUDIO) { frame('E', "Frame too large", 15); continue; }
        uint8_t *payload = size ? heap_caps_malloc(size + 1, MALLOC_CAP_SPIRAM) : NULL;
        if (size && (!payload || !receive_all(payload, size))) { free(payload); status("Connection lost"); continue; }
        if (payload) payload[size] = 0;
        if (kind == 'H') { const char *info = "adam-box3-usb-v1"; host_state(true); frame('H', info, strlen(info)); status("Ready"); }
        else if (kind == 'D' && !size) { voice_busy = false; capture_requested = false; host_state(false); }
        else if (kind == 'C' && size && payload) {
            // Wi-Fi and pairing details from the Mac's provisioning script; the box restarts to use them.
            bool stored = adam_net_store_config((char *)payload);
            frame(stored ? 'K' : 'E', stored ? NULL : "Setup details were not valid", stored ? 0 : 28);
            if (stored) { vTaskDelay(pdMS_TO_TICKS(500)); esp_restart(); }
        }
        else if (kind == 'P' && !size) {
            char *snapshot = adam_sensors_snapshot();
            if (snapshot) { status(adam_sensors_display()); frame('P', snapshot, strlen(snapshot)); free(snapshot); }
            else frame('E', "Sensor snapshot failed", 22);
        }
        else if (kind == 'R' && !size && host_connected && !voice_busy) capture();
        else if (kind == 'S' && size && !(size % 2)) {
            play(payload, size);
            frame('K', NULL, 0);
            voice_busy = false;
            status("Ready");
        } else if (kind == 'T' && size < 200 && payload) { voice_busy = true; voice_started = now; status((char *)payload); }
        free(payload);
    }
}
