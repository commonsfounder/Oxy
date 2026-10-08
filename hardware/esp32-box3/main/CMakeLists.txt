idf_component_register(SRCS "adam_box3.c" "sensors.c" "adam_net.c" "../../../firmware/alarm-pattern/alarm_pattern.c"
                       INCLUDE_DIRS "." "../../../firmware/alarm-pattern"
                       REQUIRES esp_driver_usb_serial_jtag json esp_wifi esp_http_client esp_netif esp_event nvs_flash mbedtls)
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=i2c_new_master_bus")
