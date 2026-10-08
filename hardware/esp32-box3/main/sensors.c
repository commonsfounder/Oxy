#include <math.h>
#include <stdio.h>
#include "bsp/esp-bsp.h"
#include "icm42670.h"
#include "cJSON.h"
#include "esp_timer.h"
#include "sensors.h"

static icm42670_handle_t imu;
static i2c_master_bus_handle_t dock_bus;
static i2c_master_dev_handle_t radar_device;
static bool radar_configured;
static uint8_t imu_id;
static sensor_handle_t humiture;
static float temperature, humidity;
static int64_t temperature_at, humidity_at;
static portMUX_TYPE readings_lock = portMUX_INITIALIZER_UNLOCKED;
static char display_text[128];

esp_err_t __real_i2c_new_master_bus(const i2c_master_bus_config_t *config, i2c_master_bus_handle_t *handle);

// BSP 3.2 exposes only its main bus on base ESP-IDF 5.3. Observe the real dock creation.
esp_err_t __wrap_i2c_new_master_bus(const i2c_master_bus_config_t *config, i2c_master_bus_handle_t *handle) {
    esp_err_t result = __real_i2c_new_master_bus(config, handle);
    if (result == ESP_OK && config->sda_io_num == BSP_I2C_DOCK_SDA && config->scl_io_num == BSP_I2C_DOCK_SCL) dock_bus = *handle;
    return result;
}

static void radar_init(void) {
    if (!dock_bus || i2c_master_probe(dock_bus, 0x28, 100) != ESP_OK) return;
    i2c_device_config_t config = {.device_address = 0x28, .scl_speed_hz = 100000};
    if (i2c_master_bus_add_device(dock_bus, &config, &radar_device) != ESP_OK) return;
    // Espressif AT581x default: 70uA, threshold 200, gain 3, 500ms base + 1500ms hold.
    const uint8_t settings[][2] = {
        {0x68, 0x68}, {0x67, 0x8b}, {0x10, 200}, {0x11, 0}, {0x5c, 0x1b},
        {0x3d, 0xf4}, {0x3e, 0x01}, {0x3f, 0}, {0x40, 0},
        {0x41, 1}, {0x42, 0xdc}, {0x43, 0x05}, {0x44, 0}, {0x45, 0},
        {0x38, 0xd0}, {0x39, 0x07}, {0x4e, 0xe8}, {0x4f, 0x03}, {0x55, 4}
    };
    for (size_t i = 0; i < sizeof(settings) / sizeof(settings[0]); i++) {
        if (i2c_master_transmit(radar_device, settings[i], 2, 200) != ESP_OK) return;
    }
    const uint8_t reset[][2] = {{0, 0}, {0, 1}};
    for (int i = 0; i < 2; i++) if (i2c_master_transmit(radar_device, reset[i], 2, 200) != ESP_OK) return;
    uint8_t reg = 0x10, value = 0;
    radar_configured = i2c_master_transmit_receive(radar_device, &reg, 1, &value, 1, 200) == ESP_OK && value == 200;
}

static void humiture_event(void *arg, sensor_event_base_t base, int32_t event_id, void *event_data) {
    const sensor_data_t *data = event_data;
    if (!data) return;
    portENTER_CRITICAL(&readings_lock);
    if (event_id == SENSOR_TEMP_DATA_READY && isfinite(data->temperature)) {
        temperature = data->temperature; temperature_at = esp_timer_get_time();
    } else if (event_id == SENSOR_HUMI_DATA_READY && isfinite(data->humidity)) {
        humidity = data->humidity; humidity_at = esp_timer_get_time();
    }
    portEXIT_CRITICAL(&readings_lock);
}

void adam_sensors_init(void) {
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (i2c_master_probe(bus, ICM42670_I2C_ADDRESS, 100) == ESP_OK &&
        icm42670_create(bus, ICM42670_I2C_ADDRESS, &imu) == ESP_OK) {
        icm42670_cfg_t config = {.acce_fs = ACCE_FS_2G, .acce_odr = ACCE_ODR_50HZ,
                                .gyro_fs = GYRO_FS_250DPS, .gyro_odr = GYRO_ODR_50HZ};
        if (icm42670_get_deviceid(imu, &imu_id) != ESP_OK ||
            icm42670_config(imu, &config) != ESP_OK ||
            icm42670_acce_set_pwr(imu, ACCE_PWR_LOWNOISE) != ESP_OK ||
            icm42670_gyro_set_pwr(imu, GYRO_PWR_LOWNOISE) != ESP_OK) {
            icm42670_delete(imu); imu = NULL;
        }
    }
    if (sensors_event_loop_create() == ESP_OK) {
        bsp_sensor_config_t config = {.type = HUMITURE_ID, .mode = MODE_POLLING, .period = 2000};
        if (bsp_sensor_init(&config, &humiture) == ESP_OK) {
            iot_sensor_handler_register(humiture, humiture_event, NULL);
            iot_sensor_start(humiture);
        }
    }
    gpio_config_t radar_pin = {.pin_bit_mask = 1ULL << GPIO_NUM_21, .mode = GPIO_MODE_INPUT,
                               .pull_up_en = GPIO_PULLUP_ENABLE};
    gpio_config(&radar_pin);
    radar_init();
}

static cJSON *axes(icm42670_value_t value) {
    cJSON *array = cJSON_CreateArray();
    cJSON_AddItemToArray(array, cJSON_CreateNumber(value.x));
    cJSON_AddItemToArray(array, cJSON_CreateNumber(value.y));
    cJSON_AddItemToArray(array, cJSON_CreateNumber(value.z));
    return array;
}

char *adam_sensors_snapshot(void) {
    cJSON *root = cJSON_CreateObject();
    int64_t now = esp_timer_get_time();
    cJSON_AddNumberToObject(root, "uptimeMs", now / 1000);
    cJSON *inertial = cJSON_AddObjectToObject(root, "imu");
    icm42670_value_t acceleration, rotation;
    bool imu_ok = imu && icm42670_get_acce_value(imu, &acceleration) == ESP_OK &&
                          icm42670_get_gyro_value(imu, &rotation) == ESP_OK;
    cJSON_AddBoolToObject(inertial, "available", imu_ok);
    if (imu_ok) {
        cJSON_AddNumberToObject(inertial, "chipId", imu_id);
        cJSON_AddItemToObject(inertial, "accelerationG", axes(acceleration));
        cJSON_AddItemToObject(inertial, "rotationDps", axes(rotation));
    }
    portENTER_CRITICAL(&readings_lock);
    float temp = temperature, rh = humidity;
    int64_t temp_at = temperature_at, rh_at = humidity_at;
    portEXIT_CRITICAL(&readings_lock);
    bool environment_ok = temp_at && rh_at && now - temp_at < 10000000 && now - rh_at < 10000000;
    cJSON *environment = cJSON_AddObjectToObject(root, "environment");
    cJSON_AddBoolToObject(environment, "available", environment_ok);
    if (environment_ok) {
        cJSON_AddNumberToObject(environment, "temperatureC", temp);
        cJSON_AddNumberToObject(environment, "humidityPercent", rh);
        cJSON_AddNumberToObject(environment, "ageMs", (now - (temp_at < rh_at ? temp_at : rh_at)) / 1000);
    }
    cJSON *radar = cJSON_AddObjectToObject(root, "radar");
    bool radar_ok = radar_configured && dock_bus && i2c_master_probe(dock_bus, 0x28, 100) == ESP_OK;
    cJSON_AddBoolToObject(radar, "available", radar_ok);
    cJSON_AddBoolToObject(radar, "configured", radar_configured);
    cJSON_AddStringToObject(radar, "verification", radar_configured ? "register_readback" : "signal_pin_only");
    cJSON_AddNumberToObject(radar, "gpio21Level", gpio_get_level(GPIO_NUM_21));
    if (radar_ok) cJSON_AddBoolToObject(radar, "motionSignal", gpio_get_level(GPIO_NUM_21) != 0);
    cJSON *dock = cJSON_AddArrayToObject(root, "dockAddresses");
    if (dock_bus) {
        const uint8_t addresses[] = {0x28, 0x38};
        for (int i = 0; i < 2; i++) if (i2c_master_probe(dock_bus, addresses[i], 100) == ESP_OK)
            cJSON_AddItemToArray(dock, cJSON_CreateNumber(addresses[i]));
    }
    cJSON_AddStringToObject(root, "infrared", "not_tested");
    const char *motion = radar_ok ? (gpio_get_level(GPIO_NUM_21) ? "Movement signal" : "No movement signal") : "Radar unavailable";
    if (environment_ok) snprintf(display_text, sizeof(display_text), "%.1f C    %.0f%% humidity\n%s", temp, rh, motion);
    else snprintf(display_text, sizeof(display_text), "Room sensors unavailable\n%s", motion);
    char *result = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return result;
}

const char *adam_sensors_display(void) { return display_text; }
